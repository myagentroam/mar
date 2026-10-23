import { randomUUID } from 'node:crypto';
import { projectConversationWorkProcesses } from './service/conversation-work-process.js';
import { nodeLog } from './operational.js';
import { safeErrorCode } from './util/safe-error.js';
import {
  permissionStopSchema,
  type PermissionStop,
  type AgentRunStatus,
  type RunPerformance,
  type RunnerName
} from '@myagentroam/protocol';
import type { NativeSessionControl, NodeAgentSession, NodeWorkspace } from './database.js';
import type {
  ConversationItemPage,
  ConversationPage,
  NodeAgentRun,
  NodeApproval,
  NodeConversationItem,
  NodeConversationTurn,
  NodeMessageAttachmentInput,
  NodeQueueItem,
  NodeRunnerExecution,
  NodeRunEvent
} from './runtime-model.js';

type RuntimeRunEvent = Omit<NodeRunEvent, 'id'>;

export interface AgentSessionLookup {
  getAgentSessionById(id: string): NodeAgentSession | undefined;
  findAgentSessionByExternalSession(
    runner: RunnerName,
    externalSessionId: string,
    workspaceId: string
  ): NodeAgentSession | undefined;
}

/** User inputs arrive with a durable Session identity, unlike execution-local output IDs. */
export function runConversationItemId(runId: string, itemId: string, kind?: string): string {
  return kind === 'user_message' ? itemId : `${runId}:${itemId}`;
}

/**
 * Deliberately process-local runtime domain.  No method in this class writes
 * into Node SQLite: a Node restart loses active runs, approvals, leases and
 * managed-session aliases by design.  Durable conversation history belongs to
 * the Runner/native transcript, never to MAR.
 */
export class NodeRuntimeState {
  private static readonly MAX_COMPLETED_TURNS_PER_SESSION = 10;
  private readonly sessions = new Map<string, NodeAgentSession>();
  private readonly runs = new Map<string, NodeAgentRun>();
  private readonly runPerformance = new Map<string, RunPerformance>();
  private readonly recentUserMessages = new Map<string, string>();
  private readonly messageSubmissions = new Map<
    string,
    { readonly kind: 'run' | 'queue'; readonly id: string }
  >();
  private readonly failedMessageSubmissions = new Map<string, string>();
  private readonly terminalMessageSubmissions = new Map<string, string>();
  private readonly queueItems = new Map<string, NodeQueueItem>();
  private readonly executions = new Map<string, NodeRunnerExecution>();
  private readonly retainedExecutionTurns = new Map<
    string,
    { readonly sessionId: string; readonly turnId: string }
  >();
  private readonly runSequences = new Map<string, number>();
  private readonly turns = new Map<string, NodeConversationTurn[]>();
  /** New Sessions retain their full history until the bounded Runtime window drops a Turn. */
  private readonly completeHistorySessions = new Set<string>();
  private readonly approvals = new Map<string, NodeApproval>();
  /** A Session owns at most one running turn; Workspace sessions may run concurrently. */
  private readonly leases = new Map<string, string>();
  /** Blocks new Runs or queued messages while native history is being destructively replaced. */
  private readonly sessionHistoryMutations = new Set<string>();
  /** Session FIFO metadata is deliberately process-local with the rest of run state. */
  private readonly queuedItems = new Map<string, string[]>();
  private readonly receivingQueueItems = new Set<string>();
  private readonly queueVersions = new Map<string, number>();
  private readonly pausedQueues = new Set<string>();
  /** Bounded tombstones reject stale internal start envelopes after terminal cleanup. */
  private readonly terminalRunIds = new Map<string, NodeAgentRun | undefined>();
  /**
   * Bootstrap Session IDs remain resolvable while in-flight work completes
   * after a Runner promotes the Session to its native ID.
   */
  private readonly promotedSessionAliases = new Map<string, string>();

  constructor(
    private readonly nodeId: () => string,
    private readonly getWorkspace: (id: string) => NodeWorkspace | undefined,
    private readonly now: () => number = Date.now,
    private readonly onRunChanged?: (
      run: NodeAgentRun,
      session: NodeAgentSession,
      userMessage?: string
    ) => void
  ) {}

  activeWorkspaceLeaseCount(): number {
    return this.leases.size;
  }

  activeSessionRun(sessionId: string): NodeAgentRun | undefined {
    const runId = this.leases.get(sessionId);
    return runId === undefined ? undefined : this.runs.get(runId);
  }

  hasActiveSessionLease(sessionId: string): boolean {
    return this.leases.has(sessionId);
  }

  createAgentSession(input: {
    readonly parentSessionId?: string | null;
    readonly workspaceId: string;
    readonly runner: RunnerName;
    readonly externalSessionId?: string;
    readonly nativeControl?: NativeSessionControl;
    readonly cwd: string;
    readonly title?: string;
    readonly customTitle?: string;
    readonly sessionPrompt?: string | null;
    readonly model?: string;
    readonly effort?: string;
    readonly access?: string;
    readonly createdAt?: number;
    readonly lastActivityAt?: number;
  }): NodeAgentSession {
    if (this.getWorkspace(input.workspaceId) === undefined) throw new Error('WORKSPACE_NOT_FOUND');
    const now = this.now();
    const id = input.externalSessionId ?? randomUUID();
    if (this.sessions.has(id)) throw new Error('SESSION_ID_CONFLICT');
    const customTitle = input.customTitle?.trim().slice(0, 160) || null;
    const value: NodeAgentSession = {
      id,
      nodeId: this.nodeId(),
      workspaceId: input.workspaceId,
      runner: input.runner,
      externalSessionId: input.externalSessionId ?? null,
      nativeControl:
        input.externalSessionId === undefined ? 'MAR_MANAGED' : (input.nativeControl ?? 'EXTERNAL'),
      channelToken: null,
      cwd: input.cwd,
      model: input.model ?? null,
      effort: input.effort ?? null,
      access: input.access ?? null,
      customTitle,
      sessionPrompt: input.sessionPrompt ?? null,
      runnerTitle: input.title?.trim().slice(0, 160) || null,
      pinnedAt: null,
      // A first user prompt is only a process-local temporary title. A
      // Runner/native title can replace it on the next discovery refresh.
      titleSource: customTitle === null ? 'AUTO' : 'CUSTOM',
      parentSessionId: input.parentSessionId ?? null,
      lastActivityAt: input.lastActivityAt ?? now,
      createdAt: input.createdAt ?? now
    };
    this.sessions.set(value.id, value);
    if (input.externalSessionId === undefined) this.completeHistorySessions.add(value.id);
    return value;
  }

  /** Internal envelope compatibility for a Run already accepted in this process. */
  adoptRun(input: {
    readonly runId: string;
    readonly sessionId: string;
    readonly workspaceId?: string;
    readonly runner: RunnerName;
    readonly cwd: string;
    readonly clientMessageId?: string;
    readonly externalSessionId?: string;
    readonly initiatedByUserId?: number;
  }): NodeAgentRun {
    this.assertSessionHistoryMutable(input.sessionId);
    if (this.terminalRunIds.has(input.runId)) throw new Error('RUN_TERMINAL');
    let session = this.sessions.get(input.sessionId);
    if (session === undefined) {
      const now = this.now();
      session = {
        id: input.sessionId,
        nodeId: this.nodeId(),
        workspaceId: input.workspaceId ?? `runtime:${input.cwd}`,
        runner: input.runner,
        externalSessionId: input.externalSessionId ?? null,
        nativeControl: input.externalSessionId === undefined ? 'MAR_MANAGED' : 'EXTERNAL',
        channelToken: null,
        cwd: input.cwd,
        model: null,
        effort: null,
        access: null,
        customTitle: null,
        sessionPrompt: null,
        runnerTitle: null,
        pinnedAt: null,
        titleSource: 'AUTO',
        lastActivityAt: now,
        createdAt: now
      };
      this.sessions.set(session.id, session);
      if (input.externalSessionId === undefined) this.completeHistorySessions.add(session.id);
    }
    const existing = this.getRun(input.runId);
    if (existing !== undefined) return existing;
    const now = this.now();
    const run: NodeAgentRun = {
      id: input.runId,
      sessionId: session.id,
      nodeId: this.nodeId(),
      workspaceId: session.workspaceId,
      runner: session.runner,
      status: 'STARTING',
      recoveryState: 'ACTIVE',
      version: 0,
      clientMessageId: input.clientMessageId ?? input.runId,
      ...(input.initiatedByUserId === undefined
        ? {}
        : { initiatedByUserId: input.initiatedByUserId }),
      createdAt: now,
      startedAt: now,
      completedAt: null,
      updatedAt: now
    };
    this.runs.set(run.id, run);
    this.leases.set(run.sessionId, run.id);
    this.emitRunChanged(run, session);
    return run;
  }

  getAgentSessionById(id: string): NodeAgentSession | undefined {
    return this.sessions.get(this.resolvePromotedSessionId(id));
  }

