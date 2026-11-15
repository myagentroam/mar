import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NodeWorkspace } from '../../src/workspace/contracts.js';
import { WorkspaceWatchService } from '../../src/workspace/workspace-watch-service.js';
import { WorkspaceWatchSnapshotService } from '../../src/workspace/workspace-watch-snapshot-service.js';

function fixture() {
  const workspace: NodeWorkspace = {
    id: 'workspace-1',
    path: '/workspace',
    kind: 'GIT_WORKSPACE',
    gitSummary: null
  };
  const watches = new WorkspaceWatchService(vi.fn(), vi.fn(), vi.fn());
  const current = vi.fn(async () => ({ changes: [{ path: 'first.txt' }] }));
  const fetch = vi.fn();
  const list = vi.fn(async () => ({ entries: [], nextCursor: null }));
  const emit = vi.fn();
  const snapshots = new WorkspaceWatchSnapshotService({
    requireWorkspace: () => workspace,
    watch: watches,
    files: { list } as never,
    changes: { current, fetch, revision: () => 0 } as never,
    listSessions: vi.fn(async () => ({ sessions: [] })),
    nodeId: () => 'node-1',
    emitWatchEvent: emit
  });
  async function subscribe(
    connection = 'connection-1',
    topics = { sessions: false, changes: true, files: undefined as { path: string } | undefined }
  ) {
    const watch = watches.create(
      workspace.id,
      `watch-${connection}`,
      'account',
      connection,
      'generation',
      topics
    );
    await snapshots.initial(workspace, watch);
    return watch;
  }
  return {
    watches,
    current,
    fetch,
    list,
    emit,
    snapshots,
    subscribe,
    close() {
      watches.clearAll();
      snapshots.clearAll();
    }
  };
}

describe('Workspace Watch periodic local Git refresh', () => {
  afterEach(() => vi.useRealTimers());

  it('refreshes Changes every 30 seconds without Files or fetch, sharing reads across pages', async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      const first = await f.subscribe();
      const second = await f.subscribe('connection-2');
      f.current.mockClear();
      f.emit.mockClear();
      f.current.mockResolvedValue({ changes: [{ path: 'external.txt' }] });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(f.current).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(f.current).toHaveBeenCalledOnce();
      expect(f.emit).toHaveBeenCalledTimes(2);
      for (const watch of [first, second]) {
        expect(f.emit).toHaveBeenCalledWith(
          expect.objectContaining({
            watchId: watch.watchId,
            topic: 'changes',
            payload: { changes: [{ path: 'external.txt' }] }
          })
        );
        f.watches.renew('workspace-1', `account:${watch.workbenchConnectionId}`, watch.watchId);
      }
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.current).toHaveBeenCalledTimes(2);
      expect(f.emit).toHaveBeenCalledTimes(2);
      expect(f.list).not.toHaveBeenCalled();
      expect(f.fetch).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

  it.each(['changed', 'unchanged'] as const)(
    'recovers on the next tick after a local read failure with %s content',
    async (content) => {
      vi.useFakeTimers();
      const f = fixture();
      try {
        const watch = await f.subscribe();
        f.emit.mockClear();
        f.current.mockRejectedValueOnce(new Error('LOCAL_READ_FAILED'));
        await vi.advanceTimersByTimeAsync(30_000);
        expect(f.emit).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'watch.failed',
            topic: 'changes',
            code: 'WORKSPACE_WATCH_SNAPSHOT_FAILED'
          })
        );
        f.watches.renew('workspace-1', `account:${watch.workbenchConnectionId}`, watch.watchId);
        const recovered = {
          changes: [{ path: content === 'changed' ? 'recovered.txt' : 'first.txt' }]
        };
        f.current.mockResolvedValue(recovered);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(f.emit).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'watch.workspace.snapshot',
            topic: 'changes',
            payload: recovered
          })
        );
        expect(f.fetch).not.toHaveBeenCalled();
      } finally {
        f.close();
      }
    }
  );

  it.each(['removed', 'expired', 'stopped'] as const)(
    'stops local reads when the subscription is %s',
    async (state) => {
      vi.useFakeTimers();
      const f = fixture();
      try {
        await f.subscribe();
        if (state === 'removed') f.watches.remove('workspace-1', 'account:connection-1');
        if (state === 'stopped') f.snapshots.clearAll();
        await vi.advanceTimersByTimeAsync(state === 'expired' ? 90_000 : 30_000);
        expect(f.current).toHaveBeenCalledTimes(state === 'expired' ? 2 : 1);
        expect(f.fetch).not.toHaveBeenCalled();
      } finally {
        f.close();
      }
    }
  );

  it('keeps Files and Changes refreshing together without fetching', async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      const watch = await f.subscribe('connection-1', {
        sessions: false,
        changes: true,
        files: { path: '.' }
      });
      f.current.mockClear();
      f.list.mockClear();
      for (let tick = 0; tick < 2; tick += 1) {
        await vi.advanceTimersByTimeAsync(30_000);
        f.watches.renew('workspace-1', `account:${watch.workbenchConnectionId}`, watch.watchId);
      }
      expect(f.current).toHaveBeenCalledTimes(2);
      expect(f.list).toHaveBeenCalledTimes(2);
      expect(f.fetch).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

  it('does not start resource refreshes for a sessions-only subscription', async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.subscribe('connection-1', { sessions: true, changes: false, files: undefined });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.current).not.toHaveBeenCalled();
      expect(f.list).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

  it('merges ticks during a slow read into one trailing refresh while the lease remains active', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let finish!: (value: { changes: { path: string }[] }) => void;
    const pending = new Promise<{ changes: { path: string }[] }>((resolve) => {
      finish = resolve;
    });
    const updated = { changes: [{ path: 'updated.txt' }] };
    try {
      const watch = await f.subscribe();
      f.emit.mockClear();
      f.current.mockReturnValueOnce(pending).mockResolvedValue(updated);
      for (let tick = 0; tick < 3; tick += 1) {
        await vi.advanceTimersByTimeAsync(30_000);
        f.watches.renew('workspace-1', `account:${watch.workbenchConnectionId}`, watch.watchId);
      }
      expect(f.current).toHaveBeenCalledTimes(2);
      finish(updated);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.current).toHaveBeenCalledTimes(3);
      expect(f.emit).toHaveBeenCalledOnce();
      expect(f.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'watch.workspace.snapshot',
          topic: 'changes',
          payload: updated
        })
      );
      expect(f.fetch).not.toHaveBeenCalled();
    } finally {
      finish(updated);
      f.close();
    }
  });

  it('coalesces ticks during a slow read and drops its result after the last lease is removed', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let finish!: (value: { changes: { path: string }[] }) => void;
    const pending = new Promise<{ changes: { path: string }[] }>((resolve) => {
      finish = resolve;
    });
    try {
      const watch = await f.subscribe();
      f.emit.mockClear();
      f.current.mockReturnValueOnce(pending);
      await vi.advanceTimersByTimeAsync(30_000);
      f.watches.renew('workspace-1', `account:${watch.workbenchConnectionId}`, watch.watchId);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.current).toHaveBeenCalledTimes(2);
      f.watches.remove('workspace-1', 'account:connection-1');
      finish({ changes: [{ path: 'late.txt' }] });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.current).toHaveBeenCalledTimes(2);
      expect(f.emit).not.toHaveBeenCalled();
    } finally {
      finish({ changes: [] });
      f.close();
    }
  });
});
