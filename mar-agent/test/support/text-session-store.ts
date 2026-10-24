import { randomUUID } from 'node:crypto';
import {
  MarAgentError,
  type SessionStore,
  type SessionStoreMaintenance,
  type SessionRecord,
  type SessionRecordInput,
  type MarAgentSessionSummary
} from '../../src/index.js';

/** A limited text-only test backend, not a production memory Store. */
export function textSessionStore() {
  const sessions = new Map<string, MarAgentSessionSummary>();
  const records = new Map<string, SessionRecord[]>();
  const writers = new Map<string, object | undefined>();
  const executing = new Set<string>();
  const retained = new Map<string, number>();
  const maintenance = new Map<string, SessionStoreMaintenance>();
  const holdings = new WeakMap<SessionStoreMaintenance, { id: string; kind: 'clear' | 'delete' }>();
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
  const locked = () =>
    new MarAgentError('MAR_AGENT_SESSION_LOCKED', 'Session already has a writer.');
  const releaseUnused = (id: string) => {
    if (!executing.has(id) && !retained.get(id) && !maintenance.has(id)) writers.delete(id);
  };
  const tree = (id: string) => {
    get(id);
    const ids = [id];
    for (const parent of ids)
      for (const session of sessions.values())
        if (
          session.source?.type === 'subagent' &&
          session.source.parentSessionId === parent &&
          !ids.includes(session.id)
        )
          ids.push(session.id);
    return ids;
  };
  const assertMaintenance = (
    id: string,
    kind: 'clear' | 'delete',
    holding: SessionStoreMaintenance
  ) => {
    const current = holdings.get(holding);
    if (current?.id !== id || current.kind !== kind) throw locked();
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
      if (input.source?.type === 'subagent') {
        const parentId = input.source.parentSessionId;
        if (maintenance.has(parentId))
          throw new MarAgentError('MAR_AGENT_SESSION_LOCKED', 'Session is under maintenance.');
        get(parentId);
      }
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
    sessionTree: async (id) => tree(id),
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
      if (
        maintenance.has(id) ||
        executing.has(id) ||
        (writers.has(id) && (owner === undefined || writers.get(id) !== owner))
      )
        throw locked();
      writers.set(id, owner);
      executing.add(id);
      let released = false;
      return async () => {
        if (!released) {
          released = true;
          executing.delete(id);
          releaseUnused(id);
        }
      };
    },
    acquireSessionWriteLease: async (id, owner) => {
      get(id);
      if (maintenance.has(id) || (writers.has(id) && writers.get(id) !== owner)) throw locked();
      writers.set(id, owner);
      retained.set(id, (retained.get(id) ?? 0) + 1);
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        retained.set(id, retained.get(id)! - 1);
        releaseUnused(id);
      };
    },
    retainSessionLease: async (id, owner) => {
      if (!executing.has(id) || writers.get(id) !== owner) throw locked();
      return store.acquireSessionWriteLease(id, owner);
    },
    hasRetainedSessionLease: (id, owner) =>
      writers.get(id) === owner && (retained.get(id) ?? 0) > 0,
    acquireSessionMaintenance: async (id, kind, owner) => {
      const ids = kind === 'delete' ? tree(id) : [get(id).id];
      for (const member of ids)
        if (
          maintenance.has(member) ||
          (writers.has(member) &&
            (owner === undefined ||
              writers.get(member) !== owner ||
              (kind === 'clear' && executing.has(member))))
        )
          throw locked();
      const holding: SessionStoreMaintenance = Object.freeze({
        sessionIds: Object.freeze(ids),
        release: async () => {
          if (!holdings.delete(holding)) return;
          for (const member of ids.toReversed()) {
            maintenance.delete(member);
            releaseUnused(member);
          }
        }
      });
      for (const member of ids) {
        writers.set(member, owner);
        maintenance.set(member, holding);
      }
      holdings.set(holding, { id, kind });
      return holding;
    },
    forkSession: unsupported,
    rollbackSession: unsupported,
    clearSession: async (id, holding) => {
      const current = holding ?? (await store.acquireSessionMaintenance(id, 'clear'));
      assertMaintenance(id, 'clear', current);
      try {
        records.set(id, records.get(id)!.slice(0, 1));
        worlds.delete(id);
        return get(id);
      } finally {
        if (!holding) await current.release();
      }
    },
    delete: async (id, holding) => {
      const current = holding ?? (await store.acquireSessionMaintenance(id, 'delete'));
      assertMaintenance(id, 'delete', current);
      try {
        for (const member of current.sessionIds) {
          sessions.delete(member);
          records.delete(member);
          worlds.delete(member);
        }
        return { deleted: true };
      } finally {
        if (!holding) await current.release();
      }
    },
    close: async () => {
      closes++;
    }
  };
  return { store, writers, sessions, records, closeCount: () => closes };
}
