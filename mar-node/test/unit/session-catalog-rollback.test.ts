import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeDatabase } from '../../src/database.js';
import type { NodeConversationTurn } from '../../src/runtime-model.js';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import type { NativeSessionProjectionService } from '../../src/session/native-session-projection-service.js';
import { SessionCatalogService } from '../../src/session/session-catalog-service.js';
import type { RunnerRegistry } from '../../src/runner/runner-registry.js';

function turn(items: readonly Record<string, unknown>[]): NodeConversationTurn {
  return {
    id: 'turn-2',
    sessionId: 'native-session',
    runId: null,
    userItemId: 'first-user-item',
    status: 'SUCCEEDED',
    model: null,
    effort: null,
    access: null,
    rewind: { before: 'turn-1', after: 'turn-2' },
    items,
    startedAt: 1,
    completedAt: 2
  } as unknown as NodeConversationTurn;
}

function userItem(id: string, clientMessageId?: string) {
  return {
    id,
    kind: 'user_message',
    status: 'COMPLETED',
    payload: clientMessageId === undefined ? {} : { clientMessageId }
  };
}

function fixture(initialTurn: NodeConversationTurn) {
  const database = new NodeDatabase(':memory:', 'session-catalog-rollback');
  database.saveWorkspace({
    id: 'workspace',
    path: '/workspace',
    kind: 'DIRECTORY',
    gitSummary: null
  });
  const runtime = new NodeRuntimeState(
    () => 'node',
    (id) => database.getWorkspace(id),
    () => 1_000
  );
  const session = runtime.createAgentSession({
    workspaceId: 'workspace',
    cwd: '/workspace',
    runner: 'mar-agent',
    externalSessionId: 'native-session',
    nativeControl: 'EXTERNAL'
  });
  const runner = {
    supportsRollback: vi.fn(() => true),
    rollbackNative: vi.fn(async () => 1_500)
  };
  const runners = { require: () => runner } as unknown as RunnerRegistry;
  const projection = {
    resolve: vi.fn(async () => undefined),
    remember: vi.fn()
  } as unknown as NativeSessionProjectionService;
  const history = vi.fn(async () => ({ turns: [initialTurn], nextCursor: null }));
  const catalog = new SessionCatalogService({
    database: () => database,
    nodeId: () => 'node',
    runtime,
    runners,
    projection,
    runnerAvailable: () => true,
    cachedNative: () => [],
    cachedWorkspace: async () => [],
    discoveryPending: () => false,
    discoverWorkspace: async () => [],
    present: (value) => value,
    nativeIds: () => new Set(),
    forget: () => undefined,
    refreshActivity: async () => undefined,
    externalActivity: () => undefined,
    isWatching: () => false,
    history,
    invalidateHistory: () => undefined,
    invalidateWorkspaceSessions: () => undefined,
    emitSession: () => undefined
  });
  return { database, runtime, session, runner, catalog, history };
}

const first = userItem('first-user-item', 'first-message');
const steered = userItem('steered-user-item', 'steered-message');
const multiInputTurn = turn([first, steered]);

afterEach(() => vi.restoreAllMocks());

describe('SessionCatalogService rollback target selection', () => {
  it('forwards the selected steered message identity to the Runner adapter', async () => {
    const f = fixture(multiInputTurn);
    try {
      await f.catalog.operations()['session.rollback']!({
        sessionId: f.session.id,
        turnId: multiInputTurn.id,
        itemId: 'steered-user-item',
        boundary: 'turn-1'
      });

      expect(f.runner.rollbackNative).toHaveBeenCalledWith(
        f.session,
        'turn-1',
        'turn-2',
        'steered-message'
      );
    } finally {
      f.database.close();
    }
  });

  it('keeps the first selected user on the legacy Turn rollback path', async () => {
    const f = fixture(multiInputTurn);
    try {
      await f.catalog.operations()['session.rollback']!({
        sessionId: f.session.id,
        turnId: multiInputTurn.id,
        itemId: 'first-user-item',
        boundary: 'turn-1'
      });

      expect(f.runner.rollbackNative).toHaveBeenCalledWith(
        f.session,
        'turn-1',
        'turn-2',
        undefined
      );
    } finally {
      f.database.close();
    }
  });

  it('accepts a legacy single-user Turn when itemId is omitted', async () => {
    const singleInputTurn = turn([first]);
    const f = fixture(singleInputTurn);
    try {
      await f.catalog.operations()['session.rollback']!({
        sessionId: f.session.id,
        turnId: singleInputTurn.id,
        boundary: 'turn-1'
      });

      expect(f.runner.rollbackNative).toHaveBeenCalledWith(
        f.session,
        'turn-1',
        'turn-2',
        undefined
      );
    } finally {
      f.database.close();
    }
  });

  it('rejects ambiguous, forged, non-user, cross-Turn, and unstable selectors before rollback', async () => {
    const assistant = { id: 'assistant-item', kind: 'assistant_message', status: 'COMPLETED' };
    const noStableId = turn([first, userItem('unstable-user-item')]);
    const turnWithAssistant = turn([first, steered, assistant]);
    const otherTurn = {
      ...turn([userItem('user-from-another-turn', 'other-message')]),
      id: 'turn-3'
    };
    const f = fixture(multiInputTurn);
    try {
      const rollback = f.catalog.operations()['session.rollback']!;
      const cases = [
        { turns: [multiInputTurn], itemId: undefined },
        { turns: [multiInputTurn], itemId: 'forged-item' },
        { turns: [turnWithAssistant], itemId: 'assistant-item' },
        { turns: [multiInputTurn, otherTurn], itemId: 'user-from-another-turn' },
        { turns: [noStableId], itemId: 'unstable-user-item' }
      ];

      for (const { turns, itemId } of cases) {
        f.history.mockResolvedValueOnce({ turns, nextCursor: null });
        await expect(
          rollback({
            sessionId: f.session.id,
            turnId: multiInputTurn.id,
            ...(itemId === undefined ? {} : { itemId }),
            boundary: 'turn-1'
          })
        ).rejects.toThrow('SESSION_ROLLBACK_TARGET_INVALID');
      }

      expect(f.runner.rollbackNative).not.toHaveBeenCalled();
    } finally {
      f.database.close();
    }
  });
});
