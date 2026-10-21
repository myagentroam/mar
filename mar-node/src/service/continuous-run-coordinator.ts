import type { RunnerName, ComposerAttachmentFile } from '@myagentroam/protocol';
import type { NodeMcpInstallation, ResolvedMcpServer } from '../mcp/model.js';
import type { NodeAgentRun, NodeMessageAttachmentInput, NodeQueueItem } from '../runtime-model.js';
import type { NodeRuntimeState } from '../runtime-state.js';
import type { NodeAgentSession } from '../database.js';
import { withNonImageAttachmentPrompt } from '../util/node-operation-parsers.js';
import { safeErrorCode } from '../util/safe-error.js';
import { withSessionPrompt } from '../util/personal-instructions.js';
import { prepareComposerResourceInput } from './composer-message-input.js';
import { nodeLog } from '../operational.js';

export interface PreparedExecutionInput<TAttachment = unknown> {
  readonly restartMessage?: {
    readonly content: string;
    readonly attachments: readonly NodeMessageAttachmentInput[];
    readonly initiatedByUserId?: number;
  };
  readonly runId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly runner: RunnerName;
  readonly input: string;
  readonly prepareSteerInput?: () => string;
  readonly steering?: boolean;
  readonly precedingInput?: string;
  readonly precedingExecutionId?: string;
  readonly clientMessageId?: string;
  readonly attachments: readonly TAttachment[];
  readonly attachmentPaths: readonly string[];
  readonly attachmentFiles?: readonly ComposerAttachmentFile[];
  readonly cwd: string;
  readonly workspacePath?: string;
  readonly externalSessionId: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly access: string | null;
  readonly collaborationMode: 'default' | 'plan';
  readonly serviceTier?: 'fast';
  readonly secretEnvironment: Readonly<Record<string, string>>;
  readonly personalInstructions?: string;
  readonly goal?: { readonly id: string; readonly revision: number; readonly epoch: number };
  readonly marAgentModel?: unknown;
  readonly marAgentModels?: unknown;
  readonly marAgentCompact?: unknown;
  readonly marAgentRuntimeScopeId?: unknown;
  readonly usageGrant?: import('@myagentroam/protocol').ModelUsageGrant;
  readonly computerUse?: unknown;
}

interface AcceptedMessage {
  readonly runId: string;
  readonly sessionId: string;
  readonly clientMessageId: string;
  readonly content: string;
  readonly source?: 'SCHEDULED';
  readonly suppressNotifications?: boolean;
  readonly initiatedByUserId?: number;
  readonly attachments?: readonly NodeMessageAttachmentInput[];
}

interface EnqueueDisposition {
  readonly onNativeAccepted?: () => void;
  readonly submissionId: string;
  readonly intent: 'SEND' | 'QUEUE' | 'REPLACE_CURRENT';
  readonly queueBefore: { readonly paused: boolean; readonly itemIds: readonly string[] };
  readonly activeRunId?: string;
  readonly steerTarget?: {
    readonly turnId: string | undefined;
    readonly executionId: string | undefined;
  };
}

export interface ContinuousRunCoordinatorOptions {
  readonly resolveExecutionDirectory?: (session: NodeAgentSession) => Promise<string>;
  readonly steer?: (
    prepared: PreparedExecutionInput<unknown>,
    item: NodeQueueItem,
    executionId: string
  ) => Promise<import('../runner/abstract-runner.js').RunnerSteerResult> | undefined;
  readonly runtime: NodeRuntimeState;
  readonly emitQueue: (workspaceId: string, sessionId: string) => void;
  readonly emitConversation: (turn: unknown) => void;
  readonly clearImages: (id: string) => void;
  readonly cleanupAttachments: (id: string) => void;
  readonly migrateAssets: (previousId: string, nextId: string) => void;
  readonly emitRun: (
    runId: string,
    eventType: string,
    payload: unknown,
    status?: 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED'
  ) => void;
  readonly control: (operation: string, payload: Record<string, unknown>) => void;
  readonly stopped: () => boolean;
  readonly markInterrupted: (executionId: string) => void;
  readonly mcps: (workspaceId: string) => readonly NodeMcpInstallation[];
  readonly retainEnvironment?: (environment: Readonly<Record<string, string>>) => () => void;
  readonly afterExecutionStarted?: (input: PreparedExecutionInput<unknown>) => Promise<void>;
  readonly afterExecutionSteered?: (input: PreparedExecutionInput<unknown>) => Promise<void>;
  readonly afterExecutionStartFailed?: (
    input: PreparedExecutionInput<unknown>,
    error: unknown
  ) => void;
  readonly goalMcp?: (
    input: PreparedExecutionInput<unknown>
  ) => Promise<ResolvedMcpServer | undefined>;
  readonly scheduleMcp?: (
    input: PreparedExecutionInput<unknown>
  ) => Promise<ResolvedMcpServer | undefined>;
  readonly notificationMcp?: (
    input: PreparedExecutionInput<unknown>
  ) => Promise<ResolvedMcpServer | undefined>;
  readonly goalCurrent?: (input: PreparedExecutionInput<unknown>) => boolean;
  readonly revokeExecutionMcps?: (executionId: string) => void;
  readonly goalActive?: (sessionId: string) => boolean;
}

