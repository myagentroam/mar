import type { RunnerExecutionContext } from '../runner/execution-context.js';
import { RUNNER_EXECUTION_CONTEXT } from '../runner/execution-context.js';
import { modelUsageGrantSchema } from '@myagentroam/protocol';
import { randomUUID } from 'node:crypto';
import type { NodeOperationHandler } from '../connector/node-operation-router.js';
import type { NodeAgentSession } from '../database.js';
import type { NodeRuntimeState } from '../runtime-state.js';
import type { CommandStateStore } from '../runner-command-engine.js';
import type { RunnerRegistry } from '../runner/runner-registry.js';
import {
  isImageAttachment,
  isRunnerImageAttachment,
  parseComposerAttachmentIds,
  parseMessageAttachments,
  sessionTitleFromFirstMessage,
  withNonImageAttachmentPrompt
} from '../util/node-operation-parsers.js';
import type {
  ComposerAttachmentReservation,
  ResolvedComposerAttachment,
  WorkspaceUploadService
} from './workspace-upload-service.js';
import type { RunnerImageAttachment, RunAttachmentService } from './run-attachment-service.js';
import { parseSecretEnvironment } from '../util/secret-environment.js';
import { personalInstructionsForRunner } from '../util/personal-instructions.js';
import { safeErrorCode } from '../util/safe-error.js';
import type { ContinuousRunCoordinator } from './continuous-run-coordinator.js';
import type { AcceptedMessageSession } from './external-session-resume-service.js';
import { publicGoalStartText } from './goal-runtime.js';
import {
  serializeComposerTag,
  composerVisibleText,
  steerComposerMessage
} from '@myagentroam/protocol';
import { relative } from 'node:path';
import {
  prepareComposerResourceInput,
  composerResourceInputTags,
  withSessionMessageOrigin,
  validateComposerSkills
} from './composer-message-input.js';

const INTERNAL_GOAL = Symbol('internalGoal');
const INTERNAL_SCHEDULE = Symbol('internalSchedule');
const INTERNAL_RESTORE = Symbol('internalRestore');
type MessageInput = Record<string | symbol, unknown> & {
  readonly [RUNNER_EXECUTION_CONTEXT]?: RunnerExecutionContext;
};

interface SessionMessageServiceOptions {
  readonly resolveExecutionDirectory?: (session: NodeAgentSession) => Promise<string>;
  readonly runtime: NodeRuntimeState;
  readonly uploads: WorkspaceUploadService;
  readonly attachments: RunAttachmentService;
  readonly commands: CommandStateStore;
  readonly coordinator: ContinuousRunCoordinator<RunnerImageAttachment>;
  readonly runners: RunnerRegistry;
  readonly resolve: (sessionId: string) => Promise<AcceptedMessageSession>;
  readonly workspacePath?: (workspaceId: string) => string | undefined;
  readonly present: (session: NodeAgentSession) => unknown;
  readonly emitSession: (session: NodeAgentSession) => void;
  readonly channelToken: (sessionId: string) => string | undefined;
  readonly goalMessage: (
    session: NodeAgentSession,
    content: string,
    intent: 'SEND' | 'QUEUE' | 'REPLACE_CURRENT'
  ) =>
    | {
        readonly runnerContent: string;
        readonly goal: {
          readonly id: string;
          readonly revision: number;
          readonly epoch: number;
        };
        readonly activated: boolean;
      }
    | undefined;
  readonly prepareGoalInsertion: (
    sessionId: string,
    submissionId: string,
    goal: { readonly id: string; readonly revision: number; readonly epoch: number }
  ) => boolean;
  readonly goalPreparationFailed: (
    session: NodeAgentSession,
    goal: { readonly id: string; readonly revision: number; readonly epoch: number },
    activated: boolean
  ) => void;
}

export class SessionMessageService {
  private readonly pendingMessages = new Map<string, Promise<unknown>>();
  private readonly preparations = new Set<Promise<unknown>>();
  private accepting = true;

  constructor(private readonly options: SessionMessageServiceOptions) {}

