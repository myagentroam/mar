import { workspaceTargetRef } from './support/workspace-fixture.js';
import { nextTick, ref, watch } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceSessionService } from '../../src/service/workspace-session-service.js';
import { createWorkspaceSessionPagingService } from '../../src/service/workspace-session-paging-service.js';

function state(
  runs: readonly Record<string, unknown>[] = [],
  request: ReturnType<typeof vi.fn> = vi.fn()
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
    const request = vi
      .fn()
      .mockResolvedValueOnce({ sessions: second, nextCursor: 'old-next' })
      .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
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
    finish({
      sessions: [{ id: 'stale-page', workspaceId: 'workspace-1' }],
      nextCursor: 'stale-cursor'
    });
    await loading;
    expect(paging.nextCursors.value.get('node-1:workspace-1')).toBe('new-cursor');
    expect(paging.visibleLimits.value.get('node-1:workspace-1')).toBe(20);
    expect(sessions.value[0]?.id).toBe('slow-pinned');
    expect(sessions.value.some((session) => session.id === 'stale-page')).toBe(false);
    expect(sessions.value.some((session) => session.id === 'second-9')).toBe(true);
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