export class ContinuousRunCoordinator<TAttachment> {
  private readonly preparedInputs = new Map<string, PreparedExecutionInput<TAttachment>>();
  private readonly environmentLeases = new Map<string, () => void>();
  private readonly dispatchedExecutions = new Set<string>();
  private readonly startedExecutions = new Set<string>();
  private readonly scheduledSessions = new Map<string, NodeJS.Timeout>();
  private readonly immediateQueueItems = new Set<string>();
  private readonly steerInFlight = new Map<
    string,
    { readonly sessionId: string; readonly task: Promise<boolean> }
  >();
  private suspended = false;

  constructor(private readonly options: ContinuousRunCoordinatorOptions) {}

  suspend(): void {
    this.suspended = true;
    for (const timer of this.scheduledSessions.values()) clearTimeout(timer);
    this.scheduledSessions.clear();
  }

  resumeScheduling(): void {
    this.suspended = false;
  }

  isImmediate(itemId: string): boolean {
    return this.immediateQueueItems.has(itemId);
  }

  restoreImmediate(itemId: string): void {
    this.immediateQueueItems.add(itemId);
  }

  accept(
    message: AcceptedMessage,
    environment: Readonly<Record<string, string>> = {}
  ): {
    readonly run: NodeAgentRun;
    readonly queueItem?: NodeQueueItem;
    readonly created: boolean;
  } {
    const release = this.options.retainEnvironment?.(environment);
    let retained = false;
    try {
      const active = this.options.runtime.activeSessionRun(message.sessionId);
      if (active === undefined) {
        const created = this.options.runtime.createMessageRun(message);
        if (created.created && release !== undefined) {
          this.environmentLeases.set(created.run.id, release);
          retained = true;
        }
        return created;
      }
      const created = this.options.runtime.createQueueItem({
        queueItemId: message.runId,
        sessionId: message.sessionId,
        clientMessageId: message.clientMessageId,
        content: message.content,
        ...(message.suppressNotifications === true ? { suppressNotifications: true } : {}),
        ...(message.initiatedByUserId === undefined
          ? {}
          : { initiatedByUserId: message.initiatedByUserId }),
        ...(message.attachments === undefined ? {} : { attachments: message.attachments })
      });
      if (created.created && release !== undefined) {
        this.environmentLeases.set(created.item.id, release);
        retained = true;
      }
      if (created.created) this.options.emitQueue(created.item.workspaceId, created.item.sessionId);
      return { run: active, queueItem: created.item, created: created.created };
    } finally {
      if (!retained) release?.();
    }
  }

  prepare(submissionId: string, input: PreparedExecutionInput<TAttachment>): void {
    const run = this.options.runtime.getRun(submissionId);
    const item = this.options.runtime.getQueueItem(submissionId);
    if (run === undefined && item === undefined) throw new Error('MESSAGE_NOT_FOUND');
    if ((run?.sessionId ?? item?.sessionId) !== input.sessionId)
      throw new Error('MESSAGE_SESSION_MISMATCH');
    const release = this.options.retainEnvironment?.(input.secretEnvironment);
    this.environmentLeases.get(submissionId)?.();
    if (release !== undefined) this.environmentLeases.set(submissionId, release);
    this.preparedInputs.set(submissionId, input);
  }

  pending(submissionId: string): PreparedExecutionInput<TAttachment> | undefined {
    return this.preparedInputs.get(submissionId);
  }

  failPreparation(submissionId: string, code: string): void {
    this.remove(submissionId);
    this.options.runtime.recordMessagePreparationFailure(submissionId, code);
    const item = this.options.runtime.getQueueItem(submissionId);
    if (item !== undefined) {
      const sessionId = item.sessionId;
      this.deleteQueueItem(item.id);
      const active = this.options.runtime.activeSessionRun(sessionId);
      if (active === undefined || this.options.runtime.currentExecutionId(active.id) !== undefined)
        return;
      if (!this.isMessageRun(active)) {
        this.finishTerminalCommandRun(active);
        return;
      }
      if (this.options.runtime.sessionQueue(sessionId).itemIds.length > 0) {
        this.schedule(sessionId);
        return;
      }
      this.options.emitRun(active.id, 'run.rejected', { code }, 'FAILED');
      return;
    }
    const run = this.options.runtime.getRun(submissionId);
    if (run !== undefined) this.options.emitRun(run.id, 'run.rejected', { code }, 'FAILED');
  }

  settle(
    input: EnqueueDisposition
  ): 'STARTED' | 'QUEUED' | 'ACCEPTED' | Promise<'STARTED' | 'QUEUED' | 'ACCEPTED'> {
    const pending = this.preparedInputs.get(input.submissionId);
    if (
      this.options.resolveExecutionDirectory &&
      pending &&
      this.options.runtime.getQueueItem(input.submissionId)
    ) {
      const version = this.options.runtime.sessionQueue(pending.sessionId).version;
      return this.directoryForInput(input.submissionId, pending).then((cwd) => {
        if (cwd === undefined) return 'QUEUED';
        if (
          !this.inputCurrent(input.submissionId, pending) ||
          this.options.runtime.sessionQueue(pending.sessionId).version !== version
        ) {
          this.schedule(pending.sessionId);
          return 'QUEUED';
        }
        return this.settleReady(input);
      });
    }
    return this.settleReady(input);
  }