  async drain(): Promise<void> {
    await Promise.allSettled([...this.preparations]);
  }

  setAccepting(accepting: boolean): void {
    this.accepting = accepting;
  }

  restoreQueued(input: Record<string, unknown>): Promise<unknown> {
    return this.message({ ...input, [INTERNAL_RESTORE]: true });
  }

  operations(): Readonly<Record<string, NodeOperationHandler>> {
    return {
      'session.message': (data) => this.message(record(data)),
      'session.channel.message': (data) => this.channelMessage(record(data)),
      'session.channel.token': (data) => this.channelToken(record(data))
    };
  }

  submitGoal(input: {
    readonly sessionId: string;
    readonly kind: 'start' | 'continue';
    readonly content: string;
    readonly objective?: string;
    readonly deliveryIntent: 'SEND' | 'QUEUE' | 'REPLACE_CURRENT';
    readonly goal: { readonly id: string; readonly revision: number; readonly epoch: number };
    readonly initiatedByUserId?: number;
    readonly suppressNotifications?: boolean;
    readonly secretEnvironment?: Readonly<Record<string, string>>;
    readonly personalInstructions?: string;
    readonly executionContext: RunnerExecutionContext;
    readonly usageGrant?: import('@myagentroam/protocol').ModelUsageGrant;
    readonly restoreQueued?: boolean;
  }): Promise<unknown> {
    return this.message({
      [INTERNAL_GOAL]: true,
      [INTERNAL_RESTORE]: input.restoreQueued === true,
      sessionId: input.sessionId,
      __suppressNotifications:
        input.suppressNotifications === true ||
        (input.kind === 'continue' &&
          this.options.runtime.activeSessionRun(input.sessionId)?.suppressNotifications === true),
      clientMessageId: `goal:${randomUUID()}`,
      content:
        input.kind === 'start'
          ? publicGoalStartText(input.objective ?? '')
          : serializeComposerTag('mar_goal_continue', {}),
      __runnerContent: input.content,
      __goalRef: input.goal,
      ...(input.initiatedByUserId === undefined
        ? {}
        : { __requestUserId: input.initiatedByUserId }),
      deliveryIntent: input.deliveryIntent,
      secretEnvironment: input.secretEnvironment,
      personalInstructions: input.personalInstructions,
      __usageGrant: input.usageGrant,
      [RUNNER_EXECUTION_CONTEXT]: input.executionContext
    });
  }

  submitScheduled(input: {
    readonly sessionId: string;
    readonly occurrenceId: string;
    readonly objective: string;
    readonly initiatedByUserId: number;
    readonly secretEnvironment: Readonly<Record<string, string>>;
    readonly personalInstructions?: unknown;
    readonly executionContext: RunnerExecutionContext;
    readonly usageGrant?: import('@myagentroam/protocol').ModelUsageGrant;
  }): Promise<unknown> {
    return this.message({
      [INTERNAL_SCHEDULE]: true,
      sessionId: input.sessionId,
      clientMessageId: input.occurrenceId,
      content: input.objective,
      __runnerContent: serializeComposerTag('mar_schedule', { objective: input.objective }),
      __requestUserId: input.initiatedByUserId,
      deliveryIntent: 'SEND',
      secretEnvironment: input.secretEnvironment,
      personalInstructions: input.personalInstructions,
      __usageGrant: input.usageGrant,
      [RUNNER_EXECUTION_CONTEXT]: input.executionContext
    });
  }

  private message(input: MessageInput): Promise<unknown> {
    if (!this.accepting) return Promise.reject(new Error('NODE_STOPPED'));
    const task = this.prepareMessage(input);
    this.preparations.add(task);
    return task.finally(() => this.preparations.delete(task));
  }

