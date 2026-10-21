import { composerVisibleText, type RunnerCommandState } from '@myagentroam/protocol';
import type { NodeAgentSession, NodeDatabase } from '../database.js';
import type { NodeRuntimeState } from '../runtime-state.js';
import type { CommandStateStore } from '../runner-command-engine.js';
import { nodeLog } from '../operational.js';
import { isPlainRecord } from '../util/node-operation-parsers.js';
import { safeErrorCode } from '../util/safe-error.js';
import { NODE_MCP } from '../mcp/naming.js';
import {
  goalUnrestrictedAccess,
  type GoalRuntime,
  type GoalExitSummary,
  type GoalState
} from './goal-runtime.js';
import type {
  ContinuousRunCoordinator,
  PreparedExecutionInput
} from './continuous-run-coordinator.js';
import type { SessionMessageService } from './session-message-service.js';
import type { NodeRunEventBridge } from './node-run-event-bridge.js';
import { composerResourceInputTags } from './composer-message-input.js';

type GoalStartInput = Omit<
  Parameters<SessionMessageService['submitGoal']>[0],
  'sessionId' | 'kind' | 'content' | 'deliveryIntent' | 'goal' | 'objective'
> & {
  readonly session: NodeAgentSession;
  readonly objective: string;
  readonly secretEnvironment: Readonly<Record<string, string>>;
};
interface Options {
  readonly goals: GoalRuntime;
  readonly runtime: Pick<
    NodeRuntimeState,
    | 'activeSessionRun'
    | 'currentExecutionId'
    | 'getAgentSession'
    | 'getQueueItem'
    | 'getRun'
    | 'sessionQueue'
    | 'updateAgentSessionAccess'
  >;
  readonly commands: Pick<CommandStateStore, 'get' | 'set' | 'clear'>;
  readonly queue: () => Pick<
    ContinuousRunCoordinator<unknown>,
    'pending' | 'hasExecutionStarted' | 'removeGoalQueue' | 'removePendingQueue' | 'deleteQueueItem'
  >;
  readonly submit: SessionMessageService['submitGoal'];
  readonly emitRun: NodeRunEventBridge['emitRun'];
  readonly present: (session: NodeAgentSession) => unknown;
  readonly emitSession: (session: NodeAgentSession) => void;
  readonly database: () => Pick<NodeDatabase, 'saveNativeSessionMetadata'> | undefined;
}

interface GoalRetry {
  readonly timer: NodeJS.Timeout;
  sessionId: string;
}

interface GoalContinuationAttempt {
  sessionId: string;
  readonly epoch: number;
}

interface GoalGenerationRef {
  readonly id: string;
  readonly revision: number;
  readonly epoch: number;
}

/** Owns transient Goal orchestration, not the domain state or execution queue. */
export class GoalContinuationCoordinator {
  private readonly goalRetryTimers = new Map<string, GoalRetry>();
  private readonly goalContinuationPending = new Map<string, GoalContinuationAttempt>();
  private readonly goalSubmissionAttempts = new Map<string, Set<GoalContinuationAttempt>>();
  private readonly goalContinuationEpochs = new Map<string, number>();
  private readonly goalExecutionProgress = new Set<string>();
  private readonly nativeGoalBindings = new Map<
    string,
    {
      readonly revision: number;
      readonly threadId: string;
      readonly createdAt: number;
      readonly objective: string;
    }
  >();

