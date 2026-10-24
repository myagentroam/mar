import { afterEach, describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import {
  createWorkbenchPresentationStateService,
  sessionHasActiveGoal
} from '../../src/service/workbench-presentation-state-service';
import { createComposerConfigurationService } from '../../src/service/composer-configuration-service';
import { createRunService } from '../../src/service/run-service';
import type { SessionContextUsage } from '../../src/service/conversation-state-service';
import { localePreferenceService } from '../../src/service/locale-preference-service';
import type {
  RunnerCommand,
  RunnerProfile,
  Session,
  WorkspaceQueue
} from '../../src/model/workbench';

vi.mock('../../src/service/workbench-clock-service', () => ({
  createWorkbenchClockService: () => ({
    working: ref(false),
    workingNow: ref(0),
    workingStartedAt: ref(0),
    sessionActivityNow: ref(0)
  })
}));

function controlsFixture() {
  const session = ref<Session>({
    id: 'session-1',
    workspaceId: 'workspace-1',
    runner: 'mar-agent',
    activity: 'IDLE',
    control: { level: 'MANAGED', capabilities: ['turn.start'] },
    runtime: { capabilities: ['session.rollback'] }
  });
  const selectedSessionId = ref<string | undefined>(session.value.id);
  const runService = createRunService(selectedSessionId);
  const compact: RunnerCommand = {
    id: 'compact',
    runner: 'mar-agent',
    label: 'Compact',
    description: '',
    inputHint: '',
    source: 'MAR_RUNTIME',
    interaction: 'IMMEDIATE_ACTION',
    available: true,
    reasonCode: null
  };
  const profiles = ref<readonly RunnerProfile[]>([
    {
      runner: 'mar-agent',
      models: [{ id: 'model', label: 'Model', supportedEfforts: ['high'] }],
      accessOptions: [{ id: 'full-access', label: 'Full access' }],
      commands: [compact],
      capabilities: ['turn.start']
    }
  ]);
  const configuration = createComposerConfigurationService({
    selectedSession: session,
    profiles,
    effortLabel: String
  });
  const loading = ref(false);
  const submissionPending = ref(false);
  const draftOpen = ref(false);
  const queue = ref<WorkspaceQueue>({ version: 1, paused: false, items: [] });
  const sessionContextUsage = ref<SessionContextUsage | null>();
  const state = createWorkbenchPresentationStateService({
    workspaceTarget: ref({ nodeId: 'node-1', workspaceId: 'workspace-1' }),
    selectedSessionId,
    selectedRunId: runService.selectedRunId,
    selectedSession: computed(() => session.value),
    sessions: ref([session.value]),
    runs: runService.runs,
    turns: ref([]),
    attachments: ref([]),
    draftOpen,
    runnerProfilesLoading: ref(false),
    runnerProfilesFailed: ref(false),
    composerProfile: configuration.profile,
    composerModels: configuration.models,
    composerAccessOptions: configuration.accessOptions,
    workspaceQueue: queue,
    sessionContextUsage,
    channelToken: ref(undefined),
    loading,
    submissionPending,
    nodes: ref([
      {
        id: 'node-1',
        displayName: null,
        registeredAddress: '',
        platform: 'linux',
        architecture: 'x64',
        nodeAppVersion: '0.10.3',
        nodeVersion: '',
        connected: true,
        disabled: false,
        capabilities: {}
      }
    ]),
    workspaces: ref([]),
    nodeManifest: ref({
      manifestVersion: 1,
      observedAt: 0,
      conversation: { available: true, reasonCode: null }
    }),
    visibleLimits: ref(new Map()),
    nextCursors: ref(new Map()),
    pageSize: 20,
    tabId: String,
    workspaceLabel: () => '',
    shouldDisplayItem: () => true,
    runService,
    formatTokenCount: String,
    formatPercentage: String
  });
  return {
    state,
    session,
    runService,
    compact,
    loading,
    submissionPending,
    draftOpen,
    selectedSessionId,
    queue,
    sessionContextUsage
  };
}

afterEach(() => vi.restoreAllMocks());

describe('Workbench context usage label', () => {
  it.each([
    ['en-US', 'Context Window: 203000 / 258000 tokens (78.8)'],
    ['zh-CN', '上下文窗口：203000 / 258000 tokens (78.8)']
  ] as const)('shows token usage without the model ID in %s', (locale, expected) => {
    const preference = localePreferenceService();
    const previousLocale = preference.locale.value;
    try {
      preference.setLocale(locale);
      const f = controlsFixture();
      expect(f.state.contextUsageLabel.value).toBe('');
      f.sessionContextUsage.value = {
        model: 'gpt-6.1-sol',
        usedTokens: 203000,
        maxTokens: 258000,
        percentage: 78.8
      };
      expect(f.state.contextUsageLabel.value).toBe(expected);
      f.sessionContextUsage.value = { ...f.sessionContextUsage.value, model: null };
      expect(f.state.contextUsageLabel.value).toBe(expected);
      f.sessionContextUsage.value = null;
      expect(f.state.contextUsageLabel.value).toBe('');
    } finally {
      preference.setLocale(previousLocale);
    }
  });
});

describe('Workbench mutually exclusive controls', () => {
  it('keeps the Composer available while a new draft is submitting without inventing a Run', () => {
    const f = controlsFixture();
    f.draftOpen.value = true;
    f.selectedSessionId.value = undefined;
    expect(f.state.canUseComposer.value).toBe(true);

    f.submissionPending.value = true;
    f.session.value = {
      id: 'draft:pending-session',
      workspaceId: 'workspace-1',
      runner: 'mar-agent',
      activity: 'IDLE'
    };
    f.selectedSessionId.value = f.session.value.id;
    f.draftOpen.value = false;
    expect(f.state.canUseComposer.value).toBe(true);
    expect(f.state.composerInputDisabled.value).toBe(false);
    expect(f.state.composerConfigurationDisabled.value).toBe(true);
    expect(f.state.composerAccessDisabled.value).toBe(true);
    expect(f.state.activeComposerRun.value).toBeUndefined();
    expect(f.state.composerSessionBusy.value).toBe(false);

    f.submissionPending.value = false;
    expect(f.state.canUseComposer.value).toBe(true);
    expect(f.state.composerConfigurationDisabled.value).toBe(true);
    expect(f.state.composerAccessDisabled.value).toBe(true);
    expect(f.state.rewindConversationEnabled.value).toBe(false);
    expect(
      f.state.canExecuteRunnerCommand({ ...f.compact, id: 'plan', interaction: 'TOGGLE' })
    ).toBe(false);
    f.session.value = { ...f.session.value, id: 'created-session' };
    f.selectedSessionId.value = f.session.value.id;
    expect(f.state.canUseComposer.value).toBe(false);
    f.session.value = {
      ...f.session.value,
      control: { level: 'MANAGED', capabilities: ['turn.start'] }
    };
    expect(f.state.canUseComposer.value).toBe(true);
  });

  it('hides history mutations and locks configuration and compact before an active Run arrives', () => {
    const f = controlsFixture();
    expect(f.state.rewindConversationEnabled.value).toBe(true);
    expect(f.state.rollbackConversationEnabled.value).toBe(true);
    expect(f.state.canDeleteSession(f.session.value)).toBe(true);
    expect(f.state.canCompactContext.value).toBe(true);
    f.session.value = { ...f.session.value, activity: 'MANAGED_ACTIVE' };
    expect(f.state.activeComposerRun.value).toBeUndefined();
    expect(f.state.rewindConversationEnabled.value).toBe(false);
    expect(f.state.rollbackConversationEnabled.value).toBe(false);
    expect(f.state.canDeleteSession(f.session.value)).toBe(false);
    expect(f.state.composerConfigurationDisabled.value).toBe(true);
    expect(f.state.composerAccessDisabled.value).toBe(true);
    expect(f.state.canCompactContext.value).toBe(false);
    expect(f.state.canUseComposer.value).toBe(true);
    expect(f.state.canInterruptTurn.value).toBe(true);
    f.session.value = { ...f.session.value, activity: 'IDLE' };
    expect(f.state.rewindConversationEnabled.value).toBe(true);
    expect(f.state.composerConfigurationDisabled.value).toBe(false);
  });

  it.each(['STARTING', 'RUNNING', 'CANCELLING'])(
    'locks controls during %s even before session activity updates',
    (status) => {
      const f = controlsFixture();
      f.runService.runs.value = [
        {
          id: 'run-1',
          sessionId: 'session-1',
          status,
          recoveryState: 'NONE',
          clientMessageId: 'message-1'
        }
      ];
      f.runService.selectedRunId.value = 'run-1';
      expect(f.state.rewindConversationEnabled.value).toBe(false);
      expect(f.state.canCompactContext.value).toBe(false);
      expect(f.state.composerConfigurationDisabled.value).toBe(true);
    }
  );

  it('keeps idle-only controls locked after interruption is requested until authoritative idle', () => {
    const f = controlsFixture();
    f.session.value = { ...f.session.value, activity: 'MANAGED_ACTIVE' };
    f.runService.markSessionInterruptionPending(f.session.value.id);
    expect(f.state.composerSessionBusy.value).toBe(false);
    expect(f.state.rewindConversationEnabled.value).toBe(false);
    expect(f.state.rollbackConversationEnabled.value).toBe(false);
    expect(f.state.composerConfigurationDisabled.value).toBe(true);
    expect(f.state.composerAccessDisabled.value).toBe(true);
    expect(f.state.canCompactContext.value).toBe(false);
    expect(f.state.canExecuteRunnerCommand(f.compact)).toBe(false);
    expect(f.state.canUseComposer.value).toBe(true);
    f.session.value = { ...f.session.value, activity: 'IDLE' };
    expect(f.state.rewindConversationEnabled.value).toBe(true);
    expect(f.state.canExecuteRunnerCommand(f.compact)).toBe(true);
  });

  it.each(['loading', 'submissionPending'] as const)('locks controls during %s', (pending) => {
    const f = controlsFixture();
    f[pending].value = true;
    expect(f.state.rewindConversationEnabled.value).toBe(false);
    expect(f.state.rollbackConversationEnabled.value).toBe(false);
    expect(f.state.canCompactContext.value).toBe(false);
    expect(f.state.composerAccessDisabled.value).toBe(true);
    f[pending].value = false;
    expect(f.state.rollbackConversationEnabled.value).toBe(true);
  });

  it('checks only the current session queue for destructive operations', () => {
    const f = controlsFixture();
    const item = {
      queueItemId: 'queue-1',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      runner: 'mar-agent' as const,
      clientMessageId: 'message-1',
      sessionTitle: '',
      content: '',
      createdAt: 1
    };
    const clear = { ...f.compact, id: 'clear', interaction: 'DESTRUCTIVE_ACTION' as const };
    f.queue.value = { ...f.queue.value, paused: true, items: [item] };
    expect(f.state.rollbackConversationEnabled.value).toBe(false);
    expect(f.state.rewindConversationEnabled.value).toBe(true);
    expect(f.state.canExecuteRunnerCommand(clear)).toBe(false);
    f.queue.value = { ...f.queue.value, items: [{ ...item, sessionId: 'session-2' }] };
    expect(f.state.rollbackConversationEnabled.value).toBe(true);
    expect(f.state.canExecuteRunnerCommand(clear)).toBe(true);
  });

  it('keeps state commands available while hiding idle-only commands during Working', () => {
    const f = controlsFixture();
    f.session.value = { ...f.session.value, activity: 'MANAGED_ACTIVE' };
    expect(f.state.canExecuteRunnerCommand(f.compact)).toBe(false);
    expect(
      f.state.canExecuteRunnerCommand({ ...f.compact, interaction: 'DESTRUCTIVE_ACTION' })
    ).toBe(false);
    expect(f.state.canExecuteRunnerCommand({ ...f.compact, interaction: 'TOGGLE' })).toBe(true);
  });
});

describe('Web Workbench Activity Clock', () => {
  it('Keeps processing time active across Execution handoffs during a Goal', () => {
    expect(
      sessionHasActiveGoal([
        {
          commandId: 'goal',
          active: true,
          label: 'Goal',
          detail: 'Objective',
          closable: true,
          closeInput: '/goal',
          goal: {
            id: '83e62082-b910-4d87-a4a3-9cd94877f35f',
            objective: 'Objective',
            revision: 1,
            status: 'active',
            turns: 2
          }
        }
      ])
    ).toBe(true);
    expect(
      sessionHasActiveGoal([
        {
          commandId: 'goal',
          active: false,
          label: 'Goal',
          detail: 'Objective',
          closable: true,
          closeInput: '/goal',
          goal: {
            id: '83e62082-b910-4d87-a4a3-9cd94877f35f',
            objective: 'Objective',
            revision: 1,
            status: 'completed',
            turns: 2
          }
        }
      ])
    ).toBe(false);
  });
});
