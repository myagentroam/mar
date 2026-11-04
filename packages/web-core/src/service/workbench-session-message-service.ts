import type { MessageFeedback } from '../model/message-feedback.js';
import { marIcon } from '../util/mar-icons.js';
import type { WorkspaceTarget } from '../model/workbench.js';
import { getCurrentScope, type ComputedRef, type Ref } from 'vue';
import { ElMessageBox } from './message-box-service.js';
import type {
  AgentRun,
  ComposerSkillToken,
  ComposerAttachment,
  RunnerCommand,
  Session,
  Workspace
} from '../model/workbench.js';
import { translate } from './locale-preference-service.js';
import {
  hasUnavailableSkillToken,
  serializeComposerMessage
} from './composer-skill-token-service.js';
import { sessionSubmissionContext } from './workbench-submission-service.js';
import { errorCode } from '../util/api-error.js';
import { isTerminalRunStatus } from '../util/run-state.js';

type DeliveryIntent = 'SEND' | 'QUEUE' | 'REPLACE_CURRENT';

interface CommandResult {
  readonly session?: Session;
  readonly run?: AgentRun;
}

export interface WorkbenchSessionMessageOptions {
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly selectedSessionId: Readonly<Ref<string | undefined>>;
  readonly selectedWorkspace: ComputedRef<Workspace | undefined>;
  readonly selectedSession: ComputedRef<Session | undefined>;
  readonly sessions: Ref<Session[]>;
  readonly attachments: Ref<ComposerAttachment[]>;
  readonly attachmentsPending: ComputedRef<boolean>;
  readonly composerOpen: ComputedRef<boolean>;
  readonly composerBusy: ComputedRef<boolean>;
  readonly draftOpen: Readonly<Ref<boolean>>;
  readonly restoreDraft: () => void;
  readonly selectedCommand: Ref<RunnerCommand | undefined>;
  readonly commandAvailable?: (command: RunnerCommand) => boolean;
  readonly submissionAvailable?: () => boolean;
  readonly commandPickerOpen: Ref<boolean>;
  readonly deferredCommands: Ref<readonly { command: RunnerCommand; input: string }[]>;
  readonly fastEnabled: Ref<boolean>;
  readonly notice: MessageFeedback;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly stageDraftCommand: (command: RunnerCommand, input: string) => void;
  readonly createDraftSession: (title: string) => Promise<Session | undefined>;
  readonly executeCommand: (
    session: Session,
    command: RunnerCommand,
    input: string
  ) => Promise<CommandResult>;
  readonly replaceSession: (previousId: string, next: Session) => void;
  readonly sessionPathId: (sessionId: string) => string;
  readonly temporaryTitle: (content: string) => string;
  readonly consumeAttachments: (submitted: readonly ComposerAttachment[]) => void;
  readonly retainAttachments: (submitted: readonly ComposerAttachment[]) => () => void;
  readonly captureDraft: () =>
    | {
        readonly input: Ref<string>;
        readonly skillTokens: Ref<readonly ComposerSkillToken[]>;
        readonly references?: Ref<readonly import('@myagentroam/protocol').ComposerReference[]>;
        readonly persist: () => void;
        readonly createdSession?: (session: Session) => void;
      }
    | undefined;
  readonly acceptRun: (run: AgentRun) => AgentRun;
  readonly migrateSessionCache: (
    nodeId: string,
    workspaceId: string,
    previousId: string,
    nextId: string,
    session: Session
  ) => void;
  readonly openRun: (runId: string) => void;
  readonly cacheRun: (nodeId: string, workspaceId: string, run: AgentRun) => void;
  readonly beginSessionWatch: (sessionId: string) => void;
  readonly scrollToLatest: () => void;
  readonly scrollToLatestAfterLayout: () => Promise<void>;
  readonly errorMessage: (error: unknown) => string;
  readonly beginSubmission: (
    context?: string,
    onTimeout?: () => void
  ) => (() => boolean) | undefined;
}

/**
 * During URL session recovery, the Workspace list may still be loading. The session retains its
 * workspaceId, which is a safe fallback when sending a message to that existing session.
 */
export function resolveSessionWorkspaceId(
  selectedWorkspace: Workspace | undefined,
  session: Session
): string {
  return selectedWorkspace?.id ?? session.workspaceId;
}

export function resolveDeliveryIntent(
  override: Extract<DeliveryIntent, 'REPLACE_CURRENT'> | undefined,
  composerBusy: boolean
): DeliveryIntent {
  return override ?? (composerBusy ? 'QUEUE' : 'SEND');
}

