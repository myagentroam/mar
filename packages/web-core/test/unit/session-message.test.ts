import { parseComposerTags, composerVisibleText } from '@myagentroam/protocol';
import { workspaceTargetRef } from './support/workspace-fixture.js';
import { describe, expect, it, vi } from 'vitest';
import type { ComposerAttachment, Session, Workspace } from '../../src/model/workbench.js';
import {
  createWorkbenchSessionMessageService,
  resolveDeliveryIntent,
  resolveSessionWorkspaceId
} from '../../src/service/WorkbenchSessionMessageService.js';
import {
  createWorkbenchSubmissionService,
  sessionSubmissionContext
} from '../../src/service/WorkbenchSubmissionService.js';
import { ApiError } from '../../src/util/api-error.js';
import { createRunnerInteractionService } from '../../src/service/RunnerInteractionService.js';
import { translate } from '../../src/service/LocalePreferenceService.js';

vi.mock('element-plus', () => ({ ElMessageBox: { confirm: vi.fn() } }));

const session: Session = {
  id: 'session-1',
  workspaceId: 'workspace-from-session',
  runner: 'codex'
};

const workspace: Workspace = {
  id: 'workspace-from-list',
  path: '/workspace',
  kind: 'DIRECTORY'
};

describe('Composer command dismissal', () => {
  it.each([
    ['/plan', 'success'],
    ['/goal', 'success'],
    ['/goal --clear', 'success'],
    ['/plan', 'failure'],
    ['/goal', 'blocked'],
    ['/plan', 'invalid-skill'],
    ['/goal', 'draft']
  ])('preserves the draft when closing %s (%s)', async (closeInput, outcome) => {
    const harness = pendingRequestHarness();
    if (outcome === 'failure') harness.executeCommand.mockRejectedValueOnce(new Error('offline'));
    if (outcome === 'blocked') harness.submissionAvailable.mockReturnValue(false);
    if (outcome === 'invalid-skill') {
      harness.skillTokens.value = [
        {
          name: 'missing',
          source: 'WORKSPACE',
          skillFilePath: '/workspace/.agents/skills/missing/SKILL.md',
          available: false
        }
      ];
    }
    const command = {
      id: closeInput.split(' ')[0]!.slice(1),
      runner: 'codex' as const,
      label: closeInput,
      description: '',
      inputHint: '',
      source: 'CODEX_APP_SERVER' as const,
      interaction: 'TOGGLE' as const,
      available: true,
      reasonCode: null
    };
    const interaction = createRunnerInteractionService({
      input: harness.inputValue,
      draftSessionOpen: { value: outcome === 'draft' },
      selectedSession: { value: session },
      profile: {
        value: {
          runner: 'codex',
          commands: [command],
          models: [],
          accessOptions: [],
          capabilities: []
        }
      }
    } as unknown as Parameters<typeof createRunnerInteractionService>[0]);
    if (outcome === 'draft') interaction.stageDraftCommand(command, closeInput);
    let sending: Promise<void> | undefined;
    interaction.closeCommandState(
      {
        commandId: command.id,
        active: true,
        label: closeInput,
        detail: null,
        closable: true,
        closeInput
      },
      (selected, input) => {
        sending = harness.service.send(undefined, true, undefined, { command: selected, input });
      }
    );
    expect(harness.inputValue.value).toBe('Immediate Message');
    await sending;
    if (outcome === 'blocked' || outcome === 'draft') {
      expect(harness.executeCommand).not.toHaveBeenCalled();
    } else {
      expect(harness.executeCommand).toHaveBeenCalledWith(session, command, closeInput);
    }
    expect(interaction.selectedCommand.value).toBeUndefined();
    expect(harness.selectedCommand.value).toBeUndefined();
    expect(interaction.deferredDraftCommands.value).toEqual([]);
    expect(harness.inputValue.value).toBe('Immediate Message');
    expect(harness.clearAttachments).not.toHaveBeenCalled();
    expect(harness.clearSkillTokens).not.toHaveBeenCalled();
  });
});

describe('Workbench session message workspace resolution', () => {
  it('Uses the workspaceId carried by the session when the Workspace list has not been restored', () => {
    expect(resolveSessionWorkspaceId(undefined, session)).toBe('workspace-from-session');
  });

  it('Uses the currently selected workspace when the Workspace list has been restored', () => {
    expect(resolveSessionWorkspaceId(workspace, session)).toBe('workspace-from-list');
  });

  it('Captures the delivery intent at the moment of user submission', () => {
    expect(resolveDeliveryIntent(undefined, false)).toBe('SEND');
    expect(resolveDeliveryIntent(undefined, true)).toBe('QUEUE');
    expect(resolveDeliveryIntent('REPLACE_CURRENT', true)).toBe('REPLACE_CURRENT');
  });
});

