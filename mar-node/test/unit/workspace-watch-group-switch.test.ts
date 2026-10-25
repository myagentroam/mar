import { describe, expect, it, vi } from 'vitest';
import type { NodeWorkspace } from '../../src/database.js';
import { WorkspaceDomainState } from '../../src/service/workspace-domain-state.js';
import { WorkspaceWatchController } from '../../src/service/workspace-watch-controller.js';
import { WorkspaceWatchService } from '../../src/service/workspace-watch-service.js';
import { WorkspaceWatchSnapshotService } from '../../src/service/workspace-watch-snapshot-service.js';

function fixture() {
  const workspace: NodeWorkspace = {
    id: 'workspace-1',
    path: '/fixture',
    kind: 'GIT_WORKSPACE',
    gitSummary: null
  };
  const events: Array<{ watchId: string; topic: string; payload: unknown }> = [];
  const files = vi.fn(async () => ({ entries: [{ name: 'first.txt' }], nextCursor: null }));
  const changes = vi.fn(async () => ({ changes: [{ path: 'first.txt' }] }));
  const sessions = vi.fn(async (_id: string, group?: 'MAIN' | 'CHILD') => ({
    sessions: [{ id: group ?? 'ALL' }]
  }));
  const requireWorkspace = (id: unknown) =>
    id === workspace.id ? workspace : { ...workspace, id: String(id), path: '/other' };
  const unused = vi.fn(() => snapshots.clear(workspace.id));
  const watch = new WorkspaceWatchService(new WorkspaceDomainState(), vi.fn(), vi.fn(), unused);
  let changesRevision = 0;
  const snapshots = new WorkspaceWatchSnapshotService({
    requireWorkspace,
    watch,
    files: { list: files } as never,
    changes: { current: changes, revision: () => changesRevision } as never,
    listSessions: sessions,
    nodeId: () => 'node-1',
    emitWatchEvent: (event) => events.push(event as (typeof events)[number])
  });
  const controller = new WorkspaceWatchController({
    requireWorkspace,
    watch,
    snapshots,
    nodeGeneration: () => 'generation-1'
  });
  let sequence = 0;
  async function select(
    group: 'MAIN' | 'CHILD',
    overrides: Record<string, unknown> = {},
    topics: Record<string, unknown> = {}
  ) {
    const watchId = `watch-id-${++sequence}`;
    await controller.operations()['workspace.watch']!({
      workspaceId: workspace.id,
      watchId,
      workbenchConnectionId: 'connection-1',
      mode: 'initial',
      topics: {
        sessions: true,
        sessionGroup: group,
        files: { path: '.' },
        changes: true,
        ...topics
      },
      ...overrides
    });
    return watchId;
  }
  async function settled(watchId: string) {
    await vi.waitFor(() =>
      expect(events.filter((event) => event.watchId === watchId)).toHaveLength(3)
    );
  }
  return {
    events,
    files,
    changes,
    sessions,
    unused,
    snapshots,
    select,
    settled,
    markChangesStale() {
      changesRevision += 1;
    },
    close() {
      watch.clearAll();
      snapshots.clearAll();
    }
  };
}

