import { workspaceTargetRef } from './support/workspace-fixture.js';
import { nextTick, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import type {
  AgentRun,
  ComposerSkillToken,
  ConversationTurn,
  Session,
  WorkspaceQueue
} from '../../src/model/workbench.js';
import { createWorkbenchWorkspaceCache } from '../../src/service/workbench-workspace-cache-controller.js';
import type { SessionContextUsage } from '../../src/service/conversation-state-service.js';
import { createWorkspaceSessionPagingService } from '../../src/service/workspace-session-paging-service.js';
import { createConversationProjectionService } from '../../src/service/conversation-projection-service.js';
import { createComposerConfigurationService } from '../../src/service/composer-configuration-service.js';
import { createWorkspaceSessionService } from '../../src/service/workspace-session-service.js';

function nativeSession(id = 'session-1'): Session {
  return {
    id,
    workspaceId: 'workspace-1',
    runner: 'codex',
    externalSessionId: `native-${id}`,
    activity: 'IDLE'
  };
}

const emptyFileSnapshot = () => ({ fileTabs: { tabs: [] }, dirtyTextDrafts: [] });
function fileWorkbench(snapshot = emptyFileSnapshot()) {
  return { snapshot: vi.fn(() => snapshot), restore: vi.fn() };
}

function fixture(
  domains: Pick<
    Parameters<ReturnType<typeof createWorkbenchWorkspaceCache>['connect']>[0],
    'files' | 'git' | 'search' | 'sessionList'
  > = {}
) {
  const owner = createWorkbenchWorkspaceCache((nodeId, workspaceId) => `${nodeId}:${workspaceId}`);
  const cacheService = owner.cache;
  const paging = createWorkspaceSessionPagingService(20);
  const selectedNodeId = ref<string>();
  const selectedWorkspaceId = ref<string>();
  const selectedSessionId = ref<string>();
  const sessions = ref<Session[]>([]);
  const runs = ref<AgentRun[]>([]);
  const turns = ref<ConversationTurn[]>([]);
  const nextCursor = ref<string | null>(null);
  const contextUsage = ref<SessionContextUsage | null | undefined>(null);
  const queue = ref<WorkspaceQueue>({ version: 1, paused: false, items: [] });
  const draftOpen = ref(false);
  const input = ref('');
  const skillTokens = ref<readonly ComposerSkillToken[]>([]);
  const configuration = createComposerConfigurationService({
    selectedSession: ref(undefined),
    profiles: ref([]),
    effortLabel: String
  });
  configuration.apply({
    runner: 'codex',
    modelId: 'model-a',
    effort: 'medium',
    access: 'on-request'
  });
  const { runner, modelId, effort, access } = configuration;
  const currentFileWorkbench = fileWorkbench();
  const normalizeDraft = vi.fn(configuration.apply);
  const persistDraft = vi.fn();
  const projection = createConversationProjectionService({
    turns,
    nextCursor,
    onRecentWindowOverflow: vi.fn(),
    limitHistory: (values) => [...values]
  });
  const controller = owner.connect({
    paging,
    sessions,
    captureDetail: (sessionId) => {
      projection.flushPendingTextDeltas();
      return {
        sessionId,
        runs: runs.value,
        turns: turns.value,
        nextCursor: nextCursor.value,
        contextUsage: contextUsage.value ?? null,
        lastAccessedAt: Date.now()
      };
    },
    queue,
    runner,
    modelId,
    effort,
    access,
    workspaceTarget: workspaceTargetRef(selectedNodeId, selectedWorkspaceId),
    selectedSessionId,
    fileWorkbench: currentFileWorkbench,
    ...domains,
    restoreDraftConfiguration: normalizeDraft,
    persistDraft,
    flushConversation: projection.flushPendingTextDeltas,
    maximumDetails: 5
  });

  return {
    cacheService,
    paging,
    selectedNodeId,
    selectedWorkspaceId,
    selectedSessionId,
    sessions,
    runs,
    turns,
    nextCursor,
    contextUsage,
    queue,
    draftOpen,
    input,
    skillTokens,
    runner,
    modelId,
    effort,
    access,
    currentFileWorkbench,
    normalizeDraft,
    persistDraft,
    projection,
    controller
  };
}

describe('Public Workspace Cache Controller', () => {
  it('restores grouped cached rows and their loaded range before a refresh settles', async () => {
    let discovery!: ReturnType<typeof createWorkspaceSessionService>;
    const f = fixture({
      sessionList: {
        snapshot: () => discovery.snapshot(),
        restore: (snapshot) => discovery.restore(snapshot)
      }
    });
    const request = vi.fn();
    discovery = createWorkspaceSessionService({
      runs: f.runs,
      workspaceTarget: workspaceTargetRef(f.selectedNodeId, f.selectedWorkspaceId),
      selectedSessionId: f.selectedSessionId,
      setSelectedSessionId: (id) => (f.selectedSessionId.value = id),
      paging: f.paging,
      pageSize: 20,
      groupingSupported: () => true,
      tabId: (nodeId, workspaceId) => `${nodeId}:${workspaceId}`,
      request,
      notice: vi.fn(),
      errorMessage: String
    });
    const list = discovery.createVisibleList({
      unfiltered: discovery.projection.sessions,
      canLoadMore: ref(true)
    });
    f.selectedNodeId.value = 'node-1';
    f.selectedWorkspaceId.value = 'workspace-1';
    f.cacheService.activate('node-1', 'workspace-1');
    const first = Array.from({ length: 20 }, (_, index) => nativeSession(`first-${index}`));
    const tail = [nativeSession('tail-1'), nativeSession('tail-2')];
    discovery.applySnapshot('node-1', 'workspace-1', {
      sessions: first,
      nextCursor: 'first-cursor',
      runningCounts: { MAIN: 2, CHILD: 1 }
    });
    request.mockResolvedValueOnce({ sessions: tail, nextCursor: 'tail-cursor' });
    await discovery.loadMore();
    discovery.projection.prepend(nativeSession('cached-only'));
    f.sessions.value = [...discovery.projection.sessions.value];
    f.controller.saveCurrentWorkspaceView();

    f.selectedWorkspaceId.value = 'workspace-2';
    f.cacheService.activate('node-1', 'workspace-2');
    discovery.selectGroup('CHILD');
    const child = {
      ...nativeSession('child'),
      workspaceId: 'workspace-2',
      sessionGroup: 'CHILD' as const
    };
    discovery.replaceSessions([child]);
    discovery.applySnapshot('node-1', 'workspace-2', { sessions: [child], nextCursor: null });
    f.sessions.value = [...discovery.projection.sessions.value];
    f.controller.saveCurrentWorkspaceView();

    f.selectedWorkspaceId.value = 'workspace-1';
    f.cacheService.activate('node-1', 'workspace-1');
    f.controller.restoreWorkspaceView('node-1', 'workspace-1');
    discovery.replaceSessions(f.cacheService.view('node-1', 'workspace-1').sessions);
    await nextTick();
    const expected = [...first, ...tail].map((session) => session.id);
    expect(list.visible.value.map((session) => session.id)).toEqual(expected);
    expect(discovery.currentGroup.value).toBe('MAIN');
    expect(discovery.runningCounts.value).toEqual({ MAIN: 2, CHILD: 1 });
    expect(f.paging.visibleLimits.value.get('node-1:workspace-1')).toBe(22);
    expect(f.paging.nextCursors.value.get('node-1:workspace-1')).toBe('tail-cursor');

    let fail!: (error: Error) => void;
    request.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));
    const refresh = discovery.synchronize('workspace-1', true);
    expect(list.visible.value.map((session) => session.id)).toEqual(expected);
    fail(new Error('Refresh unavailable'));
    await expect(refresh).rejects.toThrow('Refresh unavailable');
    expect(list.visible.value.map((session) => session.id)).toEqual(expected);
    expect(f.paging.nextCursors.value.get('node-1:workspace-1')).toBe('tail-cursor');

    request.mockResolvedValueOnce({ sessions: [], nextCursor: null });
    await discovery.synchronize('workspace-1', true);
    expect(list.visible.value).toEqual([]);

    f.selectedWorkspaceId.value = 'workspace-2';
    f.controller.restoreWorkspaceView('node-1', 'workspace-2');
    discovery.replaceSessions(f.cacheService.view('node-1', 'workspace-2').sessions);
    await nextTick();
    expect(discovery.currentGroup.value).toBe('CHILD');
    expect(list.visible.value.map((session) => session.id)).toEqual(['child']);
  });

  it('captures a pending streaming delta before switching and restoring the session', () => {
    const f = fixture();
    f.selectedNodeId.value = 'node-1';
    f.selectedWorkspaceId.value = 'workspace-1';
    f.selectedSessionId.value = 'session-1';
    f.sessions.value = [nativeSession()];
    f.cacheService.activate('node-1', 'workspace-1');
    f.turns.value = [
      { id: 'turn-1', sessionId: 'session-1', runId: 'run-1', status: 'RUNNING', items: [] }
    ];
    f.projection.mergeTextDelta('run-1', { itemId: 'reply', text: 'pending tail' }, 1);

    f.controller.saveCurrentWorkspaceView();
    f.turns.value = [];
    f.projection.resetHistory();
    const cached = f.cacheService.touchDetail('node-1', 'workspace-1', 'session-1')!;
    f.projection.restoreWindow(cached.turns, cached.nextCursor);

    expect(f.turns.value[0]?.items[0]?.payload).toMatchObject({ text: 'pending tail' });
    f.projection.mergeTextDelta('run-1', { itemId: 'reply', text: ' new' }, 2);
    f.projection.flushPendingTextDeltas();
    expect(f.turns.value[0]?.items[0]?.payload).toMatchObject({ text: 'pending tail new' });
    expect(cached.turns[0]?.items[0]?.payload).toMatchObject({ text: 'pending tail' });
  });

  it('Captures restorable sessions, selection, queues, details, fileWorkbench, and draft when saving the current view', () => {
    const f = fixture();
    const savedFileWorkbench = fileWorkbench();
    f.selectedNodeId.value = 'node-1';
    f.selectedWorkspaceId.value = 'workspace-1';
    f.selectedSessionId.value = 'session-1';
    f.cacheService.activate('node-1', 'workspace-1');
    f.sessions.value = [
      nativeSession(),
      { ...nativeSession('other-workspace'), workspaceId: 'workspace-2' }
    ];
    f.runs.value = [
      {
        id: 'run-1',
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        status: 'RUNNING',
        recoveryState: 'NONE',
        clientMessageId: 'message-1'
      }
    ];
    f.turns.value = [
      {
        id: 'turn-1',
        sessionId: 'session-1',
        runId: 'run-1',
        status: 'RUNNING',
        items: []
      }
    ];
    f.nextCursor.value = 'before-turn-1';
    f.contextUsage.value = {
      model: 'model-a',
      usedTokens: 10,
      maxTokens: 100,
      percentage: 10
    };
    f.queue.value = { version: 2, paused: true, items: [] };
    f.input.value = 'continue this task';
    f.skillTokens.value = [
      {
        name: 'review',
        source: 'WORKSPACE',
        skillFilePath: 'skills/review/SKILL.md',
        available: true
      }
    ];
    f.currentFileWorkbench.snapshot.mockReturnValue(savedFileWorkbench.snapshot());

    f.controller.saveCurrentWorkspaceView();

    const cache = f.cacheService.view('node-1', 'workspace-1');
    expect(f.persistDraft).toHaveBeenCalledOnce();
    expect(cache.sessions).toEqual([nativeSession()]);
    expect(cache.selectedSessionId).toBe('session-1');
    expect(f.cacheService.queueFor('node-1', 'workspace-1', 'session-1')).toEqual({
      version: 2,
      paused: true,
      items: []
    });
    expect(f.cacheService.detail('node-1', 'workspace-1', 'session-1')).toMatchObject({
      sessionId: 'session-1',
      runs: f.runs.value,
      turns: f.turns.value,
      nextCursor: 'before-turn-1',
      contextUsage: f.contextUsage.value
    });
    expect(f.cacheService.detail('node-1', 'workspace-1', 'session-1')?.turns).not.toBe(
      f.turns.value
    );
    expect(cache.fileWorkbench).toEqual(savedFileWorkbench.snapshot());
    expect(cache.draft).toMatchObject({
      runner: 'codex',
      modelId: 'model-a',
      effort: 'medium',
      access: 'on-request'
    });
    expect(cache.draft).not.toHaveProperty('input');
    expect(cache.draft).not.toHaveProperty('skillTokens');
    expect(cache.draft).not.toHaveProperty('references');
  });

  it('captures the file owner snapshot without a mounted view', () => {
    const f = fixture();
    f.cacheService.activate('node-1', 'workspace-1');
    const snapshot = emptyFileSnapshot();
    f.currentFileWorkbench.snapshot.mockReturnValue(snapshot);
    f.controller.saveCurrentWorkspaceView();
    expect(f.cacheService.view('node-1', 'workspace-1').fileWorkbench).toBe(snapshot);
  });

  it('returns a cached detail and refreshes its last-access time without writing active projections', () => {
    const f = fixture();
    f.selectedNodeId.value = 'node-1';
    f.selectedWorkspaceId.value = 'workspace-1';
    f.cacheService.activate('node-1', 'workspace-1');
    const detail = {
      sessionId: 'session-1',
      runs: [
        {
          id: 'run-1',
          sessionId: 'session-1',
          status: 'SUCCEEDED',
          recoveryState: 'NONE',
          clientMessageId: 'message-1'
        }
      ],
      turns: [
        {
          id: 'turn-1',
          sessionId: 'session-1',
          runId: 'run-1',
          status: 'SUCCEEDED',
          items: []
        }
      ],
      nextCursor: 'before-turn-1',
      contextUsage: null,
      lastAccessedAt: 1
    };
    f.cacheService.captureActive(
      { sessions: [nativeSession()], selectedSessionId: 'session-1', detail },
      2
    );
    const cached = f.cacheService.detail('node-1', 'workspace-1', 'session-1');

    const restored = f.cacheService.touchDetail('node-1', 'workspace-1', 'session-1');

    expect(restored).toBe(cached);
    expect(restored?.runs).toEqual(detail.runs);
    expect(restored?.turns).toEqual(detail.turns);
    expect(restored?.nextCursor).toBe('before-turn-1');
    expect(f.runs.value).toEqual([]);
    expect(f.turns.value).toEqual([]);
    expect(f.nextCursor.value).toBeNull();
    expect(cached?.lastAccessedAt).toBeGreaterThan(1);
    expect(f.cacheService.touchDetail('node-1', 'workspace-1', 'missing')).toBeUndefined();
  });

  it('restores only cached Runner configuration without overwriting the draft owner', () => {
    const f = fixture();
    f.input.value = 'old input';
    f.skillTokens.value = [
      {
        name: 'old-skill',
        source: 'NODE_HOME',
        skillFilePath: 'old/SKILL.md',
        available: true
      }
    ];

    f.controller.restoreWorkspaceDraft(undefined);

    expect(f.input.value).toBe('old input');
    expect(f.skillTokens.value).toHaveLength(1);
    expect(f.normalizeDraft).not.toHaveBeenCalled();
    expect(f.runner.value).toBe('codex');

    f.controller.restoreWorkspaceDraft({
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      sessions: [],
      draft: {
        runner: 'mar-agent',
        modelId: 'gpt-5',
        effort: 'high',
        access: 'full-access'
      }
    });

    expect(f.normalizeDraft).toHaveBeenCalledOnce();
    expect(f.runner.value).toBe('mar-agent');
    expect(f.modelId.value).toBe('gpt-5');
    expect(f.effort.value).toBe('high');
    expect(f.access.value).toBe('full-access');
    expect(f.input.value).toBe('old input');
  });

  it('restores the file owner snapshot synchronously without a view port', () => {
    const f = fixture();
    const savedSnapshot = {
      fileTabs: { tabs: [] },
      dirtyTextDrafts: [
        { tabIdentity: 'a', path: 'a.ts', content: 'draft', expectedRevision: 'r1' }
      ],
      fileWindowSuspended: true
    };
    f.cacheService.activate('node-1', 'workspace-1');
    f.cacheService.captureActive({ sessions: [], fileWorkbench: savedSnapshot }, 2);
    f.selectedNodeId.value = 'node-1';
    f.selectedWorkspaceId.value = 'workspace-1';
    f.controller.restoreWorkspaceView('node-1', 'workspace-1');
    expect(f.currentFileWorkbench.restore).toHaveBeenCalledWith(savedSnapshot);
  });

  it('does not restore any domain for a different target', () => {
    const files = { snapshot: vi.fn(), restore: vi.fn() };
    const git = { snapshot: vi.fn(), restore: vi.fn() };
    const search = { snapshot: vi.fn(), restore: vi.fn() };
    const f = fixture({ files, git, search });
    f.cacheService.activate('node-1', 'workspace-1');
    f.cacheService.captureActive({ sessions: [], fileWorkbench: emptyFileSnapshot() }, 2);
    f.selectedNodeId.value = 'node-1';
    f.selectedWorkspaceId.value = 'workspace-2';
    f.controller.restoreWorkspaceView('node-1', 'workspace-1');
    expect(f.currentFileWorkbench.restore).not.toHaveBeenCalled();
    expect(files.restore).not.toHaveBeenCalled();
    expect(git.restore).not.toHaveBeenCalled();
    expect(search.restore).not.toHaveBeenCalled();
  });
});
