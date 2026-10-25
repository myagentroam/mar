import type { AgentRunStatus, NodeCapabilities, NodeEnvelope } from '@myagentroam/protocol';
import {
  nodeCapabilitiesSchema,
  serializeComposerTag,
  parseComposerTags,
  composerVisibleText,
  type ComposerAttachmentFile
} from '@myagentroam/protocol';
import type {
  NodeAgentRun,
  NodeConversationTurn,
  NodeMessageAttachmentInput
} from '../runtime-model.js';

const MAX_COMPOSER_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_COMPOSER_ATTACHMENTS_BYTES = 10 * 1024 * 1024;
const USER_AUTHORIZATION_CLOCK_SKEW_MS = 60 * 60 * 1_000;

export type RunnerImageAttachment = NodeMessageAttachmentInput & {
  readonly mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
};

const COMPOSER_IMAGE_MIME_TYPES = new Set<RunnerImageAttachment['mime']>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp'
]);

export const DEFAULT_SESSION_PAGE_SIZE = 10;
export const MAX_SESSION_PAGE_SIZE = 100;

export function sessionPage<
  T extends {
    readonly id: string;
    readonly lastActivityAt: number;
    readonly pinOrder?: number | null;
    readonly externalDiscovered?: boolean;
  }
>(
  sessions: readonly T[],
  input: Record<string, unknown>
): { readonly sessions: readonly T[]; readonly nextCursor: string | null } {
  const limit =
    typeof input.limit === 'number' &&
    Number.isInteger(input.limit) &&
    input.limit >= 1 &&
    input.limit <= MAX_SESSION_PAGE_SIZE
      ? input.limit
      : DEFAULT_SESSION_PAGE_SIZE;
  const cursor = typeof input.cursor === 'string' ? input.cursor : undefined;
  const ordered = [...sessions].sort(compareSessionPageEntries);
  const cursorEntry = cursor === undefined ? undefined : parseSessionPageCursor(cursor);
  const afterCursor =
    cursor === undefined
      ? ordered
      : cursorEntry === undefined
        ? []
        : ordered.filter((session) => compareSessionPageEntries(session, cursorEntry) > 0);
  const pinned = ordered.filter(
    (session) => session.pinOrder !== null && session.pinOrder !== undefined
  );
  const pinnedIndexes = new Map(pinned.map((session, index) => [session.id, index]));
  const page = afterCursor.slice(0, limit).map((session) => {
    const pinIndex = pinnedIndexes.get(session.id);
    if (pinIndex === undefined) return session;
    return {
      ...session,
      canMovePinUp: pinIndex > 0,
      canMovePinDown: pinIndex < pinned.length - 1
    };
  });
  const last = page.at(-1);
  return {
    sessions: page,
    nextCursor:
      last !== undefined && afterCursor.length > page.length ? createSessionPageCursor(last) : null
  };
}

export function parseSessionPageCursor(cursor: string):
  | {
      readonly id: string;
      readonly lastActivityAt: number;
      readonly pinOrder: number | null;
      readonly externalDiscovered: boolean;
    }
  | undefined {
  try {
    const value = JSON.parse(decodeURIComponent(cursor)) as unknown;
    if (!Array.isArray(value) || value.length !== 3) return undefined;
    const [pinOrder, lastActivityAt, id] = value;
    if (
      (pinOrder !== null && (typeof pinOrder !== 'number' || !Number.isFinite(pinOrder))) ||
      (lastActivityAt !== null &&
        (typeof lastActivityAt !== 'number' || !Number.isFinite(lastActivityAt))) ||
      typeof id !== 'string'
    )
      return undefined;
    return {
      id,
      lastActivityAt: lastActivityAt ?? 0,
      pinOrder,
      externalDiscovered: lastActivityAt !== null
    };
  } catch {
    return undefined;
  }
}

export function createSessionPageCursor(session: {
  readonly id: string;
  readonly lastActivityAt: number;
  readonly pinOrder?: number | null;
  readonly externalDiscovered?: boolean;
}): string {
  return encodeURIComponent(
    JSON.stringify([
      session.pinOrder ?? null,
      session.externalDiscovered === false ? null : session.lastActivityAt,
      session.id
    ])
  );
}

