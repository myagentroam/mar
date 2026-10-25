import { MarAgentError } from '../error.js';
import type { MarAgentImageMetadata } from '../runtime/contracts.js';
import type { MarAgentEvent } from '../runtime/events.js';
import { publicHostedToolEvents } from '../runtime/event-projection.js';
import { JsonlSessionStore } from './store/jsonl-store.js';
import type { SessionStore } from './store/contracts.js';
import type { SessionListInput, SessionSource } from './types.js';

const MAX_INPUT_IMAGE_BYTES = 5 * 1024 * 1024;
const INPUT_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export interface MarAgentSessionSummary {
  id: string;
  title: string;
  /** First non-empty user input, whitespace-normalized and bounded to 160 characters. */
  firstUserMessagePreview?: string;
  workspace: string;
  createdAt: string;
  lastActivityAt: string;
  source: SessionSource;
  modelId?: string;
  modelName?: string;
  reasoningEffort?: string;
}

export interface MarAgentSessionPage {
  sessions: MarAgentSessionSummary[];
  nextCursor?: string;
}

export interface MarAgentHistoryImageMetadata extends MarAgentImageMetadata {
  readable: boolean;
}

export type MarAgentHistoryEntry =
  | {
      kind: 'user';
      recordId?: string;
      sequence: number;
      timestamp: string;
      sessionId: string;
      executionId: string;
      turnId: string;
      text: string;
      clientMessageId?: string;
      inputSource?: 'user' | 'parent_agent';
      images?: readonly MarAgentHistoryImageMetadata[];
    }
  | { kind: 'event'; sequence: number; event: MarAgentEvent };

export interface MarAgentHistoryPage {
  entries: MarAgentHistoryEntry[];
  nextCursor?: string;
}

export interface MarAgentContextUsage {
  inputTokens: number;
}

export interface MarAgentSessionDeleteResult {
  readonly deleted: boolean;
}

export interface MarAgentSessionImage {
  name: string;
  mimeType: string;
  byteSize: number;
  dataBase64: string;
}

/** Public session catalog facade. Storage details remain SDK-private. */
export interface MarAgentSessionCatalog {
  list(input?: SessionListInput): Promise<MarAgentSessionPage>;
  firstUserMessagePreview(sessionId: string): Promise<string | undefined>;
  executionConfiguration(
    sessionId: string
  ): Promise<
    | { readonly modelId: string; readonly modelName?: string; readonly reasoningEffort?: string }
    | undefined
  >;
  history(
    sessionId: string,
    input?: { limit?: number; cursor?: string }
  ): Promise<MarAgentHistoryPage>;
  readImage(
    sessionId: string,
    input: { readonly sequence: number; readonly imageIndex: number }
  ): Promise<MarAgentSessionImage | undefined>;
  readImageResource(
    sessionId: string,
    resourceId: string
  ): Promise<{ mimeType: string; dataBase64: string } | undefined>;
  contextUsage(sessionId: string): Promise<MarAgentContextUsage | undefined>;
  readToolResultResource(
    sessionId: string,
    input: import('./tool-result-resources.js').ToolResultResourceInput
  ): Promise<import('./tool-result-resources.js').ToolResultResourcePage>;
  fork(
    sessionId: string,
    input: { readonly boundaryTurnId: string | null; readonly title: string }
  ): Promise<MarAgentSessionSummary>;
  rollback(
    sessionId: string,
    input: { readonly boundaryTurnId: string | null }
  ): Promise<MarAgentSessionSummary>;
  clear(sessionId: string): Promise<MarAgentSessionSummary>;
  delete(sessionId: string): Promise<MarAgentSessionDeleteResult>;
  close(): Promise<void>;
}

export type OpenMarAgentSessionCatalogInput =
  | { homeDirectory: string; sessionStore?: never }
  | { sessionStore: SessionStore; homeDirectory?: never };

