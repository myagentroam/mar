import type { WorkspaceTarget } from '../model/workbench.js';
import { computed, type ComputedRef, type Ref } from 'vue';
import type {
  AgentRun,
  ComposerAttachment,
  ConversationTurn,
  NodeWorkbenchManifest,
  NodeSummary,
  RunnerCommand,
  RunnerCommandState,
  Session,
  Workspace,
  WorkspaceQueue
} from '../model/workbench.js';
import { sessionActivity, sessionHasNativeIdentity } from '../util/session-presentation.js';
import { createWorkbenchClockService } from './WorkbenchClockService.js';
import {
  conversationActivityLabel,
  conversationElapsedLabel
} from '../util/conversation-activity.js';
import type { SessionContextUsage } from './ConversationStateService.js';
import type { createRunService } from './RunService.js';
import type { createComposerConfigurationService } from './ComposerConfigurationService.js';
import { translate } from './LocalePreferenceService.js';

export function restorableWorkspaceSessions(
  sessions: readonly Session[],
  workspaceId: string | undefined
): readonly Session[] {
  return workspaceId === undefined
    ? []
    : sessions.filter(
        (session) => session.workspaceId === workspaceId && sessionHasNativeIdentity(session)
      );
}

export function sessionHasActiveGoal(
  commandStates: readonly RunnerCommandState[] | undefined
): boolean {
  return (
    commandStates?.some(
      (state) => state.commandId === 'goal' && state.active && state.goal?.status === 'active'
    ) ?? false
  );
}

interface WorkbenchPresentationStateOptions {
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly selectedSessionId: Ref<string | undefined>;
  readonly selectedRunId: Ref<string | undefined>;
  readonly selectedSession: ComputedRef<Session | undefined>;
  readonly sessions: Ref<Session[]>;
  readonly runs: Ref<AgentRun[]>;
  readonly turns: Ref<ConversationTurn[]>;
  readonly attachments: Ref<ComposerAttachment[]>;
  readonly draftOpen: Ref<boolean>;
  readonly runnerProfilesLoading: Ref<boolean>;
  readonly runnerProfilesFailed: Ref<boolean>;
  readonly composerProfile: ReturnType<typeof createComposerConfigurationService>['profile'];
  readonly composerModels: ReturnType<typeof createComposerConfigurationService>['models'];
  readonly composerAccessOptions: ReturnType<
    typeof createComposerConfigurationService
  >['accessOptions'];
  readonly workspaceQueue: Ref<WorkspaceQueue>;
  readonly sessionContextUsage: Ref<SessionContextUsage | null | undefined>;
  readonly channelToken: Ref<string | undefined>;
  readonly loading: Ref<boolean>;
  readonly submissionPending: Ref<boolean>;
  readonly nodes: Ref<NodeSummary[]>;
  readonly workspaces: Ref<Workspace[]>;
  readonly nodeManifest: Ref<NodeWorkbenchManifest | undefined>;
  readonly visibleLimits: Ref<Map<string, number>>;
  readonly nextCursors: Ref<Map<string, string | null>>;
  readonly pageSize: number;
  readonly tabId: (nodeId: string, workspaceId: string) => string;
  readonly workspaceLabel: (workspace: Workspace) => string;
  readonly shouldDisplayItem: (
    item: ConversationTurn['items'][number],
    runId: ConversationTurn['runId']
  ) => boolean;
  readonly runService: ReturnType<typeof createRunService>;
  readonly formatTokenCount: (value: number) => string;
  readonly formatPercentage: (value: number) => string;
}