export function compareSessionPageEntries(
  left: {
    readonly id: string;
    readonly lastActivityAt: number;
    readonly pinOrder?: number | null;
    readonly externalDiscovered?: boolean;
  },
  right: {
    readonly id: string;
    readonly lastActivityAt: number;
    readonly pinOrder?: number | null;
    readonly externalDiscovered?: boolean;
  }
): number {
  const leftPinned = left.pinOrder !== null && left.pinOrder !== undefined;
  const rightPinned = right.pinOrder !== null && right.pinOrder !== undefined;
  if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
  if (leftPinned && rightPinned)
    return (
      (left.pinOrder as number) - (right.pinOrder as number) || left.id.localeCompare(right.id)
    );
  const leftFound = left.externalDiscovered !== false;
  const rightFound = right.externalDiscovered !== false;
  if (leftFound !== rightFound) return leftFound ? -1 : 1;
  return right.lastActivityAt - left.lastActivityAt || left.id.localeCompare(right.id, 'en');
}

export function compactRunnerText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

export function compactRunnerValue(
  value: unknown,
  limit: number
): {
  readonly text: string;
  readonly truncated: boolean;
} {
  if (value === undefined || value === null) return { text: '', truncated: false };
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      return { text: '(Unable to display)', truncated: false };
    }
  }
  return { text: compactRunnerText(text, limit), truncated: text.length > limit };
}

export function nativePageEnd(
  cursor: string | undefined,
  sessionId: string,
  fallback: number
): number {
  if (cursor === undefined) return fallback;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      sessionId?: unknown;
      end?: unknown;
    };
    return value.sessionId === sessionId &&
      Number.isInteger(value.end) &&
      (value.end as number) >= 0
      ? Math.min(value.end as number, fallback)
      : fallback;
  } catch {
    return fallback;
  }
}

export function boundedConversationItemId(prefix: string, value: string): string {
  const candidate = `${prefix}:${value}`;
  if (candidate.length <= 88) return candidate;
  return `${prefix}:${Buffer.from(value)
    .toString('base64url')
    .slice(0, 88 - prefix.length - 1)}`;
}

export function validUserAuthorization(
  value: unknown,
  envelope: NodeEnvelope,
  operation: string,
  nodeId: string | undefined,
  now = Date.now()
): boolean {
  if (typeof value !== 'object' || value === null || nodeId === undefined) return false;
  const authorization = value as Record<string, unknown>;
  const modelResourceCapability =
    operation === 'model.resource.read' &&
    authorization.userId === 0 &&
    authorization.sessionHash === 'model-resource';
  return (
    (modelResourceCapability ||
      (typeof authorization.userId === 'number' &&
        Number.isSafeInteger(authorization.userId) &&
        authorization.userId > 0 &&
        typeof authorization.sessionHash === 'string' &&
        /^[A-Za-z0-9_-]{43}$/.test(authorization.sessionHash))) &&
    authorization.nodeId === nodeId &&
    authorization.operation === operation &&
    authorization.requestId === envelope.id &&
    typeof authorization.issuedAt === 'number' &&
    typeof authorization.expiresAt === 'number' &&
    Number.isSafeInteger(authorization.issuedAt) &&
    Number.isSafeInteger(authorization.expiresAt) &&
    authorization.expiresAt >= authorization.issuedAt &&
    authorization.issuedAt <= now + USER_AUTHORIZATION_CLOCK_SKEW_MS &&
    authorization.expiresAt >= now - USER_AUTHORIZATION_CLOCK_SKEW_MS &&
    authorization.expiresAt - authorization.issuedAt <= 15_000
  );
}

export function isTerminalRunStatus(status: AgentRunStatus): boolean {
  return (
    status === 'SUCCEEDED' ||
    status === 'FAILED' ||
    status === 'CANCELLED' ||
    status === 'INTERRUPTED'
  );
}

export function validSessionOption(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' && value.trim().length > 0 && value.length <= 120)
  );
}

export function validSessionEffort(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= 120);
}

export function validSessionTitle(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' && value.trim().length > 0 && value.length <= 160)
  );
}

export function sessionTitleFromFirstMessage(content: string): string {
  return composerVisibleText(content).replace(/\s+/g, ' ').slice(0, 160);
}

export function parseComposerAttachmentUpload(
  input: Record<string, unknown>
): { readonly id: string; readonly name: string; readonly mime: string } | undefined {
  if (input.composerAttachmentId === undefined && input.mime === undefined) return undefined;
  if (
    typeof input.composerAttachmentId !== 'string' ||
    !isUuid(input.composerAttachmentId) ||
    typeof input.name !== 'string' ||
    !validComposerAttachmentName(input.name) ||
    typeof input.mime !== 'string' ||
    input.mime.length === 0 ||
    input.mime.length > 120
  )
    throw new Error('COMPOSER_ATTACHMENT_INVALID');
  return { id: input.composerAttachmentId, name: input.name, mime: input.mime };
}

export function parseComposerAttachmentIds(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 5 || value.some((id) => typeof id !== 'string'))
    throw new Error('MESSAGE_ATTACHMENTS_INVALID');
  const ids = value as string[];
  if (ids.some((id) => !isUuid(id)) || new Set(ids).size !== ids.length)
    throw new Error('MESSAGE_ATTACHMENTS_INVALID');
  return ids;
}

