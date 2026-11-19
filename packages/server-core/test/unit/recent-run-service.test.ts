import { describe, expect, it, vi } from 'vitest';
import { RecentRunService } from '../../src/recent-run-service.js';

function projection(input: {
  runId?: string;
  sessionId?: string;
  userId?: number;
  nodeId?: string;
  workspaceId?: string;
  sessionGroup?: 'MAIN' | 'CHILD';
  status?: 'RUNNING' | 'SUCCEEDED' | 'INTERRUPTED';
  sortAt?: number;
  version?: number;
}) {
  const sortAt = input.sortAt ?? 110;
  return {
    kind: 'UPDATE' as const,
    run: {
      nodeId: input.nodeId ?? 'node-1',
      runId: input.runId ?? 'run-1',
      userId: input.userId ?? 7,
      workspaceId: input.workspaceId ?? 'workspace-1',
      sessionId: input.sessionId ?? 'session-1',
      ...(input.sessionGroup === undefined ? {} : { sessionGroup: input.sessionGroup }),
      sessionTitle: 'Test session',
      userMessage: 'Investigate duplicate task issues',
      runner: 'codex' as const,
      status: input.status ?? ('RUNNING' as const),
      createdAt: sortAt - 10,
      startedAt: sortAt,
      completedAt:
        input.status === 'SUCCEEDED' || input.status === 'INTERRUPTED' ? sortAt + 10 : null,
      sortAt,
      updatedAt: sortAt,
      version: input.version ?? 1
    }
  };
}

function database(allowed: boolean | ((userId: number, nodeId: string) => boolean) = true) {
  return {
    raw: {
      execute: vi.fn(async () => [[{ display_name: 'Workspace' }], []])
    },
    userCanRequestNode: vi.fn(async (userId: number, nodeId: string) =>
      typeof allowed === 'boolean' ? allowed : allowed(userId, nodeId)
    )
  };
}

function createRecentRunService(
  db: ReturnType<typeof database>,
  push: (userId: number, message: object) => void,
  now?: () => number
) {
  return new RecentRunService(db as never, db.userCanRequestNode, push, now);
}

