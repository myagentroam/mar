import { randomUUID } from 'node:crypto';
import {
  MarAgentError,
  type SessionStore,
  type SessionRecord,
  type SessionRecordInput,
  type MarAgentSessionSummary
} from '../../src/index.js';

/** A limited text-only test backend, not a production memory Store. */
export function textSessionStore() {
  const sessions = new Map<string, MarAgentSessionSummary>();
  const records = new Map<string, SessionRecord[]>();
  const writers = new Map<string, object | undefined>();
  const worlds = new Map<string, unknown>();
  let closes = 0;
  const unsupported = async (): Promise<never> => {
    throw new Error('Unsupported text fixture operation');
  };
  const get = (id: string) => {
    const session = sessions.get(id);
    if (!session) throw new MarAgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
    return structuredClone(session);
  };
  const append = async (id: string, input: SessionRecordInput): Promise<SessionRecord> => {
    get(id);
    const list = records.get(id)!;
    const record: SessionRecord = {
      ...structuredClone(input),
      schemaVersion: 1,
      recordId: randomUUID(),
      sequence: list.length + 1,
      sessionId: id,
      timestamp: input.timestamp ?? new Date().toISOString()
    };
    list.push(record);
    return structuredClone(record);
  };
  const store: SessionStore = {
    createSession: async (input) => {
      const now = new Date().toISOString();
      const session = {
        id: randomUUID(),
        title: input.title ?? 'Text fixture',
        workspace: input.workspace,
        createdAt: now,
        lastActivityAt: now,
        source: input.source ?? { type: 'user' as const }
      };
      sessions.set(session.id, session);
      records.set(session.id, []);
      await append(session.id, {
        type: 'session.created',
        payload: { title: session.title, automaticTitle: false }
      });
      return structuredClone(session);
    },
    getSession: async (id) => ({ ...get(id), automaticTitlePending: false }),
    list: async () => ({
      sessions: [...sessions.values()].map((session) => structuredClone(session))
    }),
    listSubagentChildren: async () => [],
    executionConfiguration: async () => undefined,
    firstUserMessagePreview: async () => undefined,
    sessionTree: async (id) => {
      get(id);
      return [id];
    },
    updateTitle: async (id, title) => {
      get(id);
      sessions.get(id)!.title = title;
      return true;
    },
    append: async (id, input, options) => {
      options?.signal?.throwIfAborted();
      return append(id, input);
    },
    read: async (id) => {
      get(id);
      return structuredClone(records.get(id)!);
    },
    readPage: async (id) => ({ records: await store.read(id) }),
    readExecutionState: async (id) => ({
      automaticTitlePending: false,
      todo: { revision: 0, items: [] },
      contextRecords: await store.read(id)
    }),
    userTurnCount: async (id) =>
      (await store.read(id)).filter((record) => record.type === 'turn.user').length,
    readContextualWorldState: async (id) => structuredClone(worlds.get(id)),
    writeContextualWorldState: async (id, value) => {
      worlds.set(id, structuredClone(value));
    },
    readCodeModeState: async () => [],
    commitCodeModeState: unsupported,
    readExtensionCheckpoint: unsupported,
    writeExtensionCheckpoint: unsupported,
    compact: unsupported,
    commitContextGc: unsupported,
    persistInputImages: unsupported,
    readInputImages: async () => [],
    readInputImage: unsupported,
    writeToolResultResource: unsupported,
    readToolResultResource: unsupported,
    acquireSessionLease: async (id, owner) => {
      get(id);
      if (writers.has(id))
        throw new MarAgentError('MAR_AGENT_SESSION_LOCKED', 'Session already has a writer.');
      writers.set(id, owner);
      let released = false;
      return async () => {
        if (!released) {
          released = true;
          writers.delete(id);
        }
      };
    },
    acquireSessionWriteLease: unsupported,
    retainSessionLease: unsupported,
    hasRetainedSessionLease: () => false,
    forkSession: unsupported,
    rollbackSession: unsupported,
    clearSession: unsupported,
    delete: unsupported,
    close: async () => {
      closes++;
    }
  };
  return { store, writers, sessions, records, closeCount: () => closes };
}