export function validComposerAttachmentName(name: string): boolean {
  return (
    name.trim().length > 0 &&
    name.length <= 255 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !Array.from(name).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 || '<>:"|?*'.includes(character);
    })
  );
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function parseMessageAttachments(value: unknown): readonly NodeMessageAttachmentInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 5) throw new Error('MESSAGE_ATTACHMENTS_INVALID');
  let totalBytes = 0;
  return value.map((attachment): NodeMessageAttachmentInput => {
    if (!isPlainRecord(attachment)) throw new Error('MESSAGE_ATTACHMENTS_INVALID');
    if (
      typeof attachment.name !== 'string' ||
      typeof attachment.mime !== 'string' ||
      typeof attachment.dataBase64 !== 'string'
    )
      throw new Error('MESSAGE_ATTACHMENTS_INVALID');
    if (
      !validComposerAttachmentName(attachment.name) ||
      attachment.mime.length === 0 ||
      attachment.mime.length > 120 ||
      !isCanonicalBase64(attachment.dataBase64)
    )
      throw new Error('MESSAGE_ATTACHMENTS_INVALID');
    const byteSize = Buffer.byteLength(attachment.dataBase64, 'base64');
    if (byteSize === 0 || byteSize > MAX_COMPOSER_ATTACHMENT_BYTES)
      throw new Error('MESSAGE_ATTACHMENTS_INVALID');
    totalBytes += byteSize;
    if (totalBytes > MAX_COMPOSER_ATTACHMENTS_BYTES) throw new Error('MESSAGE_ATTACHMENTS_INVALID');
    return { name: attachment.name, mime: attachment.mime, dataBase64: attachment.dataBase64 };
  });
}

export function parseRunnerImageAttachments(value: unknown): readonly RunnerImageAttachment[] {
  return parseMessageAttachments(value).map((attachment) => {
    if (!isRunnerImageAttachment(attachment)) throw new Error('MESSAGE_ATTACHMENT_UNSUPPORTED');
    return attachment as RunnerImageAttachment;
  });
}

export function isRunnerImageAttachment(
  attachment: NodeMessageAttachmentInput
): attachment is RunnerImageAttachment {
  return COMPOSER_IMAGE_MIME_TYPES.has(attachment.mime as RunnerImageAttachment['mime']);
}

export function isImageAttachment(attachment: NodeMessageAttachmentInput): boolean {
  return attachment.mime.startsWith('image/');
}

export function withNonImageAttachmentPrompt(
  input: string,
  paths: readonly string[],
  files?: readonly ComposerAttachmentFile[]
): string {
  if (paths.length === 0) return input;
  const tag = serializeComposerTag('mar_attachments', {
    files: files
      ? [...files]
      : paths.map((path) => ({
          name: path.split(/[\\/]/u).at(-1)!,
          mime: 'application/octet-stream',
          path
        }))
  });
  const body = parseComposerTags(input)
    .filter((part) => part.kind !== 'mar_attachments')
    .map((part) => (part.kind === 'text' ? part.text : part.raw))
    .join('')
    .trimEnd();
  return `${body}\n${tag}`;
}

export function isCanonicalBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

export function validatedCapabilities(value: unknown): NodeCapabilities {
  return nodeCapabilitiesSchema.parse(value);
}

export function nodeConnectEndpoint(serverUrl: string): string {
  const endpoint = new URL(serverUrl);
  if (endpoint.protocol === 'http:') endpoint.protocol = 'ws:';
  if (endpoint.protocol === 'https:') endpoint.protocol = 'wss:';
  if (endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:') {
    throw new Error('SERVER_URL_INVALID');
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/api/node/connect`;
  endpoint.search = '';
  endpoint.hash = '';
  return endpoint.toString();
}

export function nodeTerminalConnectEndpoint(serverUrl: string): string {
  const endpoint = new URL(serverUrl);
  if (endpoint.protocol === 'http:') endpoint.protocol = 'ws:';
  if (endpoint.protocol === 'https:') endpoint.protocol = 'wss:';
  if (endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:') {
    throw new Error('SERVER_URL_INVALID');
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/api/node/terminal-connect`;
  endpoint.search = '';
  endpoint.hash = '';
  return endpoint.toString();
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNodeAgentRun(value: unknown): value is NodeAgentRun {
  return (
    isPlainRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.status === 'string'
  );
}

export function isNodeConversationTurn(value: unknown): value is NodeConversationTurn {
  return (
    isPlainRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.sessionId === 'string' &&
    Array.isArray(value.items)
  );
}