  private settleReady(
    input: EnqueueDisposition
  ): 'STARTED' | 'QUEUED' | 'ACCEPTED' | Promise<'STARTED' | 'QUEUED' | 'ACCEPTED'> {
    const item = this.options.runtime.getQueueItem(input.submissionId);
    const active = item && this.options.runtime.activeSessionRun(item.sessionId);
    const turn = active && this.options.runtime.conversationTurnForRun(active.id);
    if (
      input.steerTarget &&
      active &&
      active.id === input.activeRunId &&
      turn?.id === input.steerTarget.turnId &&
      this.options.runtime.currentExecutionId(active.id) === input.steerTarget.executionId
    ) {
      const attempt = this.tryNativeSteer(input.submissionId, active, input.onNativeAccepted);
      if (attempt)
        return attempt.then((accepted) =>
          accepted
            ? 'ACCEPTED'
            : this.suspended || this.options.stopped()
              ? 'QUEUED'
              : this.settleFallback(input)
        );
    }
    return this.settleFallback(input);
  }

  private settleFallback(
    input: EnqueueDisposition
  ): 'STARTED' | 'QUEUED' | 'ACCEPTED' | Promise<'STARTED' | 'QUEUED' | 'ACCEPTED'> {
    const prepared = this.preparedInputs.get(input.submissionId);
    const item = this.options.runtime.getQueueItem(input.submissionId);
    const sessionId = prepared?.sessionId ?? item?.sessionId;
    if (sessionId === undefined) throw new Error('SESSION_NOT_FOUND');
    const active = this.options.runtime.activeSessionRun(sessionId);
    const activeTurn = active && this.options.runtime.conversationTurnForRun(active.id);
    const steering =
      input.steerTarget !== undefined &&
      active !== undefined &&
      active.id === input.activeRunId &&
      activeTurn?.id === input.steerTarget.turnId &&
      this.canSteer(active) &&
      (input.steerTarget.executionId === undefined ||
        this.options.runtime.currentExecutionId(active.id) === input.steerTarget.executionId);
    const intent = input.steerTarget !== undefined && !steering ? 'SEND' : input.intent;
    if (steering) this.prepareSteering(input.submissionId);
    const executionEnded =
      active !== undefined &&
      this.options.runtime.currentExecutionId(active.id) === undefined &&
      activeTurn !== undefined &&
      (activeTurn.status === 'SUCCEEDED' ||
        activeTurn.status === 'FAILED' ||
        activeTurn.status === 'INTERRUPTED');
    const queueVersionBeforeSettle = this.options.runtime.sessionQueue(sessionId).version;
    const startsAcceptedRun = active !== undefined && input.submissionId === active.id;
    if (startsAcceptedRun || !input.queueBefore.paused || intent !== 'QUEUE')
      this.options.runtime.resumeSessionQueue(sessionId);
    if (
      input.activeRunId !== undefined &&
      active?.id === input.activeRunId &&
      (input.steerTarget === undefined || steering)
    ) {
      if (item !== undefined) this.immediateQueueItems.add(item.id);
      if (executionEnded) {
        if (item !== undefined) this.options.runtime.prioritizeQueueItem(item.id);
        this.publish(sessionId);
        this.scheduleImmediate(sessionId);
        return 'ACCEPTED';
      }
      if (
        this.options.runtime.currentExecutionId(active.id) === undefined &&
        !this.isMessageRun(active)
      ) {
        if (item !== undefined) this.options.runtime.prioritizeQueueItem(item.id);
        this.publish(sessionId);
        return 'QUEUED';
      }
      this.replace(input.submissionId, active.id);
      return 'ACCEPTED';
    }
    if (startsAcceptedRun) {
      if (this.options.runtime.sessionQueue(sessionId).version !== queueVersionBeforeSettle)
        this.publish(sessionId);
      this.schedule(sessionId);
      return 'STARTED';
    }
    if (
      item !== undefined &&
      prepared?.goal === undefined &&
      this.options.goalActive?.(sessionId)
    ) {
      if (this.options.runtime.sessionQueue(sessionId).version !== queueVersionBeforeSettle)
        this.publish(sessionId);
      return 'QUEUED';
    }
    if (active === undefined && item !== undefined) {
      if (input.queueBefore.paused && intent === 'SEND')
        this.options.runtime.prioritizeQueueItem(item.id);
      return this.startIdleQueue(sessionId).then((started) =>
        started === item.id ? 'STARTED' : 'QUEUED'
      );
    }
    if (executionEnded && item !== undefined) {
      if (input.queueBefore.paused && intent === 'SEND') {
        this.options.runtime.prioritizeQueueItem(item.id);
        this.publish(sessionId);
      }
      this.schedule(sessionId);
      return this.nextQueueItem(sessionId) === item.id ? 'STARTED' : 'QUEUED';
    }
    if (this.options.runtime.sessionQueue(sessionId).version !== queueVersionBeforeSettle)
      this.publish(sessionId);
    return 'QUEUED';
  }

  executeQueueItem(
    itemId: string
  ):
    | { readonly run: NodeAgentRun; readonly delivery: string }
    | Promise<{ readonly run: NodeAgentRun; readonly delivery: string }> {
    const pending = this.preparedInputs.get(itemId);
    if (this.options.resolveExecutionDirectory && pending) {
      const version = this.options.runtime.sessionQueue(pending.sessionId).version;
      return this.directoryForInput(itemId, pending, true).then((cwd) => {
        if (cwd === undefined || !this.inputCurrent(itemId, pending))
          throw new Error('QUEUE_ITEM_INVALID');
        if (this.options.runtime.sessionQueue(pending.sessionId).version !== version)
          throw new Error('QUEUE_VERSION_CONFLICT');
        return this.executeQueueItemReady(itemId);
      });
    }
    return this.executeQueueItemReady(itemId);
  }

