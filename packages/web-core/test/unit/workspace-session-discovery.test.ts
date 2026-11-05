import { workspaceTargetRef } from './support/workspace-fixture.js';
import { nextTick, ref, watch } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceSessionService } from '../../src/service/workspace-session-service.js';
import { createWorkspaceSessionPagingService } from '../../src/service/workspace-session-paging-service.js';

function state(
  runs: readonly Record<string, unknown>[] = [],
  request: ReturnType<typeof vi.fn> = vi.fn(),
  groupingSupported?: () => boolean
) {
  const sessions = ref<Record<string, unknown>[]>([]);
  const selectedNodeId = ref('node-1');
  const selectedWorkspaceId = ref('workspace-1');
  const paging = createWorkspaceSessionPagingService(10);
  const notice = vi.fn();
  const controller = createWorkspaceSessionService({
    sessions: sessions as never,
    runs: { value: runs } as never,
    workspaceTarget: workspaceTargetRef(selectedNodeId, selectedWorkspaceId),
    selectedSessionId: { value: 'session-1' } as never,
    paging,
    pageSize: 10,
    ...(groupingSupported === undefined ? {} : { groupingSupported }),
    tabId: (nodeId, workspaceId) => `${nodeId}:${workspaceId}`,
    request: request as never,
    notice,
    errorMessage: String
  });
  return {
    sessions: sessions as { value: Record<string, unknown>[] },
    selectedNodeId,
    selectedWorkspaceId,
    paging,
    notice,
    controller
  };
}