  private nextEpoch = 0;
  private frozen = false;
  private disposed = false;
  constructor(private readonly options: Options) {}
  keepRunActive(sessionId: string): boolean {
    return (
      (this.goalRetryTimers.has(sessionId) || this.goalContinuationPending.has(sessionId)) &&
      this.options.goals.get(sessionId)?.status === 'active'
    );
  }
  changed(sessionId: string): void {
    const goal = this.options.goals.get(sessionId);
    const session = this.options.runtime.getAgentSession(sessionId);
    if (!goal || !session || this.disposed) return;
    if (goal.status !== 'active') {
      this.nativeGoalBindings.delete(goal.id);
      this.retireGoalContinuation(sessionId);
      this.options.queue().removeGoalQueue(sessionId);
    }
    this.publishGoalState(session, goal);
  }
  executionProgress(executionId: string, item: unknown): void {
    if (this.disposed) return;
    if (this.options.queue().pending(executionId)?.goal && isGoalProgressItem(item))
      this.goalExecutionProgress.add(executionId);
  }
  releaseExecution(executionId: string): void {
    this.goalExecutionProgress.delete(executionId);
  }
  freeze(): void {
    this.frozen = true;
  }
  dispose(): void {
    this.frozen = true;
    this.disposed = true;
    for (const retry of this.goalRetryTimers.values()) clearTimeout(retry.timer);
    this.goalRetryTimers.clear();
    this.goalContinuationPending.clear();
    this.goalSubmissionAttempts.clear();
    this.goalContinuationEpochs.clear();
    this.goalExecutionProgress.clear();
    this.nativeGoalBindings.clear();
  }
  reference(sessionId: string): GoalGenerationRef {
    const goal = this.options.goals.get(sessionId);
    if (!goal) throw new Error('GOAL_NOT_ACTIVE');
    return { id: goal.id, revision: goal.revision, epoch: this.continuationEpoch(sessionId) };
  }
  executionTerminating(executionId: string, status: string, permissionStop?: unknown): void {
    if (this.frozen) return;
    const pending = this.options.queue().pending(executionId);
    if (pending?.goal === undefined) return;
    const started = this.options.queue().hasExecutionStarted(executionId);
    const progressed = this.goalExecutionProgress.delete(executionId);
    if (!this.goalGenerationCurrent(pending.sessionId, pending.goal)) return;
    if (permissionStop !== undefined) {
      this.retireGoalContinuation(pending.sessionId);
      this.options.queue().removeGoalQueue(pending.sessionId);
      return;
    }
    const disposition = this.options.goals.recordExecutionResult(pending.sessionId, {
      failed: status === 'FAILED',
      progressed: status !== 'SUCCEEDED' || progressed
    });
    if (disposition === 'blocked' || disposition === 'completed') {
      this.nativeGoalBindings.delete(pending.goal.id);
      this.retireGoalContinuation(pending.sessionId);
      this.options.queue().removeGoalQueue(pending.sessionId);
      const terminalGoal = this.options.goals.get(pending.sessionId);
      const session = this.options.runtime.getAgentSession(pending.sessionId);
      if (terminalGoal !== undefined && session !== undefined)
        this.publishGoalState(session, terminalGoal);
      return;
    }
    if (status !== 'FAILED' || started) return;
    this.clearGoalRetry(pending.sessionId);
    const continuationEpoch = this.continuationEpoch(pending.sessionId);
    const retry: GoalRetry = {
      sessionId: pending.sessionId,
      timer: setTimeout(() => {
        this.goalRetryTimers.delete(retry.sessionId);
        void this.enqueueGoalContinuation({
          sessionId: retry.sessionId,
          goal: pending.goal!,
          ...(pending.usageGrant === undefined ? {} : { usageGrant: pending.usageGrant }),
          secretEnvironment: pending.secretEnvironment,
          ...(pending.personalInstructions === undefined
            ? {}
            : { personalInstructions: pending.personalInstructions }),
          ...(pending.marAgentModel === undefined ? {} : { marAgentModel: pending.marAgentModel }),
          ...(pending.marAgentModels === undefined
            ? {}
            : { marAgentModels: pending.marAgentModels }),
          ...(pending.marAgentCompact === undefined
            ? {}
            : { marAgentCompact: pending.marAgentCompact }),
          ...(pending.marAgentRuntimeScopeId === undefined
            ? {}
            : { marAgentRuntimeScopeId: pending.marAgentRuntimeScopeId }),
          continuationEpoch,
          deliveryIntent: 'SEND'
        });
      }, 15_000)
    };
    this.goalRetryTimers.set(pending.sessionId, retry);
    retry.timer.unref();
  }
  migrateSession(previousId: string, nextId: string): void {
    this.options.goals.migrateSession(previousId, nextId);
    const retry = this.goalRetryTimers.get(previousId);
    if (retry !== undefined) {
      this.goalRetryTimers.delete(previousId);
      retry.sessionId = nextId;
      this.goalRetryTimers.set(nextId, retry);
    }
    const pendingContinuation = this.goalContinuationPending.get(previousId);
    if (pendingContinuation !== undefined) {
      this.goalContinuationPending.delete(previousId);
      pendingContinuation.sessionId = nextId;
      this.goalContinuationPending.set(nextId, pendingContinuation);
    }
    const submissionAttempts = this.goalSubmissionAttempts.get(previousId);
    if (submissionAttempts !== undefined) {
      this.goalSubmissionAttempts.delete(previousId);
      const currentAttempts =
        this.goalSubmissionAttempts.get(nextId) ?? new Set<GoalContinuationAttempt>();
      for (const attempt of submissionAttempts) {
        attempt.sessionId = nextId;
        currentAttempts.add(attempt);
      }
      this.goalSubmissionAttempts.set(nextId, currentAttempts);
    }
    const continuationEpoch = this.goalContinuationEpochs.get(previousId);
    if (continuationEpoch !== undefined) {
      this.goalContinuationEpochs.delete(previousId);
      this.goalContinuationEpochs.set(nextId, continuationEpoch);
    }
  }
  begin(session: NodeAgentSession): unknown {
    const existing = this.options.commands.get(session.id, 'goal');
    if (existing?.active === true)
      return {
        session: this.options.present(session),
        goalAlreadyActive: true
      };
    if (existing !== undefined) {
      const previousGoal = this.options.goals.get(session.id);
      if (previousGoal !== undefined) this.nativeGoalBindings.delete(previousGoal.id);
      this.options.goals.clear(session.id);
      this.options.commands.clear(session.id, 'goal');
    }
    const prepared = this.prepareGoalSession(session);
    this.options.queue().removePendingQueue(session.id);
    this.options.commands.set(session.id, this.pendingGoalCommandState());
    this.options.emitSession(prepared.session);
    return {
      session: this.options.present(prepared.session),
      goalAccessChanged: prepared.changed
    };
  }
  async start({
    session,
    objective,
    initiatedByUserId,
    suppressNotifications,
    secretEnvironment,
    personalInstructions,
    marAgentModel,
    marAgentModels,
    marAgentCompact,
    marAgentRuntimeScopeId,
    usageGrant
  }: GoalStartInput): Promise<unknown> {
    this.invalidateGoalContinuation(session.id);
    const prepared = this.prepareGoalSession(session);
    const goalSession = prepared.session;
    const activeRun = this.options.runtime.activeSessionRun(session.id);
    const replacing =
      activeRun !== undefined &&
      this.options.runtime.currentExecutionId(activeRun.id) !== undefined;
    this.options.queue().removeGoalQueue(session.id);
    const goal = this.options.goals.start(session.id, objective);
    this.publishGoalState(goalSession, goal);
    const attempt = this.beginGoalSubmission(session.id);
    const goalRef = { id: goal.id, revision: goal.revision, epoch: attempt.epoch };
    let result: unknown;
    try {
      result = await this.options.submit({
        sessionId: attempt.sessionId,
        kind: 'start',
        content: this.options.goals.prompt(attempt.sessionId, 'start'),
        objective: goal.objective,
        deliveryIntent: replacing ? 'REPLACE_CURRENT' : 'SEND',
        goal: goalRef,
        ...(suppressNotifications === true ? { suppressNotifications: true } : {}),
        ...(usageGrant === undefined ? {} : { usageGrant }),
        ...(initiatedByUserId === undefined ? {} : { initiatedByUserId }),
        secretEnvironment,
        ...(personalInstructions === undefined ? {} : { personalInstructions }),
        ...(marAgentModel === undefined ? {} : { marAgentModel }),
        ...(marAgentModels === undefined ? {} : { marAgentModels }),
        ...(marAgentCompact === undefined ? {} : { marAgentCompact }),
        ...(marAgentRuntimeScopeId === undefined ? {} : { marAgentRuntimeScopeId })
      });
      if (!this.goalGenerationCurrent(attempt.sessionId, goalRef)) {
        this.removeStaleGoalSubmission(attempt.sessionId, result);
        throw new Error('GOAL_REVISION_STALE');
      }
    } finally {
      this.finishGoalSubmissionAttempt(attempt);
    }
    return {
      ...(isPlainRecord(result) ? result : { result }),
      goalAccessChanged: prepared.changed
    };
  }
  clear(session: NodeAgentSession): unknown {
    const goalExit = this.clearGoalState(session.id, 'removed');
    this.finishIdleGoalRun(session.id, 'SUCCEEDED');
    return {
      session: this.options.present(session),
      cleared: true,
      ...(goalExit === undefined ? {} : { goalExit })
    };
  }
  goalMessage(session: NodeAgentSession, content: string, intent: string) {
    const state = this.options.commands.get(session.id, 'goal');
    if (state?.active !== true) return undefined;
    const current = this.options.goals.get(session.id);
    if (current?.status === 'active') {
      const idlePausedGoal =
        this.options.runtime.activeSessionRun(session.id) === undefined &&
        this.options.runtime.sessionQueue(session.id).paused;
      if (intent !== 'REPLACE_CURRENT' && !idlePausedGoal) return undefined;
      this.invalidateGoalContinuation(session.id);
      const resumed = this.options.goals.resume(session.id)!;
      if (resumed !== current) this.publishGoalState(session, resumed);
      return {
        runnerContent: content,
        goal: {
          id: resumed.id,
          revision: resumed.revision,
          epoch: this.continuationEpoch(session.id)
        },
        activated: false
      };
    }
    const objective = composerVisibleText(content);
    if (objective.length === 0) return undefined;
    this.invalidateGoalContinuation(session.id);
    const goal = this.options.goals.start(
      session.id,
      objective,
      composerResourceInputTags(content)
    );
    this.publishGoalState(session, goal);
    return {
      runnerContent: this.options.goals.prompt(session.id, 'start'),
      goal: {
        id: goal.id,
        revision: goal.revision,
        epoch: this.continuationEpoch(session.id)
      },
      activated: true
    };
  }
  prepareInsertion(sessionId: string, submissionId: string, goal: GoalGenerationRef): boolean {
    if (!this.goalGenerationCurrent(sessionId, goal)) return false;
    this.options.queue().removeGoalQueue(sessionId, undefined, submissionId);
    return true;
  }
  private clearGoalRetry(sessionId: string): void {
    const retry = this.goalRetryTimers.get(sessionId);
    if (retry !== undefined) clearTimeout(retry.timer);
    this.goalRetryTimers.delete(sessionId);
    this.goalContinuationPending.delete(sessionId);
  }