describe('Workspace Watch session group switching', () => {
  it('reads only sessions and hands off the last resource snapshots to the new watch', async () => {
    const f = fixture();
    try {
      const main = await f.select('MAIN');
      await f.settled(main);
      const child = await f.select('CHILD');
      await f.settled(child);
      const mainAgain = await f.select('MAIN');
      await f.settled(mainAgain);
      expect(f.files).toHaveBeenCalledTimes(1);
      expect(f.changes).toHaveBeenCalledTimes(1);
      expect(f.unused).not.toHaveBeenCalled();
      expect(f.sessions.mock.calls.map(([, group]) => group)).toEqual(['MAIN', 'CHILD', 'MAIN']);
      expect(f.events.filter((event) => event.watchId === child)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            topic: 'files',
            payload: {
              files: { entries: [{ name: 'first.txt' }], nextCursor: null },
              workspace: expect.any(Object)
            }
          }),
          expect.objectContaining({
            topic: 'changes',
            payload: { changes: [{ path: 'first.txt' }] }
          }),
          expect.objectContaining({ topic: 'sessions', payload: { sessions: [{ id: 'CHILD' }] } })
        ])
      );
    } finally {
      f.close();
    }
  });

  it.each(['files', 'changes'] as const)(
    'does not hand off stale %s while its refresh is in flight',
    async (topic) => {
      const f = fixture();
      let release!: (value: never) => void;
      try {
        await f.settled(await f.select('MAIN'));
        const pending = new Promise<never>((resolve) => {
          release = resolve;
        });
        f[topic].mockImplementation(() => pending);
        const updating = f.snapshots.invalidate('workspace-1', topic);
        const child = await f.select('CHILD');
        const fresh =
          topic === 'files'
            ? { entries: [{ name: 'fresh.txt' }], nextCursor: null }
            : { changes: [{ path: 'fresh.txt' }] };
        release(fresh as never);
        await updating;
        await f.settled(child);
        const delivered = f.events.find(
          (event) => event.watchId === child && event.topic === topic
        );
        expect(delivered?.payload).toEqual(
          topic === 'files' ? { files: fresh, workspace: expect.any(Object) } : fresh
        );
      } finally {
        release?.({} as never);
        f.close();
      }
    }
  );

  it.each(['same-group', 'directory', 'connection', 'owner', 'workspace'] as const)(
    'reads resources normally for a %s replacement',
    async (change) => {
      const f = fixture();
      try {
        await f.settled(await f.select('MAIN'));
        const next = await f.select(
          change === 'same-group' ? 'MAIN' : 'CHILD',
          change === 'connection'
            ? { workbenchConnectionId: 'connection-2' }
            : change === 'owner'
              ? { __workspaceWatchSessionHash: 'other-owner' }
              : change === 'workspace'
                ? { workspaceId: 'workspace-2' }
                : {},
          change === 'directory' ? { files: { path: 'src' } } : {}
        );
        await f.settled(next);
        expect(f.files).toHaveBeenCalledTimes(2);
        expect(f.changes).toHaveBeenCalledTimes(2);
      } finally {
        f.close();
      }
    }
  );

  it('reads an invalidated Git snapshot even before its scheduled refresh starts', async () => {
    const f = fixture();
    try {
      await f.settled(await f.select('MAIN'));
      f.markChangesStale();
      await f.settled(await f.select('CHILD'));
      expect(f.files).toHaveBeenCalledTimes(1);
      expect(f.changes).toHaveBeenCalledTimes(2);
    } finally {
      f.close();
    }
  });

  it.each(['files', 'changes'] as const)(
    'retries a failed %s topic instead of handing off stale data',
    async (topic) => {
      const f = fixture();
      try {
        await f.settled(await f.select('MAIN'));
        f[topic].mockRejectedValueOnce(new Error('READ_FAILED'));
        await f.snapshots.invalidate('workspace-1', topic);
        await f.settled(await f.select('CHILD'));
        expect(f[topic]).toHaveBeenCalledTimes(3);
        expect(f[topic === 'files' ? 'changes' : 'files']).toHaveBeenCalledTimes(1);
      } finally {
        f.close();
      }
    }
  );

  it('completes a pending first Files page only for the replacement group', async () => {
    const f = fixture();
    let release!: (value: { entries: { name: string }[]; nextCursor: null }) => void;
    const pending = new Promise<{ entries: { name: string }[]; nextCursor: null }>((resolve) => {
      release = resolve;
    });
    try {
      f.files.mockImplementationOnce(() => pending);
      const main = await f.select('MAIN');
      const child = await f.select('CHILD');
      release({ entries: [{ name: 'fresh.txt' }], nextCursor: null });
      await f.settled(child);
      expect(f.files).toHaveBeenCalledTimes(1);
      expect(f.events.filter((event) => event.watchId === main && event.topic === 'files')).toEqual(
        []
      );
    } finally {
      release({ entries: [], nextCursor: null });
      f.close();
    }
  });

  it('does not reread this page directory when another page is loading a different directory', async () => {
    const f = fixture();
    let release!: (value: { entries: { name: string }[]; nextCursor: null }) => void;
    const pending = new Promise<{ entries: { name: string }[]; nextCursor: null }>((resolve) => {
      release = resolve;
    });
    try {
      await f.settled(await f.select('MAIN'));
      f.files.mockImplementationOnce(() => pending);
      const other = await f.select(
        'MAIN',
        { workbenchConnectionId: 'other-page' },
        { files: { path: 'src' } }
      );
      await f.settled(await f.select('CHILD'));
      expect(f.files).toHaveBeenCalledTimes(2);
      release({ entries: [], nextCursor: null });
      await f.settled(other);
    } finally {
      release({ entries: [], nextCursor: null });
      f.close();
    }
  });
});