function pendingRequestHarness(input: { draft?: boolean; busy?: boolean } = {}) {
  let resolveRequest!: (value: unknown) => void;
  let rejectRequest!: (reason: unknown) => void;
  const requestPending = new Promise((resolve, reject) => {
    resolveRequest = resolve;
    rejectRequest = reject;
  });
  const selectedSession = input.draft ? undefined : session;
  const draftSession = { ...session, id: 'draft:session-1' };
  const appendUserMessage = vi.fn();
  const appendActiveRun = vi.fn();
  const appendQueueItem = vi.fn();
  const acceptConversationTurn = vi.fn();
  const removeUserMessage = vi.fn();
  const removeActiveRun = vi.fn();
  const removeQueueItem = vi.fn();
  const clearAttachments = vi.fn();
  const clearSkillTokens = vi.fn(() => (skillTokens.value = []));
  const scrollToLatest = vi.fn();
  const scrollToLatestAfterLayout = vi.fn(async () => undefined);
  const beginSessionWatch = vi.fn();
  const openRun = vi.fn();
  const selectedCommand = {
    value: undefined as import('../../src/model/workbench.js').RunnerCommand | undefined
  };
  const executeCommand = vi.fn(async () => ({}));
  const commandAvailable = vi.fn(() => true);
  const submissionAvailable = vi.fn(() => true);
  const stageDraftCommand = vi.fn();
  const fastEnabled = { value: false };
  const request = vi.fn((path: string, init?: RequestInit) => {
    void path;
    void init;
    return requestPending;
  });
  const inputValue = { value: 'Immediate Message' };
  const skillTokens = {
    value: [] as import('../../src/model/workbench.js').ComposerSkillToken[]
  };
  const selectedSessionId = { value: selectedSession?.id };
  const selectedNodeId = { value: 'node-1' };
  const selectedWorkspaceId = { value: workspace.id };
  const sessions = { value: selectedSession === undefined ? [] : [selectedSession] };
  const draftOpen = { value: input.draft === true };
  const attachments = { value: [] as ComposerAttachment[] };
  const replaceSession = vi.fn((previousId: string, next: Session) => {
    const wasSelected = selectedSessionId.value === previousId;
    sessions.value = sessions.value.filter((candidate) => candidate.id !== previousId).concat(next);
    if (wasSelected) selectedSessionId.value = next.id;
  });
  const runs = { value: [] as import('../../src/model/workbench.js').AgentRun[] };
  const submission = createWorkbenchSubmissionService();
  const notice = { value: '' };
  const service = createWorkbenchSessionMessageService({
    workspaceTarget: workspaceTargetRef(selectedNodeId, selectedWorkspaceId),
    selectedSessionId,
    selectedWorkspace: { value: workspace },
    selectedSession: {
      get value() {
        return sessions.value.find((candidate) => candidate.id === selectedSessionId.value);
      }
    },
    selectedRunId: { value: undefined },
    sessions,
    runs,
    input: inputValue,
    skillTokens,
    attachments,
    attachmentsPending: { value: false },
    composerOpen: { value: true },
    composerBusy: { value: input.busy === true },
    draftOpen,
    selectedCommand,
    commandAvailable,
    submissionAvailable,
    commandPickerOpen: { value: false },
    deferredCommands: { value: [] },
    fastEnabled,
    activeRun: { value: undefined },
    loading: { value: false },
    notice,
    request,
    stageDraftCommand,
    createDraftSession: async () => {
      draftOpen.value = false;
      selectedSessionId.value = draftSession.id;
      sessions.value = [draftSession];
      return draftSession;
    },
    executeCommand,
    replaceSession,
    sessionPathId: (value: string) => value,
    temporaryTitle: () => 'Temporary session',
    sessionTitle: () => 'Session',
    appendUserMessage,
    removeUserMessage,
    bindUserTurn: vi.fn(),
    appendActiveRun,
    removeActiveRun,
    appendQueueItem,
    replaceQueueItem: vi.fn(),
    removeQueueItem,
    clearAttachments,
    clearSkillTokens,
    restoreAttachments: (values: never[]) => values,
    markSessionActive: vi.fn(),
    forgetSessionActivity: vi.fn(),
    newestRun: (_current: never, next: never) => next,
    migrateSessionCache: vi.fn(),
    openRun,
    acceptConversationTurn,
    bindCachedTurn: vi.fn(),
    cacheRun: vi.fn(),
    beginSessionWatch,
    scrollToLatest,
    scrollToLatestAfterLayout,
    rollbackCached: vi.fn(),
    errorMessage: String,
    beginSubmission: submission.begin
  } as never);
  return {
    service,
    runs,
    submission,
    notice,
    resolveRequest,
    rejectRequest,
    appendUserMessage,
    appendActiveRun,
    appendQueueItem,
    acceptConversationTurn,
    removeUserMessage,
    removeActiveRun,
    removeQueueItem,
    clearAttachments,
    request,
    inputValue,
    selectedWorkspaceId,
    selectedSessionId,
    draftOpen,
    selectedNodeId,
    attachments,
    skillTokens,
    clearSkillTokens,
    selectedCommand,
    stageDraftCommand,
    fastEnabled,
    executeCommand,
    beginSessionWatch,
    commandAvailable,
    openRun,
    submissionAvailable,
    sessions,
    scrollToLatest,
    scrollToLatestAfterLayout
  };
}

