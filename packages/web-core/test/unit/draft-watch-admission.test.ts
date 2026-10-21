import { afterEach, describe, expect, it, vi } from 'vitest';
import { computed, effectScope, ref } from 'vue';
import type { AgentRun, Session, WorkspaceTarget } from '../../src/model/workbench.js';
import type { WorkbenchView } from '../../src/util/workbench-route.js';
import { createWorkbenchSessionMessageService } from '../../src/service/WorkbenchSessionMessageService.js';
import { createWorkbenchSubmissionService } from '../../src/service/WorkbenchSubmissionService.js';
import { createWorkbenchViewWatchService } from '../../src/service/WorkbenchViewWatchService.js';
import { createHostedConversationWatchCoordinator } from '../../src/service/HostedConversationWatchCoordinator.js';
import { createHostedConversationWorkspaceService } from '../../src/service/HostedConversationWorkspaceService.js';
import { createWorkbenchSessionWatchController } from '../../src/service/WorkbenchSessionWatchController.js';
import { createWorkspaceWatchService } from '../../src/service/WorkspaceWatchService.js';

vi.mock('element-plus', () => ({ ElMessageBox: { confirm: vi.fn() } }));

function fixture() {
  const scope = effectScope();
  const workspace = { id: 'workspace-1', path: '/project', kind: 'DIRECTORY' as const };
  const draft: Session = { id: 'draft:one', workspaceId: workspace.id, runner: 'codex' };
  const created: Session = { ...draft, id: 'native-created', externalSessionId: 'native-created' };
  const workspaceTarget = ref<WorkspaceTarget>({ nodeId: 'node-1', workspaceId: workspace.id });
  const selectedSessionId = ref<string>(draft.id);
  const sessions = ref<Session[]>([draft]);
  const view = ref<WorkbenchView>('nodes');
  const connectionId = ref<string | undefined>('connection-1');
  const migrateSessionCache = vi.fn();
  const writes: { path: string; method: string; body: Record<string, unknown> }[] = [];
  let release!: (result: unknown) => void;
  const creation = new Promise((resolve) => (release = resolve));
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    writes.push({ path, method: init?.method ?? 'GET', body });
    if (path === '/api/agent-sessions/start') return (await creation) as T;
    if (init?.method === 'POST' && body.mode === 'initial') {
      if (path.includes('hosted-conversations')) {
        queueMicrotask(() =>
          coordinator.handleEvent({
            type: 'watch.hosted-conversation.snapshot',
            workbenchConnectionId: connectionId.value,
            watchId: body.watchId,
            nodeGeneration: 'generation-1',
            nodeId: 'node-1',
            conversationId: 'hosted-1',
            revision: 1,
            snapshotSequence: 1,
            expiresAt: Date.now() + 45_000,
            payload: {
              conversation: {
                id: 'hosted-1',
                nodeId: 'node-1',
                sessionId: 'hosted-session',
                templateId: 'template-1',
                templateName: 'Review',
                activeVersionId: 'version-1',
                title: 'Review',
                titleSource: 'CUSTOM',
                pinnedAt: null,
                status: 'ACTIVE',
                modelId: 'model-1',
                createdAt: 1,
                updatedAt: 1,
                lastActivityAt: 1
              },
              template: {
                id: 'template-1',
                nodeId: 'node-1',
                name: 'Review',
                description: '',
                status: 'ACTIVE',
                currentVersionId: 'version-1',
                available: true,
                createdAt: 1,
                updatedAt: 1
              },
              run: null,
              turns: [],
              historyNextCursor: null,
              files: [],
              models: [],
              error: null,
              snapshotSequence: 1
            }
          })
        );
      } else if (path.includes('agent-sessions')) {
        queueMicrotask(() =>
          coordinator.handleEvent({
            type: 'watch.session.snapshot',
            workbenchConnectionId: connectionId.value,
            watchId: body.watchId,
            nodeGeneration: 'generation-1',
            nodeId: 'node-1',
            workspaceId: workspace.id,
            sessionId: selectedSessionId.value,
            payload: { unit: 'SEGMENT', segments: [], nextCursor: null }
          })
        );
      }
      return {
        accepted: true,
        watchId: body.watchId,
        nodeGeneration: 'generation-1',
        expiresAt: Date.now() + 45_000
      } as T;
    }
    return undefined as T;
  };
  const timing = { heartbeatMs: 15_000, requestTimeoutMs: 10_000, confirmationTimeoutMs: 45_000 };
  const sessionWatch = createWorkbenchSessionWatchController({
    workspaceTarget,
    selectedSessionId,
    sessions,
    followConversation: ref(false),
    ...timing,
    workbenchConnectionId: () => connectionId.value,
    request,
    sessionPathId: (id) => id,
    mergeSessions: vi.fn(),
    applySnapshot: () => true,
    scrollAfterLayout: async () => {},
    refreshSnapshot: vi.fn(),
    openSession: async () => {}
  });
  const hosted = createHostedConversationWorkspaceService({
    request,
    workbenchConnectionId: () => connectionId.value,
    ...timing
  });
  hosted.selectConversation('node-1', 'hosted-1');
  const coordinator = createHostedConversationWatchCoordinator({
    workspace: createWorkspaceWatchService({
      workspaceTarget,
      workspaces: ref([workspace]),
      ...timing,
      workbenchConnectionId: () => connectionId.value,
      request,
      onSnapshot: vi.fn()
    }),
    session: sessionWatch,
    hosted
  });
  const navigation = createWorkbenchViewWatchService({
    coordinator: () => coordinator,
    currentView: () => view.value,
    workspaceTarget: () => workspaceTarget.value,
    selectedSessionId: () => selectedSessionId.value,
    selectedHostedConversationId: () => hosted.selectedConversationId.value
  });
  const service = scope.run(() =>
    createWorkbenchSessionMessageService({
      workspaceTarget,
      selectedSessionId,
      selectedWorkspace: computed(() => workspace),
      selectedSession: computed(() => sessions.value.find((s) => s.id === selectedSessionId.value)),
      sessions,
      runs: ref<AgentRun[]>([]),
      input: ref('Create a session'),
      skillTokens: ref([]),
      attachments: ref([]),
      attachmentsPending: computed(() => false),
      composerOpen: computed(() => true),
      composerBusy: computed(() => false),
      draftOpen: ref(true),
      selectedCommand: ref(),
      commandPickerOpen: ref(false),
      deferredCommands: ref([]),
      fastEnabled: ref(false),
      notice: ref(''),
      request,
      stageDraftCommand: vi.fn(),
      createDraftSession: async () => draft,
      executeCommand: async () => ({}),
      replaceSession: (previousId, next) => {
        sessions.value = sessions.value.filter((s) => s.id !== previousId).concat(next);
        if (selectedSessionId.value === previousId) selectedSessionId.value = next.id;
      },
      sessionPathId: (id) => id,
      temporaryTitle: (text) => text,
      clearAttachments: vi.fn(),
      clearSkillTokens: vi.fn(),
      newestRun: (_current, next) => next,
      migrateSessionCache,
      openRun: vi.fn(),
      cacheRun: vi.fn(),
      beginSessionWatch: navigation.requestSessionWatch,
      scrollToLatest: vi.fn(),
      scrollToLatestAfterLayout: async () => {},
      errorMessage: String,
      beginSubmission: createWorkbenchSubmissionService().begin
    })
  )!;
  return {
    service,
    coordinator,
    navigation,
    sessionWatch,
    view,
    connectionId,
    selectedSessionId,
    sessions,
    migrateSessionCache,
    writes,
    async send() {
      const pending = service.send();
      await vi.waitFor(() => expect(writes.some((w) => w.path.endsWith('/start'))).toBe(true));
      return {
        finish: async () => {
          release({
            session: created,
            run: { id: 'run-created', sessionId: created.id, status: 'SUCCEEDED' }
          });
          await pending;
        }
      };
    },
    select(next: WorkbenchView) {
      const previous = view.value;
      view.value = next;
      navigation.transition(previous, next);
    },
    initials: () =>
      writes.filter((w) => w.path.includes('/agent-sessions/') && w.body.mode === 'initial'),
    dispose() {
      scope.stop();
      coordinator.dispose();
    }
  };
}