describe('Server recent-run in-memory index', () => {
  it.each(['UPDATE', 'SNAPSHOT'] as const)(
    'preserves an explicit user stop reason through %s without changing the Run status',
    async (kind) => {
      const service = createRecentRunService(database(), vi.fn(), () => 1_000);
      const stopped = {
        ...projection({ status: 'INTERRUPTED' }).run,
        interruptionReason: 'USER_STOP'
      };
      try {
        await expect(
          service.consume(
            'node-1',
            kind === 'UPDATE' ? { kind, run: stopped } : { kind, runs: [stopped] }
          )
        ).resolves.toBe(true);
        await expect(service.list(7)).resolves.toEqual([
          expect.objectContaining({ status: 'INTERRUPTED', interruptionReason: 'USER_STOP' })
        ]);

        await service.consume(
          'node-1',
          projection({ runId: 'next-run', status: 'INTERRUPTED', sortAt: 200 })
        );
        const [next] = await service.list(7);
        expect(next?.status).toBe('INTERRUPTED');
        expect(next).not.toHaveProperty('interruptionReason');
      } finally {
        service.dispose();
      }
    }
  );

  it('rejects malformed projections and projections with a mismatched connected Node identity', async () => {
    const db = database();
    const service = createRecentRunService(db, vi.fn());
    await expect(service.consume('node-1', { kind: 'UPDATE', run: {} })).resolves.toBe(false);
    await expect(service.consume('node-other', projection({}))).resolves.toBe(true);
    expect(db.userCanRequestNode).not.toHaveBeenCalled();
    service.dispose();
  });

  it('rejects unauthorized users without adding entries to the list', async () => {
    const service = createRecentRunService(database(false), vi.fn(), () => 1_000);
    await service.consume('node-1', projection({}));
    await expect(service.list(7)).resolves.toEqual([]);
    service.dispose();
  });

  it('keeps only the latest Run for the same Node session and removes the old entry in real time', async () => {
    const push = vi.fn();
    const service = createRecentRunService(database(), push, () => 1_000);
    await service.consume('node-1', projection({ runId: 'run-old', sortAt: 100, version: 5 }));
    await service.consume('node-1', projection({ runId: 'run-new', sortAt: 200, version: 1 }));
    await expect(service.list(7)).resolves.toEqual([
      expect.objectContaining({
        runId: 'run-new',
        sessionId: 'session-1',
        userMessage: 'Investigate duplicate task issues',
        sortAt: 200
      })
    ]);
    expect(push).toHaveBeenCalledWith(7, {
      type: 'recent-run.removed',
      nodeId: 'node-1',
      runId: 'run-old'
    });
    service.dispose();
  });

  it('keeps tasks separately for different users of the same Node session', async () => {
    const service = createRecentRunService(database(), vi.fn(), () => 1_000);
    await service.consume('node-1', projection({ runId: 'run-user-7', userId: 7, sortAt: 100 }));
    await service.consume('node-1', projection({ runId: 'run-user-8', userId: 8, sortAt: 200 }));
    await expect(service.list(7)).resolves.toEqual([
      expect.objectContaining({ runId: 'run-user-7', sessionId: 'session-1' })
    ]);
    await expect(service.list(8)).resolves.toEqual([
      expect.objectContaining({ runId: 'run-user-8', sessionId: 'session-1' })
    ]);
    service.dispose();
  });

  it('caps terminal runs across two Node snapshots immediately while preserving active runs and TTL', async () => {
    const cleanupInterval = 5 * 60_000;
    const ttl = 12 * 60 * 60_000;
    let now = 2_000_000_000;
    const push = vi.fn();
    const service = createRecentRunService(database(), push, () => now);
    const terminal = (nodeId: string, index: number) =>
      projection({
        nodeId,
        runId: `done-${index}`,
        sessionId: `session-${index}`,
        status: 'SUCCEEDED',
        sortAt: index < 3 ? now - ttl + cleanupInterval - 12 + index : now - 1_000 + index
      }).run;
    const first = Array.from({ length: 51 }, (_, index) => terminal('node-1', index));
    const second = Array.from({ length: 51 }, (_, index) => terminal('node-2', 51 + index));
    const active = (nodeId: string, sortAt: number) =>
      projection({ nodeId, runId: `active-${nodeId}`, sessionId: 'active-session', sortAt }).run;
    const firstActive = active('node-1', now - 2_000);
    const secondActive = active('node-2', now - 20);

    try {
      await service.consume('node-1', { kind: 'SNAPSHOT', runs: [firstActive, ...first] });
      await service.consume(
        'node-1',
        projection({ userId: 8, runId: 'other-user', status: 'SUCCEEDED', sortAt: now - 500 })
      );
      push.mockClear();

      await service.consume('node-2', { kind: 'SNAPSHOT', runs: [secondActive, ...second] });
      const runs = await service.list(7);
      expect(runs.filter(({ status }) => status === 'SUCCEEDED')).toHaveLength(100);
      const retained = [secondActive, ...second.toReversed(), ...first.slice(3).toReversed()];
      expect(runs.map(({ runId }) => runId)).toEqual([
        ...retained.map(({ runId }) => runId),
        firstActive.runId,
        'done-2'
      ]);
      expect(
        push.mock.calls.filter(([, message]) => message.type === 'recent-run.removed')
      ).toEqual([
        [7, { type: 'recent-run.removed', nodeId: 'node-1', runId: 'done-0' }],
        [7, { type: 'recent-run.removed', nodeId: 'node-1', runId: 'done-1' }]
      ]);
      expect(push.mock.calls.slice(-2)).toEqual([
        [7, { type: 'recent-run.removed', nodeId: 'node-1', runId: 'done-1' }],
        [
          7,
          expect.objectContaining({
            type: 'recent-run.updated',
            run: expect.objectContaining({ runId: 'done-101' })
          })
        ]
      ]);
      expect((await service.list(8)).map(({ runId }) => runId)).toEqual(['other-user']);

      push.mockClear();
      now += cleanupInterval - 1;
      expect(await service.list(7)).toHaveLength(102);
      expect(push).not.toHaveBeenCalled();
      now++;
      expect((await service.list(7)).map(({ runId }) => runId)).toEqual([
        ...retained.map(({ runId }) => runId),
        firstActive.runId
      ]);
      expect(push.mock.calls).toEqual([
        [7, { type: 'recent-run.removed', nodeId: 'node-1', runId: 'done-2' }]
      ]);

      push.mockClear();
      await service.consume('node-2', { kind: 'UPDATE', run: terminal('node-2', 102) });
      expect(await service.list(7)).toHaveLength(102);
      expect(push).toHaveBeenCalledTimes(1);
      expect((await service.list(8)).map(({ runId }) => runId)).toEqual(['other-user']);
    } finally {
      service.dispose();
    }
  });

  it('does not publish an out-of-retention terminal update but removes its formerly active run', async () => {
    const push = vi.fn();
    const service = createRecentRunService(database(), push, () => 1_000);
    const runs = Array.from(
      { length: 100 },
      (_, index) =>
        projection({ runId: `done-${index}`, sessionId: `session-${index}`, status: 'SUCCEEDED' })
          .run
    );
    const late = projection({
      nodeId: 'node-2',
      runId: 'late',
      sessionId: 'late-session',
      status: 'SUCCEEDED',
      sortAt: 100
    });
    const live = projection({ nodeId: 'node-2', runId: 'live', sortAt: 100 });

    try {
      await service.consume('node-1', { kind: 'SNAPSHOT', runs });
      await service.consume('node-2', live);
      push.mockClear();

      await service.consume('node-2', late);
      expect(push).not.toHaveBeenCalled();
      expect(await service.list(7)).toHaveLength(101);

      await service.consume('node-2', {
        kind: 'UPDATE',
        run: { ...live.run, status: 'SUCCEEDED', completedAt: late.run.completedAt, version: 2 }
      });
      expect(push.mock.calls).toEqual([
        [7, { type: 'recent-run.removed', nodeId: 'node-2', runId: 'live' }]
      ]);
      expect((await service.list(7)).map(({ runId }) => runId)).toEqual(
        runs.map(({ runId }) => runId).sort((left, right) => right.localeCompare(left))
      );
    } finally {
      service.dispose();
    }
  });

  it('reclassifies all authorized users for one exact Session scope without extending terminal TTL', async () => {
    let now = 2_000_000_000;
    let deniedUser: number | undefined;
    const db = database((userId) => userId !== deniedUser);
    const push = vi.fn();
    const service = createRecentRunService(db, push, () => now);
    const completedAt = now - 12 * 60 * 60_000 + 60_000;
    const terminalRun = (userId: number) =>
      projection({
        userId,
        status: 'SUCCEEDED',
        sortAt: completedAt - 10,
        sessionGroup: 'CHILD'
      });

    await service.consume('node-1', terminalRun(7));
    await service.consume('node-1', terminalRun(8));
    await service.consume('node-1', terminalRun(9));
    await service.consume(
      'node-1',
      projection({ userId: 10, workspaceId: 'workspace-other', sessionGroup: 'CHILD' })
    );
    await service.consume(
      'node-1',
      projection({ userId: 11, sessionId: 'session-other', sessionGroup: 'CHILD' })
    );
    await service.consume(
      'node-2',
      projection({ userId: 12, nodeId: 'node-2', sessionGroup: 'CHILD' })
    );

    deniedUser = 8;
    db.userCanRequestNode.mockClear();
    push.mockClear();
    const change = {
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      sessionGroup: 'MAIN'
    } as const;
    await service.reclassify(change);

    expect(db.userCanRequestNode).toHaveBeenCalledTimes(3);
    expect(db.userCanRequestNode).toHaveBeenCalledWith(
      7,
      'node-1',
      'workbench.event.receive',
      change,
      'workspace-1'
    );
    expect(db.userCanRequestNode).toHaveBeenCalledWith(
      8,
      'node-1',
      'workbench.event.receive',
      change,
      'workspace-1'
    );
    expect(push).toHaveBeenCalledTimes(2);
    expect(push).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        type: 'recent-run.updated',
        run: expect.objectContaining({
          sessionGroup: 'MAIN',
          completedAt,
          sortAt: completedAt - 10
        })
      })
    );
    expect(push).toHaveBeenCalledWith(
      9,
      expect.objectContaining({
        type: 'recent-run.updated',
        run: expect.objectContaining({ sessionGroup: 'MAIN', completedAt })
      })
    );

    deniedUser = undefined;
    await expect(service.list(7)).resolves.toEqual([
      expect.objectContaining({ sessionGroup: 'MAIN', completedAt })
    ]);
    await expect(service.list(8)).resolves.toEqual([
      expect.objectContaining({ sessionGroup: 'CHILD' })
    ]);
    await expect(service.list(9)).resolves.toEqual([
      expect.objectContaining({ sessionGroup: 'MAIN', completedAt })
    ]);
    await expect(service.list(10)).resolves.toEqual([
      expect.objectContaining({ sessionGroup: 'CHILD', workspaceId: 'workspace-other' })
    ]);
    await expect(service.list(11)).resolves.toEqual([
      expect.objectContaining({ sessionGroup: 'CHILD', sessionId: 'session-other' })
    ]);
    await expect(service.list(12)).resolves.toEqual([
      expect.objectContaining({ sessionGroup: 'CHILD', nodeId: 'node-2' })
    ]);

    now += 5 * 60_000;
    await expect(service.list(7)).resolves.toEqual([]);
    expect(push).toHaveBeenCalledWith(7, {
      type: 'recent-run.removed',
      nodeId: 'node-1',
      runId: 'run-1'
    });
    service.dispose();
  });

  it('does not republish a terminal run evicted by another Node during reclassification', async () => {
    const db = database();
    const push = vi.fn();
    const service = createRecentRunService(db, push, () => 1_000);
    const entered = Promise.withResolvers<void>();
    const authorization = Promise.withResolvers<boolean>();
    let reclassify: Promise<void> | undefined;

    try {
      await service.consume(
        'node-1',
        projection({ runId: 'old', status: 'SUCCEEDED', sessionGroup: 'CHILD', sortAt: 100 })
      );
      await service.consume('node-2', {
        kind: 'SNAPSHOT',
        runs: Array.from(
          { length: 99 },
          (_, index) =>
            projection({
              nodeId: 'node-2',
              runId: `done-${index}`,
              sessionId: `session-${index}`,
              status: 'SUCCEEDED'
            }).run
        )
      });
      push.mockClear();
      db.userCanRequestNode.mockImplementationOnce(() => {
        entered.resolve();
        return authorization.promise;
      });
      reclassify = service.reclassify({
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        sessionGroup: 'MAIN'
      });
      await Promise.race([
        entered.promise,
        reclassify.then(() => {
          throw new Error('Reclassification finished without requesting authorization');
        })
      ]);

      await service.consume(
        'node-2',
        projection({
          nodeId: 'node-2',
          runId: 'newest',
          status: 'SUCCEEDED',
          sortAt: 200,
          sessionId: 'newest-session'
        })
      );
      authorization.resolve(true);
      await reclassify;

      expect(push.mock.calls).toEqual([
        [7, { type: 'recent-run.removed', nodeId: 'node-1', runId: 'old' }],
        [
          7,
          expect.objectContaining({
            type: 'recent-run.updated',
            run: expect.objectContaining({ runId: 'newest' })
          })
        ]
      ]);
      const runs = await service.list(7);
      expect(runs).toHaveLength(100);
      expect(runs.some(({ runId }) => runId === 'old')).toBe(false);
    } finally {
      authorization.resolve(false);
      service.dispose();
      await reclassify;
    }
  });

  it('defaults legacy RecentRun projections without a group to MAIN', async () => {
    const service = createRecentRunService(database(), vi.fn(), () => 1_000);
    await service.consume('node-1', projection({}));

    await expect(service.list(7)).resolves.toEqual([
      expect.objectContaining({ sessionGroup: 'MAIN' })
    ]);
    service.dispose();
  });

  it('does not let an older same-session Run from a legacy Node snapshot overwrite the latest task', async () => {
    const service = createRecentRunService(database(), vi.fn(), () => 1_000);
    await service.consume('node-1', projection({ runId: 'run-new', sortAt: 200 }));
    await service.consume('node-1', projection({ runId: 'run-old', sortAt: 100, version: 9 }));
    await expect(service.list(7)).resolves.toEqual([
      expect.objectContaining({ runId: 'run-new', sortAt: 200 })
    ]);
    service.dispose();
  });

  it('ignores lower versions and accepts higher-version states for the same Run', async () => {
    const service = createRecentRunService(database(), vi.fn(), () => 1_000);
    await service.consume('node-1', projection({ version: 3 }));
    await service.consume('node-1', projection({ status: 'INTERRUPTED', version: 2 }));
    expect((await service.list(7))[0]?.status).toBe('RUNNING');
    await service.consume('node-1', projection({ status: 'SUCCEEDED', version: 4 }));
    expect((await service.list(7))[0]?.status).toBe('SUCCEEDED');
    service.dispose();
  });

  it('removes only nonterminal tasks when a Node disconnects', async () => {
    const push = vi.fn();
    const service = createRecentRunService(database(), push, () => 1_000);
    await service.consume('node-1', projection({ runId: 'active', sessionId: 'active' }));
    await service.consume(
      'node-1',
      projection({ runId: 'done', sessionId: 'done', status: 'SUCCEEDED', sortAt: 120 })
    );
    await service.disconnected('node-1');
    await expect(service.list(7)).resolves.toEqual([expect.objectContaining({ runId: 'done' })]);
    expect(push).toHaveBeenCalledWith(7, {
      type: 'recent-run.removed',
      nodeId: 'node-1',
      runId: 'active'
    });
    service.dispose();
  });

  it('removes nonterminal sessions omitted from a complete snapshot', async () => {
    const service = createRecentRunService(database(), vi.fn(), () => 1_000);
    await service.consume('node-1', projection({ runId: 'active', sessionId: 'missing' }));
    await service.consume('node-1', { kind: 'SNAPSHOT', runs: [] });
    await expect(service.list(7)).resolves.toEqual([]);
    service.dispose();
  });
});