  private executeQueueItemReady(
    itemId: string
  ):
    | { readonly run: NodeAgentRun; readonly delivery: string }
    | Promise<{ readonly run: NodeAgentRun; readonly delivery: string }> {
    const item = this.requirePreparedItem(itemId);
    const active = this.options.runtime.activeSessionRun(item.sessionId);
    if (active) {
      const attempt = this.tryNativeSteer(itemId, active);
      if (attempt)
        return attempt.then((accepted) =>
          accepted
            ? { run: active, delivery: 'ACCEPTED' }
            : this.suspended || this.options.stopped()
              ? { run: active, delivery: 'QUEUED' }
              : this.executeQueueItemFallback(itemId)
        );
    }
    return this.executeQueueItemFallback(itemId);
  }

  private tryNativeSteer(
    itemId: string,
    active: NodeAgentRun,
    onAccepted?: () => void
  ): Promise<boolean> | undefined {
    const previous = this.steerInFlight.get(itemId);
    if (previous) return previous.task;
    if (this.suspended || this.options.stopped() || !this.options.steer || !this.canSteer(active))
      return undefined;
    const executionId = this.options.runtime.currentExecutionId(active.id);
    if (!executionId) return undefined;
    this.prepareSteering(itemId);
    const prepared = this.preparedInputs.get(itemId)!;
    const item = this.options.runtime.getQueueItem(itemId)!;
    const release = this.options.runtime.reserveQueueItem(itemId);
    let attempt: ReturnType<NonNullable<ContinuousRunCoordinatorOptions['steer']>>;
    try {
      attempt = this.options.steer(prepared, item, executionId);
    } catch (error) {
      release();
      throw error;
    }
    if (!attempt) {
      release();
      return undefined;
    }
    const task = attempt
      .then(async (result) => {
        if (result.status === 'notAccepted') return false;
        onAccepted?.();
        this.options.runtime.consumeSteeredQueueItem(itemId, active.id);
        this.immediateQueueItems.delete(itemId);
        this.options.runtime.resumeSessionQueue(item.sessionId);
        this.options.clearImages(itemId);
        if (prepared.goal !== undefined && this.goalCurrent(prepared)) {
          const current = this.preparedInputs.get(executionId);
          if (current !== undefined)
            this.preparedInputs.set(executionId, { ...current, goal: prepared.goal });
        }
        try {
          await this.options.afterExecutionSteered?.({ ...prepared, runId: executionId });
        } catch (error) {
          nodeLog('queue.native_steer.continuation_failed', {
            level: 'warn',
            sessionId: item.sessionId,
            executionId,
            code: safeErrorCode(error, 'NATIVE_STEER_CONTINUATION_FAILED')
          });
        }
        this.remove(itemId);
        // Publication is best effort after ownership transfers; it cannot undo SDK acceptance.
        for (const notify of [
          () => {
            if (result.status === 'accepted')
              this.options.emitRun(executionId, 'conversation.item', result.item);
          },
          () => this.publish(item.sessionId)
        ]) {
          try {
            notify();
          } catch {
            nodeLog('queue.native_steer.notification_failed', {
              level: 'warn',
              sessionId: item.sessionId,
              executionId
            });
          }
        }
        return true;
      })
      .finally(() => {
        release();
        this.steerInFlight.delete(itemId);
        this.schedule(item.sessionId);
      });
    this.steerInFlight.set(itemId, { sessionId: item.sessionId, task });
    return task;
  }

  private async executeQueueItemFallback(itemId: string): Promise<{
    readonly run: NodeAgentRun;
    readonly delivery: string;
  }> {
    const item = this.requirePreparedItem(itemId);
    const active = this.options.runtime.activeSessionRun(item.sessionId);
    if (active !== undefined && this.canSteer(active)) this.prepareSteering(item.id);
    this.immediateQueueItems.add(item.id);
    this.options.runtime.resumeSessionQueue(item.sessionId);
    this.options.runtime.prioritizeQueueItem(item.id);
    if (active !== undefined) {
      if (this.options.runtime.currentExecutionId(active.id) !== undefined)
        this.replace(item.id, active.id, false);
      else {
        this.publish(item.sessionId);
        if (this.isMessageRun(active)) this.scheduleImmediate(item.sessionId);
      }
      return { run: active, delivery: 'ACCEPTED' };
    }
    await this.startIdleQueue(item.sessionId, true);
    const started = this.options.runtime.activeSessionRun(item.sessionId);
    if (started === undefined) throw new Error('RUN_NOT_FOUND');
    return { run: started, delivery: 'STARTED' };
  }

  private canSteer(active: NodeAgentRun): boolean {
    const turn = this.options.runtime.conversationTurnForRun(active.id);
    return turn === undefined
      ? !this.isMessageRun(active)
      : this.options.runtime.currentExecutionId(active.id) !== undefined &&
          !['SUCCEEDED', 'FAILED', 'INTERRUPTED'].includes(turn.status);
  }

  private prepareSteering(itemId: string): void {
    const prepared = this.preparedInputs.get(itemId);
    if (prepared?.prepareSteerInput === undefined || prepared.steering) return;
    const input = prepareComposerResourceInput(
      prepared.prepareSteerInput(),
      prepared.cwd,
      prepared.workspacePath ?? prepared.cwd
    );
    this.preparedInputs.set(itemId, { ...prepared, input, steering: true });
  }