  private continuationEpoch(sessionId: string): number {
    let epoch = this.goalContinuationEpochs.get(sessionId);
    if (epoch === undefined) {
      epoch = ++this.nextEpoch;
      this.goalContinuationEpochs.set(sessionId, epoch);
    }
    return epoch;
  }

  private invalidateGoalContinuation(sessionId: string): void {
    this.goalContinuationEpochs.set(sessionId, ++this.nextEpoch);
    this.clearGoalRetry(sessionId);
  }

  private retireGoalContinuation(sessionId: string): void {
    this.clearGoalRetry(sessionId);
    this.goalContinuationEpochs.delete(sessionId);
  }

  goalGenerationCurrent(sessionId: string, goal: GoalGenerationRef): boolean {
    const current = this.options.goals.get(sessionId);
    return (
      !this.disposed &&
      this.goalContinuationEpochs.get(sessionId) === goal.epoch &&
      current?.status === 'active' &&
      current.id === goal.id &&
      current.revision === goal.revision
    );
  }

  async maintainGoalContinuation(
    input: PreparedExecutionInput<unknown>,
    started: boolean
  ): Promise<void> {
    if (this.frozen || input.goal === undefined) return;
    if (!this.goalGenerationCurrent(input.sessionId, input.goal)) return;
    const updated = started ? this.options.goals.recordTurn(input.sessionId) : undefined;
    const session = this.options.runtime.getAgentSession(input.sessionId);
    const run = this.options.runtime.getRun(input.runId);
    await this.enqueueGoalContinuation({
      sessionId: input.sessionId,
      goal: { id: input.goal.id, revision: input.goal.revision },
      continuationEpoch: input.goal.epoch,
      ...(run?.initiatedByUserId === undefined ? {} : { initiatedByUserId: run.initiatedByUserId }),
      ...(input.usageGrant === undefined ? {} : { usageGrant: input.usageGrant }),
      secretEnvironment: input.secretEnvironment,
      ...(input.personalInstructions === undefined
        ? {}
        : { personalInstructions: input.personalInstructions }),
      ...(input.marAgentModel === undefined ? {} : { marAgentModel: input.marAgentModel }),
      ...(input.marAgentModels === undefined ? {} : { marAgentModels: input.marAgentModels }),
      ...(input.marAgentCompact === undefined ? {} : { marAgentCompact: input.marAgentCompact }),
      ...(input.marAgentRuntimeScopeId === undefined
        ? {}
        : { marAgentRuntimeScopeId: input.marAgentRuntimeScopeId })
    });
    if (
      updated !== undefined &&
      session !== undefined &&
      this.goalGenerationCurrent(session.id, input.goal)
    )
      this.publishGoalState(session, this.options.goals.get(session.id)!);
  }

