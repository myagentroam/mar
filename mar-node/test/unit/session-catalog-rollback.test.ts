import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeDatabase } from '../../src/database.js';
import type { NodeConversationTurn } from '../../src/runtime-model.js';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import type { NativeSessionProjectionService } from '../../src/session/native-session-projection-service.js';
import { SessionCatalogService } from '../../src/session/session-catalog-service.js';
import { ContinuousRunCoordinator } from '../../src/service/continuous-run-coordinator.js';
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
  const history = vi.fn(
    async (
      _session: unknown,
      _input: { readonly cursor?: string; readonly limit?: number }
    ): Promise<{ turns: NodeConversationTurn[]; nextCursor: string | null }> => ({
      turns: [initialTurn],
      nextCursor: null
    })
  );
  const onHistoryMutationSettled = vi.fn();
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
    emitSession: () => undefined,
    onHistoryMutationSettled
  });
  return { database, runtime, session, runner, catalog, history, onHistoryMutationSettled };
}

const first = userItem('first-user-item', 'first-message');
const steered = userItem('steered-user-item', 'steered-message');
const multiInputTurn = turn([first, steered]);

afterEach(() => vi.restoreAllMocks());

describe('SessionCatalogService rollback target selection', () => {
  it.each(['success', 'failure', 'paused'] as const)(
    'reconsiders preserved FIFO after rollback settles without resuming a paused queue (%s)',
    async (outcome) => {
      const f = fixture(multiInputTurn);
      const control = vi.fn();
      const coordinator = new ContinuousRunCoordinator({
        runtime: f.runtime,
        control,
        executionTerminating: () => undefined,
        keepRunActive: () => false,
        emitQueue: vi.fn(),
        emitConversation: vi.fn(),
        clearImages: vi.fn(),
        cleanupAttachments: vi.fn(),
        migrateAssets: vi.fn(),
        emitRun: vi.fn(),
        stopped: () => false,
        markInterrupted: vi.fn(),
        mcps: () => []
      });
      f.onHistoryMutationSettled.mockImplementation((id: string) => coordinator.schedule(id));
      const item = f.runtime.createQueueItem({
        sessionId: f.session.id,
        clientMessageId: 'preserved-fifo',
        content: 'Continue in FIFO order'
      }).item;
      coordinator.prepare(item.id, {
        runId: item.id,
        sessionId: f.session.id,
        workspaceId: f.session.workspaceId,
        input: item.content,
        attachments: [],
        attachmentPaths: [],
        cwd: f.session.cwd,
        externalSessionId: f.session.externalSessionId,
        modelId: null,
        effort: null,
        access: null,
        collaborationMode: 'default',
        secretEnvironment: {},
        executionContext: { runner: 'mar-agent' }
      });
      if (outcome === 'paused') f.runtime.pauseSessionQueue(f.session.id);
      const native = Promise.withResolvers<number>();
      f.runner.rollbackNative.mockReturnValueOnce(native.promise);
      try {
        const pending = Promise.resolve(
          f.catalog.operations()['session.rollback']!({
            sessionId: f.session.id,
            turnId: multiInputTurn.id,
            itemId: first.id,
            boundary: 'turn-1'
          })
        );
        void pending.catch(() => undefined);
        await vi.waitFor(() => expect(f.runner.rollbackNative).toHaveBeenCalledOnce());
        if (outcome !== 'paused')
          await expect(coordinator.dispatch(f.session.id)).rejects.toThrow('SESSION_ACTIVE');
        expect(control).not.toHaveBeenCalled();
        if (outcome === 'failure') {
          native.reject(new Error('NATIVE_ROLLBACK_FAILED'));
          await expect(pending).rejects.toThrow('NATIVE_ROLLBACK_FAILED');
        } else {
          native.resolve(1_500);
          await pending;
        }
        if (outcome === 'paused') {
          await coordinator.dispatch(f.session.id);
          expect(f.runtime.sessionQueue(f.session.id)).toMatchObject({
            paused: true,
            itemIds: [item.id]
          });
          expect(control).not.toHaveBeenCalled();
        } else {
          await vi.waitFor(() =>
            expect(control).toHaveBeenCalledWith('run.start', expect.anything())
          );
          expect(f.runtime.sessionQueue(f.session.id).itemIds).toEqual([]);
        }
        expect(f.onHistoryMutationSettled).toHaveBeenCalledExactlyOnceWith(f.session.id);
      } finally {
        native.resolve(1_500);
        coordinator.clear();
        f.database.close();
      }
    }
  );

  it.each([false, true])(
    'preserves pending messages and queue state during rollback (paused=%s)',
    async (paused) => {
      const f = fixture(multiInputTurn);
      const first = f.runtime.createQueueItem({
        sessionId: f.session.id,
        clientMessageId: 'pending-first',
        content: 'Keep this first',
        initiatedByUserId: 42
      }).item;
      const second = f.runtime.createQueueItem({
        sessionId: f.session.id,
        clientMessageId: 'pending-second',
        content: 'Keep this second',
        initiatedByUserId: 42
      }).item;
      if (paused) f.runtime.pauseSessionQueue(f.session.id);
      const queue = f.runtime.sessionQueue(f.session.id);
      const native = Promise.withResolvers<number>();
      f.runner.rollbackNative.mockReturnValueOnce(native.promise);
      try {
        const pending = Promise.resolve(
          f.catalog.operations()['session.rollback']!({
            sessionId: f.session.id,
            turnId: multiInputTurn.id,
            itemId: 'first-user-item',
            boundary: 'turn-1'
          })
        );
        void pending.catch(() => undefined);
        await vi.waitFor(() => expect(f.runner.rollbackNative).toHaveBeenCalledOnce());
        expect(() => f.runtime.startRunFromQueueItem(first.id)).toThrow('SESSION_ACTIVE');
        expect(() =>
          f.runtime.createMessageRun({
            sessionId: f.session.id,
            clientMessageId: 'racing-input',
            content: 'Cannot race with history mutation'
          })
        ).toThrow('SESSION_ACTIVE');
        native.resolve(1_500);
        await expect(pending).resolves.toMatchObject({ session: { id: f.session.id } });
        expect(f.runtime.sessionQueue(f.session.id)).toEqual(queue);
        expect(f.runtime.getQueueItem(first.id)).toEqual(first);
        expect(f.runtime.getQueueItem(second.id)).toEqual(second);
        expect(f.runtime.findMessageSubmission(f.session.id, first.clientMessageId)).toMatchObject({
          kind: 'queue',
          item: first
        });
        if (paused) f.runtime.resumeSessionQueue(f.session.id);
        expect(f.runtime.startRunFromQueueItem(first.id).turn.items[0]?.payload).toMatchObject({
          text: first.content
        });
      } finally {
        native.resolve(1_500);
        f.database.close();
      }
    }
  );

  it('preserves a paused queue and releases admission when native rollback fails', async () => {
    const f = fixture(multiInputTurn);
    const queued = f.runtime.createQueueItem({
      sessionId: f.session.id,
      clientMessageId: 'pending-message',
      content: 'Keep after failure'
    }).item;
    f.runtime.pauseSessionQueue(f.session.id);
    const queue = f.runtime.sessionQueue(f.session.id);
    f.runner.rollbackNative.mockRejectedValueOnce(new Error('NATIVE_ROLLBACK_FAILED'));
    try {
      await expect(
        f.catalog.operations()['session.rollback']!({
          sessionId: f.session.id,
          turnId: multiInputTurn.id,
          boundary: 'turn-1',
          itemId: 'first-user-item'
        })
      ).rejects.toThrow('NATIVE_ROLLBACK_FAILED');
      expect(f.runtime.sessionQueue(f.session.id)).toEqual(queue);
      expect(f.runtime.getQueueItem(queued.id)).toEqual(queued);
      expect(() =>
        f.runtime.beginSessionHistoryMutation(f.session.id, { allowQueued: true })()
      ).not.toThrow();
    } finally {
      f.database.close();
    }
  });

  it('finds an older user message through history pagination rather than limiting rollback to the latest Turn', async () => {
    const f = fixture(multiInputTurn);
    const latest = {
      ...multiInputTurn,
      id: 'turn-3',
      rewind: { before: 'turn-2', after: 'turn-3' }
    };
    f.history.mockResolvedValueOnce({ turns: [latest], nextCursor: 'older' });
    try {
      await f.catalog.operations()['session.rollback']!({
        sessionId: f.session.id,
        turnId: multiInputTurn.id,
        itemId: 'first-user-item',
        boundary: 'turn-1'
      });
      expect(f.history.mock.calls.map((call) => call[1])).toEqual([
        { limit: 100 },
        { limit: 100, cursor: 'older' }
      ]);
      expect(f.runner.rollbackNative).toHaveBeenCalledExactlyOnceWith(
        f.session,
        'turn-1',
        'turn-2',
        undefined
      );
    } finally {
      f.database.close();
    }
  });

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