  updatePreparedInput(itemId: string, input: string, prepareSteerInput?: () => string): void {
    const pending = this.preparedInputs.get(itemId);
    if (pending === undefined) return;
    const resources = prepareComposerResourceInput(
      input,
      pending.cwd,
      pending.workspacePath ?? pending.cwd
    );
    this.preparedInputs.set(itemId, {
      ...pending,
      ...(prepareSteerInput === undefined ? {} : { prepareSteerInput }),
      ...(pending.restartMessage === undefined
        ? {}
        : {
            restartMessage: {
              ...pending.restartMessage,
              content: this.options.runtime.getQueueItem(itemId)?.content ?? input
            }
          }),
      input: withNonImageAttachmentPrompt(
        pending.precedingInput === undefined
          ? resources
          : `${pending.precedingInput}\n\n${resources}`,
        pending.attachmentPaths,
        pending.attachmentFiles
      )
    });
  }

  deleteQueueItem(itemId: string): void {
    const item = this.options.runtime.getQueueItem(itemId);
    if (item === undefined) throw new Error('QUEUE_ITEM_INVALID');
    this.options.runtime.deleteQueueItem(item.id);
    this.remove(item.id);
    this.options.clearImages(item.id);
    this.options.cleanupAttachments(item.id);
    this.options.emitQueue(item.workspaceId, item.sessionId);
  }

  publishCurrentTurn(runId: string): void {
    const turn = this.options.runtime.conversationTurnForRun(runId);
    if (turn !== undefined) this.options.emitConversation(turn);
  }

  publish(sessionId: string): void {
    const session = this.options.runtime.getAgentSession(sessionId);
    if (session === undefined) throw new Error('SESSION_NOT_FOUND');
    this.options.emitQueue(session.workspaceId, session.id);
  }

  replace(itemId: string, activeRunId: string, prioritize = true): void {
    const item = this.requirePreparedItem(itemId);
    const active = this.options.runtime.getRun(activeRunId);
    if (active === undefined || item.sessionId !== active.sessionId)
      throw new Error('QUEUE_ITEM_INVALID');
    if (prioritize) this.options.runtime.prioritizeQueueItem(item.id);
    this.publish(item.sessionId);
    const executionId = this.options.runtime.currentExecutionId(active.id);
    if (executionId === undefined) throw new Error('RUN_EXECUTION_NOT_FOUND');
    if (!this.startedExecutions.has(executionId)) {
      const current = this.preparedInputs.get(executionId);
      const replacement = this.preparedInputs.get(item.id);
      if (
        current !== undefined &&
        replacement !== undefined &&
        replacement.precedingExecutionId !== executionId
      )
        this.preparedInputs.set(item.id, {
          ...replacement,
          precedingExecutionId: executionId,
          precedingInput: current.input,
          input: `${current.input}\n\n${replacement.input}`
        });
    }
    this.options.markInterrupted(executionId);
    this.options.control('run.interrupt', { runId: executionId });
  }

  async resume(sessionId: string): Promise<void> {
    const session = this.options.runtime.getAgentSession(sessionId);
    if (!session) throw new Error('SESSION_NOT_FOUND');
    const version = this.options.runtime.sessionQueue(sessionId).version;
    if (this.options.resolveExecutionDirectory) {
      try {
        await this.options.resolveExecutionDirectory(session);
      } catch (error) {
        if (
          this.options.runtime.getAgentSession(sessionId)?.id === session.id &&
          this.options.runtime.sessionQueue(sessionId).version === version
        )
          this.pauseForDirectory(sessionId, error);
        throw error;
      }
      if (
        this.options.runtime.getAgentSession(sessionId)?.id !== session.id ||
        this.options.runtime.sessionQueue(sessionId).version !== version
      )
        return;
    }
    this.options.runtime.resumeSessionQueue(sessionId);
    if (this.suspended || this.options.stopped()) return;
    await this.startIdleQueue(sessionId, true);
  }

