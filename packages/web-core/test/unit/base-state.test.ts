import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../../src/model/workbench.js';
import { createWorkbenchBaseStateService } from '../../src/service/workbench-base-state-service.js';
import { createWorkspaceSessionPaneState } from '../../src/service/workspace-session-pane-state.js';
import { createWorkbenchSubmissionOwner } from '../../src/service/workbench-submission-service.js';
import { computed, effectScope, ref } from 'vue';
import { serializeComposerTag } from '@myagentroam/protocol';
import {
  createSessionDraftService,
  type DraftTarget
} from '../../src/service/session-draft-service.js';
import { createComposerAttachmentService } from '../../src/service/composer-attachment-service.js';
import { createWorkbenchWatchCoordinator } from '../../src/service/workbench-watch-coordinator.js';

const paneSubmissions = createWorkbenchSubmissionOwner();

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  });
});
afterEach(() => vi.unstubAllGlobals());
const options = () => ({
  sessionPageSize: 10,
  onUnauthenticated: vi.fn()
});

describe('shared Workbench state composition', () => {
  it('retains the Main input across existing sessions and new-session targets', () => {
    const state = createWorkbenchBaseStateService(options());
    state.selection.workspaceTarget.value = { nodeId: 'n', workspaceId: 'w' };
    state.surface.draftSessionOpen.value = true;
    state.draft.input.value = 'new';
    state.surface.draftSessionOpen.value = false;
    state.selection.selectedSessionId.value = 'a';
    expect(state.draft.input.value).toBe('new');
    state.draft.input.value = 'a';
    state.selection.selectedSessionId.value = 'b';
    expect(state.draft.input.value).toBe('a');
    state.draft.input.value = 'b';
    state.selection.selectedSessionId.value = 'a';
    expect(state.draft.input.value).toBe('b');
    state.surface.draftSessionOpen.value = true;
    expect(state.draft.input.value).toBe('b');
    state.surface.draftSessionOpen.value = false;
    state.selection.selectedSessionId.value = 'draft:pending';
    expect(state.draft.input.value).toBe('b');
  });
  it('creates isolated ordinary state without product navigation or enterprise targets', () => {
    const a = createWorkbenchBaseStateService(options());
    const b = createWorkbenchBaseStateService(options());
    expect(a).not.toHaveProperty('hostedSelection');
    expect(a).not.toHaveProperty('navigation');
    expect(a).not.toHaveProperty('notifications');
    expect(a.admin.admin.value.authenticated).toBe(false);
    a.selection.workspaceTarget.value = { nodeId: 'node-1', workspaceId: 'workspace-1' };
    a.surface.quickOpenFileVisible.value = true;
    a.paging.initialize('node-1:workspace-1');
    expect(a.paging.visibleLimits.value.get('node-1:workspace-1')).toBe(10);
    expect(b.selection.workspaceTarget.value).toBeUndefined();
    expect(b.surface.quickOpenFileVisible.value).toBe(false);
    expect(b.paging.visibleLimits.value.size).toBe(0);
    expect(a.surface.terminalDocks).not.toBe(b.surface.terminalDocks);
  });

  it('isolates per-pane reading and queue interaction state using the same factory', async () => {
    const mainTarget = ref({
      kind: 'session' as const,
      nodeId: 'n',
      workspaceId: 'w',
      sessionId: 'main'
    });
    const asideTarget = ref({
      kind: 'session' as const,
      nodeId: 'n',
      workspaceId: 'w',
      sessionId: 'child'
    });
    const drafts = createSessionDraftService({ target: mainTarget });
    const upload = vi.fn().mockResolvedValue(undefined);
    const attachments = createComposerAttachmentService({
      context: () => mainTarget.value,
      notice: vi.fn(),
      request: vi.fn().mockResolvedValue(undefined),
      csrfToken: ref('csrf'),
      renewCsrfToken: vi.fn(),
      onUnauthenticated: vi.fn(),
      direct: { generation: () => 'generation', upload }
    });
    const main = createWorkspaceSessionPaneState({
      submissions: paneSubmissions,
      draftTarget: mainTarget,
      drafts,
      attachments,
      onConversationOverflow: vi.fn()
    });
    const aside = createWorkspaceSessionPaneState({
      pane: 'aside',
      submissions: paneSubmissions,
      draftTarget: asideTarget,
      drafts,
      attachments,
      onConversationOverflow: vi.fn()
    });
    if (false) {
      // @ts-expect-error Run collections can only be installed by their owner.
      main.run.runs.value = [];
      // @ts-expect-error Run arrays exposed to consumers are immutable.
      main.run.runs.value.push(main.run.runs.value[0]!);
      // @ts-expect-error Conversation windows can only be installed by their owner.
      main.conversation.turns.value = [];
      // @ts-expect-error Conversation arrays exposed to consumers are immutable.
      main.conversation.turns.value.push(main.conversation.turns.value[0]!);
      // @ts-expect-error Cursor changes belong to the projection owner.
      main.conversation.nextCursor.value = null;
    }
    main.draft.input.value = 'main draft';
    aside.draft.input.value = 'aside draft';
    expect(drafts.forTarget(mainTarget.value).input.value).toBe('main draft');
    expect(drafts.forTarget(asideTarget.value, 'aside').input.value).toBe('aside draft');
    const search = { ready: () => true, sessionsReady: () => true, request: vi.fn() as never };
    const mainReferences = main.createReferences(search);
    const asideReferences = aside.createReferences(search);
    main.draft.references.value = [{ type: 'file', path: 'main.txt', label: 'main.txt' }];
    aside.draft.references.value = [{ type: 'file', path: 'child.txt', label: 'child.txt' }];
    expect(mainReferences.selected.value[0]?.label).toBe('main.txt');
    expect(asideReferences.selected.value[0]?.label).toBe('child.txt');
    main.skillTokens.tokens.value = [
      { name: 'main', source: 'WORKSPACE', skillFilePath: 'main/SKILL.md', available: true }
    ];
    expect(aside.skillTokens.tokens.value).toEqual([]);
    main.attachments.add([new File(['a'], 'main.txt')]);
    aside.attachments.add([new File(['b'], 'aside.txt')]);
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    expect(main.attachments.attachments.value.map((item) => item.file.name)).toEqual(['main.txt']);
    expect(aside.attachments.attachments.value.map((item) => item.file.name)).toEqual([
      'aside.txt'
    ]);
    main.attachments.clear();
    expect(aside.attachments.attachments.value).toHaveLength(1);
    const focusMain = vi.fn();
    const focusAside = vi.fn();
    main.setInputFocus(focusMain);
    aside.setInputFocus(focusAside);
    aside.focusInput(3);
    expect(focusAside).toHaveBeenCalledWith(3);
    expect(focusMain).not.toHaveBeenCalled();
    main.draggingAttachments.value = true;
    expect(aside.draggingAttachments.value).toBe(false);
    main.run.acceptRun({
      id: 'main-run',
      sessionId: 'main',
      status: 'RUNNING',
      recoveryState: 'NONE',
      clientMessageId: 'message'
    });
    aside.run.acceptRun({
      id: 'child-run',
      sessionId: 'child',
      status: 'RUNNING',
      recoveryState: 'NONE',
      clientMessageId: 'message'
    });
    main.run.mergeSnapshots([]);
    aside.run.mergeSnapshots([]);
    expect(main.run.runs.value.map((run) => run.id)).toEqual(['main-run']);
    expect(aside.run.runs.value.map((run) => run.id)).toEqual(['child-run']);
    main.conversation.channelToken.value = 'main-token';
    aside.conversation.channelToken.value = 'child-token';
    const refresh = vi.fn(async () => undefined);
    const realtime = aside.createRealtime({
      syncTurnStatus: vi.fn(),
      refreshChannelToken: refresh,
      syncCachedRunStatus: vi.fn()
    });
    realtime.openRun('child-run');
    expect(aside.run.selectedRunId.value).toBe('child-run');
    expect(aside.conversation.channelToken.value).toBeUndefined();
    expect(main.conversation.channelToken.value).toBe('main-token');
    expect(refresh).toHaveBeenCalledOnce();
    const channelRequest = vi.fn(async (_path: string) => ({ token: 'new-child-token' }));
    const channel = aside.createRunnerChannel({
      selectedSession: computed(
        () => ({ id: 'child', workspaceId: 'w', runner: 'claude-code' }) as never
      ),
      loading: ref(false),
      notice: vi.fn(),
      request: channelRequest as never,
      sessionPathId: String,
      errorMessage: String
    });
    await channel.refreshClaudeChannelToken();
    expect(channelRequest.mock.calls[0]?.[0]).toContain(
      '/agent-sessions/child/channel-token?nodeId=n'
    );
    expect(aside.conversation.channelToken.value).toBe('new-child-token');
    expect(main.conversation.channelToken.value).toBe('main-token');
    expect(main.conversation.nextDetailRequest()).toBe(1);
    expect(main.conversation.nextDetailRequest()).toBe(2);
    expect(aside.conversation.nextDetailRequest()).toBe(1);
    const asideConfiguration = aside.createConfiguration({
      sessions: ref([]),
      profiles: ref([]),
      effortLabel: (value) => value
    });
    const child = { id: 'child', workspaceId: 'w', runner: 'codex' } as never;
    aside.acceptResolvedSession('other-node', child);
    expect(asideConfiguration.selectedSession.value).toBeUndefined();
    aside.acceptResolvedSession('n', child);
    expect(asideConfiguration.selectedSession.value).toMatchObject({
      id: 'child',
      runner: 'codex'
    });
    asideTarget.value = { kind: 'session', nodeId: 'n', workspaceId: 'other', sessionId: 'child' };
    expect(asideConfiguration.selectedSession.value).toBeUndefined();
    aside.acceptResolvedSession('n', child);
    expect(asideConfiguration.selectedSession.value).toBeUndefined();
    asideTarget.value = { kind: 'session', nodeId: 'n', workspaceId: 'w', sessionId: 'child' };
    expect(asideConfiguration.selectedSession.value).toBeUndefined();
    let finishToken!: (value: { token: string }) => void;
    channelRequest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishToken = resolve;
        })
    );
    const pendingToken = channel.refreshClaudeChannelToken();
    asideTarget.value = { ...asideTarget.value, sessionId: 'other' };
    asideTarget.value = { ...asideTarget.value, sessionId: 'child' };
    aside.conversation.channelToken.value = 'current-token';
    finishToken({ token: 'stale-token' });
    await pendingToken;
    expect(aside.conversation.channelToken.value).toBe('current-token');
    main.queue.startEditing({ queueItemId: 'one', content: 'main edit' });
    aside.queue.startEditing({ queueItemId: 'two', content: 'aside edit' });
    expect(main.queue.editingContent.value).toBe('main edit');
    expect(aside.queue.editingContent.value).toBe('aside edit');
    main.scroll.following.value = false;
    expect(aside.scroll.following.value).toBe(true);
    main.draft.input.value = '@main';
    aside.draft.input.value = '@child';
    mainReferences.update();
    asideReferences.update();
    expect(mainReferences.open.value).toBe(true);
    expect(asideReferences.open.value).toBe(true);
    mainTarget.value = { ...asideTarget.value };
    expect(mainReferences.open.value).toBe(false);
    expect(asideReferences.open.value).toBe(true);
    expect(mainReferences.selected.value[0]?.label).toBe('main.txt');
    expect(main.skillTokens.tokens.value[0]?.name).toBe('main');
    mainTarget.value = { ...mainTarget.value, sessionId: 'main' };
    expect(mainReferences.selected.value[0]?.label).toBe('main.txt');
    expect(main.skillTokens.tokens.value[0]?.name).toBe('main');
    attachments.clearAll();
  });

  it('isolates same-session Pane drafts while sharing submission admission', () => {
    const target = { kind: 'session' as const, nodeId: 'n', workspaceId: 'w', sessionId: 'same' };
    const mainTarget = ref<typeof target | undefined>(target);
    const asideTarget = ref<typeof target | undefined>(target);
    const drafts = createSessionDraftService({ target: mainTarget });
    const submissions = createWorkbenchSubmissionOwner();
    const attachments = createComposerAttachmentService({
      context: () => mainTarget.value,
      notice: vi.fn(),
      request: vi.fn(),
      csrfToken: ref('csrf'),
      renewCsrfToken: vi.fn(),
      onUnauthenticated: vi.fn()
    });
    const main = createWorkspaceSessionPaneState({
      submissions,
      draftTarget: mainTarget,
      drafts,
      attachments,
      onConversationOverflow: vi.fn()
    });
    const aside = createWorkspaceSessionPaneState({
      pane: 'aside',
      submissions,
      draftTarget: asideTarget,
      drafts,
      attachments,
      onConversationOverflow: vi.fn()
    });
    main.draft.input.value = 'main';
    aside.draft.input.value = 'aside';
    expect(main.draft.input.value).toBe('main');
    const finish = main.submission.begin('session:same', undefined, null)!;
    expect(aside.submission.pending.value).toBe(true);
    expect(aside.submission.begin('session:same', undefined, null)).toBeUndefined();
    asideTarget.value = undefined;
    expect(main.draft.input.value).toBe('main');
    expect(main.submission.pending.value).toBe(true);
    expect(finish()).toBe(true);
  });

  it('routes two real Pane Watches without requiring descendants in a Main session list', async () => {
    const workspace = { nodeId: 'n', workspaceId: 'w' };
    const mainTarget = ref({ kind: 'session' as const, ...workspace, sessionId: 'main' });
    const asideTarget = ref({ kind: 'session' as const, ...workspace, sessionId: 'child' });
    const drafts = createSessionDraftService({ target: mainTarget });
    const attachments = createComposerAttachmentService({
      context: () => mainTarget.value,
      notice: vi.fn(),
      request: vi.fn(),
      csrfToken: ref('csrf'),
      renewCsrfToken: vi.fn(),
      onUnauthenticated: vi.fn()
    });
    const main = createWorkspaceSessionPaneState({
      submissions: paneSubmissions,
      draftTarget: mainTarget,
      drafts,
      attachments,
      onConversationOverflow: vi.fn()
    });
    const aside = createWorkspaceSessionPaneState({
      pane: 'aside',
      submissions: paneSubmissions,
      draftTarget: asideTarget,
      drafts,
      attachments,
      onConversationOverflow: vi.fn()
    });
    const requests: Array<{ sessionId: string; watchId: string }> = [];
    const makeWatch = (pane: typeof main, sessionId: string, secondary: boolean) =>
      pane.createWatch({
        heartbeatMs: 60_000,
        requestTimeoutMs: 10_000,
        confirmationTimeoutMs: 30_000,
        ...(secondary ? { position: 'secondary' as const } : {}),
        enabled: () => true,
        request: async <T>(path: string, init?: RequestInit) => {
          if (init?.method === 'POST')
            requests.push({ sessionId, watchId: JSON.parse(String(init.body)).watchId });
          return { nodeGeneration: 'g' } as T;
        },
        sessionPathId: (id) => id,
        applySnapshot: () => true,
        refreshSnapshot: vi.fn(),
        openSession: async () => undefined,
        openRun: vi.fn()
      });
    const primary = makeWatch(main, 'main', false);
    const secondary = makeWatch(aside, 'child', true);
    const coordinator = createWorkbenchWatchCoordinator({
      workspace: {
        start: async () => {},
        restart: async () => {},
        pause() {},
        stop() {},
        handleEvent: () => false
      },
      session: primary,
      secondary
    });
    try {
      coordinator.beginSession('main');
      coordinator.beginSecondarySession('child');
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      for (const item of [...requests].reverse()) {
        expect(
          coordinator.handleEvent({
            type: 'watch.session.snapshot',
            workbenchConnectionId: 'local-test-connection',
            nodeGeneration: 'g',
            ...workspace,
            watchId: item.watchId,
            sessionId: item.sessionId,
            payload: {
              kind: 'session-watch-snapshot',
              sequence: 1,
              session: { id: item.sessionId, workspaceId: 'w', activity: 'MANAGED_ACTIVE' },
              runs: [{ id: `run-${item.sessionId}`, sessionId: item.sessionId, status: 'RUNNING' }],
              conversation: { unit: 'SEGMENT', segments: [], nextCursor: null, source: 'runtime' }
            }
          })
        ).toBe(true);
      }
      await vi.waitFor(() => {
        expect(main.run.runs.value.map((item) => item.id)).toEqual(['run-main']);
        expect(aside.run.runs.value.map((item) => item.id)).toEqual(['run-child']);
      });
    } finally {
      coordinator.stopSession();
      coordinator.stopSecondarySession();
      attachments.clearAll();
    }
  });

  it('cancels only the changed Pane read and releases a pending read with its scope', async () => {
    const mainTarget = ref({
      kind: 'session' as const,
      nodeId: 'n',
      workspaceId: 'w',
      sessionId: 'main'
    });
    const asideTarget = ref({
      kind: 'session' as const,
      nodeId: 'n',
      workspaceId: 'w',
      sessionId: 'child'
    });
    const drafts = createSessionDraftService({ target: mainTarget });
    const attachments = createComposerAttachmentService({
      context: () => mainTarget.value,
      request: vi.fn() as never,
      renewCsrfToken: vi.fn(),
      csrfToken: ref('csrf'),
      onUnauthenticated: vi.fn(),
      notice: vi.fn()
    });
    const { effectScope } = await import('vue');
    const scope = effectScope();
    const panes = scope.run(() => ({
      main: createWorkspaceSessionPaneState({
        submissions: paneSubmissions,
        draftTarget: mainTarget,
        drafts,
        attachments,
        onConversationOverflow: vi.fn()
      }),
      aside: createWorkspaceSessionPaneState({
        pane: 'aside',
        submissions: paneSubmissions,
        draftTarget: asideTarget,
        drafts,
        attachments,
        onConversationOverflow: vi.fn()
      })
    }))!;
    const reads: { signal: AbortSignal; resolve: (value: never) => void }[] = [];
    const request = vi.fn(
      (_path: string, init?: RequestInit) =>
        new Promise((resolve) => {
          reads.push({ signal: init!.signal!, resolve: resolve as (value: never) => void });
        })
    ) as never;
    const main = panes.main.readSession('n', 'main', request, String);
    const aside = panes.aside.readSession('n', 'child', request, String);
    let mainRendered = false;
    let asideRendered = false;
    const mainRender = panes.main.conversation.beginInitialRender().then(() => {
      mainRendered = true;
    });
    const asideRender = panes.aside.conversation.beginInitialRender().then(() => {
      asideRendered = true;
    });
    panes.main.queue.startEditing({ queueItemId: 'main-item', content: 'main' });
    panes.aside.queue.startEditing({ queueItemId: 'child-item', content: 'child' });
    panes.main.queue.draggingQueueItemId.value = 'main-item';
    const settled = Promise.allSettled([main, aside]);
    mainTarget.value = { ...mainTarget.value };
    expect(reads[0]!.signal.aborted).toBe(false);
    expect(panes.main.queue.editingQueueItemId.value).toBe('main-item');
    mainTarget.value = { ...mainTarget.value, sessionId: 'next' };
    expect(reads[0]!.signal.aborted).toBe(true);
    expect(reads[1]!.signal.aborted).toBe(false);
    await mainRender;
    expect(mainRendered).toBe(true);
    expect(asideRendered).toBe(false);
    expect(panes.main.queue.editingQueueItemId.value).toBeUndefined();
    expect(panes.main.queue.draggingQueueItemId.value).toBeUndefined();
    expect(panes.aside.queue.editingQueueItemId.value).toBe('child-item');
    scope.stop();
    expect(reads[1]!.signal.aborted).toBe(true);
    await asideRender;
    expect(asideRendered).toBe(true);
    reads[0]!.resolve({ session: { id: 'main', workspaceId: 'w' } } as never);
    reads[1]!.resolve({ session: { id: 'child', workspaceId: 'w' } } as never);
    expect((await settled).map((result) => result.status)).toEqual(['rejected', 'rejected']);
  });

  it('binds each initial loader to its own Pane reader and run projection', async () => {
    const mainTarget = ref({
      kind: 'session' as const,
      nodeId: 'n',
      workspaceId: 'w',
      sessionId: 'main'
    });
    const asideTarget = ref({ ...mainTarget.value, sessionId: 'child' });
    const drafts = createSessionDraftService({ target: mainTarget });
    const attachments = createComposerAttachmentService({
      context: () => mainTarget.value,
      request: vi.fn() as never,
      renewCsrfToken: vi.fn(),
      csrfToken: ref('csrf'),
      onUnauthenticated: vi.fn(),
      notice: vi.fn()
    });
    const main = createWorkspaceSessionPaneState({
      submissions: paneSubmissions,
      draftTarget: mainTarget,
      drafts,
      attachments,
      onConversationOverflow: vi.fn()
    });
    const aside = createWorkspaceSessionPaneState({
      pane: 'aside',
      submissions: paneSubmissions,
      draftTarget: asideTarget,
      drafts,
      attachments,
      onConversationOverflow: vi.fn()
    });
    main.run.replaceRuns([
      {
        id: 'main-run',
        sessionId: 'main',
        status: 'RUNNING',
        recoveryState: 'NONE',
        clientMessageId: 'main'
      }
    ]);
    aside.run.replaceRuns([
      {
        id: 'child-run',
        sessionId: 'child',
        status: 'RUNNING',
        recoveryState: 'NONE',
        clientMessageId: 'child'
      }
    ]);
    const pending: { path: string; resolve: (value: never) => void }[] = [];
    const request = vi.fn(
      (path: string) =>
        new Promise((resolve) => {
          pending.push({ path, resolve: resolve as (value: never) => void });
        })
    ) as never;
    const projection = () => ({
      request,
      sessionPathId: String,
      replaceSession: vi.fn(),
      applyComposerConfiguration: vi.fn(),
      markActive: vi.fn(),
      openRun: vi.fn(),
      canWatch: () => true,
      beginWatch: vi.fn().mockResolvedValue(true),
      applySnapshot: vi.fn(),
      mergeTurns: vi.fn(),
      saveCurrent: vi.fn()
    });
    const mainProjection = projection();
    const asideProjection = projection();
    const childConfiguration = aside.createConfiguration({
      sessions: ref([]),
      profiles: ref([]),
      effortLabel: (value) => value
    });
    const input = (sessionId: string) => ({
      nodeId: 'n',
      workspaceId: 'w',
      sessionId,
      isCurrent: () => true,
      onResolved: vi.fn()
    });
    const mainLoad = main.createLoader(mainProjection).load(input('main'));
    const asideLoad = aside.createLoader(asideProjection).load(input('child'));
    expect(pending.map((entry) => entry.path)).toEqual([
      '/api/agent-sessions/main?nodeId=n',
      '/api/agent-sessions/child?nodeId=n'
    ]);
    pending[1]!.resolve({ session: { id: 'child', workspaceId: 'w', runner: 'CODEX' } } as never);
    await asideLoad;
    expect(childConfiguration.selectedSession.value?.id).toBe('child');
    expect(asideProjection.openRun).toHaveBeenCalledWith('child-run');
    expect(mainProjection.openRun).not.toHaveBeenCalled();
    pending[0]!.resolve({ session: { id: 'main', workspaceId: 'w', runner: 'CODEX' } } as never);
    await mainLoad;
    expect(mainProjection.openRun).toHaveBeenCalledWith('main-run');
    expect(asideProjection.beginWatch).toHaveBeenCalledWith('child');
    expect(mainProjection.beginWatch).toHaveBeenCalledWith('main');
  });

  it('binds session presentation to each Pane run and submission owner', () => {
    vi.useFakeTimers();
    try {
      const mainTarget = ref({
        kind: 'session' as const,
        nodeId: 'n',
        workspaceId: 'w',
        sessionId: 'main'
      });
      const asideTarget = ref({ ...mainTarget.value, sessionId: 'child' });
      const drafts = createSessionDraftService({ target: mainTarget });
      const attachments = createComposerAttachmentService({
        context: () => mainTarget.value,
        request: vi.fn() as never,
        renewCsrfToken: vi.fn(),
        csrfToken: ref('csrf'),
        onUnauthenticated: vi.fn(),
        notice: vi.fn()
      });
      const submissions = createWorkbenchSubmissionOwner();
      const main = createWorkspaceSessionPaneState({
        submissions,
        draftTarget: mainTarget,
        drafts,
        attachments,
        onConversationOverflow: vi.fn()
      });
      const aside = createWorkspaceSessionPaneState({
        pane: 'aside',
        submissions,
        draftTarget: asideTarget,
        drafts,
        attachments,
        onConversationOverflow: vi.fn()
      });
      main.run.replaceRuns([
        {
          id: 'main-run',
          sessionId: 'main',
          status: 'RUNNING',
          recoveryState: 'NONE',
          clientMessageId: 'main'
        }
      ]);
      aside.run.replaceRuns([
        {
          id: 'child-run',
          sessionId: 'child',
          status: 'RUNNING',
          recoveryState: 'NONE',
          clientMessageId: 'child'
        }
      ]);
      main.run.selectedRunId.value = 'main-run';
      aside.run.selectedRunId.value = 'child-run';
      const projection = (id: string) => ({
        provisionalSessionId: ref<string | undefined>(id),
        selectedSession: computed(() => undefined),
        sessions: ref([]),
        draftOpen: ref(false),
        runnerProfilesLoading: ref(false),
        runnerProfilesFailed: ref(false),
        composerProfile: computed(() => undefined),
        composerModels: computed(() => []),
        composerAccessOptions: computed(() => []),
        currentSessionQueue: computed(() => ({ version: 0, paused: false, items: [] })),
        loading: ref(false),
        nodes: ref([]),
        nodeManifest: ref(undefined),
        shouldDisplayItem: () => true,
        formatTokenCount: String,
        formatPercentage: String
      });
      const mainView = main.createPresentation(projection('main'));
      const asideView = aside.createPresentation(projection('child'));
      expect(mainView.activeComposerRun.value?.id).toBe('main-run');
      expect(asideView.activeComposerRun.value?.id).toBe('child-run');
      main.run.selectedRunId.value = undefined;
      expect(mainView.activeComposerRun.value).toBeUndefined();
      expect(asideView.activeComposerRun.value?.id).toBe('child-run');
      aside.run.selectedRunId.value = undefined;
      const finish = main.submission.begin();
      expect(mainView.sessionControlsBusy.value).toBe(true);
      expect(asideView.sessionControlsBusy.value).toBe(false);
      finish?.();
      expect(mainView.sessionControlsBusy.value).toBe(false);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('keeps performance bound to the owning Pane target and scope', () => {
    const mainTarget = ref({
      kind: 'session' as const,
      nodeId: 'n',
      workspaceId: 'w',
      sessionId: 'main'
    });
    const asideTarget = ref({ ...mainTarget.value, sessionId: 'child' });
    const drafts = createSessionDraftService({ target: mainTarget });
    const attachments = createComposerAttachmentService({
      context: () => mainTarget.value,
      request: vi.fn() as never,
      renewCsrfToken: vi.fn(),
      csrfToken: ref('csrf'),
      onUnauthenticated: vi.fn(),
      notice: vi.fn()
    });
    const submissions = createWorkbenchSubmissionOwner();
    const scope = effectScope();
    const panes = scope.run(() => {
      const main = createWorkspaceSessionPaneState({
        submissions,
        draftTarget: mainTarget,
        drafts,
        attachments,
        onConversationOverflow: vi.fn()
      });
      const aside = createWorkspaceSessionPaneState({
        pane: 'aside',
        submissions,
        draftTarget: asideTarget,
        drafts,
        attachments,
        onConversationOverflow: vi.fn()
      });
      const view = ref('nodes');
      return { main: main.createPerformance(view), aside: aside.createPerformance(view) };
    })!;
    panes.main.receive('main', { runId: 'main-run', latencyMs: 3 });
    panes.aside.receive('child', { runId: 'child-run', latencyMs: 7 });
    expect(panes.main.current.value?.runId).toBe('main-run');
    expect(panes.aside.current.value?.runId).toBe('child-run');
    asideTarget.value = { ...asideTarget.value, workspaceId: 'other' };
    expect(panes.aside.current.value).toBeUndefined();
    expect(panes.main.current.value?.runId).toBe('main-run');
    scope.stop();
    mainTarget.value = { ...mainTarget.value, sessionId: 'new' };
    expect(panes.main.current.value?.runId).toBe('main-run');
  });

  it('cancels stale initial history independently for each Pane', async () => {
    const { createWorkspaceSessionPaneReader } =
      await import('../../src/service/workspace-session-pane-state.js');
    const main = createWorkspaceSessionPaneReader();
    const aside = createWorkspaceSessionPaneReader();
    const pending: { signal: AbortSignal; resolve: (value: never) => void }[] = [];
    const request = vi.fn(
      (_path: string, init?: RequestInit) =>
        new Promise((resolve) => {
          pending.push({ signal: init!.signal!, resolve: resolve as (value: never) => void });
        })
    ) as never;
    const oldHistory = main.readInitialHistory('n', 'main', request, String);
    const rejected = expect(oldHistory).rejects.toMatchObject({ code: 'WATCH_CANCELLED' });
    const asideHistory = aside.readInitialHistory('n', 'child', request, String);
    main.cancel();
    expect(pending[0]!.signal.aborted).toBe(true);
    expect(pending[1]!.signal.aborted).toBe(false);
    pending[1]!.resolve({ segments: [], nextCursor: null } as never);
    expect((await asideHistory).turns).toEqual([]);
    pending[0]!.resolve({ segments: [], nextCursor: null } as never);
    await rejected;
  });

  it('classifies only its own aborted request as WATCH_CANCELLED', async () => {
    const { createWorkspaceSessionPaneReader } =
      await import('../../src/service/workspace-session-pane-state.js');
    const reader = createWorkspaceSessionPaneReader();
    const unexpected = new DOMException('external abort', 'AbortError');
    const external = vi.fn(async () => {
      throw unexpected;
    }) as never;
    await expect(reader.read('n', 'one', external, String)).rejects.toBe(unexpected);
    const request = vi.fn(
      (_path: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          );
        })
    ) as never;
    const cancelled = reader.read('n', 'one', request, String);
    reader.cancel();
    await expect(cancelled).rejects.toMatchObject({ code: 'WATCH_CANCELLED' });
  });

  it('binds the same queue action factory to each Pane target and editor', async () => {
    const mainTarget = ref({
      kind: 'session' as const,
      nodeId: 'n',
      workspaceId: 'w',
      sessionId: 'main'
    });
    const asideTarget = ref({
      ...mainTarget.value,
      nodeId: 'aside-node',
      workspaceId: 'aside-workspace',
      sessionId: 'child'
    });
    const drafts = createSessionDraftService({ target: mainTarget });
    const attachments = createComposerAttachmentService({
      context: () => mainTarget.value,
      request: vi.fn() as never,
      renewCsrfToken: vi.fn(),
      csrfToken: ref('csrf'),
      onUnauthenticated: vi.fn(),
      notice: vi.fn()
    });
    const main = createWorkspaceSessionPaneState({
      submissions: paneSubmissions,
      draftTarget: mainTarget,
      drafts,
      attachments,
      onConversationOverflow: vi.fn()
    });
    const aside = createWorkspaceSessionPaneState({
      pane: 'aside',
      submissions: paneSubmissions,
      draftTarget: asideTarget,
      drafts,
      attachments,
      onConversationOverflow: vi.fn()
    });
    const request = vi.fn(async (_path: string, _init?: RequestInit) => undefined);
    const queue = ref({ version: 0, paused: false, items: [] });
    const sharedQueue = ref({
      version: 2,
      paused: false,
      items: [
        { queueItemId: 'main-item', sessionId: 'main' },
        { queueItemId: 'child-item', sessionId: 'child' }
      ]
    } as never);
    expect(main.projectQueue(sharedQueue).value.items.map((item) => item.queueItemId)).toEqual([
      'main-item'
    ]);
    expect(aside.projectQueue(sharedQueue).value.items.map((item) => item.queueItemId)).toEqual([
      'child-item'
    ]);
    const common = {
      queue,
      currentSessionQueue: computed(() => queue.value),
      currentSelectionRevision: () => 0,
      request: request as never,
      notice: vi.fn(),
      errorMessage: String,
      missingQueueItemError: () => false,
      beginSubmission: () => () => true
    };
    const mainActions = main.createQueueActions(common);
    const asideActions = aside.createQueueActions(common);
    main.queue.startEditing({ queueItemId: 'main-item', content: 'main text' });
    aside.queue.startEditing({ queueItemId: 'child-item', content: 'child text' });
    expect(await asideActions.save('child-item')).toBe(true);
    expect(main.queue.editingQueueItemId.value).toBe('main-item');
    expect(aside.queue.editingQueueItemId.value).toBeUndefined();
    expect(await mainActions.save('main-item')).toBe(true);
    const calls = request.mock.calls;
    expect(calls.map(([, init]) => JSON.parse(init!.body as string))).toMatchObject([
      {
        nodeId: 'aside-node',
        workspaceId: 'aside-workspace',
        sessionId: 'child',
        content: 'child text'
      },
      { nodeId: 'n', workspaceId: 'w', sessionId: 'main', content: 'main text' }
    ]);
  });

  it('binds history mutations and admission to the Pane target rather than another workspace with the same session id', async () => {
    const target = ref<DraftTarget>({
      kind: 'session',
      nodeId: 'node',
      workspaceId: 'workspace',
      sessionId: 'same'
    });
    const drafts = createSessionDraftService({ target });
    const submissions = createWorkbenchSubmissionOwner();
    const attachments = createComposerAttachmentService({
      context: () => target.value,
      notice: vi.fn(),
      request: vi.fn(),
      csrfToken: ref('csrf'),
      renewCsrfToken: vi.fn(),
      onUnauthenticated: vi.fn()
    });
    const main = createWorkspaceSessionPaneState({
      draftTarget: target,
      drafts,
      attachments,
      submissions,
      onConversationOverflow: vi.fn()
    });
    const aside = createWorkspaceSessionPaneState({
      pane: 'aside',
      draftTarget: target,
      drafts,
      attachments,
      submissions,
      onConversationOverflow: vi.fn()
    });
    const selectedSession = ref({ id: 'same', workspaceId: 'workspace', runner: 'codex' as const });
    let resolveRequest!: (value: { session: typeof selectedSession.value }) => void;
    const request = vi.fn(
      () =>
        new Promise<{ session: typeof selectedSession.value }>((resolve) => {
          resolveRequest = resolve;
        })
    );
    const history = main.createHistoryMutation({
      selectedSession,
      canRewind: () => true,
      canRollback: () => true,
      confirmRewind: async () => true,
      confirmRollback: async () => true,
      request: request as never,
      sessionPathId: (id) => id,
      onDraftFilled: vi.fn(),
      replaceSession: vi.fn(),
      openSession: vi.fn(async () => undefined),
      invalidateDetail: vi.fn(),
      clearHistory: vi.fn()
    });
    const turn = {
      id: 'turn',
      status: 'SUCCEEDED',
      rewind: { before: 'previous', after: 'current' }
    } as never;
    const item = {
      id: 'item',
      kind: 'user_message',
      status: 'COMPLETED',
      payload: { text: 'draft' }
    } as never;
    const pending = history.rewind(turn, item);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(aside.submission.begin('same target')).toBeUndefined();
    const originalSession = selectedSession.value;
    target.value = { kind: 'session', nodeId: 'node', workspaceId: 'other', sessionId: 'same' };
    selectedSession.value = { ...originalSession, workspaceId: 'other' };
    resolveRequest({ session: originalSession });
    await expect(pending).resolves.toMatchObject({ status: 'STALE' });
    expect(main.draft.input.value).toBe('');
    target.value = { kind: 'session', nodeId: 'node', workspaceId: 'workspace', sessionId: 'same' };
    selectedSession.value = originalSession;
    const aba = history.rewind(turn, item);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    target.value = { kind: 'session', nodeId: 'node', workspaceId: 'other', sessionId: 'same' };
    target.value = { kind: 'session', nodeId: 'node', workspaceId: 'workspace', sessionId: 'same' };
    resolveRequest({ session: originalSession });
    await expect(aba).resolves.toMatchObject({ status: 'STALE' });
  });

  it.each(['workspace', 'node', 'aba', 'dispose'] as const)(
    'does not continue Plan after %s invalidates the actual Pane',
    async (change) => {
      const { effectScope } = await import('vue');
      const target = ref<DraftTarget>({
        kind: 'session',
        nodeId: 'n',
        workspaceId: 'w',
        sessionId: 'same'
      });
      const original = target.value;
      const drafts = createSessionDraftService({ target });
      const submissions = createWorkbenchSubmissionOwner();
      const attachments = createComposerAttachmentService({
        context: () => target.value,
        notice: vi.fn(),
        request: vi.fn(),
        csrfToken: ref('csrf'),
        renewCsrfToken: vi.fn(),
        onUnauthenticated: vi.fn()
      });
      const scope = effectScope();
      const pane = scope.run(() =>
        createWorkspaceSessionPaneState({
          draftTarget: target,
          drafts,
          attachments,
          submissions,
          onConversationOverflow: vi.fn()
        })
      )!;
      const selectedSession = computed(() => ({
        id: 'same',
        workspaceId: 'w',
        runner: 'codex' as const
      }));
      const send = vi.fn(async () => undefined);
      let finishClose!: (value: {}) => void;
      const execute = vi.fn(
        () =>
          new Promise<{}>((resolve) => {
            finishClose = resolve;
          })
      );
      const plan = scope.run(() =>
        pane.createPlan({
          selectedSession,
          selectedCommand: ref(),
          commandPickerOpen: ref(false),
          notice: vi.fn(),
          continuationFor: () =>
            ({
              commandId: 'plan',
              closeInput: '/plan',
              continuation: { prompt: 'implement' }
            }) as never,
          execute,
          send,
          errorMessage: String
        })
      )!;
      const pending = plan.implementPlan({} as never);
      expect(execute).toHaveBeenCalledOnce();
      if (change === 'dispose') scope.stop();
      else {
        target.value = {
          ...original,
          nodeId: change === 'node' ? 'other' : 'n',
          workspaceId: change === 'node' ? 'w' : 'other'
        };
        if (change === 'aba') target.value = original;
      }
      finishClose({});
      await pending;
      expect(send).not.toHaveBeenCalled();
      expect(drafts.forTarget(original).input.value).toBe('');
      expect(submissions.bind(() => drafts.forTarget(original)).pending.value).toBe(false);
      scope.stop();
    }
  );

  it.each(['workspace', 'node', 'aba', 'dispose'] as const)(
    'does not execute compact after %s invalidates the actual Pane during confirmation',
    async (change) => {
      const { effectScope } = await import('vue');
      const { ElMessageBox } = await import('../../src/service/message-box-service.js');
      const target = ref<DraftTarget>({
        kind: 'session',
        nodeId: 'n',
        workspaceId: 'w',
        sessionId: 'same'
      });
      const original = target.value;
      const drafts = createSessionDraftService({ target });
      const attachments = createComposerAttachmentService({
        context: () => target.value,
        notice: vi.fn(),
        request: vi.fn(),
        csrfToken: ref('csrf'),
        renewCsrfToken: vi.fn(),
        onUnauthenticated: vi.fn()
      });
      const scope = effectScope();
      const pane = scope.run(() =>
        createWorkspaceSessionPaneState({
          draftTarget: target,
          drafts,
          attachments,
          submissions: createWorkbenchSubmissionOwner(),
          onConversationOverflow: vi.fn()
        })
      )!;
      const execute = vi.fn(async () => undefined);
      let confirm!: () => void;
      const spy = vi.spyOn(ElMessageBox, 'confirm').mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            confirm = () => resolve('confirm' as never);
          })
      );
      try {
        const service = scope.run(() =>
          pane.createContextCommands({
            selectedSession: computed(() => ({
              id: 'same',
              workspaceId: 'w',
              runner: 'codex' as const
            })),
            compactCommand: computed(() => ({ id: 'compact' }) as never),
            canCompact: computed(() => true),
            contextUsageLabel: computed(() => ''),
            notice: vi.fn(),
            request: vi.fn(),
            execute,
            errorMessage: String
          })
        )!;
        const pending = service.compactCurrentContext();
        if (change === 'dispose') scope.stop();
        else {
          target.value = {
            ...original,
            nodeId: change === 'node' ? 'other' : 'n',
            workspaceId: change === 'node' ? 'w' : 'other'
          };
          if (change === 'aba') target.value = original;
        }
        confirm();
        await pending;
        expect(execute).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
        scope.stop();
      }
    }
  );

  it('binds approval actions from the common factory to the owning Pane identity', async () => {
    const mainTarget = ref({
      kind: 'session' as const,
      nodeId: 'main-node',
      workspaceId: 'main-workspace',
      sessionId: 'same'
    });
    const asideTarget = ref({
      ...mainTarget.value,
      nodeId: 'aside-node',
      workspaceId: 'aside-workspace'
    });
    const drafts = createSessionDraftService({ target: mainTarget });
    const attachments = createComposerAttachmentService({
      context: () => mainTarget.value,
      request: vi.fn() as never,
      renewCsrfToken: vi.fn(),
      csrfToken: ref('csrf'),
      onUnauthenticated: vi.fn(),
      notice: vi.fn()
    });
    const main = createWorkspaceSessionPaneState({
      submissions: paneSubmissions,
      draftTarget: mainTarget,
      drafts,
      attachments,
      onConversationOverflow: vi.fn()
    });
    const aside = createWorkspaceSessionPaneState({
      pane: 'aside',
      submissions: paneSubmissions,
      draftTarget: asideTarget,
      drafts,
      attachments,
      onConversationOverflow: vi.fn()
    });
    const request = vi.fn(async (_path: string, _init?: RequestInit) => ({}));
    const options = {
      request: request as never,
      notice: vi.fn(),
      errorMessage: String,
      beginSubmission: () => () => true
    };
    await aside.createApprovals(options).decideApproval('aside-run', 'approval', 'APPROVED');
    await main.createApprovals(options).decideApproval('main-run', 'approval', 'REJECTED');
    expect(
      request.mock.calls.map(([path, init]) => ({ path, body: JSON.parse(init!.body as string) }))
    ).toMatchObject([
      {
        path: expect.stringContaining('aside-run'),
        body: { nodeId: 'aside-node', decision: 'APPROVED' }
      },
      {
        path: expect.stringContaining('main-run'),
        body: { nodeId: 'main-node', decision: 'REJECTED' }
      }
    ]);
    const inputOptions = { ...options, missingRunError: () => false };
    const mainInput = main.createUserInput(inputOptions);
    const asideInput = aside.createUserInput(inputOptions);
    mainInput.setAnswer('item', 'question', 'main answer');
    asideInput.setAnswer('item', 'question', 'aside answer');
    expect(mainInput.answer('item', 'question')).toBe('main answer');
    expect(asideInput.answer('item', 'question')).toBe('aside answer');
  });

  it('derives each Pane composer configuration from its own session target', () => {
    const a = ref({ kind: 'session' as const, nodeId: 'n', workspaceId: 'w', sessionId: 'a' });
    const b = ref({ ...a.value, sessionId: 'b' });
    const drafts = createSessionDraftService({ target: a });
    const attachments = createComposerAttachmentService({
      context: () => a.value,
      request: vi.fn() as never,
      renewCsrfToken: vi.fn(),
      csrfToken: ref('csrf'),
      onUnauthenticated: vi.fn(),
      notice: vi.fn()
    });
    const main = createWorkspaceSessionPaneState({
      submissions: paneSubmissions,
      draftTarget: a,
      drafts,
      attachments,
      onConversationOverflow: vi.fn()
    });
    const aside = createWorkspaceSessionPaneState({
      pane: 'aside',
      submissions: paneSubmissions,
      draftTarget: b,
      drafts,
      attachments,
      onConversationOverflow: vi.fn()
    });
    const sessions = ref([
      { id: 'a', workspaceId: 'w', runner: 'codex' },
      { id: 'b', workspaceId: 'w', runner: 'mar-agent' }
    ] as import('../../src/model/workbench.js').Session[]);
    const options = { sessions, profiles: ref([]), effortLabel: String };
    const mainConfiguration = main.createConfiguration(options);
    const asideConfiguration = aside.createConfiguration(options);
    expect(mainConfiguration.selectedSession.value?.id).toBe('a');
    expect(asideConfiguration.selectedSession.value?.id).toBe('b');
    expect(mainConfiguration.activeRunner.value).toBe('codex');
    expect(asideConfiguration.activeRunner.value).toBe('mar-agent');
    const mainInteraction = main.createRunnerInteraction({
      selectedSession: mainConfiguration.selectedSession,
      profile: mainConfiguration.profile
    });
    const asideInteraction = aside.createRunnerInteraction({
      selectedSession: asideConfiguration.selectedSession,
      profile: asideConfiguration.profile
    });
    mainInteraction.composerMode.value = 'steer';
    expect(asideInteraction.composerMode.value).toBe('message');
    a.value = { ...a.value, workspaceId: 'other' };
    expect(mainConfiguration.selectedSession.value).toBeUndefined();
    expect(asideConfiguration.selectedSession.value?.id).toBe('b');
  });

  it.each(['switch', 'dispose'])(
    'does not project an old interrupt response after Pane %s',
    async (change) => {
      const target = ref({
        kind: 'session' as const,
        nodeId: 'n',
        workspaceId: 'w',
        sessionId: 'old'
      });
      const drafts = createSessionDraftService({ target });
      const attachments = createComposerAttachmentService({
        context: () => target.value,
        request: vi.fn() as never,
        renewCsrfToken: vi.fn(),
        csrfToken: ref('csrf'),
        onUnauthenticated: vi.fn(),
        notice: vi.fn()
      });
      const { effectScope } = await import('vue');
      const scope = effectScope();
      const pane = scope.run(() =>
        createWorkspaceSessionPaneState({
          submissions: paneSubmissions,
          draftTarget: target,
          drafts,
          attachments,
          onConversationOverflow: vi.fn()
        })
      )!;
      let resolve!: (value: unknown) => void;
      const request = vi.fn(
        () =>
          new Promise((done) => {
            resolve = done;
          })
      ) as never;
      const finish = vi.fn(() => true);
      const controls = scope.run(() =>
        pane.createRunControl({
          activeRun: computed(() => undefined),
          request,
          notice: vi.fn(),
          sessionPathId: String,
          errorMessage: String,
          beginSubmission: () => finish
        })
      )!;
      const stopping = controls.stopActiveRun();
      if (change === 'switch') {
        target.value = { ...target.value, sessionId: 'new' };
        target.value = { ...target.value, sessionId: 'old' };
      } else scope.stop();
      resolve({
        run: {
          id: 'old-run',
          sessionId: 'old',
          status: 'RUNNING',
          recoveryState: '',
          clientMessageId: ''
        }
      });
      await stopping;
      expect(pane.run.selectedRunId.value).toBeUndefined();
      expect(pane.run.runs.value).toEqual([]);
      expect(finish).toHaveBeenCalled();
      scope.stop();
    }
  );

  it('shares admission across Pane migration and workspace draft handoff, but not other targets', () => {
    const workspace = { kind: 'workspace' as const, nodeId: 'n', workspaceId: 'w' };
    const session = { ...workspace, kind: 'session' as const, sessionId: 'created' };
    const other = { ...session, nodeId: 'other-node' };
    const mainTarget =
      ref<import('../../src/service/session-draft-service.js').DraftTarget>(workspace);
    const asideTarget =
      ref<import('../../src/service/session-draft-service.js').DraftTarget>(other);
    const drafts = createSessionDraftService({ target: mainTarget });
    const attachments = createComposerAttachmentService({
      context: () => mainTarget.value,
      request: vi.fn() as never,
      renewCsrfToken: vi.fn(),
      csrfToken: ref('csrf'),
      onUnauthenticated: vi.fn(),
      notice: vi.fn()
    });
    const submissions = createWorkbenchSubmissionOwner();
    const main = createWorkspaceSessionPaneState({
      submissions,
      draftTarget: mainTarget,
      drafts,
      attachments,
      onConversationOverflow: vi.fn()
    });
    const aside = createWorkspaceSessionPaneState({
      pane: 'aside',
      submissions,
      draftTarget: asideTarget,
      drafts,
      attachments,
      onConversationOverflow: vi.fn()
    });
    const finishDraft = main.submission.begin('session:draft', undefined, null)!;
    const finishOther = aside.submission.begin('session:created', undefined, null)!;
    expect(finishOther).toBeDefined();
    const otherWorkspace = submissions.bind(() =>
      submissions.forTarget({ ...session, workspaceId: 'other-workspace' })
    );
    const finishOtherWorkspace = otherWorkspace.begin('session:created', undefined, null)!;
    expect(finishOtherWorkspace).toBeDefined();
    const slot = drafts.forTarget(workspace);
    main
      .captureDraft()!
      .createdSession({ id: session.sessionId, workspaceId: session.workspaceId });
    expect(drafts.forTarget(session).input).toBe(slot.input);
    expect(main.submission.pending.value).toBe(false);
    const finishNewWorkspace = main.submission.begin('session:draft', undefined, null)!;
    expect(finishNewWorkspace).toBeDefined();
    asideTarget.value = session;
    expect(aside.submission.pending.value).toBe(true);
    expect(finishDraft()).toBe(true);
    expect(aside.submission.pending.value).toBe(false);
    expect(main.submission.pending.value).toBe(true);
    expect(finishNewWorkspace()).toBe(true);
    const finishMigrated = aside.submission.begin('session:created', undefined, null)!;
    mainTarget.value = session;
    expect(main.submission.pending.value).toBe(true);
    expect(main.submission.context.value).toBe('session:created');
    mainTarget.value = other;
    asideTarget.value = session;
    expect(aside.submission.pending.value).toBe(true);
    expect(aside.submission.begin('session:created')).toBeUndefined();
    expect(finishMigrated()).toBe(true);
    expect(aside.submission.pending.value).toBe(false);
    expect(finishOther()).toBe(true);
    expect(finishOtherWorkspace()).toBe(true);
  });

  it('does not migrate a newer Workspace submission when an older creation reply arrives', () => {
    const target = ref<DraftTarget>({ kind: 'workspace', nodeId: 'n', workspaceId: 'w' });
    const drafts = createSessionDraftService({ target });
    const attachments = createComposerAttachmentService({
      context: () => target.value,
      request: vi.fn() as never,
      renewCsrfToken: vi.fn(),
      csrfToken: ref('csrf'),
      onUnauthenticated: vi.fn(),
      notice: vi.fn()
    });
    const moveAttachments = vi.spyOn(attachments, 'moveDraft');
    const submissions = createWorkbenchSubmissionOwner();
    const pane = createWorkspaceSessionPaneState({
      submissions,
      draftTarget: target,
      drafts,
      attachments,
      onConversationOverflow: vi.fn()
    });
    const first = pane.captureDraft()!;
    const finishFirst = pane.submission.begin('session:draft', undefined, null)!;
    // Timeout releases admission, but the first request can still return after a retry starts.
    finishFirst();
    const retry = pane.captureDraft()!;
    const finishRetry = pane.submission.begin('session:draft', undefined, null)!;
    first.createdSession({ id: 'first', workspaceId: 'w' });
    expect(pane.submission.pending.value).toBe(false);
    const finishNewer = pane.submission.begin('session:draft', undefined, null)!;
    expect(finishNewer).toBeDefined();
    retry.createdSession({ id: 'retry', workspaceId: 'w' });
    expect(pane.submission.pending.value).toBe(true);
    expect(moveAttachments).toHaveBeenCalledTimes(1);
    expect(pane.submission.begin('session:draft', undefined, null)).toBeUndefined();
    expect(finishRetry()).toBe(true);
    expect(pane.submission.pending.value).toBe(true);
    expect(finishNewer()).toBe(true);
    attachments.clearAll();
  });

  it('loads older history independently through the common Pane conversation window', async () => {
    const mainTarget = ref({
      kind: 'session' as const,
      nodeId: 'n',
      workspaceId: 'w',
      sessionId: 'main'
    });
    const asideTarget = ref({ ...mainTarget.value, sessionId: 'child' });
    const drafts = createSessionDraftService({ target: mainTarget });
    const attachments = createComposerAttachmentService({
      context: () => mainTarget.value,
      request: vi.fn() as never,
      renewCsrfToken: vi.fn(),
      csrfToken: ref('csrf'),
      onUnauthenticated: vi.fn(),
      notice: vi.fn()
    });
    const main = createWorkspaceSessionPaneState({
      submissions: paneSubmissions,
      draftTarget: mainTarget,
      drafts,
      attachments,
      onConversationOverflow: vi.fn()
    });
    const aside = createWorkspaceSessionPaneState({
      pane: 'aside',
      submissions: paneSubmissions,
      draftTarget: asideTarget,
      drafts,
      attachments,
      onConversationOverflow: vi.fn()
    });
    main.conversation.projection.restoreWindow([], 'main-cursor');
    aside.conversation.projection.restoreWindow([], 'aside-cursor');
    const pending: Array<{ path: string; resolve: (page: unknown) => void }> = [];
    const request = vi.fn(
      (path: string) => new Promise((resolve) => pending.push({ path, resolve }))
    ) as never;
    const options = {
      pageSize: 10,
      recentSegmentWindowSize: 10,
      request,
      sessionPathId: String,
      notice: vi.fn(),
      errorMessage: String,
      replaceCached: vi.fn()
    };
    const mainWindow = main.createConversationWindow(options);
    const asideWindow = aside.createConversationWindow(options);
    const mainRead = mainWindow.paging.loadOlderConversationTurns();
    const asideRead = asideWindow.paging.loadOlderConversationTurns();
    expect(pending[0]!.path).toContain('/main/turns');
    expect(pending[1]!.path).toContain('/child/turns');
    mainTarget.value = { ...mainTarget.value, sessionId: 'next' };
    pending[0]!.resolve({ segments: [], nextCursor: null });
    pending[1]!.resolve({ segments: [], nextCursor: null });
    await Promise.all([mainRead, asideRead]);
    expect(main.conversation.nextCursor.value).toBe('main-cursor');
    expect(aside.conversation.nextCursor.value).toBeNull();
  });

  it('retains target queue edits and metadata across target and Pane handoffs', () => {
    const a = { kind: 'session' as const, nodeId: 'n', workspaceId: 'w', sessionId: 'a' };
    const b = { ...a, sessionId: 'b' };
    const mainTarget = ref(a);
    const asideTarget = ref(b);
    const drafts = createSessionDraftService({ target: mainTarget });
    const attachments = createComposerAttachmentService({
      context: () => mainTarget.value,
      request: vi.fn() as never,
      renewCsrfToken: vi.fn(),
      csrfToken: ref('csrf'),
      onUnauthenticated: vi.fn(),
      notice: vi.fn()
    });
    const main = createWorkspaceSessionPaneState({
      submissions: paneSubmissions,
      draftTarget: mainTarget,
      drafts,
      attachments,
      onConversationOverflow: vi.fn()
    });
    const aside = createWorkspaceSessionPaneState({
      pane: 'aside',
      submissions: paneSubmissions,
      draftTarget: asideTarget,
      drafts,
      attachments,
      onConversationOverflow: vi.fn()
    });
    const origin = serializeComposerTag('mar_session_origin', {
      sessionId: 'source',
      name: 'Owner'
    });
    const references = serializeComposerTag('mar_references', {
      references: [{ type: 'file', path: 'a.ts', label: 'a.ts' }]
    });
    main.queue.startEditing({ queueItemId: 'item', content: `Before\n${origin}\n${references}` });
    main.queue.editingContent.value = 'Unsaved';
    mainTarget.value = b;
    expect(main.queue.editingQueueItemId.value).toBeUndefined();
    mainTarget.value = a;
    expect(main.queue.editingQueueItemId.value).toBe('item');
    expect(main.queue.editingContent.value).toBe('Unsaved');
    mainTarget.value = b;
    asideTarget.value = a;
    expect(aside.queue.editingContent.value).toBe('Unsaved');
    expect(aside.queue.serializeEditedContent('Unsaved')).toContain(origin);
    expect(aside.queue.serializeEditedContent('Unsaved')).toContain(references);
    aside.queue.finishEditing();
    expect(drafts.forTarget(a).queueEdit.value).toBeUndefined();
    mainTarget.value = a;
    expect(main.queue.editingQueueItemId.value).toBeUndefined();
  });

  it('does not clear a new target queue editor when an old save finishes late', async () => {
    const target = ref({
      kind: 'session' as const,
      nodeId: 'n',
      workspaceId: 'w',
      sessionId: 'old'
    });
    const drafts = createSessionDraftService({ target });
    const attachments = createComposerAttachmentService({
      context: () => target.value,
      request: vi.fn() as never,
      renewCsrfToken: vi.fn(),
      csrfToken: ref('csrf'),
      onUnauthenticated: vi.fn(),
      notice: vi.fn()
    });
    const pane = createWorkspaceSessionPaneState({
      submissions: paneSubmissions,
      draftTarget: target,
      drafts,
      attachments,
      onConversationOverflow: vi.fn()
    });
    let resolve!: () => void;
    const request = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        })
    );
    const queue = ref({ version: 0, paused: false, items: [] });
    const actions = pane.createQueueActions({
      queue,
      currentSessionQueue: computed(() => queue.value),
      currentSelectionRevision: () => 0,
      request: request as never,
      notice: vi.fn(),
      errorMessage: String,
      missingQueueItemError: () => false,
      beginSubmission: () => () => true
    });
    pane.queue.startEditing({ queueItemId: 'item', content: 'old' });
    const saving = actions.save('item');
    target.value = { ...target.value, nodeId: 'another-node', sessionId: 'new' };
    pane.queue.startEditing({ queueItemId: 'item', content: 'new' });
    const promotedTarget = ref({
      kind: 'session' as const,
      nodeId: 'n',
      workspaceId: 'w',
      sessionId: 'old'
    });
    const promoted = createWorkspaceSessionPaneState({
      submissions: paneSubmissions,
      draftTarget: promotedTarget,
      drafts,
      attachments,
      onConversationOverflow: vi.fn()
    });
    expect(promoted.queue.editingContent.value).toBe('old');
    resolve();
    expect(await saving).toBe(true);
    expect(
      drafts.forTarget({ kind: 'session', nodeId: 'n', workspaceId: 'w', sessionId: 'old' })
        .queueEdit.value
    ).toBeUndefined();
    expect(promoted.queue.editingQueueItemId.value).toBeUndefined();
    expect(pane.queue.editingQueueItemId.value).toBe('item');
    expect(pane.queue.editingContent.value).toBe('new');
  });

  it.each(['success', 'missing'])(
    'preserves newer changes while an older save ends in %s',
    async (outcome) => {
      const target = ref({
        kind: 'session' as const,
        nodeId: 'n',
        workspaceId: 'w',
        sessionId: 's'
      });
      const drafts = createSessionDraftService({ target });
      const attachments = createComposerAttachmentService({
        context: () => target.value,
        request: vi.fn() as never,
        renewCsrfToken: vi.fn(),
        csrfToken: ref('csrf'),
        onUnauthenticated: vi.fn(),
        notice: vi.fn()
      });
      const pane = createWorkspaceSessionPaneState({
        submissions: paneSubmissions,
        draftTarget: target,
        drafts,
        attachments,
        onConversationOverflow: vi.fn()
      });
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const queue = ref({ version: 0, paused: false, items: [] });
      const actions = pane.createQueueActions({
        queue,
        currentSessionQueue: computed(() => queue.value),
        currentSelectionRevision: () => 0,
        request: (() =>
          new Promise<void>((done, fail) => {
            resolve = done;
            reject = fail;
          })) as never,
        notice: vi.fn(),
        errorMessage: String,
        missingQueueItemError: () => true,
        beginSubmission: () => () => true
      });
      pane.queue.startEditing({ queueItemId: 'item', content: 'old' });
      const saving = actions.save('item');
      pane.queue.editingContent.value = 'newer';
      if (outcome === 'success') resolve();
      else reject(new Error('missing'));
      expect(await saving).toBe(outcome === 'success');
      expect(pane.queue.editingQueueItemId.value).toBe('item');
      expect(drafts.forTarget(target.value).queueEdit.value?.content).toBe('newer');
    }
  );

  it('retains a queue edit when saving fails without an authoritative missing response', async () => {
    const target = ref({ kind: 'session' as const, nodeId: 'n', workspaceId: 'w', sessionId: 's' });
    const drafts = createSessionDraftService({ target });
    const attachments = createComposerAttachmentService({
      context: () => target.value,
      request: vi.fn() as never,
      renewCsrfToken: vi.fn(),
      csrfToken: ref('csrf'),
      onUnauthenticated: vi.fn(),
      notice: vi.fn()
    });
    const pane = createWorkspaceSessionPaneState({
      submissions: paneSubmissions,
      draftTarget: target,
      drafts,
      attachments,
      onConversationOverflow: vi.fn()
    });
    const queue = ref({ version: 0, paused: false, items: [] });
    const actions = pane.createQueueActions({
      queue,
      currentSessionQueue: computed(() => queue.value),
      currentSelectionRevision: () => 0,
      request: (async () => {
        throw new Error('missing');
      }) as never,
      notice: vi.fn(),
      errorMessage: String,
      missingQueueItemError: () => false,
      beginSubmission: () => () => true
    });
    pane.queue.startEditing({ queueItemId: 'item', content: 'unsaved' });
    expect(await actions.save('item')).toBe(false);
    expect(drafts.forTarget(target.value).queueEdit.value?.content).toBe('unsaved');
    expect(pane.queue.editingQueueItemId.value).toBe('item');
  });

  it('settles only the captured target after a late authoritative missing response', async () => {
    const old = { kind: 'session' as const, nodeId: 'n', workspaceId: 'w', sessionId: 'old' };
    const target = ref(old);
    const drafts = createSessionDraftService({ target });
    const attachments = createComposerAttachmentService({
      context: () => target.value,
      request: vi.fn() as never,
      renewCsrfToken: vi.fn(),
      csrfToken: ref('csrf'),
      onUnauthenticated: vi.fn(),
      notice: vi.fn()
    });
    const pane = createWorkspaceSessionPaneState({
      submissions: paneSubmissions,
      draftTarget: target,
      drafts,
      attachments,
      onConversationOverflow: vi.fn()
    });
    let reject!: (error: Error) => void;
    const queue = ref({ version: 0, paused: false, items: [] });
    const actions = pane.createQueueActions({
      queue,
      currentSessionQueue: computed(() => queue.value),
      currentSelectionRevision: () => 0,
      request: (() =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        })) as never,
      notice: vi.fn(),
      errorMessage: String,
      missingQueueItemError: () => true,
      beginSubmission: () => () => true
    });
    pane.queue.startEditing({ queueItemId: 'item', content: 'old' });
    const saving = actions.save('item');
    target.value = { ...old, nodeId: 'other', sessionId: 'new' };
    pane.queue.startEditing({ queueItemId: 'item', content: 'new' });
    reject(new Error('missing'));
    expect(await saving).toBe(false);
    expect(drafts.forTarget(old).queueEdit.value).toBeUndefined();
    expect(pane.queue.editingQueueItemId.value).toBe('item');
    expect(pane.queue.editingContent.value).toBe('new');
  });

  it('captures a draft handoff for its original target even if the pane changes', () => {
    const workspace = { kind: 'workspace' as const, nodeId: 'n', workspaceId: 'w' };
    const target = ref<
      import('../../src/service/session-draft-service.js').DraftTarget | undefined
    >(workspace);
    const drafts = createSessionDraftService({ target });
    const attachments = createComposerAttachmentService({
      context: () => target.value,
      notice: vi.fn(),
      request: vi.fn().mockResolvedValue(undefined),
      csrfToken: ref('csrf'),
      renewCsrfToken: vi.fn(),
      onUnauthenticated: vi.fn()
    });
    const pane = createWorkspaceSessionPaneState({
      submissions: paneSubmissions,
      draftTarget: target,
      drafts,
      attachments,
      onConversationOverflow: vi.fn()
    });
    pane.draft.input.value = 'original';
    const captured = pane.captureDraft()!;
    target.value = { kind: 'session', nodeId: 'n', workspaceId: 'other', sessionId: 'current' };
    pane.draft.input.value = 'current';
    captured.createdSession({ id: 'created', workspaceId: 'w' });
    expect(
      drafts.forTarget({ kind: 'session', nodeId: 'n', workspaceId: 'w', sessionId: 'created' })
        .input.value
    ).toBe('original');
    expect(pane.draft.input.value).toBe('current');
    expect(drafts.forTarget(workspace).input.value).toBe('original');
    attachments.clearAll();
  });

  it('keeps extensible Workspace typing and connects drafts to the same selection refs', () => {
    interface Resource extends Workspace {
      readonly label: string;
    }
    const state = createWorkbenchBaseStateService<Resource>(options());
    state.selection.workspaces.value = [
      { id: 'w1', path: '/w1', kind: 'DIRECTORY', label: 'custom' }
    ];
    expect(state.selection.workspaces.value[0]?.label).toBe('custom');
    state.selection.workspaceTarget.value = { nodeId: 'n1', workspaceId: 'w1' };
    state.draft.input.value = 'first draft';
    state.draft.persist();
    state.selection.workspaceTarget.value = { nodeId: 'n1', workspaceId: 'w2' };
    state.draft.restore();
    expect(state.draft.input.value).toBe('');
    state.selection.workspaceTarget.value = { nodeId: 'n1', workspaceId: 'w1' };
    state.draft.restore();
    expect(state.draft.input.value).toBe('first draft');
  });

  it('shares the auth CSRF ref with HTTP and routes unauthenticated failure to its owner', async () => {
    const configuration = options();
    const state = createWorkbenchBaseStateService(configuration);
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'UNAUTHENTICATED',
              message: 'Authentication is required.'
            }
          }),
          { status: 401 }
        )
    );
    vi.stubGlobal('fetch', fetch);
    state.admin.csrfToken.value = 'csrf-1';
    await expect(state.http.request('/api/example', { method: 'POST' })).rejects.toMatchObject({
      code: 'UNAUTHENTICATED'
    });
    expect(fetch).toHaveBeenCalledWith(
      '/api/example',
      expect.objectContaining({
        headers: { 'x-csrf-token': 'csrf-1' },
        credentials: 'same-origin'
      })
    );
    expect(configuration.onUnauthenticated).toHaveBeenCalledOnce();
  });
});
