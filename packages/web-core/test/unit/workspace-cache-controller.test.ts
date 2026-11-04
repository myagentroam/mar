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
import {
  createWorkbenchWorkspaceCacheController,
  type WorkspaceInspectorHandle
} from '../../src/service/workbench-workspace-cache-controller.js';
import type { SessionContextUsage } from '../../src/service/conversation-state-service.js';
import { createWorkspaceSessionPagingService } from '../../src/service/workspace-session-paging-service.js';
import { createWorkspaceViewCacheService } from '../../src/service/workspace-view-cache-service.js';
import { createConversationProjectionService } from '../../src/service/conversation-projection-service.js';
import { createComposerConfigurationService } from '../../src/service/composer-configuration-service.js';

function nativeSession(id = 'session-1'): Session {
  return {
    id,
    workspaceId: 'workspace-1',
    runner: 'codex',
    externalSessionId: `native-${id}`,
    activity: 'IDLE'
  };
}

function inspector(snapshot: unknown) {
  return {
    openFile: vi.fn(async () => undefined),
    openWorkspaceFileTab: vi.fn(),
    openWorkspaceFile: vi.fn(async () => undefined),
    openWorkspaceFileComparison: vi.fn(async () => undefined),
    openWorkspaceFileExternal: vi.fn(),
    openCurrentRenderedPreview: vi.fn(() => false),
    revealAndOpenWorkspaceFile: vi.fn(async () => undefined),
    openChanges: vi.fn(),
    openSearch: vi.fn(),
    refreshVisibleSection: vi.fn(),
    snapshot: vi.fn(() => snapshot),
    restore: vi.fn(),
    restoreWorkspace: vi.fn()
  } satisfies WorkspaceInspectorHandle;
}