/** Centralizes capability-derived and time-derived Workbench presentation state. */
export function createWorkbenchPresentationStateService(
  options: WorkbenchPresentationStateOptions
) {
  const activeComposerRun = computed(() => {
    const runId = options.selectedRunId.value;
    if (runId === undefined) return undefined;
    const run = options.runs.value.find((candidate) => candidate.id === runId);
    return run !== undefined && ['STARTING', 'RUNNING', 'CANCELLING'].includes(run.status)
      ? run
      : undefined;
  });
  const workspaceHost = computed(() =>
    options.nodes.value.find((node) => node.id === options.workspaceTarget.value?.nodeId)
  );
  const nodeReady = computed(
    () =>
      workspaceHost.value?.connected === true &&
      workspaceHost.value.disabled !== true &&
      options.nodeManifest.value?.manifestVersion === 1 &&
      options.nodeManifest.value.conversation.available
  );
  const selectedSessionActivity = computed(() =>
    options.selectedSession.value === undefined
      ? undefined
      : sessionActivity(options.selectedSession.value)
  );
  const selectedCapabilities = computed(
    () => new Set(options.selectedSession.value?.control?.capabilities ?? [])
  );
  const selectedRuntimeCapabilities = computed(
    () => new Set(options.selectedSession.value?.runtime?.capabilities ?? [])
  );
  const canStartTurn = computed(
    () => nodeReady.value && selectedCapabilities.value.has('turn.start')
  );
  const mustSteerCurrentTurn = computed(
    () =>
      selectedSessionActivity.value === 'MANAGED_ACTIVE' && activeComposerRun.value !== undefined
  );
  const draftRunnerProfileSupportsTurns = computed(
    () => options.composerProfile.value?.capabilities.includes('turn.start') === true
  );
  const canUseComposer = computed(
    () =>
      nodeReady.value &&
      (options.draftOpen.value
        ? options.runnerProfilesLoading.value ||
          options.runnerProfilesFailed.value ||
          draftRunnerProfileSupportsTurns.value
        : selectedSessionActivity.value === 'MANAGED_ACTIVE' ||
          (mustSteerCurrentTurn.value
            ? selectedRuntimeCapabilities.value.has('turn.queue')
            : canStartTurn.value))
  );
  const composerSessionOpen = computed(
    () => options.selectedSession.value !== undefined || options.draftOpen.value
  );
  const composerConfigurationDisabled = computed(
    () => sessionControlsBusy.value || options.composerModels.value.length === 0
  );
  const composerAccessDisabled = computed(
    () => sessionControlsBusy.value || options.composerAccessOptions.value.length === 0
  );
  const composerInputDisabled = computed(() => !canUseComposer.value);
  const composerAttachmentsPending = computed(() =>
    options.attachments.value.some((attachment) => attachment.status !== 'COMPLETED')
  );
  const displayedConversationTurns = computed(() =>
    options.turns.value
      .map((turn) => ({
        ...turn,
        items: turn.items.filter((item) => options.shouldDisplayItem(item, turn.runId))
      }))
      .filter((turn) => turn.items.length > 0)
  );
  const currentSessionQueue = computed<WorkspaceQueue>(() => ({
    ...options.workspaceQueue.value,
    items:
      options.selectedSessionId.value === undefined
        ? []
        : options.workspaceQueue.value.items.filter(
            (item) => item.sessionId === options.selectedSessionId.value
          )
  }));
  const composerSessionBusy = computed(
    () =>
      activeComposerRun.value !== undefined ||
      sessionHasActiveGoal(options.selectedSession.value?.commandStates) ||
      (selectedSessionActivity.value === 'MANAGED_ACTIVE' &&
        !options.runService.sessionInterruptionSettled(options.selectedSessionId.value))
  );
  const sessionControlsBusy = computed(
    () =>
      composerSessionBusy.value ||
      selectedSessionActivity.value === 'MANAGED_ACTIVE' ||
      options.loading.value ||
      options.submissionPending.value
  );
  const rewindConversationEnabled = computed(
    () =>
      nodeReady.value && options.selectedSession.value !== undefined && !sessionControlsBusy.value
  );
  const rollbackConversationEnabled = computed(
    () =>
      rewindConversationEnabled.value &&
      selectedRuntimeCapabilities.value.has('session.rollback') &&
      currentSessionQueue.value.items.length === 0
  );
  function canDeleteSession(session: Session): boolean {
    const current =
      options.selectedSession.value?.id === session.id
        ? options.selectedSession.value
        : (options.sessions.value.find((candidate) => candidate.id === session.id) ?? session);
    return (
      nodeReady.value &&
      !options.loading.value &&
      !options.submissionPending.value &&
      sessionActivity(current) === 'IDLE' &&
      !sessionHasActiveGoal(current.commandStates) &&
      !options.runs.value.some(
        (run) =>
          run.sessionId === session.id && ['STARTING', 'RUNNING', 'CANCELLING'].includes(run.status)
      )
    );
  }
  function canExecuteRunnerCommand(command: RunnerCommand): boolean {
    if (!command.available || options.loading.value || options.submissionPending.value)
      return false;
    if (
      command.interaction === 'IMMEDIATE_ACTION' ||
      command.interaction === 'DESTRUCTIVE_ACTION'
    ) {
      if (sessionControlsBusy.value) return false;
      if (
        command.interaction === 'DESTRUCTIVE_ACTION' &&
        currentSessionQueue.value.items.length > 0
      )
        return false;
    }
    return true;
  }
  const compactCommand = computed(() =>
    options.composerProfile.value?.commands.find(
      (command: RunnerCommand) => command.id === 'compact' && command.available
    )
  );
  const canCompactContext = computed(
    () =>
      options.selectedSession.value !== undefined &&
      compactCommand.value !== undefined &&
      nodeReady.value &&
      !sessionControlsBusy.value
  );
  const contextUsageLabel = computed(() => {
    const usage = options.sessionContextUsage.value;
    if (usage === undefined || usage === null) return '';
    const detail = `${options.formatTokenCount(usage.usedTokens)} / ${options.formatTokenCount(usage.maxTokens)} tokens (${options.formatPercentage(usage.percentage)})`;
    return translate('generated.workbenchPresentationStateService.contextWindow', {
      value0: detail
    });
  });
  const {
    working: composerWorking,
    workingNow,
    workingStartedAt,
    sessionActivityNow: sessionActivityClockNow
  } = createWorkbenchClockService(
    options.selectedSessionId,
    composerSessionBusy,
    activeComposerRun
  );
  const workingElapsedLabel = computed(() => {
    if (!composerWorking.value || !nodeReady.value) return '';
    return conversationElapsedLabel(workingStartedAt.value, workingNow.value);
  });
  const composerWorkingLabel = computed(() =>
    composerWorking.value
      ? conversationActivityLabel(
          activeComposerRun.value,
          nodeReady.value ? options.turns.value : []
        )
      : ''
  );
  const interruptVisible = computed(
    () =>
      (activeComposerRun.value !== undefined ||
        (selectedSessionActivity.value === 'MANAGED_ACTIVE' &&
          (options.selectedSessionId.value === undefined ||
            !options.runService.sessionInterruptionSettled(options.selectedSessionId.value)))) &&
      nodeReady.value
  );
  const canInterruptTurn = computed(
    () => interruptVisible.value && activeComposerRun.value?.status !== 'CANCELLING'
  );
  const canSendClaudeChannel = computed(
    () =>
      nodeReady.value &&
      options.selectedSession.value?.runner === 'claude-code' &&
      options.channelToken.value !== undefined
  );
  const selectedWorkspace = computed(() =>
    options.workspaces.value.find(
      (workspace) => workspace.id === options.workspaceTarget.value?.workspaceId
    )
  );
  const documentTitle = computed(() =>
    selectedWorkspace.value === undefined
      ? translate('common.productName')
      : `${translate('common.productName')} - ${options.workspaceLabel(selectedWorkspace.value)}`
  );
  const workspaceSessions = computed(() =>
    restorableWorkspaceSessions(options.sessions.value, options.workspaceTarget.value?.workspaceId)
  );
  const visibleWorkspaceSessions = computed(() => {
    const nodeId = options.workspaceTarget.value?.nodeId;
    const workspaceId = options.workspaceTarget.value?.workspaceId;
    if (nodeId === undefined || workspaceId === undefined) return [];
    return workspaceSessions.value.slice(
      0,
      options.visibleLimits.value.get(options.tabId(nodeId, workspaceId)) ?? options.pageSize
    );
  });
  const canLoadMoreWorkspaceSessions = computed(() => {
    const nodeId = options.workspaceTarget.value?.nodeId;
    const workspaceId = options.workspaceTarget.value?.workspaceId;
    return (
      nodeId !== undefined &&
      workspaceId !== undefined &&
      typeof options.nextCursors.value.get(options.tabId(nodeId, workspaceId)) === 'string'
    );
  });
  const onlineNodeCount = computed(
    () => options.nodes.value.filter((node) => node.connected && !node.disabled).length
  );
  const terminalReady = computed(
    () =>
      nodeReady.value &&
      options.nodeManifest.value?.terminal?.available === true &&
      options.nodeManifest.value.terminal.supportsReplay === true
  );
  const filesReady = computed(
    () => nodeReady.value && options.nodeManifest.value?.files?.available === true
  );

  return {
    activeComposerRun,
    workspaceHost,
    nodeReady,
    selectedSessionActivity,
    selectedCapabilities,
    selectedRuntimeCapabilities,
    canStartTurn,
    mustSteerCurrentTurn,
    draftRunnerProfileSupportsTurns,
    canUseComposer,
    composerSessionOpen,
    composerConfigurationDisabled,
    composerAccessDisabled,
    composerInputDisabled,
    composerAttachmentsPending,
    displayedConversationTurns,
    currentSessionQueue,
    composerSessionBusy,
    sessionControlsBusy,
    rewindConversationEnabled,
    rollbackConversationEnabled,
    canExecuteRunnerCommand,
    canDeleteSession,
    compactCommand,
    canCompactContext,
    contextUsageLabel,
    composerWorking,
    sessionActivityClockNow,
    workingElapsedLabel,
    composerWorkingLabel,
    interruptVisible,
    canInterruptTurn,
    canSendClaudeChannel,
    selectedWorkspace,
    documentTitle,
    workspaceSessions,
    visibleWorkspaceSessions,
    canLoadMoreWorkspaceSessions,
    onlineNodeCount,
    terminalReady,
    filesReady
  };
}
