import { AgentError } from '../error.js';
import type { AgentEvent } from '../runtime/events.js';
import { publicHostedToolEvents } from '../runtime/event-projection.js';
import type { SessionStore } from './store/contracts.js';
import type { SessionListInput, SessionSource } from './types.js';
import type { AgentSessionRollbackInput } from './rollback.js';
import { appliedInputRecord } from './deferred-input.js';

const MAX_INPUT_IMAGE_BYTES = 5 * 1024 * 1024;
const INPUT_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

import type { AgentSessionSummary, AgentSessionPage } from './summary.js';
export type { AgentSessionSummary, AgentSessionPage } from './summary.js';

import type { AgentSessionHistoryImageMetadata, AgentUserHistoryEntry } from './user-history.js';
export type { AgentSessionHistoryImageMetadata } from './user-history.js';
export type AgentSessionHistoryEntry =
  AgentUserHistoryEntry | { kind: 'event'; sequence: number; event: AgentEvent };

export interface AgentSessionHistoryPage {
  entries: AgentSessionHistoryEntry[];
  nextCursor?: string;
}

export interface AgentSessionInputReceipt {
  readonly clientMessageId: string;
  readonly executionId: string;
  readonly turnId: string;
  readonly status: 'accepted' | 'applied';
  readonly appliedExecutionId?: string;
  readonly appliedTurnId?: string;
}

export interface AgentSessionContextUsage {
  inputTokens: number;
}

export interface AgentSessionDeleteResult {
  readonly deleted: boolean;
}

export interface AgentSessionImage {
  name: string;
  mimeType: string;
  byteSize: number;
  dataBase64: string;
}

/** Public session catalog facade. Storage details remain SDK-private. */
export interface AgentSessionCatalog {
  list(input?: SessionListInput): Promise<AgentSessionPage>;
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
  ): Promise<AgentSessionHistoryPage>;
  /** Read the specified receipt, or the latest receipt associated with the fixed Execution. */
  inputReceipt(
    sessionId: string,
    input: {
      clientMessageId?: string;
      executionId: string;
      signal?: AbortSignal;
      source?: { sessionId: string; extensionId: string; actors?: readonly string[] };
    }
  ): Promise<AgentSessionInputReceipt | undefined>;
  readImage(
    sessionId: string,
    input: { readonly sequence: number; readonly imageIndex: number }
  ): Promise<AgentSessionImage | undefined>;
  readResource(
    sessionId: string,
    resourceId: string
  ): Promise<{ mimeType: string; dataBase64: string } | undefined>;
  contextUsage(sessionId: string): Promise<AgentSessionContextUsage | undefined>;
  readToolResultResource(
    sessionId: string,
    input: import('./tool-result-resources.js').ToolResultResourceInput
  ): Promise<import('./tool-result-resources.js').ToolResultResourcePage>;
  fork(
    sessionId: string,
    input: { readonly boundaryTurnId: string | null; readonly title: string }
  ): Promise<AgentSessionSummary>;
  rollback(sessionId: string, input: AgentSessionRollbackInput): Promise<AgentSessionSummary>;
  clear(sessionId: string): Promise<AgentSessionSummary>;
  delete(sessionId: string): Promise<AgentSessionDeleteResult>;
  /** Delete exactly these members after their owners have released their resources. */
  deleteMembers(sessionIds: readonly string[]): Promise<AgentSessionDeleteResult>;
  close(): Promise<void>;
}

export type OpenAgentSessionCatalogInput =
  | { homeDirectory: string; sessionStore?: never }
  | { sessionStore: SessionStore; homeDirectory?: never };