describe('Draft creation Watch admission through the page services', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each(['conversations', 'settings'] as const)(
    'promotes a late result in %s without stealing the Watch and restores once on return',
    async (view) => {
      vi.useFakeTimers();
      const f = fixture();
      try {
        const sending = await f.send();
        f.select(view);
        await vi.advanceTimersByTimeAsync(0);
        const before = f.writes.length;
        await sending.finish();
        expect(f.selectedSessionId.value).toBe('native-created');
        expect(f.migrateSessionCache).toHaveBeenCalledExactlyOnceWith(
          'node-1',
          'workspace-1',
          'draft:one',
          'native-created',
          expect.objectContaining({ id: 'native-created' })
        );
        expect(f.initials()).toHaveLength(0);
        expect(
          f.writes.slice(before).filter((w) => w.path.includes('hosted-conversations'))
        ).toEqual([]);
        if (view === 'conversations') {
          await vi.advanceTimersByTimeAsync(15_000);
          expect(f.writes.at(-1)).toMatchObject({ method: 'POST', body: { mode: 'renew' } });
          expect(f.writes.at(-1)?.path).toContain('hosted-conversations');
        }
        f.select('nodes');
        await vi.advanceTimersByTimeAsync(0);
        expect(f.initials()).toHaveLength(1);
        expect(f.initials()[0]?.path).toBe('/api/agent-sessions/native-created/watch');
        f.navigation.requestSessionWatch('native-created');
        await vi.advanceTimersByTimeAsync(0);
        expect(f.initials()).toHaveLength(1);
      } finally {
        f.dispose();
      }
    }
  );

  it('does not steal another selected ordinary Session', async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      const sending = await f.send();
      f.sessions.value.push({ id: 'other', workspaceId: 'workspace-1', runner: 'codex' });
      f.selectedSessionId.value = 'other';
      f.coordinator.beginSession('other');
      await vi.advanceTimersByTimeAsync(0);
      await sending.finish();
      expect(f.selectedSessionId.value).toBe('other');
      expect(f.initials().map((w) => w.path)).toEqual(['/api/agent-sessions/other/watch']);
      expect(f.migrateSessionCache).toHaveBeenCalledOnce();
    } finally {
      f.dispose();
    }
  });

  it.each(['foreground', 'hidden', 'not-ready'] as const)(
    'uses the existing lifecycle for %s creation and recovery',
    async (state) => {
      vi.useFakeTimers();
      const f = fixture();
      try {
        const sending = await f.send();
        if (state === 'hidden') vi.stubGlobal('document', { visibilityState: 'hidden' });
        if (state === 'not-ready') f.connectionId.value = undefined;
        await sending.finish();
        expect(f.selectedSessionId.value).toBe('native-created');
        expect(f.initials()).toHaveLength(state === 'foreground' ? 1 : 0);
        vi.unstubAllGlobals();
        f.connectionId.value = 'connection-restored';
        f.coordinator.restartSession('native-created');
        await vi.advanceTimersByTimeAsync(0);
        expect(f.initials()).toHaveLength(state === 'foreground' ? 2 : 1);
      } finally {
        f.dispose();
      }
    }
  );

  it('does not write back or revive observation after its page scope is permanently disposed', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const sending = await f.send();
    f.dispose();
    const before = f.writes.length;
    await sending.finish();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.selectedSessionId.value).toBe('draft:one');
    expect(f.migrateSessionCache).not.toHaveBeenCalled();
    expect(f.writes).toHaveLength(before);
  });
});