export function createWorkbenchSessionMessageService(options: WorkbenchSessionMessageOptions) {
  const scope = getCurrentScope();
  const active = () => scope?.active !== false;
  let retryCandidate: { readonly signature: string; readonly clientMessageId: string } | undefined;

  const draftSignature = (
    nodeId: string,
    workspaceId: string,
    sessionId: string,
    content: string,
    intent: DeliveryIntent,
    attachments: readonly ComposerAttachment[]
  ) =>
    JSON.stringify([
      nodeId,
      workspaceId,
      sessionId,
      content,
      intent,
      attachments.map((attachment) => attachment.id)
    ]);

  async function send(
    intentOverride?: Extract<DeliveryIntent, 'REPLACE_CURRENT'>,
    preserveDraft = false,
    contentOverride?: string,
    commandOverride?: { readonly command: RunnerCommand; readonly input: string }
  ): Promise<void> {
    if (
      !active() ||
      options.workspaceTarget.value?.nodeId === undefined ||
      !options.composerOpen.value ||
      options.submissionAvailable?.() === false
    )
      return;
    const submissionNodeId = options.workspaceTarget.value?.nodeId;
    const submissionWorkspaceId = options.workspaceTarget.value?.workspaceId;
    const sameWorkspace = () =>
      options.workspaceTarget.value?.nodeId === submissionNodeId &&
      options.workspaceTarget.value?.workspaceId === submissionWorkspaceId;
    const capturedDraft = options.captureDraft();
    if (capturedDraft === undefined) return;
    const draftInput = capturedDraft.input;
    const draftSkills = capturedDraft.skillTokens;
    const draftReferences = capturedDraft.references;
    const originalInput = draftInput.value;
    const body = originalInput.trim();
    const titleBody = body;
    if (
      commandOverride === undefined &&
      contentOverride === undefined &&
      hasUnavailableSkillToken(draftSkills.value)
    ) {
      options.notice(translate('composer.skillUnavailable'), 'warning');
      return;
    }
    let content: string;
    try {
      content =
        commandOverride?.input ??
        contentOverride ??
        serializeComposerMessage(draftSkills.value, draftInput.value, draftReferences?.value);
    } catch (error) {
      options.notice(
        translate('generated.workbenchSessionMessageService.unableToSendTheMessage', {
          value0: options.errorMessage(error)
        }),
        'error',
        error
      );
      return;
    }
    const command =
      commandOverride?.command ??
      (contentOverride === undefined ? options.selectedCommand.value : undefined);
    if (command !== undefined && options.commandAvailable?.(command) === false) return;
    if (command === undefined && content.length === 0 && options.attachments.value.length === 0)
      return;
    if (
      options.attachmentsPending.value &&
      command === undefined &&
      contentOverride === undefined
    ) {
      options.notice(
        translate(
          'generated.workbenchSessionMessageService.attachmentsAreStillUploadingOrFailedWait'
        ),
        'warning'
      );
      return;
    }
    const deliveryIntent = resolveDeliveryIntent(intentOverride, options.composerBusy.value);
    const draftSession =
      options.draftOpen.value || options.selectedSessionId.value?.startsWith('draft:') === true;
    const commandInput =
      commandOverride?.input ??
      (preserveDraft && command !== undefined ? `/${command.id}` : content);
    if (
      draftSession &&
      command !== undefined &&
      !(command.id === 'fast' && command.runner === 'codex')
    ) {
      if (
        command.interaction === 'IMMEDIATE_ACTION' ||
        command.interaction === 'DESTRUCTIVE_ACTION'
      ) {
        options.notice(
          translate('generated.workbenchSessionMessageService.sendARegularMessageToCreateThe'),
          'warning'
        );
        return;
      }
      options.stageDraftCommand(command, commandInput);
      if (!preserveDraft) {
        draftInput.value = '';
        capturedDraft.persist();
      }
      if (commandOverride === undefined) {
        options.selectedCommand.value = undefined;
        options.commandPickerOpen.value = false;
      }
      return;
    }
    if (command?.interaction === 'DESTRUCTIVE_ACTION') {
      const confirmedSessionId = options.selectedSessionId.value;
      try {
        await ElMessageBox.confirm(
          translate('generated.workbenchSessionMessageService.clearSessionConfirmation'),
          translate('generated.workbenchSessionMessageService.clearSession'),
          {
            closeIcon: marIcon('close'),
            icon: marIcon('warning'),
            type: 'warning',
            confirmButtonText: translate(
              'generated.workbenchSessionMessageService.confirmClearSession'
            ),
            cancelButtonText: translate(
              'generated.workbenchSessionMessageService.cancelClearSession'
            ),
            confirmButtonClass: 'el-button--danger'
          }
        );
      } catch {
        return;
      }
      if (
        confirmedSessionId === undefined ||
        !sameWorkspace() ||
        options.selectedSessionId.value !== confirmedSessionId ||
        options.submissionAvailable?.() === false ||
        options.commandAvailable?.(command) === false
      )
        return;
    }

    const outgoing = contentOverride === undefined ? [...options.attachments.value] : [];
    const submittedSkillTokens = draftSkills.value;
    const submittedReferences = draftReferences?.value;
    const selectedWorkspace = options.selectedWorkspace.value;
    let startedDraft = false;
    let submittedSession: Session | undefined;
    let submittedProvisional: Session | undefined;
    let attemptedRetryCandidate:
      { readonly signature: string; readonly clientMessageId: string } | undefined;
    const submissionSessionId = options.selectedSessionId.value;
    const finishSubmission = options.beginSubmission(
      sessionSubmissionContext(submissionSessionId),
      () => {
        if (
          active() &&
          options.workspaceTarget.value?.nodeId === submissionNodeId &&
          options.workspaceTarget.value?.workspaceId === submissionWorkspaceId &&
          options.selectedSessionId.value === (submittedSession?.id ?? submissionSessionId)
        )
          options.notice(translate('workbench.submissionTimedOut'), 'warning');
      }
    );
    if (finishSubmission === undefined) return;
    const releaseAttachments = options.retainAttachments(command === undefined ? outgoing : []);
    let completedInSubmissionWindow = false;
    try {
      if (command?.id === 'fast' && command.runner === 'codex') {
        const result = await options.request<{ enabled: boolean }>('/api/runner-commands', {
          method: 'POST',
          body: JSON.stringify({
            nodeId: submissionNodeId,
            runner: 'codex',
            commandId: 'fast',
            input: `/fast ${options.fastEnabled.value ? 'off' : 'on'}`
          })
        });
        if (
          finishSubmission() &&
          sameWorkspace() &&
          options.selectedSessionId.value === submissionSessionId
        ) {
          options.fastEnabled.value = result.enabled;
          if (
            !preserveDraft &&
            draftInput.value === originalInput &&
            originalInput.trim() === content
          ) {
            draftInput.value = '';
            capturedDraft.persist();
          }
          if (commandOverride === undefined) {
            options.selectedCommand.value = undefined;
            options.commandPickerOpen.value = false;
          }
        }
        return;
      }
      const createdDraft = draftSession;
      startedDraft = createdDraft;
      const session = options.draftOpen.value
        ? await options.createDraftSession(options.temporaryTitle(titleBody))
        : options.selectedSession.value;
      if (!active()) return;
      if (session === undefined) throw new Error('SESSION_NOT_FOUND');
      submittedSession = session;
      if (createdDraft && session.id.startsWith('draft:'))
        submittedProvisional = options.sessions.value.find(
          (item) => item.id === session.id && item.workspaceId === session.workspaceId
        );
      if (command !== undefined) {
        await options.executeCommand(session, command, commandInput);
        if (finishSubmission()) {
          if (
            !preserveDraft &&
            draftInput.value === originalInput &&
            originalInput.trim() === content
          ) {
            draftInput.value = '';
            capturedDraft.persist();
          }
          if (
            commandOverride === undefined &&
            sameWorkspace() &&
            options.selectedSessionId.value === session.id
          ) {
            options.selectedCommand.value = undefined;
            options.commandPickerOpen.value = false;
          }
        }
        return;
      }
      if (createdDraft && selectedWorkspace === undefined)
        throw new Error(
          translate(
            'generated.workbenchSessionMessageService.selectAWorkspaceBeforeSendingAMessage'
          )
        );
      const workspaceId = resolveSessionWorkspaceId(selectedWorkspace, session);
      const signature = draftSignature(
        submissionNodeId,
        workspaceId,
        session.id,
        content,
        deliveryIntent,
        outgoing
      );
      if (retryCandidate?.signature !== signature) retryCandidate = undefined;
      const clientMessageId = retryCandidate?.clientMessageId ?? crypto.randomUUID();
      attemptedRetryCandidate = { signature, clientMessageId };
      retryCandidate = attemptedRetryCandidate;
      options.scrollToLatest();
      const result = await options.request<{
        session: Session;
        run: AgentRun;
        delivery?: string;
      }>(
        createdDraft
          ? '/api/agent-sessions/start'
          : `/api/agent-sessions/${options.sessionPathId(session.id)}/messages`,
        {
          method: 'POST',
          body: JSON.stringify({
            nodeId: submissionNodeId,
            ...(createdDraft
              ? {
                  workspaceId,
                  runner: session.runner,
                  cwd: selectedWorkspace!.path,
                  modelId: session.modelId,
                  effort: session.effort,
                  access: session.access,
                  ...(session.runnerTitle ? { title: session.runnerTitle } : {}),
                  deferredCommands: options.deferredCommands.value.map((deferred) => ({
                    commandId: deferred.command.id,
                    input: deferred.input
                  }))
                }
              : {
                  workspaceId,
                  ...(session.runner === 'mar-agent' ? { modelId: session.modelId } : {})
                }),
            clientMessageId,
            content,
            deliveryIntent,
            computerUse: session.runner === 'mar-agent',
            attachmentIds: outgoing.map((attachment) => attachment.id)
          })
        }
      );
      if (!active()) return;
      options.consumeAttachments(outgoing);
      if (createdDraft) capturedDraft.createdSession?.(result.session);
      if (retryCandidate === attemptedRetryCandidate) retryCandidate = undefined;
      if (createdDraft && sameWorkspace() && options.selectedSessionId.value === session.id)
        options.deferredCommands.value = [];
      const selectedBeforeDelivery = options.selectedSessionId.value;
      const nodeStillSelected = sameWorkspace();
      const submittedWasSelected = nodeStillSelected && selectedBeforeDelivery === session.id;
      const identityChanged = session.id !== result.session.id;
      if (identityChanged)
        options.migrateSessionCache(
          submissionNodeId,
          session.workspaceId,
          session.id,
          result.session.id,
          result.session
        );
      if (nodeStillSelected) options.replaceSession(session.id, result.session);
      if (
        createdDraft &&
        nodeStillSelected &&
        options.selectedSessionId.value === result.session.id
      )
        options.beginSessionWatch(result.session.id);
      if (
        submittedWasSelected ||
        (nodeStillSelected && selectedBeforeDelivery === result.session.id)
      ) {
        const latest = options.acceptRun({
          ...result.run,
          sessionId: result.run.sessionId ?? result.session.id
        });
        if (
          (result.delivery === undefined || result.delivery === 'STARTED') &&
          !isTerminalRunStatus(latest.status)
        )
          options.openRun(result.run.id);
      } else {
        options.cacheRun(submissionNodeId, session.workspaceId, {
          ...result.run,
          sessionId: result.run.sessionId ?? result.session.id,
          workspaceId: result.run.workspaceId ?? session.workspaceId
        });
      }
      if (
        submittedWasSelected ||
        (nodeStillSelected &&
          (selectedBeforeDelivery === result.session.id ||
            options.selectedSessionId.value === result.session.id))
      )
        void options.scrollToLatestAfterLayout();
      completedInSubmissionWindow = finishSubmission();
      if (
        contentOverride === undefined &&
        draftInput.value === originalInput &&
        draftSkills.value === submittedSkillTokens &&
        draftReferences?.value === submittedReferences
      ) {
        draftInput.value = '';
        draftSkills.value = [];
        if (draftReferences !== undefined) draftReferences.value = [];
        capturedDraft.persist();
      }
    } catch (error) {
      if (!active()) return;
      if (retryCandidate === attemptedRetryCandidate && errorCode(error) !== undefined)
        retryCandidate = undefined;
      completedInSubmissionWindow = finishSubmission();
      if (startedDraft && completedInSubmissionWindow) {
        const provisionalStillCurrent =
          submittedProvisional !== undefined &&
          options.sessions.value.includes(submittedProvisional);
        if (sameWorkspace() && provisionalStillCurrent)
          options.sessions.value = options.sessions.value.filter(
            (session) => session !== submittedProvisional
          );
        if (
          sameWorkspace() &&
          provisionalStillCurrent &&
          options.selectedSessionId.value === submittedSession?.id
        ) {
          options.restoreDraft();
        }
      }
      if (completedInSubmissionWindow)
        options.notice(
          translate('generated.workbenchSessionMessageService.unableToSendTheMessage', {
            value0: options.errorMessage(error)
          }),
          'error',
          error
        );
    } finally {
      releaseAttachments();
      finishSubmission();
    }
  }

  return { send };
}