  getAgentSession(id: string): NodeAgentSession | undefined {
    return (
      this.getAgentSessionById(id) ??
      [...this.sessions.values()].find((value) => value.externalSessionId === id)
    );
  }
  listAgentSessions(): readonly NodeAgentSession[] {
    return [...this.sessions.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }
  findAgentSessionByExternalSession(
    runner: RunnerName,
    externalSessionId: string,
    workspaceId?: string
  ): NodeAgentSession | undefined {
    return [...this.sessions.values()].find(
      (value) =>
        value.runner === runner &&
        value.externalSessionId === externalSessionId &&
        (workspaceId === undefined || value.workspaceId === workspaceId)
    );
  }

  /** Request-local identity lookups; callers must consume them synchronously. */
  createSessionLookup(): AgentSessionLookup {
    const byId = new Map(this.sessions);
    const byNative = new Map<string, NodeAgentSession>();
    for (const session of byId.values()) {
      if (session.externalSessionId === null) continue;
      const key = JSON.stringify([session.runner, session.workspaceId, session.externalSessionId]);
      if (!byNative.has(key)) byNative.set(key, session);
    }
    return {
      getAgentSessionById: (id) => byId.get(this.resolvePromotedSessionId(id)),
      findAgentSessionByExternalSession: (runner, externalId, workspaceId) =>
        byNative.get(JSON.stringify([runner, workspaceId, externalId]))
    };
  }
  updateAgentSessionConfiguration(input: {
    readonly sessionId: string;
    readonly model?: string;
    readonly effort?: string;
    readonly access?: string;
  }): NodeAgentSession {
    return this.replaceSession(input.sessionId, {
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.effort === undefined ? {} : { effort: input.effort }),
      ...(input.access === undefined ? {} : { access: input.access })
    });
  }
  updateAgentSessionAccess(sessionId: string, access: string): NodeAgentSession {
    return this.replaceSession(sessionId, { access });
  }
  setNativeControl(id: string, nativeControl: NativeSessionControl): void {
    this.replaceSession(id, { nativeControl });
  }
  setExternalSessionId(id: string, externalSessionId: string): void {
    if (externalSessionId.length === 0) throw new Error('SESSION_EXTERNAL_ID_INVALID');
    this.promoteSessionIdentity(id, externalSessionId);
  }

  validateSessionIdentityPromotion(id: string, nativeSessionId: string): NodeAgentSession {
    if (nativeSessionId.length === 0) throw new Error('SESSION_EXTERNAL_ID_INVALID');
    const current = this.requireSession(id);
    if (id !== nativeSessionId && this.sessions.has(nativeSessionId))
      throw new Error('SESSION_ID_CONFLICT');
    return current;
  }

  /**
   * Atomically replaces the bootstrap Session key with the Runner-native ID.
   * No caller may migrate the individual runtime maps independently.
   */
  promoteSessionIdentity(
    id: string,
    nativeSessionId: string,
    options: { readonly deferRunChanges?: boolean } = {}
  ): NodeAgentSession {
    const current = this.validateSessionIdentityPromotion(id, nativeSessionId);
    if (id === nativeSessionId)
      return this.replaceSession(id, {
        externalSessionId: nativeSessionId,
        nativeControl: 'MAR_MANAGED'
      });
    const next: NodeAgentSession = {
      ...current,
      id: nativeSessionId,
      externalSessionId: nativeSessionId,
      nativeControl: 'MAR_MANAGED'
    };
    const runs = this.listRunsForSession(id);
    const turns = this.turns.get(id) ?? [];
    const queue = this.queuedItems.get(id);
    const queueVersion = this.queueVersions.get(id);
    const lease = this.leases.get(id);
    const paused = this.pausedQueues.has(id);

    this.sessions.delete(id);
    this.sessions.set(nativeSessionId, next);
    if (this.completeHistorySessions.delete(id)) this.completeHistorySessions.add(nativeSessionId);
    this.promotedSessionAliases.set(id, nativeSessionId);
    for (const [alias, target] of this.promotedSessionAliases)
      if (target === id) this.promotedSessionAliases.set(alias, nativeSessionId);
    for (const run of runs) this.runs.set(run.id, { ...run, sessionId: nativeSessionId });
    for (const run of this.terminalRunIds.values())
      if (run?.sessionId === id)
        this.terminalRunIds.set(run.id, { ...run, sessionId: nativeSessionId });
    this.turns.delete(id);
    this.turns.set(
      nativeSessionId,
      turns.map((turn) => ({
        ...turn,
        sessionId: nativeSessionId,
        items: turn.items.map((item) => ({ ...item, sessionId: nativeSessionId }))
      }))
    );
    if (queue !== undefined) {
      this.queuedItems.delete(id);
      this.queuedItems.set(nativeSessionId, queue);
      for (const itemId of queue) {
        const item = this.queueItems.get(itemId);
        if (item !== undefined)
          this.queueItems.set(itemId, { ...item, sessionId: nativeSessionId });
      }
    }
    if (queueVersion !== undefined) {
      this.queueVersions.delete(id);
      this.queueVersions.set(nativeSessionId, queueVersion);
    }
    if (lease !== undefined) {
      this.leases.delete(id);
      this.leases.set(nativeSessionId, lease);
    }
    if (paused) {
      this.pausedQueues.delete(id);
      this.pausedQueues.add(nativeSessionId);
    }
    for (const [key, submission] of [...this.messageSubmissions]) {
      if (!key.startsWith(`${id}\u0000`)) continue;
      this.messageSubmissions.delete(key);
      this.messageSubmissions.set(`${nativeSessionId}${key.slice(id.length)}`, submission);
    }
    const terminalSubmissions = [...this.terminalMessageSubmissions];
    this.terminalMessageSubmissions.clear();
    for (const [key, runId] of terminalSubmissions)
      this.terminalMessageSubmissions.set(
        key.startsWith(`${id}\u0000`) ? `${nativeSessionId}${key.slice(id.length)}` : key,
        runId
      );
    for (const [executionId, reference] of this.retainedExecutionTurns)
      if (reference.sessionId === id)
        this.retainedExecutionTurns.set(executionId, {
          ...reference,
          sessionId: nativeSessionId
        });
    if (options.deferRunChanges !== true) this.publishSessionIdentity(nativeSessionId);
    return next;
  }

  /** Identity observers run only after the owning identity commit is complete. */
  publishSessionIdentity(sessionId: string): void {
    const session = this.requireSession(sessionId);
    for (const run of this.listRunsForSession(sessionId)) {
      try {
        this.emitRunChanged(run, session);
      } catch (error) {
        nodeLog('session.identity.publish.failed', {
          sessionId,
          runId: run.id,
          phase: 'run.observer',
          errorCode: safeErrorCode(error, 'SESSION_IDENTITY_PUBLICATION_FAILED')
        });
      }
    }
  }
  setChannelToken(id: string, channelToken: string): void {
    if (channelToken.length < 16) throw new Error('SESSION_CHANNEL_TOKEN_INVALID');
    this.replaceSession(id, { channelToken });
  }
  updateSessionMetadata(input: {
    readonly sessionId: string;
    readonly customTitle?: string | null;
    readonly sessionPrompt?: string | null;
    readonly pinned?: boolean;
  }): NodeAgentSession {
    const current = this.requireSession(input.sessionId);
    const title =
      input.customTitle === undefined ? current.customTitle : input.customTitle?.trim() || null;
    if (title !== null && title.length > 160) throw new Error('SESSION_TITLE_INVALID');
    return this.replaceSession(current.id, {
      customTitle: title,
      sessionPrompt:
        input.sessionPrompt === undefined ? (current.sessionPrompt ?? null) : input.sessionPrompt,
      pinnedAt: input.pinned === undefined ? current.pinnedAt : input.pinned ? this.now() : null,
      titleSource: title === null ? 'AUTO' : 'CUSTOM'
    });
  }

  /**
   * Give a new or restored managed Session a readable local title while the
   * Runner still has a placeholder. Never replace a user rename or a
   * non-placeholder Runner title.
   */
  setTemporaryTitleIfMissing(id: string, title: string): NodeAgentSession {
    const current = this.requireSession(id);
    const value = title.trim().replace(/\s+/g, ' ').slice(0, 160);
    if (
      value.length === 0 ||
      current.customTitle !== null ||
      (current.runnerTitle !== null && !isDefaultRunnerTitle(current.runnerTitle))
    )
      return current;
    return this.replaceSession(id, { runnerTitle: value, titleSource: 'AUTO' });
  }

  /**
   * Runner/native discovery is authoritative for its own title. Keep it on
   * the managed Session so later `session.get` polls cannot regress to an
   * empty fallback after a discovery response has already shown the title.
   */
  setRunnerTitleFromNative(id: string, title: string): NodeAgentSession {
    const current = this.requireSession(id);
    const value = title.trim().replace(/\s+/g, ' ').slice(0, 160);
    if (
      value.length === 0 ||
      current.customTitle !== null ||
      (current.titleSource === 'AUTO' && isDefaultRunnerTitle(value))
    )
      return current;
    if (current.runnerTitle === value)
      return current.titleSource === 'RUNNER'
        ? current
        : this.replaceSession(id, { titleSource: 'RUNNER' });
    return this.replaceSession(id, { runnerTitle: value, titleSource: 'RUNNER' });
  }

