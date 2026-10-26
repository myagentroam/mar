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

describe('Server recent-run in-memory index', () => {
  it.each(['UPDATE', 'SNAPSHOT'] as const)(
    'preserves an explicit user stop reason through %s without changing the Run status',
    async (kind) => {
      const service = new RecentRunService(database() as never, vi.fn(), () => 1_000);
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
    const service = new RecentRunService(db as never, vi.fn());
    await expect(service.consume('node-1', { kind: 'UPDATE', run: {} })).resolves.toBe(false);
    await expect(service.consume('node-other', projection({}))).resolves.toBe(true);
    expect(db.userCanRequestNode).not.toHaveBeenCalled();
    service.dispose();
  });

  it('rejects unauthorized users without adding entries to the list', async () => {
    const service = new RecentRunService(database(false) as never, vi.fn(), () => 1_000);
    await service.consume('node-1', projection({}));
    await expect(service.list(7)).resolves.toEqual([]);
    service.dispose();
  });

  it('keeps only the latest Run for the same Node session and removes the old entry in real time', async () => {
    const push = vi.fn();
    const service = new RecentRunService(database() as never, push, () => 1_000);
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
    const service = new RecentRunService(database() as never, vi.fn(), () => 1_000);
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

  it('reclassifies all authorized users for one exact Session scope without extending terminal TTL', async () => {
    let now = 2_000_000_000;
    let deniedUser: number | undefined;
    const db = database((userId) => userId !== deniedUser);
    const push = vi.fn();
    const service = new RecentRunService(db as never, push, () => now);
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

  it('defaults legacy RecentRun projections without a group to MAIN', async () => {
    const service = new RecentRunService(database() as never, vi.fn(), () => 1_000);
    await service.consume('node-1', projection({}));

    await expect(service.list(7)).resolves.toEqual([
      expect.objectContaining({ sessionGroup: 'MAIN' })
    ]);
    service.dispose();
  });

  it('does not let an older same-session Run from a legacy Node snapshot overwrite the latest task', async () => {
    const service = new RecentRunService(database() as never, vi.fn(), () => 1_000);
    await service.consume('node-1', projection({ runId: 'run-new', sortAt: 200 }));
    await service.consume('node-1', projection({ runId: 'run-old', sortAt: 100, version: 9 }));
    await expect(service.list(7)).resolves.toEqual([
      expect.objectContaining({ runId: 'run-new', sortAt: 200 })
    ]);
    service.dispose();
  });

  it('ignores lower versions and accepts higher-version states for the same Run', async () => {
    const service = new RecentRunService(database() as never, vi.fn(), () => 1_000);
    await service.consume('node-1', projection({ version: 3 }));
    await service.consume('node-1', projection({ status: 'INTERRUPTED', version: 2 }));
    expect((await service.list(7))[0]?.status).toBe('RUNNING');
    await service.consume('node-1', projection({ status: 'SUCCEEDED', version: 4 }));
    expect((await service.list(7))[0]?.status).toBe('SUCCEEDED');
    service.dispose();
  });

  it('removes only nonterminal tasks when a Node disconnects', async () => {
    const push = vi.fn();
    const service = new RecentRunService(database() as never, push, () => 1_000);
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
    const service = new RecentRunService(database() as never, vi.fn(), () => 1_000);
    await service.consume('node-1', projection({ runId: 'active', sessionId: 'missing' }));
    await service.consume('node-1', { kind: 'SNAPSHOT', runs: [] });
    await expect(service.list(7)).resolves.toEqual([]);
    service.dispose();
  });
});