  schedule(sessionId: string, delayMs = 0): void {
    if (this.suspended) return;
    if (this.scheduledSessions.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.scheduledSessions.delete(sessionId);
      if (!this.options.stopped())
        void this.dispatch(sessionId).catch((error) =>
          nodeLog('queue.dispatch.failed', {
            sessionId,
            code: safeErrorCode(error, 'QUEUE_DISPATCH_FAILED')
          })
        );
    }, delayMs);
    this.scheduledSessions.set(sessionId, timer);
    timer.unref();
  }

  private scheduleImmediate(sessionId: string): void {
    const timer = this.scheduledSessions.get(sessionId);
    if (timer !== undefined) clearTimeout(timer);
    this.scheduledSessions.delete(sessionId);
    this.schedule(sessionId);
  }

  async dispatch(sessionId: string): Promise<void> {
    if (this.suspended || this.options.stopped()) return;
    if ([...this.steerInFlight.values()].some((entry) => entry.sessionId === sessionId)) return;
    const active = this.options.runtime.activeSessionRun(sessionId);
    if (active === undefined) {
      await this.startIdleQueue(sessionId);
      return;
    }
    let executionId = this.options.runtime.currentExecutionId(active.id);
    if (executionId !== undefined && this.dispatchedExecutions.has(executionId)) return;
    let pending =
      executionId === undefined
        ? this.preparedInputs.get(active.id)
        : this.preparedInputs.get(executionId);
    let executionCwd = pending?.cwd;
    if (pending && this.options.resolveExecutionDirectory) {
      const key = executionId ?? active.id;
      executionCwd = await this.directoryForInput(key, pending);
      if (
        executionCwd === undefined ||
        !this.inputCurrent(key, pending) ||
        this.options.runtime.activeSessionRun(sessionId)?.id !== active.id ||
        this.options.runtime.currentExecutionId(active.id) !== executionId
      )
        return;
    }
    if (executionId === undefined && pending === undefined) {
      const itemId = this.nextQueueItem(sessionId);
      if (itemId === undefined) return;
      pending = this.preparedInputs.get(itemId);
      if (pending === undefined) return;
      const item = this.options.runtime.getQueueItem(itemId);
      if (item === undefined) return;
      if (this.options.resolveExecutionDirectory) {
        const version = this.options.runtime.sessionQueue(sessionId).version;
        executionCwd = await this.directoryForInput(itemId, pending);
        if (executionCwd === undefined) return;
        if (
          !this.inputCurrent(itemId, pending) ||
          this.options.runtime.activeSessionRun(sessionId)?.id !== active.id ||
          this.options.runtime.currentExecutionId(active.id) !== undefined ||
          this.options.runtime.sessionQueue(sessionId).version !== version ||
          this.nextQueueItem(sessionId) !== itemId
        ) {
          this.schedule(sessionId);
          return;
        }
      }
      if (!this.goalCurrent(pending)) {
        this.deleteQueueItem(item.id);
        this.schedule(sessionId);
        return;
      }
      this.prioritizeNextQueueItem(sessionId, itemId);
      if (
        this.options.runtime.claimNextQueueItem(
          sessionId,
          withNonImageAttachmentPrompt(
            item.content,
            pending.attachmentPaths,
            pending.attachmentFiles
          )
        ) === undefined
      )
        return;
      const execution = this.options.runtime.createExecution(active.id);
      executionId = execution.id;
      this.immediateQueueItems.delete(itemId);
      this.preparedInputs.delete(itemId);
      this.moveEnvironmentLease(itemId, execution.id);
      this.preparedInputs.set(execution.id, { ...pending, runId: execution.id });
      this.options.migrateAssets(itemId, execution.id);
      this.publish(sessionId);
      const turn = this.options.runtime.conversationTurnForExecution(execution.id);
      if (turn === undefined) throw new Error('RUN_TURN_NOT_FOUND');
      this.options.emitConversation(turn);
    } else if (executionId === undefined && pending !== undefined) {
      if (!this.goalCurrent(pending)) {
        this.rejectStaleGoal(active.id);
        return;
      }
      const execution = this.options.runtime.createExecution(active.id);
      executionId = execution.id;
      this.preparedInputs.delete(active.id);
      this.moveEnvironmentLease(active.id, execution.id);
      this.preparedInputs.set(execution.id, { ...pending, runId: execution.id });
      this.options.migrateAssets(active.id, execution.id);
    }
    if (executionId === undefined || pending === undefined) return;
    if (this.dispatchedExecutions.has(executionId)) return;
    if (!this.goalCurrent(pending)) {
      this.rejectStaleGoal(executionId);
      return;
    }
    this.dispatchedExecutions.add(executionId);
    let dispatched = false;
    try {
      // Capabilities belong to this Execution, never the Run or a claimed QueueItem.
      const executionInput: PreparedExecutionInput<unknown> = {
        ...pending,
        cwd: executionCwd ?? pending.cwd,
        runId: executionId
      };
      const goalMcp =
        pending.goal === undefined ? undefined : await this.options.goalMcp?.(executionInput);
      const scheduleMcp = await this.options.scheduleMcp?.(executionInput);
      const notificationMcp = await this.options.notificationMcp?.(executionInput);
      if (this.suspended || this.options.stopped() || !this.dispatchedExecutions.has(executionId))
        return;
      if (!this.goalCurrent(pending)) {
        this.dispatchedExecutions.delete(executionId);
        this.rejectStaleGoal(executionId);
        return;
      }
      const personalInstructions = withSessionPrompt(
        pending.personalInstructions,
        this.options.runtime.getAgentSession(pending.sessionId)?.sessionPrompt
      );
      this.options.control('run.start', {
        ...(pending.usageGrant === undefined ? {} : { usageGrant: pending.usageGrant }),
        runId: executionId,
        sessionId: pending.sessionId,
        workspaceId: pending.workspaceId,
        runner: pending.runner,
        input: pending.input,
        ...(pending.clientMessageId === undefined
          ? {}
          : { clientMessageId: pending.clientMessageId }),
        ...(pending.attachments.length === 0 ? {} : { attachments: pending.attachments }),
        cwd: executionCwd ?? pending.cwd,
        ...(pending.externalSessionId === null
          ? {}
          : { externalSessionId: pending.externalSessionId }),
        ...(pending.model === null ? {} : { model: pending.model }),
        ...(pending.effort === null ? {} : { effort: pending.effort }),
        ...(pending.access === null ? {} : { access: pending.access }),
        collaborationMode: pending.collaborationMode,
        ...(pending.serviceTier === undefined ? {} : { serviceTier: pending.serviceTier }),
        secretEnvironment: {
          ...pending.secretEnvironment,
          MAR_CTL_NODE_ID: this.options.runtime.getAgentSession(pending.sessionId)?.nodeId ?? '',
          MAR_CTL_WORKSPACE_ID: pending.workspaceId,
          MAR_CTL_SESSION_ID:
            this.options.runtime.getAgentSession(pending.sessionId)?.id ?? pending.sessionId,
          MAR_CTL_RUN_ID: active.id,
          MAR_CTL_RUNNER: pending.runner
        },
        ...(personalInstructions === undefined ? {} : { personalInstructions }),
        ...(pending.marAgentModel === undefined ? {} : { marAgentModel: pending.marAgentModel }),
        ...(pending.marAgentModels === undefined ? {} : { marAgentModels: pending.marAgentModels }),
        ...(pending.marAgentCompact === undefined
          ? {}
          : { marAgentCompact: pending.marAgentCompact }),
        ...(pending.marAgentRuntimeScopeId === undefined
          ? {}
          : { marAgentRuntimeScopeId: pending.marAgentRuntimeScopeId }),
        ...(pending.computerUse === undefined ? {} : { computerUse: pending.computerUse }),
        mcpInstallations: this.options.mcps(pending.workspaceId),
        executionMcpServers: [goalMcp, scheduleMcp, notificationMcp].filter(
          (server): server is ResolvedMcpServer => server !== undefined
        )
      });
      dispatched = true;
    } catch (error) {
      this.options.emitRun(
        executionId,
        'run.rejected',
        { code: safeErrorCode(error, 'RUN_START_FAILED') },
        'FAILED'
      );
    } finally {
      if (!dispatched) this.options.revokeExecutionMcps?.(executionId);
    }
  }

  executionStarted(executionId: string): void {
    if (this.startedExecutions.has(executionId)) return;
    const pending = this.preparedInputs.get(executionId);
    if (pending === undefined) return;
    this.startedExecutions.add(executionId);
    void this.options
      .afterExecutionStarted?.(pending as PreparedExecutionInput<unknown>)
      .catch((error) =>
        this.options.afterExecutionStartFailed?.(pending as PreparedExecutionInput<unknown>, error)
      );
  }

  hasExecutionStarted(executionId: string): boolean {
    return this.startedExecutions.has(executionId);
  }

  migrateSession(previousId: string, nextId: string): void {
    for (const [id, pending] of this.preparedInputs)
      if (pending.sessionId === previousId)
        this.preparedInputs.set(id, { ...pending, sessionId: nextId, externalSessionId: nextId });
    const timer = this.scheduledSessions.get(previousId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.scheduledSessions.delete(previousId);
      this.schedule(nextId);
    }
  }

  remove(id: string): void {
    this.immediateQueueItems.delete(id);
    this.environmentLeases.get(id)?.();
    this.environmentLeases.delete(id);
    this.preparedInputs.delete(id);
    this.dispatchedExecutions.delete(id);
    this.startedExecutions.delete(id);
  }

  private moveEnvironmentLease(previousId: string, nextId: string): void {
    const lease = this.environmentLeases.get(previousId);
    this.environmentLeases.delete(previousId);
    if (lease !== undefined) this.environmentLeases.set(nextId, lease);
  }

  removeGoalQueue(
    sessionId: string,
    preservedGoal?: { readonly id: string; readonly revision: number },
    preservedSubmissionId?: string
  ): void {
    for (const [id, pending] of this.preparedInputs) {
      if (id === preservedSubmissionId) continue;
      // Native admission owns receiving items until its receipt settles.
      if (this.steerInFlight.has(id)) continue;
      if (pending.sessionId !== sessionId || pending.goal === undefined) continue;
      if (pending.goal.id === preservedGoal?.id && pending.goal.revision === preservedGoal.revision)
        continue;
      const item = this.options.runtime.getQueueItem(id);
      if (item !== undefined) this.deleteQueueItem(id);
    }
  }

  removePendingQueue(sessionId: string, preservedItemId?: string): void {
    for (const itemId of [...this.options.runtime.sessionQueue(sessionId).itemIds]) {
      if (itemId === preservedItemId) continue;
      this.deleteQueueItem(itemId);
    }
  }

  clear(): void {
    for (const release of this.environmentLeases.values()) release();
    this.environmentLeases.clear();
    this.preparedInputs.clear();
    this.dispatchedExecutions.clear();
    this.startedExecutions.clear();
    this.immediateQueueItems.clear();
    for (const timer of this.scheduledSessions.values()) clearTimeout(timer);
    this.scheduledSessions.clear();
  }

  private async startIdleQueue(
    sessionId: string,
    throwOnError = false
  ): Promise<string | undefined> {
    if (this.options.runtime.activeSessionRun(sessionId) !== undefined) {
      this.schedule(sessionId);
      return;
    }
    const itemId = this.nextQueueItem(sessionId);
    if (itemId === undefined) return;
    const pending = this.preparedInputs.get(itemId);
    if (pending === undefined) throw new Error('QUEUE_INPUT_LOST');
    const item = this.options.runtime.getQueueItem(itemId);
    if (item === undefined) throw new Error('QUEUE_ITEM_INVALID');
    if (!this.goalCurrent(pending)) {
      this.deleteQueueItem(item.id);
      return this.startIdleQueue(sessionId, throwOnError);
    }
    if (this.options.resolveExecutionDirectory) {
      const version = this.options.runtime.sessionQueue(sessionId).version;
      const cwd = await this.directoryForInput(itemId, pending, throwOnError);
      if (cwd === undefined) return;
      if (
        !this.inputCurrent(itemId, pending) ||
        this.options.runtime.activeSessionRun(sessionId) !== undefined ||
        this.options.runtime.sessionQueue(sessionId).version !== version ||
        this.nextQueueItem(sessionId) !== itemId
      ) {
        this.schedule(sessionId);
        return;
      }
    }
    this.prioritizeNextQueueItem(sessionId, itemId);
    const { run, turn } = this.options.runtime.startRunFromQueueItem(
      itemId,
      withNonImageAttachmentPrompt(item.content, pending.attachmentPaths, pending.attachmentFiles)
    );
    this.immediateQueueItems.delete(itemId);
    this.preparedInputs.delete(itemId);
    this.preparedInputs.set(run.id, { ...pending, runId: run.id });
    this.options.emitQueue(run.workspaceId, sessionId);
    this.options.emitConversation(turn);
    this.schedule(sessionId);
    return itemId;
  }

  private inputCurrent(id: string, pending: PreparedExecutionInput<TAttachment>): boolean {
    const session = this.options.runtime.getAgentSession(pending.sessionId);
    return (
      !this.suspended &&
      !this.options.stopped() &&
      this.preparedInputs.get(id) === pending &&
      session?.id === pending.sessionId &&
      session.workspaceId === pending.workspaceId
    );
  }

  private async directoryForInput(
    id: string,
    pending: PreparedExecutionInput<TAttachment>,
    throwOnError = false
  ): Promise<string | undefined> {
    const session = this.options.runtime.getAgentSession(pending.sessionId);
    if (!session || !this.inputCurrent(id, pending)) return undefined;
    const version = this.options.runtime.sessionQueue(session.id).version;
    try {
      return await this.options.resolveExecutionDirectory!(session);
    } catch (error) {
      if (!this.inputCurrent(id, pending)) {
        if (
          this.options.runtime.getAgentSession(session.id) !== undefined &&
          this.preparedInputs.get(id) !== pending
        )
          this.schedule(session.id);
        return undefined;
      }
      if (this.options.runtime.getQueueItem(id)) {
        if (this.options.runtime.sessionQueue(session.id).version === version)
          this.pauseForDirectory(session.id, error);
        else this.schedule(session.id);
      } else {
        this.options.emitRun(
          pending.runId,
          'run.rejected',
          { code: safeErrorCode(error, 'QUEUE_DISPATCH_FAILED') },
          'FAILED'
        );
      }
      if (throwOnError) throw error;
      return undefined;
    }
  }

  private pauseForDirectory(sessionId: string, error: unknown): void {
    if (!this.options.runtime.sessionQueue(sessionId).paused)
      this.options.runtime.pauseSessionQueue(sessionId);
    nodeLog('queue.execution_directory.invalid', {
      sessionId,
      code: safeErrorCode(error, 'QUEUE_DISPATCH_FAILED')
    });
    const active = this.options.runtime.activeSessionRun(sessionId);
    if (active && this.options.runtime.currentExecutionId(active.id) === undefined)
      this.finishTerminalCommandRun(active);
    try {
      this.publish(sessionId);
    } catch {
      nodeLog('queue.execution_directory.publish_failed', { sessionId });
    }
  }

  private nextQueueItem(sessionId: string): string | undefined {
    const queue = this.options.runtime.sessionQueue(sessionId);
    if (queue.paused) return undefined;
    const immediate = queue.itemIds.find((id) => this.immediateQueueItems.has(id));
    if (immediate !== undefined) return immediate;
    if (this.options.goalActive?.(sessionId))
      return queue.itemIds.find((id) => this.preparedInputs.get(id)?.goal !== undefined);
    return queue.itemIds[0];
  }

  private prioritizeNextQueueItem(sessionId: string, itemId: string): void {
    if (this.options.runtime.sessionQueue(sessionId).itemIds[0] !== itemId)
      this.options.runtime.prioritizeQueueItem(itemId);
  }

  private requirePreparedItem(itemId: string): NodeQueueItem {
    const item = this.options.runtime.getQueueItem(itemId);
    if (item === undefined) throw new Error('QUEUE_ITEM_INVALID');
    if (!this.preparedInputs.has(itemId)) throw new Error('QUEUE_INPUT_LOST');
    return item;
  }

  private goalCurrent(pending: PreparedExecutionInput<TAttachment>): boolean {
    return (
      pending.goal === undefined ||
      this.options.goalCurrent?.(pending as PreparedExecutionInput<unknown>) !== false
    );
  }

  private rejectStaleGoal(runId: string): void {
    this.remove(runId);
    this.options.emitRun(runId, 'run.completed', { code: 'GOAL_SUBMISSION_STALE' }, 'INTERRUPTED');
  }

  private isMessageRun(run: NodeAgentRun): boolean {
    return this.options.runtime.findMessageRun(run.sessionId, run.clientMessageId)?.id === run.id;
  }

  private finishTerminalCommandRun(run: NodeAgentRun): void {
    const status = this.options.runtime.conversationTurnForRun(run.id)?.status;
    if (status === 'SUCCEEDED') this.options.emitRun(run.id, 'run.completed', {}, 'SUCCEEDED');
    else if (status === 'FAILED') this.options.emitRun(run.id, 'run.failed', {}, 'FAILED');
    else if (status === 'INTERRUPTED')
      this.options.emitRun(run.id, 'run.completed', {}, 'INTERRUPTED');
  }
}