  createMessageRun(input: {
    readonly runId?: string;
    readonly sessionId: string;
    readonly clientMessageId: string;
    readonly content: string;
    readonly source?: 'SCHEDULED';
    readonly suppressNotifications?: boolean;
    readonly recentUserMessage?: string;
    readonly initiatedByUserId?: number;
    readonly attachments?: readonly NodeMessageAttachmentInput[];
  }): { readonly run: NodeAgentRun; readonly created: boolean } {
    this.assertSessionHistoryMutable(input.sessionId);
    const key = `${input.sessionId}\u0000${input.clientMessageId}`;
    const duplicate = this.messageSubmissions.get(key);
    if (duplicate !== undefined) {
      if (duplicate.kind !== 'run') throw new Error('MESSAGE_ALREADY_QUEUED');
      return { run: this.requireRun(duplicate.id), created: false };
    }
    const session = this.requireSession(input.sessionId);
    if (this.activeSessionRun(session.id) !== undefined) throw new Error('RUN_ALREADY_ACTIVE');
    const now = this.now();
    const run: NodeAgentRun = {
      id: input.runId ?? randomUUID(),
      sessionId: session.id,
      nodeId: this.nodeId(),
      workspaceId: session.workspaceId,
      runner: session.runner,
      status: 'STARTING',
      recoveryState: 'ACTIVE',
      version: 0,
      clientMessageId: input.clientMessageId,
      ...(input.source === undefined ? {} : { source: input.source }),
      ...(input.suppressNotifications === true ? { suppressNotifications: true } : {}),
      ...(input.initiatedByUserId === undefined
        ? {}
        : { initiatedByUserId: input.initiatedByUserId }),
      createdAt: now,
      startedAt: now,
      completedAt: null,
      updatedAt: now
    };
    const attachments = this.projectMessageAttachments(run.id, input.attachments ?? []);
    const user: NodeConversationItem = {
      id: randomUUID(),
      sessionId: session.id,
      turnId: '',
      runId: run.id,
      parentItemId: null,
      sourceSequence: null,
      revision: 0,
      kind: 'user_message',
      status: 'COMPLETED',
      payload: {
        clientMessageId: input.clientMessageId,
        text: input.content,
        ...(input.source === undefined ? {} : { source: input.source }),
        contexts: [],
        attachments,
        delivery: 'ACCEPTED'
      },
      startedAt: now,
      completedAt: now
    };
    const turn: NodeConversationTurn = {
      id: randomUUID(),
      sessionId: session.id,
      runId: run.id,
      userItemId: user.id,
      status: 'PREPARING',
      model: session.model,
      effort: session.effort,
      access: session.access,
      items: [user],
      startedAt: now,
      completedAt: null
    };
    const fixedTurn = { ...turn, items: [{ ...user, turnId: turn.id }] };
    this.runs.set(run.id, run);
    this.recentUserMessages.set(run.id, input.recentUserMessage ?? input.content);
    this.messageSubmissions.set(key, { kind: 'run', id: run.id });
    this.leases.set(session.id, run.id);
    this.turns.set(session.id, [...(this.turns.get(session.id) ?? []), fixedTurn]);
    this.replaceSession(session.id, { lastActivityAt: now });
    this.emitRunChanged(run, this.requireSession(session.id));
    return { run, created: true };
  }

  createQueueItem(input: {
    readonly queueItemId?: string;
    readonly sessionId: string;
    readonly clientMessageId: string;
    readonly content: string;
    readonly suppressNotifications?: boolean;
    readonly initiatedByUserId?: number;
    readonly attachments?: readonly NodeMessageAttachmentInput[];
  }): { readonly item: NodeQueueItem; readonly created: boolean } {
    this.assertSessionHistoryMutable(input.sessionId);
    const key = `${input.sessionId}\u0000${input.clientMessageId}`;
    const duplicate = this.messageSubmissions.get(key);
    if (duplicate !== undefined) {
      if (duplicate.kind !== 'queue') throw new Error('MESSAGE_ALREADY_STARTED');
      return { item: this.requireQueueItem(duplicate.id), created: false };
    }
    const session = this.requireSession(input.sessionId);
    const active = this.activeSessionRun(session.id);
    const queuedOwner = (this.queuedItems.get(session.id) ?? [])
      .map((itemId) => this.queueItems.get(itemId)?.initiatedByUserId)
      .find((userId) => userId !== undefined);
    const expectedOwner = active?.initiatedByUserId ?? queuedOwner;
    if (expectedOwner !== undefined && input.initiatedByUserId !== expectedOwner)
      throw new Error('RUN_OWNED_BY_ANOTHER_USER');
    const now = this.now();
    const item: NodeQueueItem = {
      id: input.queueItemId ?? randomUUID(),
      sessionId: session.id,
      workspaceId: session.workspaceId,
      runner: session.runner,
      clientMessageId: input.clientMessageId,
      content: input.content,
      ...(input.suppressNotifications === true ? { suppressNotifications: true } : {}),
      attachments: input.attachments ?? [],
      ...(input.initiatedByUserId === undefined
        ? {}
        : { initiatedByUserId: input.initiatedByUserId }),
      createdAt: now
    };
    this.queueItems.set(item.id, item);
    this.messageSubmissions.set(key, { kind: 'queue', id: item.id });
    this.queuedItems.set(session.id, [...(this.queuedItems.get(session.id) ?? []), item.id]);
    this.bumpQueueVersion(session.id);
    return { item, created: true };
  }

  sessionQueue(sessionId: string): {
    readonly version: number;
    readonly paused: boolean;
    readonly itemIds: readonly string[];
  } {
    return {
      version: this.queueVersions.get(sessionId) ?? 0,
      paused: this.pausedQueues.has(sessionId),
      itemIds: this.queuedItems.get(sessionId) ?? []
    };
  }

  getQueueItem(id: string): NodeQueueItem | undefined {
    return this.queueItems.get(id);
  }
  reserveQueueItem(itemId: string): () => void {
    this.requireQueueItem(itemId);
    this.assertQueueItemMutable(itemId);
    this.receivingQueueItems.add(itemId);
    return () => {
      this.receivingQueueItems.delete(itemId);
    };
  }
  private assertQueueItemMutable(itemId: string): void {
    if (this.receivingQueueItems.has(itemId)) throw new Error('QUEUE_ITEM_RECEIVING');
  }
  consumeSteeredQueueItem(itemId: string, runId: string): void {
    const item = this.requireQueueItem(itemId);
    const run = this.getRun(runId);
    if (!run || run.sessionId !== item.sessionId || !this.receivingQueueItems.has(itemId))
      throw new Error('QUEUE_ITEM_INVALID');
    this.queuedItems.set(
      item.sessionId,
      (this.queuedItems.get(item.sessionId) ?? []).filter((id) => id !== itemId)
    );
    this.queueItems.delete(itemId);
    this.bumpQueueVersion(item.sessionId);
    this.messageSubmissions.set(`${item.sessionId}\u0000${item.clientMessageId}`, {
      kind: 'run',
      id: run.id
    });
    this.recentUserMessages.set(run.id, item.content);
  }

  claimNextQueueItem(
    sessionId: string,
    content?: string
  ): { readonly item: NodeQueueItem; readonly turn: NodeConversationTurn } | undefined {
    if (this.pausedQueues.has(sessionId)) return undefined;
    const active = this.activeSessionRun(sessionId);
    if (active === undefined) return undefined;
    const queue = this.queuedItems.get(sessionId) ?? [];
    const itemId = queue[0];
    if (itemId === undefined) return undefined;
    if (this.receivingQueueItems.has(itemId)) return undefined;
    const item = this.requireQueueItem(itemId);
    const run = {
      ...active,
      ...(active.initiatedByUserId === undefined && item.initiatedByUserId !== undefined
        ? { initiatedByUserId: item.initiatedByUserId }
        : {}),
      suppressNotifications: item.suppressNotifications === true
    };
    this.runs.set(run.id, run);
    this.queuedItems.set(sessionId, queue.slice(1));
    this.bumpQueueVersion(sessionId);
    this.queueItems.delete(itemId);
    this.messageSubmissions.set(`${item.sessionId}\u0000${item.clientMessageId}`, {
      kind: 'run',
      id: run.id
    });
    const turn = this.createTurn(
      run,
      item.clientMessageId,
      content ?? item.content,
      item.attachments
    );
    this.recentUserMessages.set(run.id, item.content);
    this.emitRunChanged(run, this.requireSession(sessionId));
    return { item, turn };
  }

  startRunFromQueueItem(
    itemId: string,
    content?: string
  ): {
    readonly run: NodeAgentRun;
    readonly turn: NodeConversationTurn;
  } {
    const item = this.requireQueueItem(itemId);
    this.assertSessionHistoryMutable(item.sessionId);
    if (this.activeSessionRun(item.sessionId) !== undefined) throw new Error('RUN_ALREADY_ACTIVE');
    const queue = this.queuedItems.get(item.sessionId) ?? [];
    if (queue[0] !== itemId) throw new Error('QUEUE_ITEM_INVALID');
    this.queuedItems.set(item.sessionId, queue.slice(1));
    this.queueItems.delete(itemId);
    this.messageSubmissions.delete(`${item.sessionId}\u0000${item.clientMessageId}`);
    this.bumpQueueVersion(item.sessionId);
    const created = this.createMessageRun({
      sessionId: item.sessionId,
      clientMessageId: item.clientMessageId,
      content: content ?? item.content,
      recentUserMessage: item.content,
      ...(item.suppressNotifications === true ? { suppressNotifications: true } : {}),
      ...(item.attachments.length === 0 ? {} : { attachments: item.attachments }),
      ...(item.initiatedByUserId === undefined ? {} : { initiatedByUserId: item.initiatedByUserId })
    });
    const turn = this.currentTurnForRun(created.run.id);
    if (turn === undefined) throw new Error('RUN_TURN_NOT_FOUND');
    return { run: created.run, turn };
  }

  pauseSessionQueue(sessionId: string): void {
    this.pausedQueues.add(sessionId);
    this.bumpQueueVersion(sessionId);
  }

  resumeSessionQueue(sessionId: string): void {
    if (!this.pausedQueues.delete(sessionId)) return;
    this.bumpQueueVersion(sessionId);
  }

  reorderSessionQueue(
    sessionId: string,
    expectedVersion: number,
    itemIds: readonly string[]
  ): void {
    const current = this.queuedItems.get(sessionId) ?? [];
    for (const id of current) this.assertQueueItemMutable(id);
    if (
      this.sessionQueue(sessionId).version !== expectedVersion ||
      current.length !== itemIds.length ||
      new Set(current).size !== current.length ||
      current.some((itemId) => !itemIds.includes(itemId))
    )
      throw new Error('QUEUE_VERSION_CONFLICT');
    if (itemIds.some((itemId) => this.queueItems.get(itemId)?.sessionId !== sessionId))
      throw new Error('QUEUE_ITEM_INVALID');
    this.queuedItems.set(sessionId, [...itemIds]);
    this.bumpQueueVersion(sessionId);
  }

  prioritizeQueueItem(itemId: string): NodeQueueItem {
    this.assertQueueItemMutable(itemId);
    const item = this.requireQueueItem(itemId);
    const queue = this.queuedItems.get(item.sessionId) ?? [];
    if (!queue.includes(itemId)) throw new Error('QUEUE_ITEM_INVALID');
    this.queuedItems.set(item.sessionId, [
      itemId,
      ...queue.filter((candidate) => candidate !== itemId)
    ]);
    this.bumpQueueVersion(item.sessionId);
    return item;
  }