  private async prepareMessage(input: MessageInput): Promise<unknown> {
    if (
      typeof input.sessionId !== 'string' ||
      typeof input.clientMessageId !== 'string' ||
      input.clientMessageId.length === 0 ||
      typeof input.content !== 'string' ||
      (input.content.length === 0 &&
        !(Array.isArray(input.attachmentIds) && input.attachmentIds.length > 0) &&
        !(Array.isArray(input.attachments) && input.attachments.length > 0))
    )
      throw new Error('MESSAGE_INVALID');
    const clientMessageId = input.clientMessageId;
    const content = input.content;
    const internalGoal = input[INTERNAL_GOAL] === true;
    const internalSchedule = input[INTERNAL_SCHEDULE] === true;
    const internalRestore = input[INTERNAL_RESTORE] === true;
    const internalRunnerContent =
      (internalGoal || internalSchedule || internalRestore) &&
      typeof input.__runnerContent === 'string'
        ? input.__runnerContent
        : content;
    const inlineAttachments = parseMessageAttachments(input.attachments);
    const secretEnvironment = parseSecretEnvironment(input.secretEnvironment);
    const attachmentIds = parseComposerAttachmentIds(input.attachmentIds);
    if (inlineAttachments.length > 0 && attachmentIds.length > 0)
      throw new Error('MESSAGE_ATTACHMENTS_INVALID');
    const accepted = await this.options.resolve(input.sessionId);
    const session = accepted.session;
    if (input.workspaceId !== undefined && session.workspaceId !== input.workspaceId)
      throw new Error('SESSION_NOT_FOUND');
    const personalInstructions =
      internalGoal && typeof input.personalInstructions === 'string'
        ? input.personalInstructions
        : personalInstructionsForRunner(input.personalInstructions, session.runner);
    const requestedIntent = input.deliveryIntent ?? 'SEND';
    if (
      requestedIntent !== 'SEND' &&
      requestedIntent !== 'QUEUE' &&
      requestedIntent !== 'REPLACE_CURRENT'
    )
      throw new Error('MESSAGE_INVALID');
    const pendingKey = `${session.id}\u0000${clientMessageId}`;
    const pending = this.pendingMessages.get(pendingKey);
    if (pending !== undefined) return pending;
    const preparationFailure = this.options.runtime.messagePreparationFailure(
      session.id,
      clientMessageId
    );
    if (preparationFailure !== undefined) throw new Error(preparationFailure);
    const existing = this.options.runtime.findMessageSubmission(session.id, clientMessageId);
    if (existing !== undefined)
      return {
        session: this.options.present(session),
        run: existing.run,
        ...(existing.kind === 'queue' ? { queueItemId: existing.item.id } : {}),
        delivery: existing.kind === 'queue' ? 'QUEUED' : 'STARTED',
        idempotent: true,
        auditReceipt: auditReceipt(
          session,
          existing.kind === 'queue' ? 'QUEUE' : 'SEND',
          existing.kind === 'queue' ? existing.item.id : existing.run.id,
          existing.kind === 'queue' ? existing.item.id : undefined
        )
      };
    const executionContext =
      input[RUNNER_EXECUTION_CONTEXT] ??
      this.options.runners.require(session.runner).prepareExecutionContext(input);
    const sourceContent = withSessionMessageOrigin(content, input.__marctlOrigin);
    const goalMessage =
      internalGoal || internalSchedule || internalRestore
        ? undefined
        : this.options.goalMessage(session, content, requestedIntent);
    const executionContent = goalMessage?.runnerContent ?? internalRunnerContent;
    const runnerContent =
      executionContent === content
        ? sourceContent
        : withSessionMessageOrigin(executionContent, input.__marctlOrigin);
    const publicContent =
      goalMessage?.activated === true
        ? withSessionMessageOrigin(
            [publicGoalStartText(composerVisibleText(content)), composerResourceInputTags(content)]
              .filter(Boolean)
              .join('\n'),
            input.__marctlOrigin
          )
        : sourceContent;
    const intent = goalMessage?.activated === true ? 'REPLACE_CURRENT' : requestedIntent;
    const releasePreparation = this.options.attachments.protectSession(session.id);
    const operation = (async (): Promise<unknown> => {
      const acceptedSession = accepted.session;
      const session = this.options.runtime.getAgentSession(acceptedSession.id) ?? acceptedSession;
      const runId =
        internalRestore && typeof input.__queueItemId === 'string'
          ? input.__queueItemId
          : randomUUID();
      const queueBeforeCreate = this.options.runtime.sessionQueue(session.id);
      const active = this.options.runtime.activeSessionRun(session.id);
      if (internalSchedule && (active !== undefined || queueBeforeCreate.itemIds.length > 0))
        throw new Error('SCHEDULE_SESSION_BUSY');
      const replaceCurrentRun = intent === 'REPLACE_CURRENT' ? active : undefined;
      const userMessage =
        goalMessage?.activated !== true && !internalGoal && !internalSchedule && !internalRestore;
      const steerTarget =
        userMessage && requestedIntent === 'REPLACE_CURRENT'
          ? {
              turnId:
                active === undefined
                  ? undefined
                  : this.options.runtime.conversationTurnForRun(active.id)?.id,
              executionId:
                active === undefined
                  ? undefined
                  : this.options.runtime.currentExecutionId(active.id)
            }
          : undefined;
      const acceptedMessage = {
        runId,
        sessionId: session.id,
        clientMessageId,
        content: publicContent,
        ...(internalGoal || goalMessage?.activated === true ? { goalInput: true as const } : {}),
        ...(internalSchedule ? { source: 'SCHEDULED' as const } : {}),
        ...(input.__suppressNotifications === true ? { suppressNotifications: true } : {}),
        ...(Number.isSafeInteger(input.__requestUserId)
          ? { initiatedByUserId: input.__requestUserId as number }
          : {}),
        ...(inlineAttachments.length === 0 ? {} : { attachments: inlineAttachments })
      };
      const created = internalRestore
        ? {
            run: undefined,
            queueItem: this.options.runtime.createQueueItem({
              ...acceptedMessage,
              queueItemId: runId
            }).item
          }
        : this.options.coordinator.accept(acceptedMessage, secretEnvironment);
      const submissionId = created.queueItem?.id ?? created.run!.id;
      const sessionForPresentation =
        input.__goal === true
          ? session
          : this.options.runtime.setTemporaryTitleIfMissing(
              session.id,
              sessionTitleFromFirstMessage(content)
            );
      this.options.emitSession(sessionForPresentation);
      if (created.queueItem === undefined)
        this.options.coordinator.publishCurrentTurn(created.run!.id);
      const prepare = async (): Promise<'STARTED' | 'QUEUED' | 'ACCEPTED'> => {
        let reservation: ComposerAttachmentReservation | undefined;
        let nativeAccepted = false;
        try {
          let currentSession = this.options.runtime.getAgentSession(session.id) ?? session;
          const cwd = this.options.resolveExecutionDirectory
            ? await this.options.resolveExecutionDirectory(currentSession)
            : currentSession.cwd;
          if (this.options.resolveExecutionDirectory) {
            const latest = this.options.runtime.getAgentSession(currentSession.id);
            if (
              !latest ||
              latest.workspaceId !== currentSession.workspaceId ||
              latest.cwd !== currentSession.cwd
            )
              throw new Error('SESSION_NOT_FOUND');
            currentSession = latest;
          }
          if (attachmentIds.length > 0)
            reservation = await this.options.uploads.reserve(session.workspaceId, attachmentIds);
          const attachments =
            reservation === undefined
              ? inlineAttachments
              : reservation.attachments.map((attachment) => attachment.attachment);
          const imageAttachments = attachments.filter(isImageAttachment);
          const runnerImageAttachments = attachments.filter(isRunnerImageAttachment);
          const workspacePath =
            this.options.workspacePath?.(currentSession.workspaceId) ?? currentSession.cwd;
          await validateComposerSkills(runnerContent, workspacePath);
          const attachmentPaths =
            reservation === undefined
              ? await this.persistAttachments(currentSession, submissionId, attachments)
              : reservation.attachments.map((attachment) => attachment.path);
          const attachmentFiles = attachments.map((attachment, index) => ({
            name: attachment.name,
            mime: attachment.mime,
            path:
              reservation?.attachments[index]?.resourcePath ??
              this.options.attachments.resourcePath(attachmentPaths[index]!)
          }));
          const runnerFiles = attachmentFiles.map((file, index) => {
            const path = relative(cwd, attachmentPaths[index]!).replaceAll('\\', '/');
            return path === file.path ? file : { ...file, path, workspacePath: file.path };
          });
          const displayInput = withNonImageAttachmentPrompt(
            publicContent,
            attachmentPaths,
            attachmentFiles
          );
          const resourceInput = prepareComposerResourceInput(runnerContent, cwd, workspacePath);
          const runnerInput = withNonImageAttachmentPrompt(
            resourceInput,
            attachmentPaths,
            runnerFiles
          );
          const planActive = this.options.commands
            .list(session.id)
            .some((state) => state.commandId === 'plan');
          const runner = this.options.runners.require(currentSession.runner);
          if (created.queueItem === undefined) {
            this.options.runtime.updatePreparingTurnMessage(
              created.run!.id,
              displayInput,
              attachments
            );
            if (attachmentIds.length > 0 || displayInput !== publicContent)
              this.options.coordinator.publishCurrentTurn(created.run!.id);
          } else
            this.options.runtime.updateQueueItemAttachments(
              created.queueItem.id,
              attachments,
              displayInput
            );
          this.options.coordinator.prepare(submissionId, {
            restartMessage: {
              content: sourceContent,
              attachments,
              ...(Number.isSafeInteger(input.__requestUserId)
                ? { initiatedByUserId: input.__requestUserId as number }
                : {})
            },
            ...(input.__usageGrant === undefined
              ? {}
              : { usageGrant: modelUsageGrantSchema.parse(input.__usageGrant) }),
            runId,
            sessionId: currentSession.id,
            workspaceId: currentSession.workspaceId,
            executionContext,
            input: runner.prepareMessageInput(runnerInput, planActive ? 'plan' : 'default'),
            ...(userMessage
              ? {
                  prepareSteerInput: () =>
                    runner.prepareMessageInput(
                      steerComposerMessage(runnerInput),
                      planActive ? 'plan' : 'default'
                    )
                }
              : {}),
            clientMessageId,
            attachments: runnerImageAttachments,
            attachmentPaths,
            attachmentFiles: runnerFiles,
            cwd,
            workspacePath,
            externalSessionId: currentSession.externalSessionId,
            model: currentSession.model,
            effort: currentSession.effort,
            access: currentSession.access,
            collaborationMode: planActive ? 'plan' : 'default',
            secretEnvironment,
            ...(personalInstructions === undefined ? {} : { personalInstructions }),
            ...(input.computerUse === undefined ? {} : { computerUse: input.computerUse }),
            ...(goalMessage !== undefined
              ? { goal: goalMessage.goal }
              : isGoalRef(input.__goalRef)
                ? { goal: input.__goalRef }
                : {}),
            ...(runner.serviceTier() === 'fast' ? { serviceTier: 'fast' } : {})
          });
          this.options.attachments.cache(submissionId, imageAttachments);
          if (
            goalMessage !== undefined &&
            !this.options.prepareGoalInsertion(session.id, submissionId, goalMessage.goal)
          )
            throw new Error('GOAL_REVISION_STALE');
          this.options.attachments.retainSessionFiles(currentSession.id, submissionId);
          const delivery = internalRestore
            ? 'QUEUED'
            : await this.options.coordinator.settle({
                onNativeAccepted: () => {
                  nativeAccepted = true;
                },
                submissionId,
                intent,
                queueBefore: queueBeforeCreate,
                ...(steerTarget === undefined ? {} : { steerTarget }),
                ...(replaceCurrentRun === undefined ? {} : { activeRunId: replaceCurrentRun.id })
              });
          reservation?.commit((directories) =>
            this.options.attachments.adoptSessionFiles(
              currentSession.id,
              submissionId,
              directories,
              currentSession.workspaceId,
              attachmentPaths
            )
          );
          this.options.attachments.acceptSessionInput(currentSession.id);
          return delivery;
        } catch (error) {
          if (nativeAccepted) throw error;
          reservation?.release();
          if (goalMessage !== undefined)
            this.options.goalPreparationFailed(session, goalMessage.goal, goalMessage.activated);
          this.options.coordinator.failPreparation(
            submissionId,
            safeErrorCode(error, 'MESSAGE_PREPARATION_FAILED')
          );
          this.options.attachments.clear(submissionId);
          this.options.attachments.cleanup(submissionId);
          await this.options.attachments.discardFiles(submissionId);
          throw error;
        }
      };
      const delivery = await prepare();
      return {
        session: this.options.present(
          this.options.runtime.getAgentSession(session.id) ?? sessionForPresentation
        ),
        run: created.run,
        ...(created.queueItem === undefined ? {} : { queueItemId: created.queueItem.id }),
        delivery,
        idempotent: false,
        auditReceipt: auditReceipt(
          sessionForPresentation,
          intent === 'QUEUE' ? 'QUEUE' : intent === 'REPLACE_CURRENT' ? 'REPLACE_CURRENT' : 'SEND',
          created.run?.id ?? submissionId,
          created.queueItem?.id
        )
      };
    })();
    this.pendingMessages.set(pendingKey, operation);
    try {
      return await operation;
    } finally {
      releasePreparation();
      if (this.pendingMessages.get(pendingKey) === operation)
        this.pendingMessages.delete(pendingKey);
    }
  }

