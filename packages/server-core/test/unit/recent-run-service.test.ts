import { describe, expect, it, vi } from 'vitest';
import { RecentRunService } from '../../src/recent-run-service.js';

function projection(input: {
  runId?: string;
  sessionId?: string;
  userId?: number;
  status?: 'RUNNING' | 'SUCCEEDED' | 'INTERRUPTED';
  sortAt?: number;
  version?: number;
}) {
  const sortAt = input.sortAt ?? 110;
  return {
    kind: 'UPDATE' as const,
    run: {
      nodeId: 'node-1',
      runId: input.runId ?? 'run-1',
      userId: input.userId ?? 7,
      workspaceId: 'workspace-1',
      sessionId: input.sessionId ?? 'session-1',
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

function database(allowed = true) {
  return {
    raw: {
      execute: vi.fn(async () => [[{ display_name: 'Workspace' }], []])
    },
    userCanRequestNode: vi.fn(async () => allowed)
  };
}

describe('Server recent-run in-memory index', () => {
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