  handleNativeGoalUpdate(
    runId: string,
    nativeGoal: {
      readonly threadId: string;
      readonly createdAt: number;
      readonly objective: string;
      readonly status: 'active' | 'completed';
    }
  ): void {
    const pending = this.options.queue().pending(runId);
    if (pending?.goal === undefined || !this.goalGenerationCurrent(pending.sessionId, pending.goal))
      return;
    const goal = this.options.goals.get(pending.sessionId)!;
    if (nativeGoal.status === 'active') {
      if ((nativeGoal.createdAt + 1) * 1_000 < goal.revisionStartedAt) return;
      const previous = this.nativeGoalBindings.get(goal.id);
      if (
        previous !== undefined &&
        previous.revision !== goal.revision &&
        previous.threadId === nativeGoal.threadId &&
        previous.createdAt === nativeGoal.createdAt &&
        previous.objective === nativeGoal.objective
      )
        return;
      this.nativeGoalBindings.set(goal.id, {
        revision: goal.revision,
        threadId: nativeGoal.threadId,
        createdAt: nativeGoal.createdAt,
        objective: nativeGoal.objective
      });
      return;
    }
    const bound = this.nativeGoalBindings.get(goal.id);
    if (
      bound?.revision !== goal.revision ||
      bound.threadId !== nativeGoal.threadId ||
      bound.createdAt !== nativeGoal.createdAt ||
      bound.objective !== nativeGoal.objective
    )
      return;
    this.nativeGoalBindings.delete(goal.id);
    const completed = this.options.goals.update(
      pending.sessionId,
      goal.id,
      goal.revision,
      'completed'
    );
    this.retireGoalContinuation(pending.sessionId);
    this.options.queue().removeGoalQueue(pending.sessionId);
    const session = this.options.runtime.getAgentSession(pending.sessionId);
    if (session !== undefined) this.publishGoalState(session, completed);
  }