  private async persistAttachments(
    session: NodeAgentSession,
    runId: string,
    attachments: readonly ResolvedComposerAttachment['attachment'][]
  ): Promise<readonly string[]> {
    return this.options.attachments.persistFiles(session.workspaceId, runId, attachments);
  }

  private async channelMessage(input: Record<string, unknown>): Promise<unknown> {
    if (
      typeof input.sessionId !== 'string' ||
      typeof input.token !== 'string' ||
      typeof input.clientMessageId !== 'string' ||
      typeof input.content !== 'string' ||
      input.content.length === 0 ||
      !Number.isSafeInteger(input.__requestUserId)
    )
      throw new Error('MESSAGE_INVALID');
    const session = this.options.runtime.getAgentSession(input.sessionId);
    if (session === undefined || session.channelToken !== input.token)
      throw new Error('SESSION_CHANNEL_UNAVAILABLE');
    return this.message({
      sessionId: input.sessionId,
      clientMessageId: input.clientMessageId,
      content: input.content,
      deliveryIntent: 'QUEUE',
      secretEnvironment: input.secretEnvironment,
      __requestUserId: input.__requestUserId
    });
  }

  private channelToken(input: Record<string, unknown>): unknown {
    if (typeof input.sessionId !== 'string') throw new Error('SESSION_INVALID');
    const token = this.options.channelToken(input.sessionId);
    if (token === undefined) throw new Error('SESSION_CHANNEL_UNAVAILABLE');
    return { token };
  }
}

function auditReceipt(
  session: NodeAgentSession,
  inputMode: 'SEND' | 'QUEUE' | 'REPLACE_CURRENT',
  runId: string,
  queueItemId?: string
): {
  readonly sessionId: string;
  readonly conversationTitle: string;
  readonly runId: string;
  readonly queueItemId?: string;
  readonly inputMode: 'SEND' | 'QUEUE' | 'REPLACE_CURRENT';
} {
  return {
    sessionId: session.id,
    conversationTitle: session.customTitle ?? session.runnerTitle ?? 'Untitled session',
    runId,
    ...(queueItemId === undefined ? {} : { queueItemId }),
    inputMode
  };
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function isGoalRef(
  value: unknown
): value is { readonly id: string; readonly revision: number; readonly epoch: number } {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { id?: unknown }).id === 'string' &&
    Number.isInteger((value as { revision?: unknown }).revision) &&
    Number.isInteger((value as { epoch?: unknown }).epoch)
  );
}