export async function openMarAgentSessionCatalog(
  input: OpenMarAgentSessionCatalogInput
): Promise<MarAgentSessionCatalog> {
  const borrowed = input.sessionStore !== undefined;
  if (
    input.sessionStore === null ||
    borrowed === (input.homeDirectory !== undefined) ||
    (!borrowed && (typeof input.homeDirectory !== 'string' || !input.homeDirectory))
  )
    throw new MarAgentError(
      'MAR_AGENT_SESSION_STORE_INVALID',
      'Specify exactly one Session store or home directory.'
    );
  const store: SessionStore =
    input.sessionStore ?? (await JsonlSessionStore.open(input.homeDirectory!));
  let closure: Promise<void> | undefined;
  const assertOpen = () => {
    if (closure) throw new MarAgentError('MAR_AGENT_DISPOSED', 'Session catalog is closed.');
  };
  return {
    list: async (options) => {
      assertOpen();
      return store.list(options);
    },
    firstUserMessagePreview: async (sessionId) => {
      assertOpen();
      return store.firstUserMessagePreview(sessionId);
    },
    executionConfiguration: async (sessionId) => {
      assertOpen();
      return store.executionConfiguration(sessionId);
    },
    history: async (sessionId, options = {}) => {
      assertOpen();
      const beforeSequence = parseCursor(options.cursor);
      const page = await store.readPage(sessionId, {
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(beforeSequence === undefined ? {} : { beforeSequence })
      });
      const entries = page.records.flatMap((record): MarAgentHistoryEntry[] => {
        if (
          record.type === 'turn.user' &&
          record.executionId !== undefined &&
          record.turnId !== undefined &&
          isRecord(record.payload) &&
          typeof record.payload.prompt === 'string'
        ) {
          const images = imageMetadata(record.payload.images);
          return [
            {
              kind: 'user',
              ...(record.payload.deferred === true ? { recordId: record.recordId } : {}),
              sequence: record.sequence,
              timestamp: record.timestamp,
              sessionId: record.sessionId,
              executionId: record.executionId,
              turnId: record.turnId,
              text: record.payload.prompt,
              ...(typeof record.payload.clientMessageId === 'string'
                ? { clientMessageId: record.payload.clientMessageId }
                : {}),
              ...(record.payload.inputSource === 'parent_agent'
                ? { inputSource: 'parent_agent' as const }
                : {}),
              ...(images.length > 0 ? { images } : {})
            }
          ];
        }
        if (isMarAgentEvent(record.payload) && record.payload.type === 'hosted_tool.updated') {
          const legacy = record.payload;
          return publicHostedToolEvents({ ...legacy, type: 'hosted_tool' }).map((event) => ({
            kind: 'event',
            sequence: record.sequence,
            event: {
              sequence: legacy.sequence,
              timestamp: legacy.timestamp,
              sessionId: legacy.sessionId,
              executionId: legacy.executionId,
              ...(legacy.turnId === undefined ? {} : { turnId: legacy.turnId }),
              ...event,
              eventId: `${legacy.eventId}:${event.type}`
            }
          }));
        }
        if (isMarAgentEvent(record.payload)) {
          const event = record.payload;
          return [{ kind: 'event', sequence: record.sequence, event }];
        }
        return [];
      });
      return {
        entries,
        ...(page.previousBeforeSequence === undefined
          ? {}
          : { nextCursor: String(page.previousBeforeSequence) })
      };
    },
    readImage: async (sessionId, input) => {
      assertOpen();
      const image = await store.readInputImage(sessionId, input);
      return image === undefined
        ? undefined
        : {
            name: image.name,
            mimeType: image.mimeType,
            byteSize: image.byteSize,
            dataBase64: image.dataBase64
          };
    },
    readImageResource: async (sessionId, resourceId) => {
      assertOpen();
      return store.readImageResource(sessionId, resourceId);
    },
    readToolResultResource: async (sessionId, input) => {
      assertOpen();
      return store.readToolResultResource(sessionId, input);
    },
    contextUsage: async (sessionId) => {
      assertOpen();
      const page = await store.readPage(sessionId, { limit: 1000 });
      for (const record of page.records.toReversed()) {
        if (!isMarAgentEvent(record.payload)) continue;
        if (record.payload.type === 'context.compacted')
          return record.payload.retainedContext === true ? undefined : { inputTokens: 0 };
        if (record.payload.type === 'usage.updated' && record.payload.purpose !== 'compact') {
          const inputTokens = record.payload.contextInputTokens ?? record.payload.inputTokens;
          if (
            typeof inputTokens === 'number' &&
            Number.isSafeInteger(inputTokens) &&
            inputTokens >= 0
          )
            return { inputTokens };
        }
      }
      return undefined;
    },
    fork: async (sessionId, options) => {
      assertOpen();
      const session = await store.forkSession(sessionId, options);
      return { ...session, source: session.source ?? { type: 'user' } };
    },
    rollback: async (sessionId, options) => {
      assertOpen();
      return store.rollbackSession(sessionId, options);
    },
    clear: async (sessionId) => {
      assertOpen();
      return store.clearSession(sessionId);
    },
    delete: async (sessionId) => {
      assertOpen();
      return store.delete(sessionId);
    },
    close: () => {
      closure ??= Promise.resolve().then(() => (borrowed ? undefined : store.close()));
      return closure;
    }
  };
}

function parseCursor(cursor: string | undefined): number | undefined {
  if (cursor === undefined) return undefined;
  const value = Number(cursor);
  if (!/^[1-9]\d*$/u.test(cursor) || !Number.isSafeInteger(value))
    throw new MarAgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Session history cursor is invalid.');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function imageMetadata(value: unknown): MarAgentHistoryImageMetadata[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((image) =>
    isRecord(image) &&
    typeof image.name === 'string' &&
    typeof image.mimeType === 'string' &&
    typeof image.byteSize === 'number' &&
    Number.isSafeInteger(image.byteSize) &&
    image.byteSize >= 0
      ? [
          {
            name: image.name,
            mimeType: image.mimeType,
            byteSize: image.byteSize,
            readable:
              INPUT_IMAGE_MIME_TYPES.has(image.mimeType) &&
              image.byteSize > 0 &&
              image.byteSize <= MAX_INPUT_IMAGE_BYTES &&
              typeof image.fileName === 'string' &&
              /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.bin$/u.test(image.fileName) &&
              typeof image.sha256 === 'string' &&
              /^[a-f0-9]{64}$/u.test(image.sha256)
          }
        ]
      : []
  );
}

function isMarAgentEvent(value: unknown): value is MarAgentEvent {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    value.type !== 'reasoning.summary' &&
    typeof value.eventId === 'string' &&
    typeof value.sequence === 'number' &&
    typeof value.timestamp === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.executionId === 'string'
  );
}
