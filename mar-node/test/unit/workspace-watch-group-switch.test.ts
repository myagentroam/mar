import { describe, expect, it, vi } from 'vitest';
import type { NodeWorkspace } from '../../src/database.js';
import { WorkspaceWatchController } from '../../src/service/workspace-watch-controller.js';
import { WorkspaceWatchService } from '../../src/workspace/workspace-watch-service.js';
import { WorkspaceWatchSnapshotService } from '../../src/workspace/workspace-watch-snapshot-service.js';

function fixture() {
  const workspace: NodeWorkspace = {
    id: 'workspace-1',
    path: '/fixture',
    kind: 'GIT_WORKSPACE',
    gitSummary: null
  };
  const events: Array<{
    watchId: string;
    workbenchConnectionId: string;
    topic: string;
    payload: unknown;
  }> = [];
  const files = vi.fn(async () => ({ entries: [{ name: 'first.txt' }], nextCursor: null }));
  const changes = vi.fn(async () => ({ changes: [{ path: 'first.txt' }] }));
  const sessions = vi.fn(async (_id: string, group?: 'MAIN' | 'CHILD') => ({
    sessions: [{ id: group ?? 'ALL' }]
  }));
  const navigation = vi.fn(
    async (_id: string, query: { treeAnchor?: string | undefined }, _userId?: number) => ({
      anchor: query.treeAnchor
    })
  );
  const requireWorkspace = (id: unknown) =>
    id === workspace.id ? workspace : { ...workspace, id: String(id), path: '/other' };
  const unused = vi.fn(() => snapshots.clear(workspace.id));
  const watch = new WorkspaceWatchService(vi.fn(), vi.fn(), unused);
  let changesRevision = 0;
  const snapshots = new WorkspaceWatchSnapshotService({
    requireWorkspace,
    watch,
    files: { list: files } as never,
    changes: { current: changes, revision: () => changesRevision } as never,
    listSessions: sessions,
    sessionNavigation: navigation,
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
    navigation,
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
  const summary = { sessionIds: [], summaryAnchors: ['one'], limit: 20 };
  const collaboration = { ...summary, treeAnchor: 'one', collaboration: {} };

  it('rejects invalid navigation query shapes with the existing watch error code', async () => {
    const f = fixture();
    try {
      for (const sessionNavigation of [
        { sessionIds: [''], summaryAnchors: [], limit: 10 },
        { sessionIds: [], summaryAnchors: [], limit: 101 },
        { sessionIds: [], summaryAnchors: [], limit: 10, unexpected: true }
      ]) {
        await expect(f.select('MAIN', {}, { sessionNavigation })).rejects.toThrow(
          'WORKSPACE_WATCH_INVALID'
        );
      }
    } finally {
      f.close();
    }
  });

  it('hands off unchanged topics while initializing each new navigation query', async () => {
    const f = fixture();
    try {
      const first = await f.select(
        'MAIN',
        {},
        {
          sessionNavigation: {
            sessionIds: ['one'],
            summaryAnchors: ['one'],
            treeAnchor: 'one',
            limit: 20
          }
        }
      );
      await vi.waitFor(() =>
        expect(f.events.filter((event) => event.watchId === first)).toHaveLength(4)
      );
      const second = await f.select(
        'MAIN',
        {},
        {
          sessionNavigation: {
            sessionIds: ['one'],
            summaryAnchors: ['one'],
            treeAnchor: 'two',
            limit: 20
          }
        }
      );
      await vi.waitFor(() =>
        expect(f.events.filter((event) => event.watchId === second)).toHaveLength(4)
      );
      expect(f.sessions).toHaveBeenCalledTimes(1);
      expect(f.files).toHaveBeenCalledTimes(1);
      expect(f.changes).toHaveBeenCalledTimes(1);
      expect(f.navigation).toHaveBeenCalledTimes(2);
      expect(f.events).toContainEqual(
        expect.objectContaining({
          watchId: second,
          topic: 'sessionNavigation',
          payload: { anchor: 'two' }
        })
      );
    } finally {
      f.close();
    }
  });
  it('passes the authenticated user to each Watch and reinitializes navigation when picking a board', async () => {
    const f = fixture();
    const graph = {
      sessionIds: [],
      summaryAnchors: [],
      treeAnchor: 'one',
      collaboration: {},
      limit: 20
    };
    const board = { ...graph, collaboration: { boardSessionId: 'one' } };
    try {
      const firstUser = { __requestUserId: 7, __workspaceWatchSessionHash: 'first' };
      const secondUser = { __requestUserId: 8, __workspaceWatchSessionHash: 'second' };
      await f.select('MAIN', firstUser, { sessionNavigation: graph });
      await f.select('MAIN', secondUser, { sessionNavigation: graph });
      await vi.waitFor(() => expect(f.navigation).toHaveBeenCalledTimes(2));
      expect(f.navigation).toHaveBeenCalledWith('workspace-1', graph, 7);
      expect(f.navigation).toHaveBeenCalledWith('workspace-1', graph, 8);
      f.sessions.mockClear();
      f.files.mockClear();
      f.changes.mockClear();
      const selected = await f.select('MAIN', firstUser, { sessionNavigation: board });
      await vi.waitFor(() =>
        expect(f.events.filter((event) => event.watchId === selected)).toHaveLength(4)
      );
      expect(f.navigation).toHaveBeenLastCalledWith('workspace-1', board, 7);
      expect(f.sessions).not.toHaveBeenCalled();
      expect(f.files).not.toHaveBeenCalled();
      expect(f.changes).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

  it('isolates navigation projections by active lease', async () => {
    const f = fixture();
    const watchId = 'shared-watch-id';
    const connections = [
      {
        workbenchConnectionId: 'connection-1',
        __workspaceWatchSessionHash: 'first',
        __requestUserId: 7
      },
      {
        workbenchConnectionId: 'connection-2',
        __workspaceWatchSessionHash: 'second',
        __requestUserId: 8
      }
    ];
    try {
      await Promise.all(
        connections.map((connection) =>
          f.select('MAIN', { ...connection, watchId }, { sessionNavigation: collaboration })
        )
      );
      await vi.waitFor(() =>
        expect(f.events.filter(({ topic }) => topic === 'sessionNavigation')).toHaveLength(2)
      );
      f.events.length = 0;
      f.navigation.mockImplementation(async (_id, query, userId) => ({
        anchor: `${query.treeAnchor}:${userId}`
      }));

      await f.snapshots.invalidate('workspace-1', 'sessionNavigation');

      expect(f.events).toEqual(
        connections.map((connection) =>
          expect.objectContaining({
            workbenchConnectionId: connection.workbenchConnectionId,
            topic: 'sessionNavigation',
            payload: { anchor: `one:${connection.__requestUserId}` }
          })
        )
      );
    } finally {
      f.close();
    }
  });

  it('discards a replaced lease’s pending navigation result when the watch ID is retained', async () => {
    const f = fixture();
    const watchId = 'shared-watch-id';
    let complete!: (value: { anchor: string }) => void;
    const oldRead = new Promise<{ anchor: string }>((resolve) => {
      complete = resolve;
    });
    try {
      f.navigation.mockReturnValueOnce(oldRead);
      await f.select('MAIN', { watchId }, { sessionNavigation: collaboration });
      await f.select(
        'MAIN',
        { watchId },
        { sessionNavigation: { ...collaboration, treeAnchor: 'two' } }
      );
      complete({ anchor: 'one' });
      // Drain delivery from the old read before checking that it never published.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.events.filter(({ topic }) => topic === 'sessionNavigation')).toEqual([
        expect.objectContaining({ payload: { anchor: 'two' } })
      ]);
    } finally {
      complete({ anchor: 'one' });
      f.close();
    }
  });

  it('refreshes only collaboration leases on whiteboard changes and still refreshes all navigation on session changes', async () => {
    const f = fixture();
    try {
      await f.select('MAIN', {}, { sessionNavigation: summary });
      await vi.waitFor(() => expect(f.events).toHaveLength(4));
      f.events.length = 0;
      f.navigation.mockClear();

      await f.snapshots.invalidate('workspace-1', 'collaboration');
      expect(f.navigation).not.toHaveBeenCalled();
      expect(f.events).toEqual([]);

      const watchId = await f.select(
        'MAIN',
        { workbenchConnectionId: 'connection-2' },
        { sessionNavigation: collaboration }
      );
      await vi.waitFor(() => expect(f.events).toHaveLength(4));
      f.events.length = 0;
      f.navigation.mockClear();

      await f.snapshots.invalidate('workspace-1', 'collaboration');
      expect(f.navigation.mock.calls.map(([, query]) => query)).toEqual([collaboration]);
      expect(f.events).toEqual([expect.objectContaining({ watchId, topic: 'sessionNavigation' })]);

      f.events.length = 0;
      f.navigation.mockClear();
      await f.snapshots.invalidate('workspace-1', 'sessions');
      await vi.waitFor(() =>
        expect(f.events.filter(({ topic }) => topic === 'sessionNavigation')).toHaveLength(2)
      );
      expect(f.navigation.mock.calls.map(([, query]) => query)).toEqual([summary, collaboration]);
    } finally {
      f.close();
    }
  });

  it('keeps full navigation invalidation pending when whiteboard refreshes overlap', async () => {
    const f = fixture();
    let complete!: (value: { anchor: string }) => void;
    const pending = new Promise<{ anchor: string }>((resolve) => {
      complete = resolve;
    });
    try {
      await f.select('MAIN', {}, { sessionNavigation: summary });
      await f.select(
        'MAIN',
        { workbenchConnectionId: 'connection-2' },
        { sessionNavigation: collaboration }
      );
      await vi.waitFor(() => expect(f.events).toHaveLength(8));
      f.events.length = 0;
      f.navigation.mockClear();
      f.navigation.mockReturnValueOnce(pending);

      const narrow = f.snapshots.invalidate('workspace-1', 'collaboration');
      const full = f.snapshots.invalidate('workspace-1', 'sessionNavigation');
      const laterNarrow = f.snapshots.invalidate('workspace-1', 'collaboration');
      expect(f.navigation.mock.calls.map(([, query]) => query)).toEqual([collaboration]);
      complete({ anchor: 'one' });
      await Promise.all([narrow, full, laterNarrow]);

      await vi.waitFor(() => expect(f.events).toHaveLength(3));
      expect(f.navigation.mock.calls.map(([, query]) => query)).toEqual([
        collaboration,
        summary,
        collaboration
      ]);
    } finally {
      complete({ anchor: 'one' });
      f.close();
    }
  });

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

  it.each(['files', 'changes', 'sessions', 'navigation'] as const)(
    'does not reschedule the current view because an obsolete %s read is still pending',
    async (resource) => {
      const f = fixture();
      let release!: (value: never) => void;
      const pending = new Promise<never>((resolve) => {
        release = resolve;
      });
      const topic = resource === 'navigation' ? 'sessionNavigation' : resource;
      const navigation = (anchor: string) => ({
        sessionIds: [anchor],
        summaryAnchors: [],
        treeAnchor: anchor,
        limit: 20
      });
      try {
        f[resource].mockImplementationOnce(() => pending);
        const previous = await f.select(
          'MAIN',
          {},
          resource === 'navigation' ? { sessionNavigation: navigation('one') } : {}
        );
        if (resource === 'changes') f.markChangesStale();
        const current = await f.select(
          'CHILD',
          {},
          resource === 'files'
            ? { files: { path: 'src' } }
            : resource === 'navigation'
              ? { sessionNavigation: navigation('two') }
              : {}
        );
        await vi.waitFor(() =>
          expect(f.events.filter((event) => event.watchId === current)).toHaveLength(
            resource === 'navigation' ? 4 : 3
          )
        );

        await f.snapshots.invalidate('workspace-1', topic);
        const reads = f[resource].mock.calls.length;
        // An unresolved obsolete view must not keep scheduling the settled current view.
        for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();

        expect(f[resource]).toHaveBeenCalledTimes(reads);
        expect(f[resource]).toHaveBeenCalledTimes(3);
        expect(
          f.events.filter((event) => event.watchId === previous && event.topic === topic)
        ).toEqual([]);
      } finally {
        release({} as never);
        f.close();
        await f.snapshots.ensureSnapshot('workspace-1', topic);
      }
    }
  );

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