  private beginGoalSubmission(
    sessionId: string,
    continuationEpoch = this.continuationEpoch(sessionId)
  ): GoalContinuationAttempt {
    const attempt = { sessionId, epoch: continuationEpoch };
    const attempts =
      this.goalSubmissionAttempts.get(sessionId) ?? new Set<GoalContinuationAttempt>();
    attempts.add(attempt);
    this.goalSubmissionAttempts.set(sessionId, attempts);
    return attempt;
  }

  private finishGoalSubmissionAttempt(attempt: GoalContinuationAttempt): void {
    const attempts = this.goalSubmissionAttempts.get(attempt.sessionId);
    attempts?.delete(attempt);
    if (attempts?.size === 0) this.goalSubmissionAttempts.delete(attempt.sessionId);
  }

  private finishGoalContinuationAttempt(attempt: GoalContinuationAttempt): void {
    if (this.goalContinuationPending.get(attempt.sessionId) === attempt)
      this.goalContinuationPending.delete(attempt.sessionId);
    this.finishGoalSubmissionAttempt(attempt);
  }

  private removeStaleGoalSubmission(sessionId: string, result: unknown): void {
    if (this.disposed) return;
    if (!isPlainRecord(result)) return;
    if (typeof result.queueItemId === 'string') {
      const item = this.options.runtime.getQueueItem(result.queueItemId);
      if (item?.sessionId === sessionId) this.options.queue().deleteQueueItem(item.id);
      return;
    }
    if (!isPlainRecord(result.run) || typeof result.run.id !== 'string') return;
    const run = this.options.runtime.getRun(result.run.id);
    if (
      run?.sessionId === sessionId &&
      this.options.runtime.currentExecutionId(run.id) === undefined
    )
      this.options.emitRun(
        run.id,
        'run.completed',
        { code: 'GOAL_SUBMISSION_STALE' },
        'INTERRUPTED'
      );
  }

