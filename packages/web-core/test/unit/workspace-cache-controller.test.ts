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
  const runner = ref<Session['runner']>('codex');
  const model = ref('model-a');
  const effort = ref('medium');
  const access = ref('on-request');
  const currentInspector = ref<WorkspaceInspectorHandle | null>();
  const normalizeDraft = vi.fn();
  const persistDraft = vi.fn();
  const controller = createWorkbenchWorkspaceCacheController({
    cacheService,
    paging,
    activeCache: cacheService.active,
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
    model,
    effort,
    access,
    workspaceTarget: workspaceTargetRef(selectedNodeId, selectedWorkspaceId),
    selectedSessionId,
    inspector: currentInspector,
    normalizeDraft,
    persistDraft,
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
    model,
    effort,
    access,
    currentInspector,
    normalizeDraft,
    persistDraft,
    controller
  };
}

describe('Public Workspace Cache Controller', () => {
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

    const cache = f.cacheService.get('node-1', 'workspace-1');
    expect(f.persistDraft).toHaveBeenCalledOnce();
    expect(cache.sessions).toEqual([nativeSession()]);
    expect(cache.selectedSessionId).toBe('session-1');
    expect(cache.queues.get('session-1')).toEqual({ version: 2, paused: true, items: [] });
    expect(cache.sessionDetails.get('session-1')).toMatchObject({
      sessionId: 'session-1',
      runs: f.runs.value,
      turns: f.turns.value,
      nextCursor: 'before-turn-1',
      contextUsage: f.contextUsage.value
    });
    expect(cache.sessionDetails.get('session-1')?.turns).not.toBe(f.turns.value);
    expect(cache.inspector).toEqual({ tab: 'files', path: 'src/main.ts' });
    expect(cache.draft).toMatchObject({
      input: 'continue this task',
      skillTokens: f.skillTokens.value,
      runner: 'codex',
      model: 'model-a',
      effort: 'medium',
      access: 'on-request'
    });
  });

  it('Preserves the cached Inspector snapshot when saving while its Vue ref is unmounted', () => {
    const f = fixture();
    const cache = f.cacheService.activate('node-1', 'workspace-1');
    const snapshot = { tab: 'files', path: 'src/main.ts' };
    cache.inspector = snapshot;
    f.currentInspector.value = null;

    f.controller.saveCurrentWorkspaceView();

    expect(cache.inspector).toBe(snapshot);
  });

  it('Copies the cached detail window and refreshes its last-access time when restoring a match', () => {
    const f = fixture();
    f.selectedNodeId.value = 'node-1';
    f.selectedWorkspaceId.value = 'workspace-1';
    const cache = f.cacheService.get('node-1', 'workspace-1');
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
    cache.sessionDetails.set('session-1', detail);

    const restored = f.controller.restoreCachedSessionDetail('session-1');

    expect(restored).toBe(detail);
    expect(f.runs.value).toEqual(detail.runs);
    expect(f.runs.value).not.toBe(detail.runs);
    expect(f.turns.value).toEqual(detail.turns);
    expect(f.turns.value).not.toBe(detail.turns);
    expect(f.nextCursor.value).toBe('before-turn-1');
    expect(detail.lastAccessedAt).toBeGreaterThan(1);
    expect(f.controller.restoreCachedSessionDetail('missing')).toBeUndefined();
  });

  it('Applies cached Runner configuration when restoring a draft and clears only editable content when the cache is missing', () => {
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

    expect(f.input.value).toBe('');
    expect(f.skillTokens.value).toEqual([]);
    expect(f.normalizeDraft).not.toHaveBeenCalled();
    expect(f.runner.value).toBe('codex');

    f.controller.restoreWorkspaceDraft({
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      sessions: [],
      queues: new Map(),
      sessionDetails: new Map(),
      draft: {
        input: 'restored input',
        skillTokens: [],
        runner: 'mar-agent',
        model: 'gpt-5',
        effort: 'high',
        access: 'full-access'
      }
    });

    expect(f.normalizeDraft).toHaveBeenCalledOnce();
    expect(f.runner.value).toBe('mar-agent');
    expect(f.model.value).toBe('gpt-5');
    expect(f.effort.value).toBe('high');
    expect(f.access.value).toBe('full-access');
    expect(f.input.value).toBe('restored input');
  });

  it('Queues Inspector restoration before the Workspace identity update renders an empty state', () => {
    const f = fixture();
    const savedSnapshot = { tab: 'search', query: 'TODO' };
    const activeInspector = inspector(undefined);
    f.currentInspector.value = activeInspector;
    f.cacheService.get('node-1', 'workspace-1').inspector = savedSnapshot;
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
    f.cacheService.get('node-1', 'workspace-1').inspector = savedSnapshot;
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
    f.cacheService.get('node-1', 'workspace-1').inspector = savedSnapshot;
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
    f.cacheService.get('node-1', 'workspace-1').inspector = savedSnapshot;
    f.selectedNodeId.value = 'node-1';
    f.selectedWorkspaceId.value = 'workspace-1';

    f.controller.restoreWorkspaceInspector('node-1', 'workspace-1');
    f.selectedWorkspaceId.value = 'workspace-2';
    f.currentInspector.value = activeInspector;
    await nextTick();

    expect(activeInspector.restore).not.toHaveBeenCalled();
  });
});