function fixture() {
  const cacheService = createWorkspaceViewCacheService(
    (nodeId, workspaceId) => `${nodeId}:${workspaceId}`
  );
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
  const currentInspector = ref<WorkspaceInspectorHandle | null>();
  const normalizeDraft = vi.fn(configuration.apply);
  const persistDraft = vi.fn();
  const projection = createConversationProjectionService({
    turns,
    nextCursor,
    onRecentWindowOverflow: vi.fn(),
    limitHistory: (values) => [...values]
  });
  const controller = createWorkbenchWorkspaceCacheController({
    cacheService,
    paging,
    sessions,
    runs,
    turns,
    nextCursor,
    contextUsage,
    queue,
    runner,
    modelId,
    effort,
    access,
    workspaceTarget: workspaceTargetRef(selectedNodeId, selectedWorkspaceId),
    selectedSessionId,
    inspector: currentInspector,
    restoreDraftConfiguration: normalizeDraft,
    persistDraft,
    flushConversation: projection.flushPendingTextDeltas,
    tabId: (nodeId, workspaceId) => `${nodeId}:${workspaceId}`,
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
    currentInspector,
    normalizeDraft,
    persistDraft,
    projection,
    controller
  };
}

describe('Public Workspace Cache Controller', () => {
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
    const cached = f.controller.restoreCachedSessionDetail('session-1')!;
    f.projection.restoreWindow(cached.turns, cached.nextCursor);

    expect(f.turns.value[0]?.items[0]?.payload).toMatchObject({ text: 'pending tail' });
    f.projection.mergeTextDelta('run-1', { itemId: 'reply', text: ' new' }, 2);
    f.projection.flushPendingTextDeltas();
    expect(f.turns.value[0]?.items[0]?.payload).toMatchObject({ text: 'pending tail new' });
    expect(cached.turns[0]?.items[0]?.payload).toMatchObject({ text: 'pending tail' });
  });

  it('Captures restorable sessions, selection, queues, details, inspector, and draft when saving the current view', () => {
    const f = fixture();
    const savedInspector = inspector({ tab: 'files', path: 'src/main.ts' });
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
    f.currentInspector.value = savedInspector;

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
    expect(cache.inspector).toEqual({ tab: 'files', path: 'src/main.ts' });
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

  it('Preserves the cached Inspector snapshot when saving while its Vue ref is unmounted', () => {
    const f = fixture();
    f.cacheService.activate('node-1', 'workspace-1');
    const snapshot = { tab: 'files', path: 'src/main.ts' };
    f.cacheService.captureActive({ sessions: [], inspector: snapshot }, 2);
    f.currentInspector.value = null;

    f.controller.saveCurrentWorkspaceView();

    expect(f.cacheService.view('node-1', 'workspace-1').inspector).toBe(snapshot);
  });

  it('clears the old Inspector snapshot when the mounted Inspector explicitly captures none', () => {
    const f = fixture();
    f.cacheService.activate('node-1', 'workspace-1');
    f.cacheService.captureActive({ sessions: [], inspector: { tab: 'files' } }, 2);
    f.currentInspector.value = inspector(undefined);

    f.controller.saveCurrentWorkspaceView();

    expect(f.cacheService.view('node-1', 'workspace-1').inspector).toBeUndefined();
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

    const restored = f.controller.restoreCachedSessionDetail('session-1');

    expect(restored).toBe(cached);
    expect(restored?.runs).toEqual(detail.runs);
    expect(restored?.turns).toEqual(detail.turns);
    expect(restored?.nextCursor).toBe('before-turn-1');
    expect(f.runs.value).toEqual([]);
    expect(f.turns.value).toEqual([]);
    expect(f.nextCursor.value).toBeNull();
    expect(cached?.lastAccessedAt).toBeGreaterThan(1);
    expect(f.controller.restoreCachedSessionDetail('missing')).toBeUndefined();
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

  it('Queues Inspector restoration before the Workspace identity update renders an empty state', () => {
    const f = fixture();
    const savedSnapshot = { tab: 'search', query: 'TODO' };
    const activeInspector = inspector(undefined);
    f.currentInspector.value = activeInspector;
    f.cacheService.activate('node-1', 'workspace-1');
    f.cacheService.captureActive({ sessions: [], inspector: savedSnapshot }, 2);
    f.selectedNodeId.value = 'node-1';
    f.selectedWorkspaceId.value = 'workspace-1';

    f.controller.restoreWorkspaceInspector('node-1', 'workspace-1');
    expect(activeInspector.restoreWorkspace).toHaveBeenCalledWith(
      'node-1',
      'workspace-1',
      savedSnapshot
    );
    expect(activeInspector.restore).not.toHaveBeenCalled();
  });

  it('Falls back to a guarded next-tick restore when the Inspector is not mounted yet', async () => {
    const f = fixture();
    const savedSnapshot = { tab: 'search', query: 'TODO' };
    const activeInspector = inspector(undefined);
    f.cacheService.activate('node-1', 'workspace-1');
    f.cacheService.captureActive({ sessions: [], inspector: savedSnapshot }, 2);
    f.selectedNodeId.value = 'node-1';
    f.selectedWorkspaceId.value = 'workspace-1';

    f.controller.restoreWorkspaceInspector('node-1', 'workspace-1');
    f.currentInspector.value = activeInspector;
    await nextTick();

    expect(activeInspector.restore).toHaveBeenCalledWith(savedSnapshot);
  });

  it('Restores a cached Inspector after its Vue ref is temporarily null during notification navigation', async () => {
    const f = fixture();
    const savedSnapshot = { tab: 'search', query: 'TODO' };
    const activeInspector = inspector(undefined);
    f.cacheService.activate('node-1', 'workspace-1');
    f.cacheService.captureActive({ sessions: [], inspector: savedSnapshot }, 2);
    f.selectedNodeId.value = 'node-1';
    f.selectedWorkspaceId.value = 'workspace-1';
    f.currentInspector.value = null;

    expect(() => f.controller.restoreWorkspaceInspector('node-1', 'workspace-1')).not.toThrow();
    f.currentInspector.value = activeInspector;
    await nextTick();

    expect(activeInspector.restore).toHaveBeenCalledWith(savedSnapshot);
  });

  it('Does not apply a fallback Inspector restore after the selected Workspace changes', async () => {
    const f = fixture();
    const savedSnapshot = { tab: 'search', query: 'TODO' };
    const activeInspector = inspector(undefined);
    f.cacheService.activate('node-1', 'workspace-1');
    f.cacheService.captureActive({ sessions: [], inspector: savedSnapshot }, 2);
    f.selectedNodeId.value = 'node-1';
    f.selectedWorkspaceId.value = 'workspace-1';

    f.controller.restoreWorkspaceInspector('node-1', 'workspace-1');
    f.selectedWorkspaceId.value = 'workspace-2';
    f.currentInspector.value = activeInspector;
    await nextTick();

    expect(activeInspector.restore).not.toHaveBeenCalled();
  });
});