const acceptedResult = {
  session,
  run: {
    id: 'run-1',
    sessionId: session.id,
    workspaceId: session.workspaceId,
    status: 'STARTING',
    recoveryState: 'ACTIVE',
    clientMessageId: 'server-id'
  },
  delivery: 'STARTED'
};

describe('Workbench Message Submission Status', () => {
  it.each(['SUCCEEDED', 'FAILED', 'INTERRUPTED'])(
    'accepts a terminal %s receipt without opening the old Run or restarting observation',
    async (status) => {
      const fixture = pendingRequestHarness();
      const active = { ...acceptedResult.run, id: 'newer-run', status: 'RUNNING' };
      fixture.runs.value = [active as never];
      const pending = fixture.service.send();
      fixture.resolveRequest({
        ...acceptedResult,
        run: { ...acceptedResult.run, status },
        idempotent: true
      });
      await pending;
      expect(fixture.inputValue.value).toBe('');
      expect(fixture.openRun).not.toHaveBeenCalled();
      expect(fixture.beginSessionWatch).not.toHaveBeenCalled();
      expect(fixture.appendUserMessage).not.toHaveBeenCalled();
      expect(fixture.runs.value.find((run) => run.id === active.id)).toEqual(active);
    }
  );
  it('does not send ordinary input during a pending session mutation, even after the submission gate expires', async () => {
    const harness = pendingRequestHarness();
    harness.submissionAvailable.mockReturnValue(false);
    await harness.service.send();
    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.appendQueueItem).not.toHaveBeenCalled();
    expect(harness.submission.pending.value).toBe(false);
    expect(harness.inputValue.value).toBe('Immediate Message');
  });

  it('does not clear a same-ID session on another Node after confirmation', async () => {
    const { ElMessageBox } = await import('element-plus');
    const harness = pendingRequestHarness();
    harness.selectedCommand.value = { id: 'clear', interaction: 'DESTRUCTIVE_ACTION' } as never;
    vi.mocked(ElMessageBox.confirm).mockImplementationOnce(async () => {
      harness.selectedNodeId.value = 'node-2';
      return 'confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>;
    });
    await harness.service.send();
    expect(harness.executeCommand).not.toHaveBeenCalled();
    expect(harness.submission.pending.value).toBe(false);
  });

  it('preserves an unavailable selected command without issuing a request or acquiring the gate', async () => {
    const harness = pendingRequestHarness({ busy: true });
    harness.selectedCommand.value = { id: 'compact', interaction: 'IMMEDIATE_ACTION' } as never;
    harness.commandAvailable.mockReturnValue(false);
    await harness.service.send();
    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.executeCommand).not.toHaveBeenCalled();
    expect(harness.submission.pending.value).toBe(false);
    expect(harness.inputValue.value).toBe('Immediate Message');
    expect(harness.selectedCommand.value).toEqual(expect.objectContaining({ id: 'compact' }));
  });

  it('Applies /fast directly for a new Codex session without staging it as message input', async () => {
    const harness = pendingRequestHarness({ draft: true });
    harness.inputValue.value = '';
    harness.selectedCommand.value = {
      id: 'fast',
      runner: 'codex',
      interaction: 'TOGGLE'
    } as never;

    const sending = harness.service.send(undefined, true);
    expect(harness.request).toHaveBeenCalledWith('/api/runner-commands', {
      method: 'POST',
      body: JSON.stringify({
        nodeId: 'node-1',
        runner: 'codex',
        commandId: 'fast',
        input: '/fast on'
      })
    });
    expect(harness.stageDraftCommand).not.toHaveBeenCalled();
    harness.resolveRequest({ enabled: true });
    await sending;
    expect(harness.fastEnabled.value).toBe(true);
    expect(harness.inputValue.value).toBe('');
    expect(harness.selectedCommand.value).toBeUndefined();
  });

  it('Does not apply a stale /fast response to another selected Node', async () => {
    const harness = pendingRequestHarness({ draft: true });
    harness.inputValue.value = '';
    harness.selectedCommand.value = {
      id: 'fast',
      runner: 'codex',
      interaction: 'TOGGLE'
    } as never;

    const sending = harness.service.send(undefined, true);
    harness.selectedNodeId.value = 'node-2';
    harness.resolveRequest({ enabled: true });
    await sending;
    expect(harness.fastEnabled.value).toBe(false);
  });

  it('Projects a new native session and starts its Watch without refreshing the session page', async () => {
    const draft = pendingRequestHarness({ draft: true });
    const sending = draft.service.send();
    draft.resolveRequest({
      ...acceptedResult,
      session: {
        ...session,
        id: 'native-created',
        workspaceId: workspace.id,
        runner: 'mar-agent',
        externalSessionId: 'native-created'
      },
      run: { ...acceptedResult.run, sessionId: 'native-created' }
    });
    await sending;
    expect(draft.request).toHaveBeenCalledTimes(1);
    expect(draft.selectedSessionId.value).toBe('native-created');
    expect(draft.sessions.value.map((session) => session.id)).toEqual(['native-created']);
    expect(draft.beginSessionWatch).toHaveBeenCalledExactlyOnceWith('native-created');

    const existing = pendingRequestHarness();
    const existingSend = existing.service.send();
    existing.resolveRequest(acceptedResult);
    await existingSend;
    expect(existing.request).toHaveBeenCalledTimes(1);
    expect(existing.beginSessionWatch).not.toHaveBeenCalled();
  });

  it('Does not refresh the session page before a new session has a native identity', async () => {
    const harness = pendingRequestHarness({ draft: true });
    const sending = harness.service.send();
    harness.resolveRequest({
      ...acceptedResult,
      session: { ...session, id: 'bootstrap', workspaceId: workspace.id, externalSessionId: null },
      run: { ...acceptedResult.run, sessionId: 'bootstrap' }
    });
    await sending;
    expect(harness.request).toHaveBeenCalledTimes(1);
    expect(harness.beginSessionWatch).toHaveBeenCalledExactlyOnceWith('bootstrap');
  });

  it('Does not refresh a different Workspace when a new session finishes after switching away', async () => {
    const harness = pendingRequestHarness({ draft: true });
    const sending = harness.service.send();
    harness.selectedWorkspaceId.value = 'another-workspace';
    harness.resolveRequest({
      ...acceptedResult,
      session: {
        ...session,
        id: 'native-created',
        workspaceId: workspace.id,
        externalSessionId: 'native-created'
      },
      run: { ...acceptedResult.run, sessionId: 'native-created' }
    });
    await sending;
    expect(harness.request).toHaveBeenCalledTimes(1);
  });

  it('Keeps the same submission context when a new session moves from a generic to a specific draft ID', () => {
    expect(sessionSubmissionContext(undefined)).toBe('session:draft');
    expect(sessionSubmissionContext('draft:session-1')).toBe('session:draft');
    expect(sessionSubmissionContext('session-1')).toBe('session:session-1');
  });

  it('Shares a five-second submission lock across messages, Runner commands, stopping, and queue execution', async () => {
    vi.useFakeTimers();
    try {
      const submission = createWorkbenchSubmissionService();
      const finish = submission.begin();
      expect(finish).toBeTypeOf('function');
      expect(submission.pending.value).toBe(true);
      expect(submission.begin()).toBeUndefined();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(submission.pending.value).toBe(false);
      expect(submission.begin()).toBeTypeOf('function');
      expect(finish?.()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Records the session context that starts submission and clears it when finished', () => {
    const submission = createWorkbenchSubmissionService();
    const finish = submission.begin('session:session-1');

    expect(submission.context.value).toBe('session:session-1');
    expect(finish?.()).toBe(true);
    expect(submission.context.value).toBeUndefined();
  });

  it('requires confirmation before submitting a destructive Runner command', async () => {
    const { ElMessageBox } = await import('element-plus');
    const harness = pendingRequestHarness();
    harness.selectedCommand.value = {
      id: 'clear',
      runner: 'mar-agent',
      label: '/clear',
      description: 'Clear the session.',
      inputHint: '/clear',
      source: 'MAR_RUNTIME',
      interaction: 'DESTRUCTIVE_ACTION',
      available: true,
      reasonCode: null
    };
    vi.mocked(ElMessageBox.confirm).mockRejectedValueOnce('cancel');

    await harness.service.send(undefined, true);

    expect(harness.executeCommand).not.toHaveBeenCalled();
    expect(harness.inputValue.value).toBe('Immediate Message');
    expect(harness.submission.pending.value).toBe(false);
  });

  it('submits a destructive Runner command only after confirmation', async () => {
    const { ElMessageBox } = await import('element-plus');
    const harness = pendingRequestHarness();
    harness.selectedCommand.value = {
      id: 'clear',
      runner: 'mar-agent',
      label: '/clear',
      description: 'Clear the session.',
      inputHint: '/clear',
      source: 'MAR_RUNTIME',
      interaction: 'DESTRUCTIVE_ACTION',
      available: true,
      reasonCode: null
    };
    vi.mocked(ElMessageBox.confirm).mockResolvedValueOnce(
      'confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>
    );

    await harness.service.send(undefined, true);

    expect(harness.executeCommand).toHaveBeenCalledWith(
      expect.objectContaining({ id: session.id }),
      expect.objectContaining({ id: 'clear' }),
      '/clear'
    );
  });

  it('Keeps the draft and shows only the sending state for an existing session while HTTP is pending', async () => {
    const harness = pendingRequestHarness();

    const sending = harness.service.send();

    expect(harness.submission.pending.value).toBe(true);
    expect(harness.appendUserMessage).not.toHaveBeenCalled();
    expect(harness.appendActiveRun).not.toHaveBeenCalled();
    expect(harness.inputValue.value).toBe('Immediate Message');
    harness.resolveRequest(acceptedResult);
    await sending;
    expect(harness.inputValue.value).toBe('');
    expect(harness.clearAttachments).toHaveBeenCalledWith(false);
  });

  it('Scrolls immediately when a valid message starts submitting and recalibrates after the authoritative projection', async () => {
    const harness = pendingRequestHarness();

    const sending = harness.service.send();

    expect(harness.scrollToLatest).toHaveBeenCalledOnce();
    expect(harness.scrollToLatestAfterLayout).not.toHaveBeenCalled();
    harness.resolveRequest(acceptedResult);
    await sending;
    expect(harness.scrollToLatestAfterLayout).toHaveBeenCalledOnce();
  });

  it('Does not scroll invalid messages or let a late response from a previous session recalibrate the current one', async () => {
    const invalid = pendingRequestHarness();
    invalid.inputValue.value = '   ';

    await invalid.service.send();

    expect(invalid.scrollToLatest).not.toHaveBeenCalled();
    expect(invalid.scrollToLatestAfterLayout).not.toHaveBeenCalled();

    const switched = pendingRequestHarness();
    const sending = switched.service.send();
    switched.selectedSessionId.value = 'session-2';
    switched.resolveRequest(acceptedResult);
    await sending;

    expect(switched.scrollToLatest).toHaveBeenCalledOnce();
    expect(switched.scrollToLatestAfterLayout).not.toHaveBeenCalled();
    expect(switched.beginSessionWatch).not.toHaveBeenCalled();
  });

  it('Ignores a legacy HTTP Turn after the first message creates a session', async () => {
    const harness = pendingRequestHarness({ draft: true });

    const sending = harness.service.send();
    await Promise.resolve();

    expect(harness.appendUserMessage).not.toHaveBeenCalled();
    expect(harness.appendActiveRun).not.toHaveBeenCalled();
    expect(harness.acceptConversationTurn).not.toHaveBeenCalled();
    const turn = {
      id: 'turn-created',
      sessionId: 'session-created',
      runId: 'run-1',
      status: 'RUNNING',
      startedAt: null,
      completedAt: null,
      items: []
    };
    harness.resolveRequest({
      ...acceptedResult,
      session: { ...session, id: 'session-created' },
      run: { ...acceptedResult.run, sessionId: 'session-created' },
      turn
    });
    await sending;
    expect(harness.acceptConversationTurn).not.toHaveBeenCalled();
    expect(harness.beginSessionWatch).toHaveBeenCalledWith('session-created');
  });

  it('Does not start a Watch for a session that was switched away from before the draft send returned', async () => {
    const harness = pendingRequestHarness({ draft: true });

    const sending = harness.service.send();
    await Promise.resolve();
    harness.selectedSessionId.value = 'session-2';
    harness.resolveRequest({
      ...acceptedResult,
      session: { ...session, id: 'session-created' },
      run: { ...acceptedResult.run, sessionId: 'session-created' }
    });
    await sending;

    expect(harness.beginSessionWatch).not.toHaveBeenCalled();
  });

  it('Does not project a FIFO queue item before a normal send finishes while another Run is active', async () => {
    const harness = pendingRequestHarness({ busy: true });

    const sending = harness.service.send();

    expect(harness.appendQueueItem).not.toHaveBeenCalled();
    expect(harness.appendUserMessage).not.toHaveBeenCalled();
    expect(harness.appendActiveRun).not.toHaveBeenCalled();
    harness.resolveRequest({ ...acceptedResult, delivery: 'QUEUED' });
    await sending;
  });

  it('Keeps the existing Session Watch after accepted queued and idle deliveries', async () => {
    const harness = pendingRequestHarness({ busy: true });

    const sending = harness.service.send();
    harness.resolveRequest({ ...acceptedResult, delivery: 'QUEUED' });
    await sending;

    expect(harness.beginSessionWatch).not.toHaveBeenCalled();
    for (const delivery of [undefined, 'STARTED']) {
      const idle = pendingRequestHarness();
      const idleSending = idle.service.send();
      idle.resolveRequest({ ...acceptedResult, delivery });
      await idleSending;
      expect(idle.beginSessionWatch).not.toHaveBeenCalled();
      expect(idle.openRun).toHaveBeenCalledWith(acceptedResult.run.id);
    }
  });

  it.each(['ACCEPTED', 'QUEUED'])(
    'Does not project prioritized input before HTTP returns or reopen the active Run (%s)',
    async (delivery) => {
      const harness = pendingRequestHarness({ busy: true });

      const sending = harness.service.send('REPLACE_CURRENT');

      expect(harness.appendUserMessage).not.toHaveBeenCalled();
      expect(harness.appendActiveRun).not.toHaveBeenCalled();
      expect(harness.appendQueueItem).not.toHaveBeenCalled();
      harness.resolveRequest({ ...acceptedResult, delivery });
      await sending;
      expect(harness.openRun).not.toHaveBeenCalled();
      expect(harness.beginSessionWatch).not.toHaveBeenCalled();
    }
  );

  it('Preserves input when sending fails without rolling back business projections', async () => {
    const harness = pendingRequestHarness();

    const sending = harness.service.send();
    harness.rejectRequest(new Error('REQUEST_FAILED'));
    await sending;

    expect(harness.removeUserMessage).not.toHaveBeenCalled();
    expect(harness.removeActiveRun).not.toHaveBeenCalled();
    expect(harness.removeQueueItem).not.toHaveBeenCalled();
    expect(harness.inputValue.value).toBe('Immediate Message');
  });

  it('submits only the attachment ID without inline content for a Composer attachment', async () => {
    const harness = pendingRequestHarness();
    harness.attachments.value = [
      {
        id: '00000000-0000-4000-8000-000000000001',
        file: { name: 'notes.pdf', type: 'application/pdf', size: 3 } as File,
        previewUrl: null,
        nodeId: 'node-1',
        workspaceId: workspace.id,
        uploadId: 'upload-1',
        receivedBytes: 3,
        status: 'COMPLETED'
      }
    ];

    const sending = harness.service.send();
    const body = JSON.parse(String(harness.request.mock.calls[0]?.[1]?.body));

    expect(body.attachmentIds).toEqual(['00000000-0000-4000-8000-000000000001']);
    expect(body.attachments).toBeUndefined();
    expect(body.computerUse).toBe(false);
    harness.resolveRequest(acceptedResult);
    await sending;
  });

  it('Preserves attachments and retries with a new message ID after an explicit send failure', async () => {
    const harness = pendingRequestHarness({ busy: true });
    harness.attachments.value = [
      {
        id: '00000000-0000-4000-8000-000000000001',
        file: { name: 'notes.pdf', type: 'application/pdf', size: 3 } as File,
        previewUrl: null,
        nodeId: 'node-1',
        workspaceId: workspace.id,
        uploadId: 'upload-1',
        receivedBytes: 3,
        status: 'COMPLETED'
      }
    ];

    const first = harness.service.send('REPLACE_CURRENT');
    const firstBody = JSON.parse(String(harness.request.mock.calls[0]?.[1]?.body));
    harness.rejectRequest(
      new ApiError('RUN_EXECUTION_NOT_FOUND', 'The current execution was not found.')
    );
    await first;

    expect(harness.attachments.value.map((attachment) => attachment.id)).toEqual([
      '00000000-0000-4000-8000-000000000001'
    ]);
    expect(harness.clearAttachments).not.toHaveBeenCalled();

    await harness.service.send('REPLACE_CURRENT');
    const secondBody = JSON.parse(String(harness.request.mock.calls[1]?.[1]?.body));
    expect(secondBody.attachmentIds).toEqual(firstBody.attachmentIds);
    expect(secondBody.clientMessageId).not.toBe(firstBody.clientMessageId);
  });

  it('Retries with the original message ID when the network result is unknown', async () => {
    const harness = pendingRequestHarness();

    const first = harness.service.send();
    const firstBody = JSON.parse(String(harness.request.mock.calls[0]?.[1]?.body));
    harness.rejectRequest(new TypeError('Failed to fetch'));
    await first;

    await harness.service.send();
    const secondBody = JSON.parse(String(harness.request.mock.calls[1]?.[1]?.body));
    expect(secondBody.clientMessageId).toBe(firstBody.clientMessageId);
  });

  it('Serializes skill tokens into hidden model input tags and clears them after success', async () => {
    const harness = pendingRequestHarness();
    harness.skillTokens.value = [
      {
        name: 'db-query',
        source: 'WORKSPACE',
        skillFilePath: '/workspace/.agents/skills/db-query/SKILL.md',
        available: true
      }
    ];
    harness.inputValue.value = 'Immediate Message';

    const sending = harness.service.send();
    const body = JSON.parse(String(harness.request.mock.calls[0]?.[1]?.body));
    expect(composerVisibleText(body.content)).toBe('Immediate Message');
    expect(parseComposerTags(body.content)).toContainEqual(
      expect.objectContaining({
        kind: 'mar_skills',
        payload: expect.objectContaining({
          action: 'use',
          skills: [
            {
              name: 'db-query',
              source: 'WORKSPACE',
              path: '/workspace/.agents/skills/db-query/SKILL.md'
            }
          ]
        })
      })
    );
    harness.resolveRequest(acceptedResult);
    await sending;
    expect(harness.clearSkillTokens).toHaveBeenCalledOnce();
  });

  it('Allows sending selected skills when the body is empty', async () => {
    const harness = pendingRequestHarness();
    harness.skillTokens.value = [
      {
        name: 'db-query',
        source: 'WORKSPACE',
        skillFilePath: '/workspace/.agents/skills/db-query/SKILL.md',
        available: true
      }
    ];
    harness.inputValue.value = '';

    const sending = harness.service.send();
    const body = JSON.parse(String(harness.request.mock.calls[0]?.[1]?.body));
    expect(composerVisibleText(body.content)).toBe('');
    expect(parseComposerTags(body.content)).toContainEqual(
      expect.objectContaining({
        kind: 'mar_skills',
        payload: expect.objectContaining({ action: 'use' })
      })
    );
    expect(body.content).not.toContain('[invoke skill]');
    harness.resolveRequest(acceptedResult);
    await sending;

    expect(harness.clearSkillTokens).toHaveBeenCalledOnce();
  });

  it('Blocks sending and preserves the complete draft when a skill token is invalid', async () => {
    const harness = pendingRequestHarness();
    harness.skillTokens.value = [
      {
        name: 'db-query',
        source: 'WORKSPACE',
        skillFilePath: '/workspace/.agents/skills/db-query/SKILL.md',
        available: false
      }
    ];
    harness.inputValue.value = 'Immediate Message';

    await harness.service.send();

    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.inputValue.value).toBe('Immediate Message');
    expect(harness.skillTokens.value).toHaveLength(1);
  });

  it('Does not clear only the body and leave an orphaned skill token when token state changes during sending', async () => {
    const harness = pendingRequestHarness();
    harness.skillTokens.value = [
      {
        name: 'db-query',
        source: 'WORKSPACE',
        skillFilePath: '/workspace/.agents/skills/db-query/SKILL.md',
        available: true
      }
    ];
    harness.inputValue.value = 'Immediate Message';

    const sending = harness.service.send();
    harness.skillTokens.value = harness.skillTokens.value.map((token) => ({ ...token }));
    harness.resolveRequest(acceptedResult);
    await sending;

    expect(harness.inputValue.value).toBe('Immediate Message');
    expect(harness.skillTokens.value).toHaveLength(1);
    expect(harness.clearSkillTokens).not.toHaveBeenCalled();
  });

  it('Releases the submission state after five seconds, preserves the draft, and retries with the same message ID', async () => {
    vi.useFakeTimers();
    try {
      const harness = pendingRequestHarness();
      const first = harness.service.send();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(harness.submission.pending.value).toBe(false);
      expect(harness.inputValue.value).toBe('Immediate Message');
      expect(harness.notice.value).toBe(translate('workbench.submissionTimedOut'));

      const second = harness.service.send();
      const firstBody = JSON.parse(String(harness.request.mock.calls[0]?.[1]?.body));
      const secondBody = JSON.parse(String(harness.request.mock.calls[1]?.[1]?.body));
      expect(secondBody.clientMessageId).toBe(firstBody.clientMessageId);

      harness.resolveRequest(acceptedResult);
      await Promise.all([first, second]);
      expect(harness.inputValue.value).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a timed-out new session through start without sending its local draft ID to Node', async () => {
    vi.useFakeTimers();
    try {
      const harness = pendingRequestHarness({ draft: true });
      const first = harness.service.send();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(harness.draftOpen.value).toBe(false);
      expect(harness.selectedSessionId.value).toBe('draft:session-1');
      expect(harness.notice.value).toBe(translate('workbench.submissionTimedOut'));
      const second = harness.service.send();
      await Promise.resolve();
      expect(harness.request.mock.calls.map((call) => call[0])).toEqual([
        '/api/agent-sessions/start',
        '/api/agent-sessions/start'
      ]);
      const firstBody = JSON.parse(String(harness.request.mock.calls[0]?.[1]?.body));
      const secondBody = JSON.parse(String(harness.request.mock.calls[1]?.[1]?.body));
      expect(secondBody.clientMessageId).toBe(firstBody.clientMessageId);
      expect(secondBody).toEqual(firstBody);
      harness.resolveRequest(acceptedResult);
      await Promise.all([first, second]);
      expect(harness.inputValue.value).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Clears an unchanged draft after a late success but preserves content edited by the user', async () => {
    vi.useFakeTimers();
    try {
      const unchanged = pendingRequestHarness();
      const unchangedSending = unchanged.service.send();
      await vi.advanceTimersByTimeAsync(5_000);
      unchanged.resolveRequest(acceptedResult);
      await unchangedSending;
      expect(unchanged.inputValue.value).toBe('');

      const changed = pendingRequestHarness();
      const changedSending = changed.service.send();
      await vi.advanceTimersByTimeAsync(5_000);
      changed.inputValue.value = 'User-edited draft';
      changed.resolveRequest(acceptedResult);
      await changedSending;
      expect(changed.inputValue.value).toBe('User-edited draft');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['node', 'workspace', 'session', 'new draft'])(
    'does not show a submission timeout after switching %s',
    async (target) => {
      vi.useFakeTimers();
      try {
        const harness = pendingRequestHarness({ draft: target === 'new draft' });
        const sending = harness.service.send();
        await Promise.resolve();
        if (target === 'node') harness.selectedNodeId.value = 'other-node';
        if (target === 'workspace') harness.selectedWorkspaceId.value = 'other-workspace';
        if (target === 'session') harness.selectedSessionId.value = 'other-session';
        if (target === 'new draft') harness.selectedSessionId.value = undefined;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(harness.notice.value).toBe('');
        expect(harness.submission.pending.value).toBe(false);
        harness.resolveRequest(acceptedResult);
        await sending;
      } finally {
        vi.useRealTimers();
      }
    }
  );
});