export function createSessionCatalog(
  store: Pick<
    SessionStore,
    | 'list'
    | 'firstUserMessagePreview'
    | 'executionConfiguration'
    | 'readPage'
    | 'readInputImage'
    | 'readResource'
    | 'readToolResultResource'
    | 'forkSession'
    | 'rollbackSession'
    | 'clearSession'
    | 'delete'
    | 'acquireSessionMaintenance'
    | 'close'
  >,
  borrowed: boolean
): AgentSessionCatalog {
  let closure: Promise<void> | undefined;
  const assertOpen = () => {
    if (closure) throw new AgentError('MAR_AGENT_DISPOSED', 'Session catalog is closed.');
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
    inputReceipt: async (sessionId, input) => {
      assertOpen();
      if (
        (input.clientMessageId !== undefined && !input.clientMessageId.trim()) ||
        !input.executionId.trim()
      )
        throw new AgentError(
          'MAR_AGENT_SESSION_INPUT_INVALID',
          'Input receipt identity is invalid.'
        );
      const applied = new Map<string, { executionId?: string; turnId?: string }>();
      let beforeSequence: number | undefined;
      do {
        input.signal?.throwIfAborted();
        const page = await store.readPage(sessionId, {
          limit: 1000,
          ...(beforeSequence === undefined ? {} : { beforeSequence })
        });
        input.signal?.throwIfAborted();
        for (const record of [...page.records].reverse()) {
          if (!isRecord(record.payload)) continue;
          if (
            record.type === 'input.applied' &&
            typeof record.payload.inputRef === 'string' &&
            !applied.has(record.payload.inputRef)
          )
            applied.set(record.payload.inputRef, {
              ...(record.executionId === undefined ? {} : { executionId: record.executionId }),
              ...(record.turnId === undefined ? {} : { turnId: record.turnId })
            });
          if (
            record.type === 'model.context' &&
            isRecord(record.payload.input) &&
            (input.clientMessageId === undefined ||
              record.payload.input.clientMessageId === input.clientMessageId)
          ) {
            const projected = appliedInputRecord(record);
            if (projected && !applied.has(projected.recordId))
              applied.set(projected.recordId, {
                ...(record.executionId === undefined ? {} : { executionId: record.executionId }),
                ...(record.turnId === undefined ? {} : { turnId: record.turnId })
              });
          }
          if (
            record.type !== 'turn.user' ||
            !record.executionId ||
            !record.turnId ||
            typeof record.payload.clientMessageId !== 'string' ||
            !record.payload.clientMessageId ||
            (input.clientMessageId !== undefined &&
              record.payload.clientMessageId !== input.clientMessageId)
          )
            continue;
          if (input.source) {
            const source = record.payload.source;
            if (
              !isRecord(source) ||
              source.sessionId !== input.source.sessionId ||
              source.extensionId !== input.source.extensionId ||
              (input.source.actors && !input.source.actors.includes(String(source.actor)))
            )
              continue;
          }
          const application = applied.get(record.recordId);
          if (
            input.clientMessageId === undefined
              ? record.executionId !== input.executionId &&
                application?.executionId !== input.executionId
              : record.executionId !== input.executionId
          )
            continue;
          return {
            clientMessageId: record.payload.clientMessageId,
            executionId: record.executionId,
            turnId: record.turnId,
            status: application ? ('applied' as const) : ('accepted' as const),
            ...{
              ...(application?.executionId === undefined
                ? {}
                : { appliedExecutionId: application.executionId }),
              ...(application?.turnId === undefined ? {} : { appliedTurnId: application.turnId })
            }
          };
        }
        beforeSequence = page.previousBeforeSequence;
      } while (beforeSequence !== undefined);
      return undefined;
    },
    history: async (sessionId, options = {}) => {
      assertOpen();
      const beforeSequence = parseCursor(options.cursor);
      const page = await store.readPage(sessionId, {
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(beforeSequence === undefined ? {} : { beforeSequence })
      });
      const entries = page.records.flatMap((record): AgentSessionHistoryEntry[] => {
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
        if (isAgentEvent(record.payload) && record.payload.type === 'hosted_tool.updated') {
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
        if (isAgentEvent(record.payload)) {
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
    readResource: async (sessionId, resourceId) => {
      assertOpen();
      return store.readResource(sessionId, resourceId);
    },
    readToolResultResource: async (sessionId, input) => {
      assertOpen();
      return store.readToolResultResource(sessionId, input);
    },
    contextUsage: async (sessionId) => {
      assertOpen();
      const page = await store.readPage(sessionId, { limit: 1000 });
      for (const record of page.records.toReversed()) {
        if (!isAgentEvent(record.payload)) continue;
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
    deleteMembers: async (sessionIds) => {
      assertOpen();
      const ids = [...sessionIds];
      if (
        ids.length === 0 ||
        ids.some((id) => typeof id !== 'string' || id.length === 0) ||
        new Set(ids).size !== ids.length
      )
        throw new AgentError('MAR_AGENT_SESSION_INVALID', 'Invalid Session maintenance members.');
      ids.sort();
      const maintenance = await store.acquireSessionMaintenance(ids[0]!, 'delete', undefined, ids);
      let failed = false;
      try {
        return await store.delete(ids[0]!, maintenance);
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        try {
          await maintenance.release();
        } catch (error) {
          if (!failed) throw error;
        }
      }
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
    throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Session history cursor is invalid.');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function imageMetadata(value: unknown): AgentSessionHistoryImageMetadata[] {
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
              image.resourceInputVersion === 1 &&
              typeof image.resourceId === 'string' &&
              /^[a-f0-9]{64}$/u.test(image.resourceId) &&
              typeof image.sha256 === 'string' &&
              /^[a-f0-9]{64}$/u.test(image.sha256)
          }
        ]
      : []
  );
}

function isAgentEvent(value: unknown): value is AgentEvent {
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