  private async enqueueGoalContinuation(input: {
    readonly sessionId: string;
    readonly goal: { readonly id: string; readonly revision: number };
    readonly initiatedByUserId?: number;
    readonly secretEnvironment: Readonly<Record<string, string>>;
    readonly personalInstructions?: string;
    readonly marAgentModel?: unknown;
    readonly marAgentModels?: unknown;
    readonly marAgentCompact?: unknown;
    readonly marAgentRuntimeScopeId?: unknown;
    readonly usageGrant?: import('@myagentroam/protocol').ModelUsageGrant;
    readonly failedAttempts?: number;
    readonly continuationEpoch?: number;
    readonly deliveryIntent?: 'QUEUE' | 'SEND';
  }): Promise<void> {
    if (this.frozen) return;
    const attempt = this.beginGoalSubmission(input.sessionId, input.continuationEpoch);
    const generation = { ...input.goal, epoch: attempt.epoch };
    if (!this.goalGenerationCurrent(attempt.sessionId, generation)) {
      this.finishGoalSubmissionAttempt(attempt);
      return;
    }
    this.goalContinuationPending.set(input.sessionId, attempt);
    try {
      const result = await this.options.submit({
        sessionId: attempt.sessionId,
        kind: 'continue',
        content: this.options.goals.prompt(attempt.sessionId, 'continue'),
        deliveryIntent: input.deliveryIntent ?? 'QUEUE',
        goal: generation,
        ...(input.initiatedByUserId === undefined
          ? {}
          : { initiatedByUserId: input.initiatedByUserId }),
        ...(input.usageGrant === undefined ? {} : { usageGrant: input.usageGrant }),
        secretEnvironment: input.secretEnvironment,
        ...(input.personalInstructions === undefined
          ? {}
          : { personalInstructions: input.personalInstructions }),
        ...(input.marAgentModel === undefined ? {} : { marAgentModel: input.marAgentModel }),
        ...(input.marAgentModels === undefined ? {} : { marAgentModels: input.marAgentModels }),
        ...(input.marAgentCompact === undefined ? {} : { marAgentCompact: input.marAgentCompact }),
        ...(input.marAgentRuntimeScopeId === undefined
          ? {}
          : { marAgentRuntimeScopeId: input.marAgentRuntimeScopeId })
      });
      if (!this.goalGenerationCurrent(attempt.sessionId, generation)) {
        this.removeStaleGoalSubmission(attempt.sessionId, result);
        this.finishGoalContinuationAttempt(attempt);
        return;
      }
      if (this.goalContinuationPending.get(attempt.sessionId) === attempt) {
        const retry = this.goalRetryTimers.get(attempt.sessionId);
        if (retry !== undefined) clearTimeout(retry.timer);
        this.goalRetryTimers.delete(attempt.sessionId);
      }
      this.finishGoalContinuationAttempt(attempt);
    } catch (error) {
      const failedAttempts = (input.failedAttempts ?? 0) + 1;
      nodeLog('goal.continuation.enqueue.failed', {
        sessionId: attempt.sessionId,
        goalId: input.goal.id,
        revision: input.goal.revision,
        attempt: failedAttempts,
        code: safeErrorCode(error, 'GOAL_CONTINUATION_ENQUEUE_FAILED')
      });
      if (!this.goalGenerationCurrent(attempt.sessionId, generation)) {
        this.finishGoalContinuationAttempt(attempt);
        return;
      }
      // A newer attempt owns retry decisions, even within the same Goal generation.
      if (this.goalContinuationPending.get(attempt.sessionId) !== attempt) return;
      const session = this.options.runtime.getAgentSession(attempt.sessionId);
      if (failedAttempts > 3 || session === undefined) {
        this.clearGoalRetry(attempt.sessionId);
        if (failedAttempts > 3) {
          const blocked = this.options.goals.blockAfterRuntimeFailure(
            attempt.sessionId,
            input.goal.id,
            input.goal.revision
          );
          this.nativeGoalBindings.delete(input.goal.id);
          this.options.queue().removeGoalQueue(attempt.sessionId);
          this.goalContinuationEpochs.delete(attempt.sessionId);
          this.finishIdleGoalRun(attempt.sessionId, 'FAILED');
          if (session !== undefined) this.publishGoalState(session, blocked);
        }
        return;
      }
      this.finishGoalContinuationAttempt(attempt);
      if (this.frozen) return;
      const previousRetry = this.goalRetryTimers.get(attempt.sessionId);
      if (previousRetry !== undefined) clearTimeout(previousRetry.timer);
      const retry: GoalRetry = {
        sessionId: attempt.sessionId,
        timer: setTimeout(() => {
          if (!this.goalGenerationCurrent(retry.sessionId, generation)) return;
          void this.enqueueGoalContinuation({
            ...input,
            sessionId: retry.sessionId,
            failedAttempts,
            continuationEpoch: attempt.epoch
          });
        }, 15_000)
      };
      this.goalRetryTimers.set(attempt.sessionId, retry);
      retry.timer.unref();
    } finally {
      this.finishGoalSubmissionAttempt(attempt);
    }
  }