  updateQueueItem(itemId: string, content: string): NodeQueueItem {
    this.assertQueueItemMutable(itemId);
    const item = this.requireQueueItem(itemId);
    if (!(this.queuedItems.get(item.sessionId) ?? []).includes(itemId))
      throw new Error('QUEUE_ITEM_INVALID');
    const next = { ...item, content };
    this.queueItems.set(itemId, next);
    this.bumpQueueVersion(item.sessionId);
    return next;
  }

  updateQueueItemAttachments(
    itemId: string,
    attachments: readonly NodeMessageAttachmentInput[],
    content?: string
  ): NodeQueueItem {
    this.assertQueueItemMutable(itemId);
    const item = this.requireQueueItem(itemId);
    const next = { ...item, attachments, ...(content === undefined ? {} : { content }) };
    this.queueItems.set(itemId, next);
    if (content !== undefined && content !== item.content) this.bumpQueueVersion(item.sessionId);
    return next;
  }

  deleteQueueItem(itemId: string): void {
    this.assertQueueItemMutable(itemId);
    const item = this.requireQueueItem(itemId);
    const queue = this.queuedItems.get(item.sessionId) ?? [];
    if (!queue.includes(itemId)) throw new Error('QUEUE_ITEM_INVALID');
    this.queuedItems.set(
      item.sessionId,
      queue.filter((candidate) => candidate !== itemId)
    );
    this.bumpQueueVersion(item.sessionId);
    this.queueItems.delete(itemId);
    for (const [key, candidate] of this.messageSubmissions)
      if (candidate.kind === 'queue' && candidate.id === itemId)
        this.messageSubmissions.delete(key);
  }

  currentRunMessageText(runId: string): string {
    const run = this.requireRun(runId);
    const turn = (this.turns.get(run.sessionId) ?? []).findLast(
      (candidate) => candidate.runId === runId
    );
    const item = turn?.items.find((candidate) => candidate.id === turn.userItemId);
    return isRecord(item?.payload) && typeof item.payload.text === 'string'
      ? item.payload.text
      : '';
  }

  updatePreparingTurnMessage(
    runId: string,
    content: string,
    attachments: readonly NodeMessageAttachmentInput[]
  ): void {
    const projected = this.projectMessageAttachments(runId, attachments);
    this.updateCurrentTurnForRun(runId, (turn) => ({
      ...turn,
      items: turn.items.map((item) =>
        item.id === turn.userItemId && isRecord(item.payload)
          ? { ...item, payload: { ...item.payload, text: content, attachments: projected } }
          : item
      )
    }));
  }