describe('Web Workspace Session Discovery', () => {
  it.each(['event', 'page', 'watch'] as const)(
    'Keeps the list reference when an equivalent %s update arrives',
    (source) => {
      const { sessions, controller, paging } = state();
      sessions.value = [
        { id: 'session-1', workspaceId: 'workspace-1', runner: 'codex', activity: 'IDLE' },
        { id: 'session-2', workspaceId: 'workspace-1', runner: 'codex', activity: 'IDLE' }
      ];
      const current = sessions.value;
      const listChanged = vi.fn();
      const stop = watch(() => sessions.value, listChanged, { flush: 'sync' });
      paging.visibleLimits.value.set('node-1:workspace-1', 30);
      for (let index = 0; index < 2; index += 1) {
        const next = current.map((session) => ({ ...session }));
        if (source === 'watch')
          controller.applySnapshot('node-1', 'workspace-1', {
            sessions: next as never,
            nextCursor: `cursor-${index}`
          });
        else controller.merge(next as never, { authoritativeOrder: source === 'page' });
        expect(sessions.value).toBe(current);
        expect(sessions.value[0]).toBe(current[0]);
        expect(sessions.value[1]).toBe(current[1]);
      }
      if (source === 'watch') {
        expect(paging.nextCursors.value.get('node-1:workspace-1')).toBe('cursor-1');
        expect(paging.visibleLimits.value.get('node-1:workspace-1')).toBe(30);
      }
      expect(listChanged).not.toHaveBeenCalled();
      stop();
    }
  );

  it('Keeps an empty list reference across empty events and Watch snapshots', () => {
    const { sessions, controller, paging } = state();
    const current = sessions.value;
    controller.merge([]);
    expect(sessions.value).toBe(current);
    controller.applySnapshot('node-1', 'workspace-1', { sessions: [], nextCursor: null });
    expect(sessions.value).toBe(current);
    expect(paging.nextCursors.value.get('node-1:workspace-1')).toBeNull();
  });

  it.each(['resolve', 'reject'] as const)(
    'Restores the latest authoritative Watch page when its fallback list request is superseded and later %s',
    async (completion) => {
      let finish!: (page: unknown) => void;
      let fail!: (error: Error) => void;
      const request = vi.fn(
        () =>
          new Promise((resolve, reject) => {
            finish = resolve;
            fail = reject;
          })
      );
      const { controller, sessions } = state([], request);
      const restoring = controller.synchronize('workspace-1', true);
      const snapshot = {
        sessions: [
          { id: 'authoritative-fallback', workspaceId: 'workspace-1', runner: 'codex' as const }
        ],
        nextCursor: 'snapshot-cursor'
      };
      controller.applySnapshot('node-1', 'workspace-1', snapshot);
      if (completion === 'resolve')
        finish({
          sessions: [{ id: 'stale-fallback', workspaceId: 'workspace-1' }],
          nextCursor: null
        });
      else fail(new Error('Superseded fallback failed'));
      await expect(restoring).resolves.toEqual(snapshot);
      expect(sessions.value.map((session) => session.id)).toEqual(['authoritative-fallback']);
    }
  );

  it('Preserves loaded visibility and rejects an older pagination result after a progressive Runner snapshot', async () => {
    const first = Array.from({ length: 10 }, (_, index) => ({
      id: `first-${index}`,
      workspaceId: 'workspace-1',
      runner: 'mar-agent' as const
    }));
    const second = Array.from({ length: 10 }, (_, index) => ({
      id: `second-${index}`,
      workspaceId: 'workspace-1',
      runner: 'mar-agent' as const
    }));
    let finish!: (page: unknown) => void;
    let finishRebase!: (page: unknown) => void;
    const request = vi
      .fn()
      .mockResolvedValueOnce({ sessions: second, nextCursor: 'old-next' })
      .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (finishRebase = resolve)));
    const { controller, paging, sessions } = state([], request);
    controller.applySnapshot('node-1', 'workspace-1', {
      sessions: first,
      nextCursor: 'first-cursor'
    });
    await controller.loadMore();
    expect(paging.visibleLimits.value.get('node-1:workspace-1')).toBe(20);
    const loading = controller.loadMore();
    controller.applySnapshot('node-1', 'workspace-1', {
      sessions: [
        { id: 'slow-pinned', workspaceId: 'workspace-1', runner: 'codex', pinOrder: 0 },
        ...first.slice(0, 9)
      ],
      nextCursor: 'new-cursor'
    });
    expect(controller.listedSessionIds.value.size).toBe(20);
    finish({
      sessions: [{ id: 'stale-page', workspaceId: 'workspace-1' }],
      nextCursor: 'stale-cursor'
    });
    await loading;
    expect(paging.loadingMore.value).toBe(true);
    const rebasedTail = [...first.slice(9), ...second.slice(0, 9)];
    finishRebase({ sessions: rebasedTail, nextCursor: 'rebased-cursor' });
    await vi.waitFor(() => expect(paging.loadingMore.value).toBe(false));
    expect(paging.nextCursors.value.get('node-1:workspace-1')).toBe('rebased-cursor');
    expect(paging.visibleLimits.value.get('node-1:workspace-1')).toBe(20);
    expect(sessions.value[0]?.id).toBe('slow-pinned');
    expect(sessions.value.some((session) => session.id === 'stale-page')).toBe(false);
    expect(sessions.value.some((session) => session.id === 'second-9')).toBe(true);
    expect(controller.listedSessionIds.value.has('second-9')).toBe(false);
    expect(controller.listedSessionIds.value.has('first-9')).toBe(true);
    expect(controller.listedSessionIds.value.size).toBe(20);
    expect(request.mock.calls[2]?.[0]).toContain('limit=10&cursor=new-cursor');
  });

  it('Does not replay older snapshot or page metadata over events received while rebuilding the directory', async () => {
    const entries = Array.from({ length: 25 }, (_, index) => ({
      id: `session-${index}`,
      workspaceId: 'workspace-1',
      runner: 'codex' as const,
      runnerTitle: `Original ${index}`,
      lastActivityAt: index
    }));
    let finish!: (page: unknown) => void;
    const request = vi
      .fn()
      .mockResolvedValueOnce({ sessions: entries.slice(10, 20), nextCursor: 'old-20' })
      .mockResolvedValueOnce({ sessions: entries.slice(20), nextCursor: null })
      .mockResolvedValueOnce({ sessions: entries.slice(10, 20), nextCursor: 'new-20' })
      .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const { controller, paging, sessions } = state([], request);
    controller.applySnapshot('node-1', 'workspace-1', {
      sessions: entries.slice(0, 10),
      nextCursor: 'old-10'
    });
    await controller.loadMore();
    await controller.loadMore();
    controller.applySnapshot('node-1', 'workspace-1', {
      sessions: entries.slice(0, 10),
      nextCursor: 'new-10'
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4));
    controller.merge([
      { ...entries[0]!, runnerTitle: 'Newer head title', lastActivityAt: 1000 },
      { ...entries[10]!, runnerTitle: 'Newer page title', lastActivityAt: 1001 },
      { ...entries[20]!, runnerTitle: 'Updated before page response', lastActivityAt: 1002 }
    ]);
    finish({ sessions: entries.slice(20), nextCursor: null });
    await vi.waitFor(() => expect(paging.loadingMore.value).toBe(false));
    expect(sessions.value.find((entry) => entry.id === entries[0]!.id)).toMatchObject({
      runnerTitle: 'Newer head title',
      lastActivityAt: 1000
    });
    expect(sessions.value.find((entry) => entry.id === entries[10]!.id)).toMatchObject({
      runnerTitle: 'Newer page title',
      lastActivityAt: 1001
    });
    expect(sessions.value.find((entry) => entry.id === entries[20]!.id)).toMatchObject({
      runnerTitle: 'Updated before page response',
      lastActivityAt: 1002
    });
    expect(controller.listedSessionIds.value.size).toBe(25);
    expect(paging.nextCursors.value.get('node-1:workspace-1')).toBeNull();
  });

  it('Continues snapshot pagination when a changed session repeats but the cursor advances', async () => {
    const entries = Array.from({ length: 11 }, (_, index) => ({
      id: `session-${index}`,
      workspaceId: 'workspace-1',
      runner: 'codex' as const
    }));
    const request = vi
      .fn()
      .mockResolvedValueOnce({ sessions: entries.slice(10), nextCursor: null })
      .mockResolvedValueOnce({ sessions: [entries[0]], nextCursor: 'advanced-cursor' })
      .mockResolvedValueOnce({ sessions: entries.slice(10), nextCursor: null });
    const { controller, paging } = state([], request);
    controller.applySnapshot('node-1', 'workspace-1', {
      sessions: entries.slice(0, 10),
      nextCursor: 'original-cursor'
    });
    await controller.loadMore();
    controller.applySnapshot('node-1', 'workspace-1', {
      sessions: entries.slice(0, 10),
      nextCursor: 'fresh-cursor'
    });
    await vi.waitFor(() => expect(paging.loadingMore.value).toBe(false));
    expect(paging.loadMoreErrors.value.get('node-1:workspace-1')).toBeUndefined();
    expect([...controller.listedSessionIds.value]).toEqual(entries.map((entry) => entry.id));
    expect(paging.nextCursors.value.get('node-1:workspace-1')).toBeNull();
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2]?.[0]).toContain('cursor=advanced-cursor');
  });

  it('Rebuilds only the loaded range across multiple pages without prefetching the remaining directory', async () => {
    const entries = Array.from({ length: 40 }, (_, index) => ({
      id: `session-${index}`,
      workspaceId: 'workspace-1',
      runner: 'codex' as const
    }));
    let catalog = entries.slice(15);
    const request = vi.fn(async (path: string) => {
      const query = new URL(path, 'http://localhost').searchParams;
      const start = Number(query.get('cursor'));
      const limit = catalog === entries && start === 10 ? 4 : Number(query.get('limit'));
      const end = Math.min(catalog.length, start + limit);
      return {
        sessions: catalog.slice(start, end),
        nextCursor: end < catalog.length ? String(end) : null
      };
    });
    const { controller, paging } = state([], request);
    controller.applySnapshot('node-1', 'workspace-1', {
      sessions: catalog.slice(0, 10),
      nextCursor: '10'
    });
    await controller.loadMore();
    await controller.loadMore();
    expect(controller.listedSessionIds.value.size).toBe(25);
    catalog = entries;
    controller.applySnapshot('node-1', 'workspace-1', {
      sessions: catalog.slice(0, 10),
      nextCursor: '10'
    });
    await vi.waitFor(() => expect(paging.loadingMore.value).toBe(false));
    expect([...controller.listedSessionIds.value]).toEqual(
      catalog.slice(0, 25).map((entry) => entry.id)
    );
    expect(paging.nextCursors.value.get('node-1:workspace-1')).toBe('25');
    expect(request).toHaveBeenCalledTimes(5);
    expect(request.mock.calls[4]?.[0]).toContain('limit=1&cursor=24');
  });

  it('Keeps loaded rows when snapshot pagination fails and retries from the latest authoritative cursor', async () => {
    const first = Array.from({ length: 10 }, (_, index) => ({
      id: `session-${index}`,
      workspaceId: 'workspace-1',
      runner: 'codex' as const
    }));
    const tail = { id: 'cached-tail', workspaceId: 'workspace-1', runner: 'codex' as const };
    const error = new Error('Snapshot page unavailable');
    const request = vi
      .fn()
      .mockResolvedValueOnce({ sessions: [tail], nextCursor: null })
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ sessions: [], nextCursor: null });
    const { controller, paging } = state([], request);
    controller.applySnapshot('node-1', 'workspace-1', {
      sessions: first,
      nextCursor: 'original-cursor'
    });
    await controller.loadMore();
    controller.applySnapshot('node-1', 'workspace-1', {
      sessions: first,
      nextCursor: 'fresh-cursor'
    });
    await vi.waitFor(() =>
      expect(paging.loadMoreErrors.value.get('node-1:workspace-1')).toBe(error)
    );
    expect(controller.listedSessionIds.value.has(tail.id)).toBe(true);
    expect(controller.listedSessionIds.value.size).toBe(11);
    await controller.loadMore();
    expect(controller.listedSessionIds.value.has(tail.id)).toBe(false);
    expect(controller.listedSessionIds.value.size).toBe(10);
    expect(paging.nextCursors.value.get('node-1:workspace-1')).toBeNull();
    expect(paging.loadMoreErrors.value.has('node-1:workspace-1')).toBe(false);
    expect(request.mock.calls[1]?.[0]).toContain('limit=1&cursor=fresh-cursor');
    expect(request.mock.calls[2]?.[0]).toContain('limit=1&cursor=fresh-cursor');
  });

  it.each(['snapshot', 'workspace', 'group'] as const)(
    'Discards snapshot pagination after a newer %s supersedes it',
    async (change) => {
      const first = Array.from({ length: 10 }, (_, index) => ({
        id: `session-${index}`,
        workspaceId: 'workspace-1',
        runner: 'codex' as const
      }));
      let finish!: (page: unknown) => void;
      const request = vi
        .fn()
        .mockResolvedValueOnce({
          sessions: [{ id: 'tail', workspaceId: 'workspace-1', runner: 'codex' }],
          nextCursor: null
        })
        .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
      const { controller, paging, selectedWorkspaceId, sessions } = state([], request, () => true);
      controller.applySnapshot('node-1', 'workspace-1', { sessions: first, nextCursor: 'first' });
      await controller.loadMore();
      controller.applySnapshot('node-1', 'workspace-1', { sessions: first, nextCursor: 'new' });
      expect(paging.loadingMore.value).toBe(true);
      if (change === 'workspace') selectedWorkspaceId.value = 'workspace-2';
      if (change === 'group') controller.selectGroup('CHILD');
      await nextTick();
      controller.applySnapshot('node-1', selectedWorkspaceId.value, {
        sessions: [],
        nextCursor: null
      });
      finish({
        sessions: [{ id: 'stale-tail', workspaceId: 'workspace-1', runner: 'codex' }],
        nextCursor: 'stale-cursor'
      });
      await vi.waitFor(() => expect(paging.loadingMore.value).toBe(false));
      expect(controller.listedSessionIds.value.size).toBe(0);
      expect(sessions.value.some((session) => session.id === 'stale-tail')).toBe(false);
      expect(paging.nextCursors.value.get(`node-1:${selectedWorkspaceId.value}`)).toBeNull();
    }
  );

  it('Stops snapshot pagination on a non-advancing cursor without dropping loaded rows', async () => {
    const first = Array.from({ length: 10 }, (_, index) => ({
      id: `session-${index}`,
      workspaceId: 'workspace-1',
      runner: 'codex' as const
    }));
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessions: [{ id: 'tail', workspaceId: 'workspace-1', runner: 'codex' }],
        nextCursor: null
      })
      .mockResolvedValue({ sessions: [], nextCursor: 'new-cursor' });
    const { controller, paging } = state([], request);
    controller.applySnapshot('node-1', 'workspace-1', { sessions: first, nextCursor: 'first' });
    await controller.loadMore();
    controller.applySnapshot('node-1', 'workspace-1', {
      sessions: first,
      nextCursor: 'new-cursor'
    });
    await vi.waitFor(() =>
      expect(paging.loadMoreErrors.value.get('node-1:workspace-1')).toEqual(
        new Error('SESSION_PAGINATION_NO_PROGRESS')
      )
    );
    expect(controller.listedSessionIds.value.size).toBe(11);
    expect(paging.loadingMore.value).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('Retains existing sessions and the cursor after a page failure, then retries successfully', async () => {
    const error = new TypeError('Session page unavailable');
    let resolveRetry!: (page: unknown) => void;
    const retryPage = new Promise((resolve) => (resolveRetry = resolve));
    const request = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockImplementationOnce(() => retryPage);
    const { controller, notice, paging, sessions } = state([], request);
    const existing = { id: 'existing', workspaceId: 'workspace-1', runner: 'codex' };
    sessions.value = [existing];
    paging.nextCursors.value.set('node-1:workspace-1', 'cursor-one');

    await controller.loadMore();

    expect(sessions.value).toEqual([existing]);
    expect(paging.nextCursors.value.get('node-1:workspace-1')).toBe('cursor-one');
    expect(paging.loadMoreErrors.value.get('node-1:workspace-1')).toBe(error);
    expect(paging.loadingMore.value).toBe(false);
    expect(notice).not.toHaveBeenCalled();

    const retry = controller.loadMore();
    expect(paging.loadMoreErrors.value.has('node-1:workspace-1')).toBe(false);
    expect(paging.loadingMore.value).toBe(true);
    resolveRetry({
      sessions: [{ id: 'added', workspaceId: 'workspace-1', runner: 'codex' }],
      nextCursor: 'cursor-two'
    });
    await retry;

    expect(sessions.value.map((session) => session.id)).toEqual(['existing', 'added']);
    expect(paging.nextCursors.value.get('node-1:workspace-1')).toBe('cursor-two');
    expect(paging.loadMoreErrors.value.has('node-1:workspace-1')).toBe(false);
    expect(paging.loadingMore.value).toBe(false);
  });

  it('Treats a non-advancing ordinary session cursor as a page failure without merging the page', async () => {
    const existing = { id: 'existing', workspaceId: 'workspace-1', runner: 'codex' };
    const { controller, notice, paging, sessions } = state(
      [],
      vi.fn().mockResolvedValue({
        sessions: [{ id: 'duplicate-page', workspaceId: 'workspace-1', runner: 'codex' }],
        nextCursor: 'cursor-one'
      })
    );
    sessions.value = [existing];
    paging.nextCursors.value.set('node-1:workspace-1', 'cursor-one');

    await controller.loadMore();

    expect(sessions.value).toEqual([existing]);
    expect(paging.nextCursors.value.get('node-1:workspace-1')).toBe('cursor-one');
    expect(paging.loadMoreErrors.value.get('node-1:workspace-1')).toMatchObject({
      message: 'SESSION_PAGINATION_NO_PROGRESS'
    });
    expect(paging.loadingMore.value).toBe(false);
    expect(notice).not.toHaveBeenCalled();
  });

  it('Does not publish a late append failure after an authoritative same-size Watch page replaces the directory', async () => {
    const initialError = new Error('Initial page failed');
    let rejectLatePage!: (error: unknown) => void;
    const latePage = new Promise((_, reject) => (rejectLatePage = reject));
    const request = vi
      .fn()
      .mockRejectedValueOnce(initialError)
      .mockImplementationOnce(() => latePage)
      .mockResolvedValueOnce({
        sessions: [{ id: 'fresh-page', workspaceId: 'workspace-1', runner: 'codex' }],
        nextCursor: null
      });
    const { controller, paging, sessions } = state([], request);
    sessions.value = [
      { id: 'session-1', workspaceId: 'workspace-1', runner: 'codex', title: 'old' }
    ];
    paging.nextCursors.value.set('node-1:workspace-1', 'old-cursor');

    await controller.loadMore();
    expect(paging.loadMoreErrors.value.get('node-1:workspace-1')).toBe(initialError);

    controller.applySnapshot('node-1', 'workspace-1', {
      sessions: [
        { id: 'session-1', workspaceId: 'workspace-1', runner: 'codex', title: 'authoritative' }
      ] as never,
      nextCursor: 'snapshot-cursor'
    });
    expect(paging.loadMoreErrors.value.has('node-1:workspace-1')).toBe(false);

    const staleLoad = controller.loadMore();
    controller.applySnapshot('node-1', 'workspace-1', {
      sessions: [
        {
          id: 'session-1',
          workspaceId: 'workspace-1',
          runner: 'codex',
          title: 'latest authoritative'
        }
      ] as never,
      nextCursor: 'latest-snapshot-cursor'
    });
    const loadingMoreAfterSnapshot = paging.loadingMore.value;
    const freshLoad = controller.loadMore();
    rejectLatePage(new Error('Stale page failed'));
    await Promise.all([staleLoad, freshLoad]);

    expect(loadingMoreAfterSnapshot).toBe(false);
    expect(request).toHaveBeenCalledTimes(3);
    expect(sessions.value).toMatchObject([
      { id: 'session-1', title: 'latest authoritative' },
      { id: 'fresh-page' }
    ]);
    expect(paging.nextCursors.value.get('node-1:workspace-1')).toBeNull();
    expect(paging.loadMoreErrors.value.has('node-1:workspace-1')).toBe(false);
    expect(paging.loadingMore.value).toBe(false);
  });

  it('Discards an append failure from a Workspace after the selected target changes', async () => {
    let rejectPage!: (error: unknown) => void;
    const pendingPage = new Promise((_, reject) => (rejectPage = reject));
    const { controller, paging, selectedWorkspaceId } = state(
      [],
      vi.fn(() => pendingPage)
    );
    paging.nextCursors.value.set('node-1:workspace-1', 'workspace-one-cursor');

    const loading = controller.loadMore();
    selectedWorkspaceId.value = 'workspace-2';
    await nextTick();
    const loadingMoreAfterTargetChange = paging.loadingMore.value;
    rejectPage(new TypeError('Old Workspace page failed'));
    await loading;

    expect(loadingMoreAfterTargetChange).toBe(false);
    expect(paging.loadMoreErrors.value.has('node-1:workspace-1')).toBe(false);
    expect(paging.nextCursors.value.get('node-1:workspace-1')).toBe('workspace-one-cursor');
    expect(paging.loadingMore.value).toBe(false);
  });

  it('Shows a newly created MAR Agent session in Node page order after refreshing the first page', async () => {
    const older = Array.from({ length: 10 }, (_, index) => ({
      id: `older-${index}`,
      workspaceId: 'workspace-1',
      runner: 'mar-agent',
      externalSessionId: `older-${index}`
    }));
    const created = {
      id: 'native-new',
      workspaceId: 'workspace-1',
      runner: 'mar-agent' as const,
      externalSessionId: 'native-new'
    };
    const request = vi.fn().mockResolvedValue({
      sessions: [created, ...older.slice(0, 9)],
      nextCursor: 'next-page'
    });
    const { sessions, controller } = state([], request);
    sessions.value = [
      { id: 'draft:local', workspaceId: 'workspace-1', runner: 'mar-agent' },
      ...older
    ];

    controller.merge([created]);
    sessions.value = sessions.value.filter((session) => session.id !== 'draft:local');
    expect(sessions.value.slice(0, 10).map((session) => session.id)).not.toContain('native-new');
    await controller.synchronize('workspace-1');

    expect(request).toHaveBeenCalledWith(
      '/api/agent-sessions?nodeId=node-1&workspaceId=workspace-1&limit=10'
    );
    expect(sessions.value.slice(0, 10).map((session) => session.id)).toContain('native-new');
    expect(sessions.value.filter((session) => session.id === 'native-new')).toHaveLength(1);
    expect(sessions.value[0]?.id).toBe('native-new');
  });

  it('Applies pinned order from the authoritative page on refresh instead of replaying the old cache order', async () => {
    const previous = { id: 'previous', workspaceId: 'workspace-1', runner: 'codex' };
    const pinned = { id: 'pinned', workspaceId: 'workspace-1', runner: 'codex', pinOrder: 0 };
    const { sessions, controller } = state(
      [],
      vi.fn().mockResolvedValue({ sessions: [pinned, previous], nextCursor: null })
    );
    sessions.value = [previous, { ...pinned, pinOrder: null }];
    await controller.refresh();
    expect(sessions.value.map((session) => session.id)).toEqual(['pinned', 'previous']);
  });

  it('Restores selection from the current authoritative page independently of the session cache retained by merging', async () => {
    const firstPage = {
      sessions: [{ id: 'new-first', workspaceId: 'workspace-1' }],
      nextCursor: null
    };
    const { sessions, controller } = state([], vi.fn().mockResolvedValue(firstPage));
    sessions.value = [{ id: 'old-cached', workspaceId: 'workspace-1' }];
    await expect(controller.synchronize('workspace-1', true)).resolves.toEqual(firstPage);
    expect(sessions.value.map((session) => session.id)).toEqual(['new-first', 'old-cached']);
  });

  it('Propagates list-read failures during selection restoration while ordinary synchronization keeps the current list', async () => {
    const error = new TypeError('Network unavailable');
    const { sessions, controller } = state([], vi.fn().mockRejectedValue(error));
    const existing = { id: 'session-1', workspaceId: 'workspace-1' };
    sessions.value = [existing];
    await expect(controller.synchronize('workspace-1', true)).rejects.toBe(error);
    expect(sessions.value).toEqual([existing]);
    await expect(controller.synchronize('workspace-1')).resolves.toBeUndefined();
    expect(sessions.value).toEqual([existing]);
  });

  it('Sends search requests to the Node session catalog, uses independent results, and does not filter loaded cache entries', async () => {
    const request = vi.fn().mockResolvedValue({
      sessions: [{ id: 'remote-match', workspaceId: 'workspace-1', runner: 'codex' }],
      nextCursor: 'next-search-page'
    });
    const { sessions, controller } = state([], request);
    sessions.value = [{ id: 'loaded-only', workspaceId: 'workspace-1', runner: 'codex' }];

    await controller.search(' release ');

    expect(request).toHaveBeenCalledWith(
      '/api/agent-sessions?nodeId=node-1&workspaceId=workspace-1&limit=10&query=release'
    );
    expect(controller.searchResults.value.map((session) => session.id)).toEqual(['remote-match']);
    expect(controller.searchNextCursor.value).toBe('next-search-page');
    expect(sessions.value.map((session) => session.id)).toEqual(['loaded-only']);
  });

  it.each(['resolve', 'reject'] as const)(
    'Keeps results and cursor during a same-query refresh that will %s',
    async (completion) => {
      let finish!: (page: unknown) => void;
      let fail!: (error: Error) => void;
      const original = { id: 'match', workspaceId: 'workspace-1', runner: 'codex' };
      const request = vi
        .fn()
        .mockResolvedValueOnce({ sessions: [original], nextCursor: 'original-cursor' })
        .mockImplementationOnce(
          () =>
            new Promise((resolve, reject) => {
              finish = resolve;
              fail = reject;
            })
        );
      const { controller, notice } = state([], request);
      await controller.search('release');
      const rows = controller.searchResults.value;
      const refreshing = controller.refresh();
      expect(controller.searchResults.value).toBe(rows);
      expect(controller.searchNextCursor.value).toBe('original-cursor');
      expect(controller.searching.value).toBe(true);
      if (completion === 'resolve') {
        finish({ sessions: [{ ...original, runnerTitle: 'Updated title' }], nextCursor: null });
      } else fail(new Error('Search unavailable'));
      await refreshing;
      expect(controller.searchResults.value.map((session) => session.id)).toEqual(['match']);
      if (completion === 'resolve') {
        expect(controller.searchResults.value[0]?.runnerTitle).toBe('Updated title');
        expect(controller.searchNextCursor.value).toBeNull();
      } else {
        expect(controller.searchResults.value).toBe(rows);
        expect(controller.searchNextCursor.value).toBe('original-cursor');
        expect(notice).toHaveBeenCalledOnce();
      }
      expect(controller.searching.value).toBe(false);
    }
  );

  it('Clears results for a different query and ignores a late background search refresh', async () => {
    let finishOld!: (page: unknown) => void;
    let finishNew!: (page: unknown) => void;
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessions: [{ id: 'release-match', workspaceId: 'workspace-1', runner: 'codex' }],
        nextCursor: 'original-cursor'
      })
      .mockImplementationOnce(() => new Promise((resolve) => (finishOld = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (finishNew = resolve)));
    const { controller } = state([], request);
    await controller.search('release');
    const refreshing = controller.refresh();
    const searching = controller.search('different');
    expect(controller.searchResults.value).toEqual([]);
    expect(controller.searchNextCursor.value).toBeNull();
    finishNew({
      sessions: [{ id: 'different-match', workspaceId: 'workspace-1', runner: 'codex' }],
      nextCursor: 'new-cursor'
    });
    await searching;
    finishOld({ sessions: [], nextCursor: null });
    await refreshing;
    expect(controller.searchResults.value.map((session) => session.id)).toEqual([
      'different-match'
    ]);
    expect(controller.searchNextCursor.value).toBe('new-cursor');
  });

  it('keeps group selection per Workspace and leaves unsupported Nodes on the mixed list', async () => {
    const grouped = state(
      [],
      vi.fn().mockResolvedValue({ sessions: [], nextCursor: null }),
      () => true
    );
    expect(grouped.controller.currentGroup.value).toBe('MAIN');
    grouped.controller.selectGroup('CHILD');
    expect(grouped.controller.currentGroup.value).toBe('CHILD');

    grouped.selectedWorkspaceId.value = 'workspace-2';
    await nextTick();
    expect(grouped.controller.currentGroup.value).toBe('MAIN');
    grouped.controller.selectGroup('CHILD');
    grouped.selectedWorkspaceId.value = 'workspace-1';
    await nextTick();
    expect(grouped.controller.currentGroup.value).toBe('CHILD');

    grouped.selectedNodeId.value = 'node-2';
    await nextTick();
    expect(grouped.controller.currentGroup.value).toBe('MAIN');
    grouped.controller.selectGroup('CHILD');
    grouped.selectedNodeId.value = 'node-1';
    await nextTick();
    expect(grouped.controller.currentGroup.value).toBe('CHILD');

    const legacyRequest = vi.fn().mockResolvedValue({ sessions: [], nextCursor: null });
    const legacy = state([], legacyRequest);
    expect(legacy.controller.currentGroup.value).toBeUndefined();
    legacy.controller.selectGroup('CHILD');
    await legacy.controller.synchronize('workspace-1');
    expect(legacy.controller.currentGroup.value).toBeUndefined();
    expect(legacyRequest).toHaveBeenCalledWith(
      '/api/agent-sessions?nodeId=node-1&workspaceId=workspace-1&limit=10'
    );
  });

  it('retains a navigated group while the Node capability is still being resolved', async () => {
    const supported = ref(false);
    const fixture = state(
      [],
      vi.fn().mockResolvedValue({ sessions: [], nextCursor: null }),
      () => supported.value
    );
    fixture.controller.selectGroup('CHILD', true);
    expect(fixture.controller.currentGroup.value).toBeUndefined();
    supported.value = true;
    await nextTick();
    expect(fixture.controller.currentGroup.value).toBe('CHILD');
  });

  it('includes the selected group in every Workspace list and search request', async () => {
    const request = vi.fn().mockResolvedValue({ sessions: [], nextCursor: 'next' });
    const { controller, paging } = state([], request, () => true);

    await controller.synchronize('workspace-1');
    await controller.loadMore();
    await controller.search('needle');
    await controller.loadMoreSearchResults();
    await controller.refresh();

    expect(request).toHaveBeenCalledTimes(5);
    expect(request.mock.calls.every(([path]) => path.includes('sessionGroup=MAIN'))).toBe(true);
    expect(paging.nextCursors.value.get('node-1:workspace-1')).toBe('next');
  });

  it('tracks current page membership across snapshots, synchronization, pagination, and group changes', async () => {
    const appended = { id: 'appended', workspaceId: 'workspace-1', runner: 'codex' };
    const synchronized = { id: 'synchronized', workspaceId: 'workspace-1', runner: 'codex' };
    const request = vi
      .fn()
      .mockResolvedValueOnce({ sessions: [appended], nextCursor: 'append-cursor' })
      .mockResolvedValueOnce({ sessions: [synchronized], nextCursor: null });
    const { controller, sessions } = state([], request, () => true);
    const currentBodySession = {
      id: 'session-1',
      workspaceId: 'workspace-1',
      runner: 'codex' as const
    };
    sessions.value = [currentBodySession, { ...currentBodySession, id: 'cached-only' }];

    controller.applySnapshot('node-1', 'workspace-1', {
      sessions: [{ id: 'snapshot', workspaceId: 'workspace-1', runner: 'codex' }],
      nextCursor: 'first-cursor'
    });
    expect(controller.listedSessionIds.value).toEqual(new Set(['snapshot']));

    await controller.loadMore();
    expect(controller.listedSessionIds.value).toEqual(new Set(['snapshot', 'appended']));
    expect(sessions.value.some((session) => session.id === currentBodySession.id)).toBe(true);

    await controller.synchronize('workspace-1');
    expect(controller.listedSessionIds.value).toEqual(new Set(['synchronized']));
    expect(sessions.value.some((session) => session.id === currentBodySession.id)).toBe(true);

    controller.applySnapshot('node-1', 'workspace-1', {
      sessions: [{ id: 'watch-replacement', workspaceId: 'workspace-1', runner: 'codex' }],
      nextCursor: null
    });
    expect(controller.listedSessionIds.value).toEqual(new Set(['watch-replacement']));

    controller.selectGroup('CHILD');
    expect(controller.listedSessionIds.value).toEqual(new Set());
    expect(sessions.value.some((session) => session.id === currentBodySession.id)).toBe(true);
  });

  it('invalidates an old group page, clears pagination errors, and reruns search for the selected group', async () => {
    let resolveMainAppend!: (page: unknown) => void;
    const mainAppend = new Promise((resolve) => (resolveMainAppend = resolve));
    const request = vi.fn((path: string) => {
      if (path.includes('sessionGroup=CHILD'))
        return Promise.resolve({
          sessions: [{ id: 'child-result', workspaceId: 'workspace-1', runner: 'codex' }],
          nextCursor: 'child-search-cursor'
        });
      if (path.includes('cursor=main-cursor')) return mainAppend;
      if (path.includes('query=release'))
        return Promise.resolve({
          sessions: [{ id: 'main-result', workspaceId: 'workspace-1', runner: 'codex' }],
          nextCursor: 'main-search-cursor'
        });
      throw new Error(`Unexpected request: ${path}`);
    });
    const { controller, paging, sessions } = state([], request, () => true);
    sessions.value = [{ id: 'main-loaded', workspaceId: 'workspace-1', runner: 'codex' }];
    paging.nextCursors.value.set('node-1:workspace-1', 'main-cursor');
    paging.loadMoreErrors.value.set('node-1:workspace-1', new Error('old page failure'));

    await controller.search('release');
    const oldAppend = controller.loadMore();
    controller.selectGroup('CHILD');
    resolveMainAppend({
      sessions: [{ id: 'stale-main-page', workspaceId: 'workspace-1', runner: 'codex' }],
      nextCursor: null
    });
    await oldAppend;
    await vi.waitFor(() => expect(controller.searchResults.value[0]?.id).toBe('child-result'));

    expect(request.mock.calls[0]?.[0]).toContain('sessionGroup=MAIN');
    expect(request.mock.calls[1]?.[0]).toContain('sessionGroup=MAIN');
    expect(request.mock.calls[2]?.[0]).toContain('sessionGroup=CHILD');
    expect(controller.currentGroup.value).toBe('CHILD');
    expect(controller.searchQuery.value).toBe('release');
    expect(controller.searchNextCursor.value).toBe('child-search-cursor');
    expect(paging.nextCursors.value.get('node-1:workspace-1')).toBeNull();
    expect(paging.loadMoreErrors.value.has('node-1:workspace-1')).toBe(false);
    expect(sessions.value.some((session) => session.id === 'stale-main-page')).toBe(false);
  });

  it('refreshes the active grouped search after a move without waiting for a Watch snapshot', async () => {
    const child = {
      id: 'child-match',
      workspaceId: 'workspace-1',
      runner: 'codex' as const,
      sessionGroup: 'CHILD' as const
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({ sessions: [child], nextCursor: 'child-search-cursor' })
      .mockResolvedValue({
        sessions: [],
        nextCursor: null,
        runningCounts: { MAIN: 1, CHILD: 0 }
      });
    const { controller } = state([], request, () => true);
    controller.selectGroup('CHILD');
    controller.applySnapshot('node-1', 'workspace-1', {
      sessions: [child],
      nextCursor: null,
      runningCounts: { MAIN: 0, CHILD: 1 }
    });
    await controller.search('release');
    expect(controller.searchResults.value.map((session) => session.id)).toEqual(['child-match']);

    controller.merge([{ ...child, sessionGroup: 'MAIN' }]);
    await controller.refresh();

    expect(controller.searchQuery.value).toBe('release');
    expect(controller.searchResults.value).toEqual([]);
    expect(controller.searchNextCursor.value).toBeNull();
    expect(controller.runningCounts.value).toEqual({ MAIN: 1, CHILD: 0 });
    expect(request.mock.calls[1]?.[0]).toContain('sessionGroup=CHILD&query=release');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('Retains search results and cursor after an append failure, then retries successfully', async () => {
    const error = new TypeError('Search page unavailable');
    let resolveRetry!: (page: unknown) => void;
    const retryPage = new Promise((resolve) => (resolveRetry = resolve));
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessions: [{ id: 'match', workspaceId: 'workspace-1', runner: 'codex' }],
        nextCursor: 'search-cursor-one'
      })
      .mockRejectedValueOnce(error)
      .mockImplementationOnce(() => retryPage);
    const { controller } = state([], request);

    await controller.search('release');
    await controller.loadMoreSearchResults();

    expect(controller.searchResults.value.map((session) => session.id)).toEqual(['match']);
    expect(controller.searchNextCursor.value).toBe('search-cursor-one');
    expect(controller.loadMoreSearchResultsError.value).toBe(error);
    expect(controller.loadingMoreSearchResults.value).toBe(false);

    const retry = controller.loadMoreSearchResults();
    expect(controller.loadMoreSearchResultsError.value).toBeUndefined();
    expect(controller.loadingMoreSearchResults.value).toBe(true);
    resolveRetry({
      sessions: [
        { id: 'match', workspaceId: 'workspace-1', runner: 'codex', runnerTitle: 'updated' },
        { id: 'match-two', workspaceId: 'workspace-1', runner: 'codex' }
      ],
      nextCursor: null
    });
    await retry;

    expect(controller.searchResults.value.map((session) => session.id)).toEqual([
      'match',
      'match-two'
    ]);
    expect(controller.searchResults.value[0]?.runnerTitle).toBe('updated');
    expect(controller.searchNextCursor.value).toBeNull();
    expect(controller.loadMoreSearchResultsError.value).toBeUndefined();
    expect(controller.loadingMoreSearchResults.value).toBe(false);
  });

  it('Treats a non-advancing search cursor as a page failure without merging its page', async () => {
    const { controller } = state(
      [],
      vi
        .fn()
        .mockResolvedValueOnce({
          sessions: [{ id: 'match', workspaceId: 'workspace-1', runner: 'codex' }],
          nextCursor: 'search-cursor'
        })
        .mockResolvedValueOnce({
          sessions: [{ id: 'duplicate-page', workspaceId: 'workspace-1', runner: 'codex' }],
          nextCursor: 'search-cursor'
        })
    );

    await controller.search('release');
    await controller.loadMoreSearchResults();

    expect(controller.searchResults.value.map((session) => session.id)).toEqual(['match']);
    expect(controller.searchNextCursor.value).toBe('search-cursor');
    expect(controller.loadMoreSearchResultsError.value).toMatchObject({
      message: 'SESSION_PAGINATION_NO_PROGRESS'
    });
    expect(controller.loadingMoreSearchResults.value).toBe(false);
  });

  it.each(['cleared', 'changed'] as const)(
    'Does not publish an old search append failure after the query is %s',
    async (action) => {
      const error = new TypeError('Stale search page failed');
      let rejectAppend!: (error: unknown) => void;
      const appendPage = new Promise((_, reject) => (rejectAppend = reject));
      const request = vi
        .fn()
        .mockResolvedValueOnce({
          sessions: [{ id: 'old-match', workspaceId: 'workspace-1', runner: 'codex' }],
          nextCursor: 'old-cursor'
        })
        .mockImplementationOnce(() => appendPage)
        .mockResolvedValueOnce({
          sessions: [{ id: 'new-match', workspaceId: 'workspace-1', runner: 'codex' }],
          nextCursor: 'new-cursor'
        });
      const { controller } = state([], request);

      await controller.search('old query');
      const staleAppend = controller.loadMoreSearchResults();
      if (action === 'cleared') controller.clearSearch();
      else await controller.search('new query');
      rejectAppend(error);
      await staleAppend;

      expect(controller.loadMoreSearchResultsError.value).toBeUndefined();
      expect(controller.loadingMoreSearchResults.value).toBe(false);
      if (action === 'cleared') {
        expect(controller.searchQuery.value).toBe('');
        expect(controller.searchResults.value).toEqual([]);
        expect(controller.searchNextCursor.value).toBeNull();
      } else {
        expect(controller.searchQuery.value).toBe('new query');
        expect(controller.searchResults.value.map((session) => session.id)).toEqual(['new-match']);
        expect(controller.searchNextCursor.value).toBe('new-cursor');
      }
    }
  );

  it('Clears search and invalidates in-flight results when the Node or Workspace changes', async () => {
    let resolveSearch!: (value: {
      sessions: Record<string, unknown>[];
      nextCursor: string | null;
    }) => void;
    const request = vi.fn(
      () =>
        new Promise<{ sessions: Record<string, unknown>[]; nextCursor: string | null }>(
          (resolve) => {
            resolveSearch = resolve;
          }
        )
    );
    const { selectedWorkspaceId, controller } = state([], request);

    const searching = controller.search('release');
    selectedWorkspaceId.value = 'workspace-2';
    await nextTick();
    resolveSearch({
      sessions: [{ id: 'stale-result', workspaceId: 'workspace-1' }],
      nextCursor: null
    });
    await searching;

    expect(controller.searchQuery.value).toBe('');
    expect(controller.searchResults.value).toEqual([]);
    expect(controller.searchNextCursor.value).toBeNull();
    expect(controller.searching.value).toBe(false);
  });

  it('Stops showing search busy state when an empty query supersedes an in-flight search', async () => {
    let resolveSearch!: (page: unknown) => void;
    const pendingSearch = new Promise((resolve) => (resolveSearch = resolve));
    const { controller } = state(
      [],
      vi.fn(() => pendingSearch)
    );

    const oldSearch = controller.search('old query');
    await controller.search('');
    const searchingAfterClear = controller.searching.value;
    resolveSearch({
      sessions: [{ id: 'stale-result', workspaceId: 'workspace-1', runner: 'codex' }],
      nextCursor: null
    });
    await oldSearch;

    expect(searchingAfterClear).toBe(false);
    expect(controller.searching.value).toBe(false);
    expect(controller.searchQuery.value).toBe('');
    expect(controller.searchResults.value).toEqual([]);
  });

  it('Preserves current command state when a weaker snapshot omits it', () => {
    const { sessions, controller } = state();
    sessions.value = [
      {
        id: 'session-1',
        workspaceId: 'workspace-1',
        runner: 'codex',
        activity: 'IDLE',
        commandStates: [{ commandId: 'plan', active: true }]
      }
    ];
    controller.merge([
      { id: 'session-1', workspaceId: 'workspace-1', runner: 'codex', activity: 'IDLE' } as never
    ]);
    expect(sessions.value[0]?.commandStates).toEqual([{ commandId: 'plan', active: true }]);
  });

  it('Preserves current Rewind capability when a partial update omits runtime capabilities', () => {
    const { sessions, controller } = state();
    sessions.value = [
      {
        id: 'session-1',
        workspaceId: 'workspace-1',
        runner: 'codex',
        activity: 'IDLE',
        runtime: { capabilities: ['history.read', 'session.rewind'] }
      }
    ];

    controller.merge([
      {
        id: 'session-1',
        workspaceId: 'workspace-1',
        runner: 'codex',
        activity: 'IDLE',
        runnerTitle: 'Updated session'
      } as never
    ]);

    expect(sessions.value[0]?.runtime).toEqual({
      capabilities: ['history.read', 'session.rewind']
    });
  });

  it('Does not let a stale IDLE snapshot revoke managed activity while an active Run exists', () => {
    const { sessions, controller } = state([
      { id: 'run-1', sessionId: 'session-1', status: 'RUNNING' }
    ]);
    sessions.value = [
      {
        id: 'session-1',
        workspaceId: 'workspace-1',
        runner: 'codex',
        activity: 'MANAGED_ACTIVE',
        control: { level: 'MANAGED' }
      }
    ];
    controller.merge([
      { id: 'session-1', workspaceId: 'workspace-1', runner: 'codex', activity: 'IDLE' } as never
    ]);
    expect(sessions.value[0]?.activity).toBe('MANAGED_ACTIVE');
  });

  it('Allows an authoritative Watch snapshot with IDLE to converge stale browser activity', () => {
    const { sessions, controller } = state([
      { id: 'run-1', sessionId: 'session-1', status: 'RUNNING' }
    ]);
    sessions.value = [
      {
        id: 'session-1',
        workspaceId: 'workspace-1',
        runner: 'codex',
        activity: 'MANAGED_ACTIVE',
        lastActivityAt: 100,
        control: { level: 'MANAGED' },
        runtime: { capabilities: ['history.read'] }
      }
    ];

    controller.merge(
      [
        {
          id: 'session-1',
          workspaceId: 'workspace-1',
          runner: 'codex',
          activity: 'IDLE',
          lastActivityAt: 200,
          control: { level: 'MANAGED' }
        } as never
      ],
      { authoritativeActivity: true }
    );

    expect(sessions.value[0]?.activity).toBe('IDLE');
    expect(sessions.value[0]?.lastActivityAt).toBe(200);
    expect(sessions.value[0]?.runtime).toBeUndefined();
  });

  it('Replaces an externally discovered snapshot with a managed session sharing the same native identity', () => {
    const { sessions, controller } = state();
    sessions.value = [
      {
        id: 'managed',
        workspaceId: 'workspace-1',
        runner: 'claude-code',
        externalSessionId: 'native-1',
        nativeControl: 'MAR_MANAGED'
      }
    ];
    controller.merge([
      {
        id: 'external',
        workspaceId: 'workspace-1',
        runner: 'claude-code',
        externalSessionId: 'native-1',
        nativeControl: 'EXTERNAL'
      } as never
    ]);
    expect(sessions.value.map((session) => session.id)).toEqual(['managed']);
  });

  it('Preserves the existing list position when partially updating a session', () => {
    const { sessions, controller } = state();
    sessions.value = [
      { id: 'session-1', workspaceId: 'workspace-1', runner: 'codex' },
      { id: 'session-2', workspaceId: 'workspace-1', runner: 'codex' },
      { id: 'session-3', workspaceId: 'workspace-1', runner: 'codex' }
    ] as never;
    const current = sessions.value;

    controller.merge([
      {
        id: 'session-2',
        workspaceId: 'workspace-1',
        runner: 'codex',
        runnerTitle: 'Updated session'
      } as never
    ]);

    expect(sessions.value.map((session) => session.id)).toEqual([
      'session-1',
      'session-2',
      'session-3'
    ]);
    expect(sessions.value[1]?.runnerTitle).toBe('Updated session');
    expect(sessions.value).not.toBe(current);
    expect(sessions.value[0]).toBe(current[0]);
    expect(sessions.value[2]).toBe(current[2]);
  });

  it('Keeps a session added in real time at its current position until the authoritative Watch snapshot orders it', () => {
    const { sessions, controller } = state();
    sessions.value = Array.from({ length: 21 }, (_, index) => ({
      id: `session-${index + 1}`,
      workspaceId: 'workspace-1',
      runner: 'codex'
    }));

    controller.merge([{ id: 'session-new', workspaceId: 'workspace-1', runner: 'codex' }] as never);

    expect(sessions.value.map((session) => session.id)).toEqual([
      ...Array.from({ length: 21 }, (_, index) => `session-${index + 1}`),
      'session-new'
    ]);

    controller.merge(
      [
        { id: 'session-1', workspaceId: 'workspace-1', runner: 'codex' },
        { id: 'session-new', workspaceId: 'workspace-1', runner: 'codex' },
        { id: 'session-2', workspaceId: 'workspace-1', runner: 'codex' }
      ] as never,
      { authoritativeOrder: true }
    );

    expect(sessions.value.map((session) => session.id)).toEqual([
      'session-1',
      'session-new',
      ...Array.from({ length: 20 }, (_, index) => `session-${index + 2}`)
    ]);
  });

  it('Updates order from the newest first page across consecutive authoritative snapshots', () => {
    const { sessions, controller } = state();
    sessions.value = [{ id: 'session-1', workspaceId: 'workspace-1', runner: 'codex' }] as never;

    controller.merge([{ id: 'session-new', workspaceId: 'workspace-1', runner: 'codex' }] as never);
    controller.merge(
      [
        { id: 'session-new', workspaceId: 'workspace-1', runner: 'codex' },
        { id: 'session-1', workspaceId: 'workspace-1', runner: 'codex' }
      ] as never,
      { authoritativeOrder: true }
    );
    controller.merge(
      [
        { id: 'session-1', workspaceId: 'workspace-1', runner: 'codex' },
        { id: 'session-new', workspaceId: 'workspace-1', runner: 'codex' }
      ] as never,
      { authoritativeOrder: true }
    );

    expect(sessions.value.map((session) => session.id)).toEqual(['session-1', 'session-new']);
  });

  it('Uses one-time session.list only to add unloaded sessions, not to impersonate an authoritative Watch snapshot', async () => {
    let resolvePage!: (value: unknown) => void;
    const page = new Promise((resolve) => (resolvePage = resolve));
    const sessions = { value: [] } as never;
    const controller = createWorkspaceSessionService({
      sessions,
      runs: { value: [{ id: 'run-1', sessionId: 'session-1', status: 'RUNNING' }] } as never,
      workspaceTarget: workspaceTargetRef(ref('node-1'), ref('workspace-1')),
      selectedSessionId: { value: undefined } as never,
      paging: {
        nextCursors: { value: new Map() } as never,
        loadMoreErrors: ref(new Map()),
        loadingMore: { value: false } as never,
        initialize: vi.fn(),
        reset: vi.fn(),
        append: vi.fn()
      },
      pageSize: 10,
      tabId: () => 'node-1:workspace-1',
      request: vi.fn(() => page) as never,
      notice: vi.fn(),
      errorMessage: String
    });
    (sessions as { value: Record<string, unknown>[] }).value = [
      {
        id: 'session-1',
        workspaceId: 'workspace-1',
        runner: 'codex',
        activity: 'MANAGED_ACTIVE'
      }
    ];
    const synchronizing = controller.synchronize('workspace-1');
    await Promise.resolve();
    await Promise.resolve();
    resolvePage({
      sessions: [
        {
          id: 'session-1',
          workspaceId: 'workspace-1',
          runner: 'codex',
          activity: 'IDLE',
          runnerTitle: 'Old home-page title'
        }
      ],
      nextCursor: null
    });
    await synchronizing;
    expect((sessions as { value: { runnerTitle?: string }[] }).value[0]?.runnerTitle).toBe(
      'Old home-page title'
    );
    expect((sessions as { value: { activity?: string }[] }).value[0]?.activity).toBe(
      'MANAGED_ACTIVE'
    );
  });

  it('Preserves the current page cursor when a manual refresh fails', async () => {
    const sessions = {
      value: [{ id: 'session-1', workspaceId: 'workspace-1', runner: 'codex' }]
    };
    const paging = createWorkspaceSessionPagingService(10);
    paging.initialize('node-1:workspace-1');
    paging.nextCursors.value.set('node-1:workspace-1', 'existing-cursor');
    const reset = vi.spyOn(paging, 'reset');
    const controller = createWorkspaceSessionService({
      sessions: sessions as never,
      runs: { value: [] } as never,
      workspaceTarget: workspaceTargetRef(ref('node-1'), ref('workspace-1')),
      selectedSessionId: { value: undefined } as never,
      paging,
      pageSize: 10,
      tabId: () => 'node-1:workspace-1',
      request: vi.fn().mockRejectedValue(new Error('session list failed')) as never,
      notice: vi.fn(),
      errorMessage: String
    });

    await controller.refresh();

    expect(sessions.value).toEqual([
      { id: 'session-1', workspaceId: 'workspace-1', runner: 'codex' }
    ]);
    expect(paging.nextCursors.value.get('node-1:workspace-1')).toBe('existing-cursor');
    expect(reset).not.toHaveBeenCalled();
    expect(controller.refreshing.value).toBe(false);
  });

  it('Does not let an older synchronization request overwrite a newer result when it returns later', async () => {
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    const pages = [
      new Promise((resolve) => (resolveFirst = resolve)),
      new Promise((resolve) => (resolveSecond = resolve))
    ];
    let pageIndex = 0;
    const sessions = { value: [] } as never;
    const nextCursors = { value: new Map<string, string | null>() };
    const controller = createWorkspaceSessionService({
      sessions,
      runs: { value: [] } as never,
      workspaceTarget: workspaceTargetRef(ref('node-1'), ref('workspace-1')),
      selectedSessionId: { value: undefined } as never,
      paging: {
        nextCursors: nextCursors as never,
        loadMoreErrors: ref(new Map()),
        loadingMore: { value: false } as never,
        initialize: vi.fn(),
        reset: vi.fn(),
        append: vi.fn()
      },
      pageSize: 10,
      tabId: () => 'node-1:workspace-1',
      request: vi.fn(() => pages[pageIndex++]!) as never,
      notice: vi.fn(),
      errorMessage: String
    });

    const first = controller.synchronize('workspace-1');
    const second = controller.synchronize('workspace-1');
    resolveSecond({
      sessions: [
        {
          id: 'session-1',
          workspaceId: 'workspace-1',
          runner: 'codex',
          runnerTitle: 'Newer title'
        }
      ],
      nextCursor: 'new-cursor'
    });
    await second;
    resolveFirst({
      sessions: [
        {
          id: 'session-1',
          workspaceId: 'workspace-1',
          runner: 'codex',
          runnerTitle: 'Stale title'
        }
      ],
      nextCursor: 'old-cursor'
    });
    await first;

    expect((sessions as { value: { runnerTitle?: string }[] }).value[0]?.runnerTitle).toBe(
      'Newer title'
    );
    expect(nextCursors.value.get('node-1:workspace-1')).toBe('new-cursor');
  });
});
