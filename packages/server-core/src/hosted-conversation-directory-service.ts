import { randomBytes } from 'node:crypto';
import {
  type HostedConversationDirectoryPage,
  type HostedConversationListPage,
  hostedConversationListPageSchema,
  nodeCapabilitiesSchema,
  type HostedConversationListInput,
  type HostedConversationSummary
} from '@myagentroam/protocol';
import type { CurrentUserSession } from './session.js';
import type { HostedNodeControl, HostedDirectoryNode } from './hosted-contracts.js';
import { requestHostedConversationNode } from './hosted-http-support.js';
import { compareStableVersions } from './node-upgrade-service.js';

const MINIMUM_HOSTED_CONVERSATION_VERSION = '0.9.27';
const DIRECTORY_SORT_VERSION = 1;
const CURSOR_TTL_MS = 10 * 60 * 1000;
const MAX_CURSOR_COUNT = 2_048;

interface DirectoryCursorState {
  readonly userId: number;
  readonly limit: number;
  readonly sortVersion: number;
  readonly nodeCursors: readonly {
    readonly nodeId: string;
    readonly cursor: string;
  }[];
  readonly expiresAt: number;
}

export class HostedConversationDirectoryService {
  private readonly cursors = new Map<string, DirectoryCursorState>();

  constructor(
    private readonly nodeControl: HostedNodeControl,
    private readonly authorizeHostedConversation: (
      userId: number,
      nodeId: string,
      templateId: string
    ) => Promise<boolean>,
    private readonly now: () => number = Date.now,
    private readonly createToken: () => string = () => randomBytes(32).toString('base64url')
  ) {}

  async listNode(
    actor: CurrentUserSession,
    nodeId: string,
    input: HostedConversationListInput
  ): Promise<HostedConversationListPage> {
    return this.readNodePage(actor, nodeId, input, new Map());
  }

  async list(
    actor: CurrentUserSession,
    input: HostedConversationListInput
  ): Promise<HostedConversationDirectoryPage> {
    this.deleteExpiredCursors();
    const cursorState =
      input.cursor === undefined
        ? undefined
        : this.requireCursor(actor.userId, input.limit, input.cursor);
    const eligibleNodes = new Map(
      (await this.nodeControl.listNodes())
        .filter(eligibleDirectoryNode)
        .map((node) => [node.id, node] as const)
    );
    const targets =
      cursorState === undefined
        ? [...eligibleNodes.keys()]
            .sort((left, right) => left.localeCompare(right))
            .map((nodeId) => ({ nodeId, cursor: undefined }))
        : cursorState.nodeCursors.flatMap(({ nodeId, cursor }) =>
            eligibleNodes.has(nodeId) ? [{ nodeId, cursor }] : []
          );
    if (targets.length === 0) return { items: [], nextCursor: null };

    const authorizations = new Map<string, Promise<boolean>>();
    const settled = await Promise.allSettled(
      targets.map(async ({ nodeId, cursor }) => ({
        nodeId,
        page: await this.readNodePage(
          actor,
          nodeId,
          {
            limit: input.limit,
            ...(cursor === undefined ? {} : { cursor })
          },
          authorizations
        )
      }))
    );
    const items: HostedConversationSummary[] = [];
    const nextNodeCursors: { readonly nodeId: string; readonly cursor: string }[] = [];
    for (const result of settled) {
      if (result.status !== 'fulfilled') continue;
      items.push(...result.value.page.items);
      if (result.value.page.nextCursor !== null)
        nextNodeCursors.push({
          nodeId: result.value.nodeId,
          cursor: result.value.page.nextCursor
        });
    }
    items.sort(compareConversations);
    return {
      items,
      nextCursor:
        nextNodeCursors.length === 0
          ? null
          : this.saveCursor({
              userId: actor.userId,
              limit: input.limit,
              sortVersion: DIRECTORY_SORT_VERSION,
              nodeCursors: nextNodeCursors,
              expiresAt: this.now() + CURSOR_TTL_MS
            })
    };
  }

  private async readNodePage(
    actor: CurrentUserSession,
    nodeId: string,
    input: HostedConversationListInput,
    authorizations: Map<string, Promise<boolean>>
  ): Promise<HostedConversationListPage> {
    const page = hostedConversationListPageSchema.parse(
      await requestHostedConversationNode(
        this.nodeControl,
        actor,
        nodeId,
        'conversation.hosted.list',
        input
      )
    );
    if (page.items.some((conversation) => conversation.nodeId !== nodeId))
      throw new Error('HOSTED_CONVERSATION_NOT_AUTHORIZED');
    const items = await Promise.all(
      page.items.map(async (conversation) => {
        const key = `${nodeId}\0${conversation.templateId}`;
        let authorization = authorizations.get(key);
        if (authorization === undefined) {
          authorization = this.authorizeHostedConversation(
            actor.userId,
            nodeId,
            conversation.templateId
          ).catch(() => false);
          authorizations.set(key, authorization);
        }
        return (await authorization) ? conversation : null;
      })
    );
    return {
      ...page,
      items: items.filter((conversation): conversation is HostedConversationSummary => {
        return conversation !== null;
      })
    };
  }

  private requireCursor(userId: number, limit: number, cursor: string): DirectoryCursorState {
    const state = this.cursors.get(cursor);
    if (state === undefined) throw new Error('HOSTED_CONVERSATION_INPUT_INVALID');
    if (state.expiresAt <= this.now()) {
      this.cursors.delete(cursor);
      throw new Error('HOSTED_CONVERSATION_INPUT_INVALID');
    }
    if (
      state.userId !== userId ||
      state.limit !== limit ||
      state.sortVersion !== DIRECTORY_SORT_VERSION
    )
      throw new Error('HOSTED_CONVERSATION_INPUT_INVALID');
    return state;
  }

  private saveCursor(state: DirectoryCursorState): string {
    while (this.cursors.size >= MAX_CURSOR_COUNT) {
      const oldest = this.cursors.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cursors.delete(oldest);
    }
    let token = this.createToken();
    while (this.cursors.has(token)) token = this.createToken();
    this.cursors.set(token, state);
    return token;
  }

  private deleteExpiredCursors(): void {
    const timestamp = this.now();
    for (const [token, state] of this.cursors) {
      if (state.expiresAt <= timestamp) this.cursors.delete(token);
    }
  }
}

function eligibleDirectoryNode(node: HostedDirectoryNode): boolean {
  if (!node.connected || node.disabled) return false;
  let metadata: unknown;
  try {
    metadata = JSON.parse(node.metadata);
  } catch {
    return false;
  }
  const capabilities = nodeCapabilitiesSchema.safeParse(metadata);
  if (!capabilities.success) return false;
  const version = capabilities.data.nodeAppVersion;
  const comparison =
    version === undefined
      ? undefined
      : compareStableVersions(version, MINIMUM_HOSTED_CONVERSATION_VERSION);
  return (
    comparison !== undefined &&
    comparison >= 0 &&
    capabilities.data.conversationHosting?.supportsExistingConversations === true
  );
}

function compareConversations(
  left: HostedConversationSummary,
  right: HostedConversationSummary
): number {
  const leftPinned = left.pinnedAt !== null;
  const rightPinned = right.pinnedAt !== null;
  if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
  if (left.lastActivityAt !== right.lastActivityAt)
    return right.lastActivityAt - left.lastActivityAt;
  const nodeComparison = left.nodeId.localeCompare(right.nodeId);
  return nodeComparison === 0 ? left.id.localeCompare(right.id) : nodeComparison;
}