  getRun(id: string): NodeAgentRun | undefined {
    const canonical = this.executions.get(id)?.runId ?? id;
    return this.runs.get(canonical);
  }
  /** Only the current execution may replace an active Run's ephemeral metrics. */
  updateRunPerformance(id: string, performance: RunPerformance): boolean {
    const run = this.getRun(id);
    if (run === undefined || terminal(run.status) || performance.runId !== run.id) return false;
    if (id !== run.id && this.currentExecutionId(run.id) !== id) return false;
    this.runPerformance.set(run.id, {
      ...this.runPerformance.get(run.id),
      runId: performance.runId,
      ...(performance.latencyMs === undefined ? {} : { latencyMs: performance.latencyMs }),
      ...(performance.tokensPerSecond === undefined
        ? {}
        : { tokensPerSecond: performance.tokensPerSecond })
    });
    return true;
  }
  sessionPerformance(sessionId: string): RunPerformance | undefined {
    const run = this.activeSessionRun(sessionId);
    const performance = run === undefined ? undefined : this.runPerformance.get(run.id);
    return performance === undefined ? undefined : { ...performance };
  }
  findMessageRun(sessionId: string, clientMessageId: string): NodeAgentRun | undefined {
    const submission = this.messageSubmissions.get(`${sessionId}\u0000${clientMessageId}`);
    return submission?.kind === 'run' ? this.runs.get(submission.id) : undefined;
  }
  findMessageSubmission(
    sessionId: string,
    clientMessageId: string
  ):
    | { readonly kind: 'run'; readonly run: NodeAgentRun }
    | {
        readonly kind: 'queue';
        readonly item: NodeQueueItem;
        readonly run: NodeAgentRun | undefined;
      }
    | undefined {
    const key = `${sessionId}\u0000${clientMessageId}`;
    const submission = this.messageSubmissions.get(key);
    if (submission === undefined) {
      const runId = this.terminalMessageSubmissions.get(key);
      const run = runId === undefined ? undefined : this.terminalRunIds.get(runId);
      return run === undefined ? undefined : { kind: 'run', run };
    }
    if (submission.kind === 'run') return { kind: 'run', run: this.requireRun(submission.id) };
    const item = this.requireQueueItem(submission.id);
    const run = this.activeSessionRun(sessionId);
    return { kind: 'queue', item, run };
  }
  messagePreparationFailure(sessionId: string, clientMessageId: string): string | undefined {
    return this.failedMessageSubmissions.get(`${sessionId}\u0000${clientMessageId}`);
  }
  recordMessagePreparationFailure(submissionId: string, code: string): void {
    const entry = [...this.messageSubmissions].find(
      ([, submission]) => submission.id === submissionId
    );
    if (entry === undefined) return;
    this.failedMessageSubmissions.set(entry[0], code);
    if (this.failedMessageSubmissions.size > 1_024)
      this.failedMessageSubmissions.delete(
        this.failedMessageSubmissions.keys().next().value as string
      );
  }
  listRunsForSession(
    sessionId: string,
    options: { readonly includeTerminal?: boolean } = {}
  ): readonly NodeAgentRun[] {
    const workspaceId = this.getAgentSession(sessionId)?.workspaceId;
    return [
      ...this.runs.values(),
      ...(options.includeTerminal === true ? this.terminalRunIds.values() : [])
    ]
      .filter(
        (run): run is NodeAgentRun =>
          run !== undefined &&
          run.sessionId === sessionId &&
          (options.includeTerminal !== true || run.workspaceId === workspaceId)
      )
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  transitionRun(id: string, next: AgentRunStatus): NodeAgentRun {
    const runId = this.executions.get(id)?.runId ?? id;
    const current = this.requireRun(runId);
    if (!transitionAllowed(current.status, next)) throw new Error('RUN_STATE_INVALID');
    const now = this.now();
    const value = {
      ...current,
      status: next,
      version: current.version + 1,
      completedAt: terminal(next) ? now : current.completedAt,
      updatedAt: now
    };
    this.runs.set(runId, value);
    if (terminal(next)) this.runPerformance.delete(runId);
    this.emitRunChanged(value, this.requireSession(value.sessionId));
    if (terminal(next) && this.leases.get(value.sessionId) === value.id)
      this.leases.delete(value.sessionId);
    this.updateCurrentTurnForRun(value.id, (turn) => ({
      ...turn,
      status: next,
      completedAt: terminal(next) ? this.now() : turn.completedAt,
      items: terminal(next)
        ? turn.items.map((item) =>
            activeConversationItem(item.status)
              ? {
                  ...item,
                  status: completedStatusForRun(next),
                  completedAt: this.now(),
                  updatedAt: now
                }
              : item
          )
        : turn.items
    }));
    return value;
  }
  appendRunEvent(input: {
    readonly runId: string;
    readonly sequence: number;
    readonly eventType: string;
    readonly payload: unknown;
    readonly status?: AgentRunStatus;
  }): RuntimeRunEvent | undefined {
    const execution = this.executions.get(input.runId);
    const runId = execution?.runId ?? input.runId;
    this.requireRun(runId);
    const priorSequence = this.runSequences.get(runId) ?? 0;
    if (input.sequence <= priorSequence) return undefined;
    if (input.sequence > priorSequence + 1) throw new Error('EVENT_SEQUENCE_GAP');
    const value: RuntimeRunEvent = {
      runId,
      sequence: input.sequence,
      eventType: input.eventType,
      payload: input.payload,
      ...(input.status === undefined ? {} : { status: input.status }),
      createdAt: this.now()
    };
    this.runSequences.set(runId, input.sequence);
    if (execution !== undefined && input.status !== undefined) {
      const executionStatus = executionStatusForRun(input.status);
      this.executions.set(input.runId, {
        ...execution,
        status: executionStatus,
        completedAt: terminal(input.status) ? value.createdAt : execution.completedAt
      });
    }
    if (input.status !== undefined && !terminal(input.status))
      this.transitionRun(runId, input.status);
    this.projectEvent(value, execution?.turnId);
    if (input.status !== undefined && terminal(input.status) && execution !== undefined)
      this.completeTurn(execution.turnId, input.status, value.createdAt);
    return value;
  }

  currentExecutionId(runId: string): string | undefined {
    const turn = this.currentTurnForRun(runId);
    if (turn === undefined) return undefined;
    for (const [executionId, execution] of this.executions)
      if (
        execution.runId === runId &&
        execution.turnId === turn.id &&
        !terminalExecution(execution.status)
      )
        return executionId;
    return undefined;
  }

  createExecution(runId: string): NodeRunnerExecution {
    const canonicalRunId = this.canonicalRunId(runId);
    const turn = this.currentTurnForRun(canonicalRunId);
    if (turn === undefined || turn.status !== 'PREPARING') throw new Error('RUN_TURN_NOT_READY');
    const existing = [...this.executions.values()].find(
      (execution) => execution.runId === canonicalRunId && execution.turnId === turn.id
    );
    if (existing !== undefined) return existing;
    const now = this.now();
    const execution: NodeRunnerExecution = {
      id: randomUUID(),
      runId: canonicalRunId,
      turnId: turn.id,
      status: 'STARTING',
      startedAt: now,
      completedAt: null
    };
    this.executions.set(execution.id, execution);
    this.updateCurrentTurnForRun(canonicalRunId, (current) => ({
      ...current,
      items: current.items.map((item) =>
        item.id === current.userItemId &&
        isRecord(item.payload) &&
        Array.isArray(item.payload.attachments)
          ? {
              ...item,
              payload: {
                ...item.payload,
                attachments: item.payload.attachments.map((attachment) =>
                  isRecord(attachment) && typeof attachment.imageIndex === 'number'
                    ? { ...attachment, runId: execution.id }
                    : attachment
                )
              }
            }
          : item
      )
    }));
    return execution;
  }

  canonicalRunId(id: string): string {
    return this.executions.get(id)?.runId ?? id;
  }

  finishRun(runId: string, status: 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED'): NodeAgentRun {
    return this.transitionRun(this.canonicalRunId(runId), status);
  }
  listConversationTurns(input: {
    readonly sessionId: string;
    readonly cursor?: string;
    readonly limit?: number;
  }): ConversationPage & { readonly historyComplete: boolean } {
    this.requireSession(input.sessionId);
    // A managed Turn keeps the user's acceptance time as its stable timeline
    // position. Runner start/completion timestamps must not move it behind a
    // message that was accepted later. Native Turns without a user timestamp
    // fall back to their own lifecycle time.
    const all = [...(this.turns.get(input.sessionId) ?? [])]
      .map((turn, index) => ({ turn, index }))
      .sort((a, b) => {
        const timestamp = (value: NodeConversationTurn) =>
          value.items.find((item) => item.id === value.userItemId)?.startedAt ??
          value.startedAt ??
          value.completedAt ??
          0;
        return timestamp(a.turn) - timestamp(b.turn) || a.index - b.index;
      })
      .map(({ turn }) => turn);
    const end =
      input.cursor === undefined ? all.length : decodeCursor(input.cursor, input.sessionId);
    const limit = Math.min(Math.max(input.limit ?? 30, 1), 500);
    const start = Math.max(0, end - limit);
    const slice = all.slice(start, end);
    return {
      turns: slice,
      historyComplete: this.completeHistorySessions.has(input.sessionId),
      nextCursor: start > 0 ? encodeCursor(input.sessionId, start) : null
    };
  }

  conversationTurnForRun(runId: string): NodeConversationTurn | undefined {
    const canonicalRunId = this.canonicalRunId(runId);
    const run = this.runs.get(canonicalRunId);
    if (run !== undefined)
      return (this.turns.get(run.sessionId) ?? []).findLast(
        (turn) => turn.runId === canonicalRunId
      );
    // Terminal Run cleanup may retain Turns after removing the Run.
    for (const turns of this.turns.values()) {
      const turn = turns.findLast((candidate) => candidate.runId === canonicalRunId);
      if (turn !== undefined) return turn;
    }
    return undefined;
  }

  conversationTurnForExecution(executionId: string): NodeConversationTurn | undefined {
    const execution = this.executions.get(executionId);
    const reference =
      execution === undefined
        ? this.retainedExecutionTurns.get(executionId)
        : {
            sessionId: this.requireRun(execution.runId).sessionId,
            turnId: execution.turnId
          };
    if (reference === undefined) return undefined;
    return (this.turns.get(reference.sessionId) ?? []).find((turn) => turn.id === reference.turnId);
  }
  listConversationItems(input: {
    readonly sessionId: string;
    readonly cursor?: string;
    readonly limit?: number;
  }): ConversationItemPage {
    const turns = this.listConversationTurns(input).turns;
    return { items: turns.flatMap((turn) => turn.items), nextCursor: null };
  }

  conversationTail(sessionId: string): readonly NodeConversationTurn[] {
    return this.turns.get(this.resolvePromotedSessionId(sessionId)) ?? [];
  }

  recordCommandExecution(input: {
    readonly sessionId: string;
    readonly command: string;
    readonly cwd: string;
    readonly outputPreview: string;
    readonly failed?: boolean;
  }): NodeConversationTurn {
    const session = this.requireSession(input.sessionId);
    const now = this.now();
    const item: NodeConversationItem = {
      id: randomUUID(),
      sessionId: input.sessionId,
      turnId: '',
      runId: null,
      parentItemId: null,
      sourceSequence: null,
      revision: 1,
      kind: 'command_execution',
      status: input.failed ? 'FAILED' : 'COMPLETED',
      payload: {
        command: input.command,
        cwd: input.cwd,
        outputPreview: input.outputPreview.slice(0, 10_000),
        outputRef: null,
        exitCode: input.failed ? 1 : 0,
        durationMs: 0,
        truncated: false
      },
      startedAt: now,
      completedAt: now
    };
    const turn: NodeConversationTurn = {
      id: randomUUID(),
      sessionId: input.sessionId,
      runId: null,
      userItemId: null,
      status: input.failed ? 'FAILED' : 'SUCCEEDED',
      model: session.model,
      effort: session.effort,
      access: session.access,
      items: [],
      startedAt: now,
      completedAt: now
    };
    const completedItem = { ...item, turnId: turn.id };
    const completedTurn = { ...turn, items: [completedItem] };
    this.turns.set(input.sessionId, [...(this.turns.get(input.sessionId) ?? []), completedTurn]);
    this.replaceSession(session.id, { lastActivityAt: now });
    return completedTurn;
  }

  createApproval(input: {
    readonly runId: string;
    readonly approvalId: string;
    readonly payload: unknown;
    readonly expiresAt: number;
  }): NodeApproval {
    const run = this.getRun(input.runId);
    if (run === undefined) throw new Error('RUN_NOT_FOUND');
    if (input.runId !== run.id && this.currentExecutionId(run.id) !== input.runId)
      throw new Error('RUN_EXECUTION_NOT_CURRENT');
    if (this.approvals.has(input.approvalId)) throw new Error('APPROVAL_ALREADY_EXISTS');
    if (input.expiresAt <= this.now()) throw new Error('APPROVAL_EXPIRED');
    const value: NodeApproval = {
      id: input.approvalId,
      runId: input.runId,
      status: 'PENDING',
      payload: input.payload,
      expiresAt: input.expiresAt,
      createdAt: this.now(),
      decidedAt: null
    };
    this.approvals.set(value.id, value);
    return value;
  }
  getApproval(id: string): NodeApproval | undefined {
    const value = this.approvals.get(id);
    if (value?.status === 'PENDING' && value.expiresAt <= this.now())
      return this.expireApproval(id);
    return value;
  }
  listApprovals(runId: string): readonly NodeApproval[] {
    const canonicalRunId = this.canonicalRunId(runId);
    return [...this.approvals.values()]
      .filter((value) => this.canonicalRunId(value.runId) === canonicalRunId)
      .map((value) => this.getApproval(value.id) as NodeApproval);
  }
  expireApproval(id: string): NodeApproval {
    const value = this.requireApproval(id);
    if (value.status !== 'PENDING') return value;
    if (value.expiresAt > this.now()) throw new Error('APPROVAL_NOT_EXPIRED');
    const next = { ...value, status: 'EXPIRED' as const, decidedAt: this.now() };
    this.approvals.set(id, next);
    return next;
  }
  decideApproval(id: string, decision: 'APPROVED' | 'REJECTED'): NodeApproval {
    const value = this.getApproval(id);
    if (value === undefined) throw new Error('APPROVAL_NOT_FOUND');
    if (value.status === 'EXPIRED') throw new Error('APPROVAL_EXPIRED');
    if (value.status !== 'PENDING') throw new Error('APPROVAL_ALREADY_DECIDED');
    const next = { ...value, status: decision, decidedAt: this.now() };
    this.approvals.set(id, next);
    return next;
  }
  expireDueApprovals(): readonly NodeApproval[] {
    return [...this.approvals.values()]
      .filter((value) => value.status === 'PENDING' && value.expiresAt <= this.now())
      .map((value) => this.expireApproval(value.id));
  }
  listNonterminalRuns(): readonly NodeAgentRun[] {
    return [...this.runs.values()].filter((run) => !terminal(run.status));
  }
  lastRunSequence(id: string): number {
    return this.runSequences.get(id) ?? 0;
  }
  removeTerminalRun(runId: string): void {
    const run = this.requireRun(runId);
    if (!terminal(run.status)) throw new Error('RUN_ACTIVE');
    this.terminalRunIds.set(runId, run);
    if (this.terminalRunIds.size > 1_024) {
      const oldest = this.terminalRunIds.keys().next().value as string;
      this.terminalRunIds.delete(oldest);
      for (const [key, id] of this.terminalMessageSubmissions)
        if (id === oldest) this.terminalMessageSubmissions.delete(key);
    }
    const executionIds = new Set(
      [...this.executions.values()]
        .filter((execution) => execution.runId === runId)
        .map((execution) => execution.id)
    );
    const turns = (this.turns.get(run.sessionId) ?? []).filter((turn) => {
      const hasVisibleError = turn.items.some((item) => item.kind === 'error');
      if (turn.runId === runId)
        return run.status === 'SUCCEEDED' || run.status === 'INTERRUPTED' || hasVisibleError;
      const isTransientErrorTurn =
        hasVisibleError && turn.status !== 'SUCCEEDED' && turn.status !== 'INTERRUPTED';
      return run.status !== 'SUCCEEDED' || !isTransientErrorTurn;
    });
    const completed = turns.filter((turn) => terminalTurn(turn.status));
    const retainedCompleted = new Set(
      completed.slice(-NodeRuntimeState.MAX_COMPLETED_TURNS_PER_SESSION).map((turn) => turn.id)
    );
    const retainedTurns = turns.filter(
      (turn) => !terminalTurn(turn.status) || retainedCompleted.has(turn.id)
    );
    const retainedTurnIds = new Set(retainedTurns.map((turn) => turn.id));
    if (retainedTurns.length < (this.turns.get(run.sessionId)?.length ?? 0))
      this.completeHistorySessions.delete(run.sessionId);
    this.turns.set(run.sessionId, retainedTurns);
    for (const [executionId, execution] of this.executions) {
      if (execution.runId !== runId) continue;
      this.executions.delete(executionId);
      if (retainedTurnIds.has(execution.turnId))
        this.retainedExecutionTurns.set(executionId, {
          sessionId: run.sessionId,
          turnId: execution.turnId
        });
    }
    this.pruneRetainedExecutionTurns(run.sessionId, retainedTurnIds);
    this.runs.delete(runId);
    this.runPerformance.delete(runId);
    this.recentUserMessages.delete(runId);
    this.runSequences.delete(runId);
    for (const [key, candidate] of this.messageSubmissions)
      if (candidate.kind === 'run' && candidate.id === runId) {
        this.messageSubmissions.delete(key);
        this.terminalMessageSubmissions.set(key, runId);
        if (this.terminalMessageSubmissions.size > 1_024)
          this.terminalMessageSubmissions.delete(
            this.terminalMessageSubmissions.keys().next().value as string
          );
      }
    for (const [approvalId, approval] of this.approvals)
      if (approval.runId === runId || executionIds.has(approval.runId))
        this.approvals.delete(approvalId);
  }
  private clearTerminalMessageSubmissions(sessionId: string): void {
    for (const key of this.terminalMessageSubmissions.keys())
      if (key.startsWith(`${sessionId}\u0000`)) this.terminalMessageSubmissions.delete(key);
  }
  hasActiveWorkspaceLease(workspaceId: string): boolean {
    return [...this.leases.values()]
      .map((runId) => this.runs.get(runId))
      .some((run) => run?.workspaceId === workspaceId);
  }
  /** Removes a terminal Session's process-local projection after its native history is deleted. */
  removeAgentSession(sessionId: string): void {
    this.requireSession(sessionId);
    const runs = this.listRunsForSession(sessionId);
    if (runs.some((run) => !terminal(run.status))) throw new Error('SESSION_ACTIVE');
    const runIds = new Set(runs.map((run) => run.id));
    const executionIds = new Set(
      [...this.executions.values()]
        .filter((execution) => runIds.has(execution.runId))
        .map((execution) => execution.id)
    );
    this.sessions.delete(sessionId);
    this.clearTerminalMessageSubmissions(sessionId);
    this.completeHistorySessions.delete(sessionId);
    this.removePromotedSessionAliases(sessionId);
    this.turns.delete(sessionId);
    this.pruneRetainedExecutionTurns(sessionId, new Set());
    const queued = this.queuedItems.get(sessionId) ?? [];
    this.queuedItems.delete(sessionId);
    for (const itemId of queued) this.queueItems.delete(itemId);
    this.queueVersions.delete(sessionId);
    this.pausedQueues.delete(sessionId);
    this.leases.delete(sessionId);
    for (const runId of runIds) {
      this.runs.delete(runId);
      this.runPerformance.delete(runId);
      this.recentUserMessages.delete(runId);
      this.runSequences.delete(runId);
    }
    for (const executionId of executionIds) this.executions.delete(executionId);
    for (const [key, submission] of this.messageSubmissions)
      if (
        (submission.kind === 'run' && runIds.has(submission.id)) ||
        (submission.kind === 'queue' && queued.includes(submission.id))
      )
        this.messageSubmissions.delete(key);
    for (const key of this.failedMessageSubmissions.keys())
      if (key.startsWith(`${sessionId}\u0000`)) this.failedMessageSubmissions.delete(key);
    for (const [approvalId, approval] of this.approvals)
      if (runIds.has(approval.runId) || executionIds.has(approval.runId))
        this.approvals.delete(approvalId);
  }
  beginSessionHistoryMutation(
    sessionId: string,
    options?: { readonly allowQueued?: boolean }
  ): () => void {
    if (this.sessionHistoryMutations.has(sessionId)) throw new Error('SESSION_ACTIVE');
    if (this.activeSessionRun(sessionId) !== undefined) throw new Error('SESSION_ACTIVE');
    if (options?.allowQueued !== true && this.sessionQueue(sessionId).itemIds.length > 0)
      throw new Error('SESSION_QUEUE_NOT_EMPTY');
    this.sessionHistoryMutations.add(sessionId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.sessionHistoryMutations.delete(sessionId);
    };
  }
  resetAgentSessionHistory(sessionId: string, lastActivityAt: number): NodeAgentSession {
    if (this.activeSessionRun(sessionId) !== undefined) throw new Error('SESSION_ACTIVE');
    if (this.sessionQueue(sessionId).itemIds.length > 0) throw new Error('SESSION_QUEUE_NOT_EMPTY');
    this.turns.delete(sessionId);
    this.clearTerminalMessageSubmissions(sessionId);
    for (const [id, run] of this.terminalRunIds)
      if (run?.sessionId === sessionId) this.terminalRunIds.set(id, undefined);
    this.completeHistorySessions.delete(sessionId);
    this.pruneRetainedExecutionTurns(sessionId, new Set());
    for (const key of this.failedMessageSubmissions.keys())
      if (key.startsWith(`${sessionId}\u0000`)) this.failedMessageSubmissions.delete(key);
    return this.replaceSession(sessionId, { lastActivityAt });
  }
  removeWorkspace(workspaceId: string): void {
    if (this.hasActiveWorkspaceLease(workspaceId)) throw new Error('WORKSPACE_BUSY');
    const sessionIds = new Set(
      [...this.sessions.values()]
        .filter((session) => session.workspaceId === workspaceId)
        .map((session) => session.id)
    );
    const runIds = new Set(
      [...this.runs.values()].filter((run) => run.workspaceId === workspaceId).map((run) => run.id)
    );
    const executionIds = new Set(
      [...this.executions.values()]
        .filter((execution) => runIds.has(execution.runId))
        .map((execution) => execution.id)
    );
    const queueItemIds = new Set(
      [...sessionIds].flatMap((sessionId) => this.queuedItems.get(sessionId) ?? [])
    );
    for (const sessionId of sessionIds) {
      this.sessions.delete(sessionId);
      this.clearTerminalMessageSubmissions(sessionId);
      this.completeHistorySessions.delete(sessionId);
      this.removePromotedSessionAliases(sessionId);
      this.turns.delete(sessionId);
      this.pruneRetainedExecutionTurns(sessionId, new Set());
    }
    for (const runId of runIds) {
      this.runs.delete(runId);
      this.runPerformance.delete(runId);
      this.recentUserMessages.delete(runId);
      this.runSequences.delete(runId);
    }
    for (const executionId of executionIds) this.executions.delete(executionId);
    for (const [key, submission] of this.messageSubmissions)
      if (
        (submission.kind === 'run' && runIds.has(submission.id)) ||
        (submission.kind === 'queue' && queueItemIds.has(submission.id))
      )
        this.messageSubmissions.delete(key);
    for (const key of this.failedMessageSubmissions.keys()) {
      const separator = key.indexOf('\u0000');
      if (separator >= 0 && sessionIds.has(key.slice(0, separator)))
        this.failedMessageSubmissions.delete(key);
    }
    for (const [approvalId, approval] of this.approvals)
      if (runIds.has(approval.runId) || executionIds.has(approval.runId))
        this.approvals.delete(approvalId);
    for (const sessionId of sessionIds) {
      const queued = this.queuedItems.get(sessionId) ?? [];
      this.queuedItems.delete(sessionId);
      for (const itemId of queued) this.queueItems.delete(itemId);
      this.queueVersions.delete(sessionId);
      this.pausedQueues.delete(sessionId);
      this.leases.delete(sessionId);
    }
  }

  private assertSessionHistoryMutable(sessionId: string): void {
    if (this.sessionHistoryMutations.has(sessionId)) throw new Error('SESSION_ACTIVE');
  }
  reconcileRun(id: string, active: boolean): void {
    // There is no cross-restart run recovery: this process-local state is
    // discarded on restart and cannot be reconciled from SQLite.
    void id;
    void active;
  }

  private replaceSession(id: string, patch: Partial<NodeAgentSession>): NodeAgentSession {
    const value = this.requireSession(id);
    const next = { ...value, ...patch };
    this.sessions.set(id, next);
    if (value.customTitle !== next.customTitle || value.runnerTitle !== next.runnerTitle)
      for (const run of this.listRunsForSession(id)) this.emitRunChanged(run, next);
    return next;
  }
  private emitRunChanged(run: NodeAgentRun, session: NodeAgentSession): void {
    const turn = this.currentTurnForRun(run.id);
    const payload = turn?.items.find((item) => item.kind === 'user_message')?.payload;
    const clientMessageId =
      isRecord(payload) && typeof payload.clientMessageId === 'string'
        ? payload.clientMessageId
        : undefined;
    const userMessage = clientMessageId?.startsWith('goal:')
      ? ''
      : (this.recentUserMessages.get(run.id) ?? this.currentRunMessageText(run.id));
    this.onRunChanged?.(run, session, userMessage.length === 0 ? undefined : userMessage);
  }
  private bumpQueueVersion(sessionId: string): void {
    this.queueVersions.set(sessionId, (this.queueVersions.get(sessionId) ?? 0) + 1);
  }

  private pruneRetainedExecutionTurns(
    sessionId: string,
    retainedTurnIds: ReadonlySet<string>
  ): void {
    for (const [executionId, reference] of this.retainedExecutionTurns)
      if (reference.sessionId === sessionId && !retainedTurnIds.has(reference.turnId))
        this.retainedExecutionTurns.delete(executionId);
  }
  private requireSession(id: string): NodeAgentSession {
    const value = this.sessions.get(id);
    if (value === undefined) throw new Error('SESSION_NOT_FOUND');
    return value;
  }
  private resolvePromotedSessionId(id: string): string {
    let resolved = id;
    const visited = new Set<string>();
    while (!visited.has(resolved)) {
      visited.add(resolved);
      const next = this.promotedSessionAliases.get(resolved);
      if (next === undefined) break;
      resolved = next;
    }
    return resolved;
  }
  private removePromotedSessionAliases(sessionId: string): void {
    for (const [alias, target] of this.promotedSessionAliases)
      if (alias === sessionId || target === sessionId) this.promotedSessionAliases.delete(alias);
  }
  private requireRun(id: string): NodeAgentRun {
    const value = this.runs.get(id);
    if (value === undefined) throw new Error('RUN_NOT_FOUND');
    return value;
  }
  private requireQueueItem(id: string): NodeQueueItem {
    const value = this.queueItems.get(id);
    if (value === undefined) throw new Error('QUEUE_ITEM_INVALID');
    return value;
  }
  private requireApproval(id: string): NodeApproval {
    const value = this.approvals.get(id);
    if (value === undefined) throw new Error('APPROVAL_NOT_FOUND');
    return value;
  }
  private updateTurnForRun(
    runId: string,
    update: (value: NodeConversationTurn) => NodeConversationTurn
  ): void {
    const run = this.requireRun(runId);
    const current = this.turns.get(run.sessionId) ?? [];
    this.turns.set(
      run.sessionId,
      current.map((turn) => (turn.runId === runId ? update(turn) : turn))
    );
  }
  private updateCurrentTurnForRun(
    runId: string,
    update: (value: NodeConversationTurn) => NodeConversationTurn
  ): void {
    const run = this.requireRun(runId);
    const current = this.turns.get(run.sessionId) ?? [];
    const index = current.findLastIndex((turn) => turn.runId === runId);
    if (index < 0) return;
    this.turns.set(
      run.sessionId,
      current.map((turn, turnIndex) => (turnIndex === index ? update(turn) : turn))
    );
  }
  private currentTurnForRun(runId: string): NodeConversationTurn | undefined {
    const run = this.requireRun(runId);
    return (this.turns.get(run.sessionId) ?? []).findLast((turn) => turn.runId === runId);
  }
  private createItemOnlyTurn(run: NodeAgentRun, startedAt: number): NodeConversationTurn {
    const session = this.requireSession(run.sessionId);
    const turn: NodeConversationTurn = {
      id: randomUUID(),
      sessionId: session.id,
      runId: run.id,
      userItemId: null,
      status: terminal(run.status) ? run.status : 'RUNNING',
      model: session.model,
      effort: session.effort,
      access: session.access,
      items: [],
      startedAt,
      completedAt: terminal(run.status) ? startedAt : null
    };
    this.turns.set(session.id, [...(this.turns.get(session.id) ?? []), turn]);
    this.replaceSession(session.id, { lastActivityAt: startedAt });
    return turn;
  }
  private createTurn(
    run: NodeAgentRun,
    clientMessageId: string,
    content: string,
    attachments: readonly NodeMessageAttachmentInput[]
  ): NodeConversationTurn {
    const session = this.requireSession(run.sessionId);
    const now = this.now();
    const turnId = randomUUID();
    const userId = randomUUID();
    const user: NodeConversationItem = {
      id: userId,
      sessionId: session.id,
      turnId,
      runId: run.id,
      parentItemId: null,
      sourceSequence: null,
      revision: 0,
      kind: 'user_message',
      status: 'COMPLETED',
      payload: {
        clientMessageId,
        text: content,
        contexts: [],
        attachments: this.projectMessageAttachments(run.id, attachments),
        delivery: 'ACCEPTED'
      },
      startedAt: now,
      completedAt: now
    };
    const turn: NodeConversationTurn = {
      id: turnId,
      sessionId: session.id,
      runId: run.id,
      userItemId: userId,
      status: 'PREPARING',
      model: session.model,
      effort: session.effort,
      access: session.access,
      items: [user],
      startedAt: now,
      completedAt: null
    };
    this.turns.set(session.id, [...(this.turns.get(session.id) ?? []), turn]);
    this.replaceSession(session.id, { lastActivityAt: now });
    return turn;
  }
  private projectMessageAttachments(
    runId: string,
    attachments: readonly NodeMessageAttachmentInput[]
  ): readonly Record<string, unknown>[] {
    let imageIndex = 0;
    return attachments
      .filter(({ mime }) => mime.startsWith('image/'))
      .map(({ name, mime, dataBase64 }) => {
        const attachment = {
          name,
          mime,
          byteSize: Buffer.byteLength(dataBase64, 'base64'),
          runId
        };
        if (!mime.startsWith('image/')) return attachment;
        return { ...attachment, imageIndex: imageIndex++ };
      });
  }
  private completeTurn(turnId: string, status: AgentRunStatus, completedAt: number): void {
    for (const [sessionId, turns] of this.turns) {
      if (!turns.some((turn) => turn.id === turnId)) continue;
      this.turns.set(
        sessionId,
        turns.map((turn) =>
          turn.id === turnId
            ? {
                ...turn,
                status,
                completedAt,
                items: turn.items.map((item) =>
                  activeConversationItem(item.status)
                    ? {
                        ...item,
                        status: completedStatusForRun(status),
                        completedAt,
                        updatedAt: completedAt
                      }
                    : item
                )
              }
            : turn
        )
      );
      return;
    }
  }
  private projectEvent(event: RuntimeRunEvent, turnId?: string): void {
    const run = this.requireRun(event.runId);
    if (
      turnId === undefined &&
      this.currentTurnForRun(event.runId) === undefined &&
      conversationItemFromEvent(event) !== undefined
    )
      this.createItemOnlyTurn(run, event.createdAt);
    let needsProcessProjection = false;
    const update = (turn: NodeConversationTurn): NodeConversationTurn => {
      if (
        event.eventType === 'text.delta' &&
        isRecord(event.payload) &&
        typeof event.payload.text === 'string'
      ) {
        const nativeItemId =
          typeof event.payload.itemId === 'string' && event.payload.itemId.length <= 88
            ? event.payload.itemId
            : undefined;
        const stableItemId =
          nativeItemId === undefined ? undefined : `${event.runId}:${nativeItemId}`;
        const lastItem = turn.items.at(-1);
        const existing =
          stableItemId === undefined
            ? lastItem?.kind === 'assistant_message' && activeConversationItem(lastItem.status)
              ? lastItem
              : undefined
            : turn.items.find(
                (item) => item.id === stableItemId && item.kind === 'assistant_message'
              );
        const text = `${existing === undefined ? '' : readableText(existing.payload)}${event.payload.text}`;
        const sourceItemId = conversationSourceItemId(event.payload) ?? existing?.sourceItemId;
        needsProcessProjection =
          existing === undefined ||
          existing.sourceItemId !== sourceItemId ||
          (!readableText(existing.payload).trim() && !!text.trim());
        const item: NodeConversationItem = {
          id: existing?.id ?? stableItemId ?? `${event.runId}:assistant:${event.sequence}`,
          ...(sourceItemId === undefined ? {} : { sourceItemId }),
          sessionId: run.sessionId,
          turnId: turn.id,
          runId: event.runId,
          parentItemId: null,
          sourceSequence: existing?.sourceSequence ?? event.sequence,
          revision: event.sequence,
          kind: 'assistant_message',
          ...(existing?.processGroup === undefined ? {} : { processGroup: existing.processGroup }),
          updatedAt: event.createdAt,
          status: 'IN_PROGRESS',
          payload: { text, format: 'markdown', model: null },
          startedAt: existing?.startedAt ?? event.createdAt,
          completedAt: null
        };
        return {
          ...turn,
          status: 'RUNNING',
          startedAt: turn.startedAt ?? event.createdAt,
          items:
            existing === undefined
              ? [...turn.items, item]
              : turn.items.map((value) => (value.id === item.id ? item : value))
        };
      }
      const projected = conversationItemFromEvent(event);
      if (projected !== undefined) {
        const itemId = runConversationItemId(event.runId, projected.itemId, projected.kind);
        const trailingItem = turn.items.at(-1);
        const orderedItems =
          projected.kind !== 'user_message' &&
          trailingItem?.kind === 'assistant_message' &&
          activeConversationItem(trailingItem.status)
            ? turn.items.map((item) =>
                item.id === trailingItem.id
                  ? {
                      ...item,
                      status: 'COMPLETED',
                      completedAt: event.createdAt,
                      updatedAt: event.createdAt
                    }
                  : item
              )
            : turn.items;
        const existing =
          orderedItems.find((item) => item.id === itemId) ??
          (projected.kind === 'assistant_message' &&
          projected.itemId.startsWith('codex:') &&
          trailingItem?.kind === 'assistant_message' &&
          trailingItem.id.startsWith(`${event.runId}:assistant:`) &&
          activeConversationItem(trailingItem.status)
            ? trailingItem
            : undefined);
        const status = projected.status;
        const sourceItemId = projected.sourceItemId ?? existing?.sourceItemId;
        const parentItemId =
          projected.parentItemId === undefined
            ? (existing?.parentItemId ?? null)
            : runConversationItemId(event.runId, projected.parentItemId);
        needsProcessProjection =
          existing === undefined ||
          existing.kind !== projected.kind ||
          projected.kind === 'context_compaction' ||
          existing.parentItemId !== parentItemId ||
          existing.sourceItemId !== sourceItemId ||
          (projected.kind === 'assistant_message' &&
            !!readableText(existing.payload).trim() !== !!readableText(projected.payload).trim()) ||
          (projected.kind === 'reasoning' && existing.processGroup === undefined);
        const item: NodeConversationItem = {
          id: itemId,
          sessionId: run.sessionId,
          turnId: turn.id,
          runId: event.runId,
          parentItemId,
          ...(sourceItemId === undefined ? {} : { sourceItemId }),
          sourceSequence: existing?.sourceSequence ?? event.sequence,
          revision: (existing?.revision ?? -1) + 1,
          kind: projected.kind,
          ...(existing?.processGroup === undefined ? {} : { processGroup: existing.processGroup }),
          updatedAt: event.createdAt,
          status,
          payload: mergeConversationItemPayload(existing?.payload, projected),
          ...(projected.permissionStop === undefined
            ? {}
            : { permissionStop: projected.permissionStop }),
          startedAt: existing?.startedAt ?? event.createdAt,
          completedAt: completedConversationItem(status) ? event.createdAt : null
        };
        return {
          ...turn,
          status: terminal(run.status) ? run.status : 'RUNNING',
          startedAt: turn.startedAt ?? event.createdAt,
          items:
            existing === undefined
              ? [...orderedItems, item]
              : orderedItems.map((value) => (value.id === existing.id ? item : value))
        };
      }
      if (event.eventType === 'run.started' || event.eventType === 'run.running')
        return { ...turn, status: 'RUNNING', startedAt: turn.startedAt ?? event.createdAt };
      if (
        event.eventType === 'run.completed' ||
        event.eventType === 'run.failed' ||
        event.eventType === 'run.rejected'
      ) {
        const status = event.status ?? this.requireRun(event.runId).status;
        return {
          ...turn,
          status,
          completedAt: event.createdAt,
          items: turn.items.map((item) =>
            activeConversationItem(item.status)
              ? {
                  ...item,
                  status: completedStatusForRun(status),
                  completedAt: event.createdAt
                }
              : item
          )
        };
      }
      return turn;
    };
    const project = (turn: NodeConversationTurn) => {
      const next = update(turn);
      // Ordinary token/output updates retain membership; only structural input needs a scan.
      return needsProcessProjection ? projectConversationWorkProcesses(next) : next;
    };
    if (turnId === undefined) this.updateCurrentTurnForRun(event.runId, project);
    else {
      const current = this.turns.get(run.sessionId) ?? [];
      this.turns.set(
        run.sessionId,
        current.map((turn) => (turn.id === turnId ? project(turn) : turn))
      );
    }
  }
}

function isDefaultRunnerTitle(title: string): boolean {
  return /^(?:new|untitled) session(?:\s*[-–—:]\s*\d{4}-\d{2}-\d{2}.*)?$/iu.test(title);
}

function terminal(status: AgentRunStatus): boolean {
  return ['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'LOST'].includes(status);
}
function terminalTurn(status: string): boolean {
  return ['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'LOST'].includes(status);
}
function transitionAllowed(from: AgentRunStatus, to: AgentRunStatus): boolean {
  return !terminal(from) || from === to;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function readableText(value: unknown): string {
  return isRecord(value) && typeof value.text === 'string' ? value.text : '';
}

type ProjectedConversationItem = {
  readonly sourceItemId?: string;
  readonly parentItemId?: string;
  readonly permissionStop?: PermissionStop;
  readonly itemId: string;
  readonly kind: string;
  readonly status: string;
  readonly payload: Record<string, unknown>;
  readonly merge: boolean;
  readonly append?: 'sections' | 'outputPreview' | 'outputSummary';
};

function conversationItemFromEvent(event: RuntimeRunEvent): ProjectedConversationItem | undefined {
  if (isRecord(event.payload)) {
    const approvalId = event.payload.approvalId;
    if (typeof approvalId === 'string' && approvalId.length > 0) {
      if (event.eventType === 'approval.request')
        return {
          itemId: `approval:${approvalId}`,
          kind: 'approval_request',
          status: 'PENDING',
          payload: {
            approvalId,
            approvalStatus: 'PENDING',
            approval: event.payload.payload,
            expiresAt: event.payload.expiresAt
          },
          merge: false
        };
      if (event.eventType === 'approval.decided') {
        const decision = event.payload.decision;
        if (decision === 'APPROVED' || decision === 'REJECTED')
          return {
            itemId: `approval:${approvalId}`,
            kind: 'approval_request',
            status: decision === 'APPROVED' ? 'COMPLETED' : 'DECLINED',
            payload: { approvalId, approvalStatus: decision },
            merge: true
          };
      }
      if (event.eventType === 'approval.expired')
        return {
          itemId: `approval:${approvalId}`,
          kind: 'approval_request',
          status: 'CANCELLED',
          payload: { approvalId, approvalStatus: 'EXPIRED' },
          merge: true
        };
    }
  }
  if (event.eventType !== 'conversation.item' || !isRecord(event.payload)) return undefined;
  const itemId = event.payload.itemId;
  const kind = event.payload.kind;
  const status = event.payload.status;
  const payload = event.payload.payload;
  if (
    typeof itemId !== 'string' ||
    itemId.length === 0 ||
    itemId.length > 88 ||
    typeof kind !== 'string' ||
    !projectableConversationKind(kind) ||
    typeof status !== 'string' ||
    !projectableConversationStatus(status) ||
    !isRecord(payload)
  )
    return undefined;
  const append = event.payload.append;
  const sourceItemId = conversationSourceItemId(event.payload);
  const permissionStop = permissionStopSchema.safeParse(event.payload.permissionStop);
  return {
    itemId,
    kind,
    status,
    payload,
    ...(sourceItemId === undefined ? {} : { sourceItemId }),
    ...(typeof event.payload.parentItemId === 'string' &&
    event.payload.parentItemId.length > 0 &&
    event.payload.parentItemId.length <= 88
      ? { parentItemId: event.payload.parentItemId }
      : {}),
    ...(permissionStop.success ? { permissionStop: permissionStop.data } : {}),
    merge: event.payload.merge === true,
    ...(append === 'sections' || append === 'outputPreview' || append === 'outputSummary'
      ? { append }
      : {})
  };
}

function conversationSourceItemId(payload: Record<string, unknown>): string | undefined {
  return typeof payload.sourceItemId === 'string' &&
    payload.sourceItemId.length > 0 &&
    payload.sourceItemId.length <= 1024
    ? payload.sourceItemId
    : undefined;
}

function projectableConversationKind(value: string): boolean {
  return (
    value === 'user_message' ||
    value === 'assistant_message' ||
    value === 'reasoning' ||
    value === 'tool_call' ||
    value === 'command_execution' ||
    value === 'approval_request' ||
    value === 'user_input_request' ||
    value === 'plan' ||
    value === 'todo_list' ||
    value === 'file_change' ||
    value === 'context_compaction' ||
    value === 'unknown' ||
    value === 'warning' ||
    value === 'error'
  );
}

function projectableConversationStatus(value: string): boolean {
  return [
    'PENDING',
    'IN_PROGRESS',
    'COMPLETED',
    'FAILED',
    'DECLINED',
    'CANCELLED',
    'INTERRUPTED'
  ].includes(value);
}

function mergeConversationItemPayload(
  existing: unknown,
  next: ProjectedConversationItem
): Record<string, unknown> {
  const base = next.merge && isRecord(existing) ? existing : {};
  const value = { ...base, ...next.payload };
  if (next.append === 'sections') {
    const prior = Array.isArray(base.sections) ? base.sections : [];
    const incoming = Array.isArray(next.payload.sections) ? next.payload.sections : [];
    const sections = new Map<number, string>();
    for (const section of [...prior, ...incoming]) {
      if (
        !isRecord(section) ||
        typeof section.index !== 'number' ||
        !Number.isInteger(section.index) ||
        section.index < 0 ||
        typeof section.text !== 'string'
      )
        continue;
      sections.set(
        section.index,
        appendProjectionText(sections.get(section.index) ?? '', section.text)
      );
    }
    value.sections = [...sections]
      .sort(([left], [right]) => left - right)
      .map(([index, text]) => ({ index, text }));
  }
  if (next.append === 'outputPreview') {
    const prior = typeof base.outputPreview === 'string' ? base.outputPreview : '';
    const incoming =
      typeof next.payload.outputPreview === 'string' ? next.payload.outputPreview : '';
    value.outputPreview = appendProjectionText(prior, incoming);
  }
  if (next.append === 'outputSummary') {
    const prior = typeof base.outputSummary === 'string' ? base.outputSummary : '';
    const incoming =
      typeof next.payload.outputSummary === 'string' ? next.payload.outputSummary : '';
    value.outputSummary = appendProjectionText(prior, incoming);
  }
  return value;
}

function appendProjectionText(previous: string, next: string): string {
  const text = `${previous}${next}`;
  return text.length <= 10_000 ? text : `${text.slice(0, 9_999)}…`;
}

function activeConversationItem(status: string): boolean {
  return status === 'PENDING' || status === 'IN_PROGRESS';
}

function completedConversationItem(status: string): boolean {
  return !activeConversationItem(status);
}

function completedStatusForRun(status: AgentRunStatus): string {
  if (status === 'INTERRUPTED') return 'INTERRUPTED';
  if (status === 'CANCELLED') return 'CANCELLED';
  if (status === 'FAILED') return 'FAILED';
  return 'COMPLETED';
}
function executionStatusForRun(status: AgentRunStatus): NodeRunnerExecution['status'] {
  if (status === 'FAILED') return 'FAILED';
  if (status === 'INTERRUPTED' || status === 'CANCELLED') return 'INTERRUPTED';
  if (status === 'SUCCEEDED') return 'SUCCEEDED';
  if (status === 'RUNNING') return 'RUNNING';
  return 'STARTING';
}
function terminalExecution(status: NodeRunnerExecution['status']): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED' || status === 'INTERRUPTED';
}
function encodeCursor(scope: string, value: number): string {
  return Buffer.from(JSON.stringify({ scope, value })).toString('base64url');
}
function decodeCursor(cursor: string | undefined, scope: string): number {
  if (cursor === undefined) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      scope?: unknown;
      value?: unknown;
    };
    return value.scope === scope && Number.isInteger(value.value) && (value.value as number) >= 0
      ? (value.value as number)
      : 0;
  } catch {
    return 0;
  }
}