  handleGoalPreparationFailed(
    session: NodeAgentSession,
    goal: GoalGenerationRef,
    activated: boolean
  ): void {
    if (!activated || !this.goalGenerationCurrent(session.id, goal)) return;
    this.options.goals.clear(session.id);
    this.finishIdleGoalRun(session.id, 'FAILED');
    this.options.commands.set(session.id, this.pendingGoalCommandState());
    this.options.emitSession(session);
  }

  private finishIdleGoalRun(sessionId: string, status: 'SUCCEEDED' | 'FAILED'): void {
    const run = this.options.runtime.activeSessionRun(sessionId);
    if (run === undefined || this.options.runtime.currentExecutionId(run.id) !== undefined) return;
    this.options.emitRun(
      run.id,
      status === 'SUCCEEDED' ? 'run.completed' : 'run.failed',
      status === 'SUCCEEDED' ? {} : { code: 'GOAL_CONTINUATION_FAILED' },
      status
    );
  }

  clearGoalState(
    sessionId: string,
    status: GoalExitSummary['status']
  ): GoalExitSummary | undefined {
    const goalExit = this.options.goals.exitSummary(sessionId, status);
    const goal = this.options.goals.get(sessionId);
    if (goal !== undefined) this.nativeGoalBindings.delete(goal.id);
    this.retireGoalContinuation(sessionId);
    const removed = this.options.goals.clear(sessionId);
    this.options.queue().removeGoalQueue(sessionId);
    const commandState = this.options.commands.get(sessionId, 'goal');
    if (commandState !== undefined) this.options.commands.clear(sessionId, 'goal');
    if (!removed && commandState === undefined) return goalExit;
    const session = this.options.runtime.getAgentSession(sessionId);
    if (session !== undefined) this.options.emitSession(session);
    return goalExit;
  }

  private prepareGoalSession(session: NodeAgentSession): {
    readonly session: NodeAgentSession;
    readonly changed: boolean;
  } {
    const access = goalUnrestrictedAccess(session.runner, session.access);
    const requiresUpdate = session.access !== access;
    const changed = session.runner !== 'mar-agent' && requiresUpdate;
    const prepared = requiresUpdate
      ? this.options.runtime.updateAgentSessionAccess(session.id, access)
      : session;
    if (
      changed &&
      prepared.externalSessionId !== null &&
      prepared.model !== null &&
      prepared.effort !== null
    )
      this.options.database()?.saveNativeSessionMetadata({
        runner: prepared.runner,
        externalSessionId: prepared.externalSessionId,
        workspaceId: prepared.workspaceId,
        model: prepared.model,
        effort: prepared.effort,
        access
      });
    return { session: prepared, changed };
  }

  private pendingGoalCommandState(): RunnerCommandState {
    return {
      commandId: 'goal',
      active: true,
      label: 'Goal',
      detail: null,
      closable: true,
      closeInput: '/goal --clear'
    };
  }

  publishGoalState(session: NodeAgentSession, goal: GoalState): void {
    if (goal.status !== 'active') {
      this.options.commands.clear(session.id, 'goal');
      this.options.emitSession(session);
      return;
    }
    this.options.commands.set(session.id, {
      commandId: 'goal',
      active: goal.status === 'active',
      label: 'Goal',
      detail: goal.objective.slice(0, 500),
      closable: true,
      closeInput: '/goal',
      goal: {
        id: goal.id,
        objective: goal.objective,
        revision: goal.revision,
        status: goal.status,
        turns: goal.turns
      }
    });
    this.options.emitSession(session);
  }
}

const goalReadToolNames = new Set([
  `${NODE_MCP.goal.name}.${NODE_MCP.goal.tools.get}`,
  `${NODE_MCP.goal.name}_${NODE_MCP.goal.tools.get}`,
  `mcp__${NODE_MCP.goal.name}__${NODE_MCP.goal.tools.get}`
]);

function isGoalProgressItem(item: unknown): boolean {
  if (!isPlainRecord(item) || typeof item.kind !== 'string') return false;
  if (item.kind === 'command_execution' || item.kind === 'file_change') return true;
  if (item.kind !== 'tool_call' || !isPlainRecord(item.payload)) return false;
  const toolName = item.payload.toolName;
  return (
    typeof toolName === 'string' &&
    !goalReadToolNames.has(toolName) &&
    !(item.payload.namespace === NODE_MCP.goal.name && toolName === NODE_MCP.goal.tools.get)
  );
}
