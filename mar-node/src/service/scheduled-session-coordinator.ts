import type { RunnerExecutionContext } from '../runner/execution-context.js';
import type { NodeAgentRun } from '../runtime-model.js';
import type { RunnerExecutionStatus } from '../runner/contracts.js';
import { nodeLog } from '../operational.js';
import { safeErrorCode } from '../util/safe-error.js';
import type { ScheduledSessionTask } from './scheduled-session-store.js';
import {
  ScheduledSessionStore,
  SCHEDULE_RESTART_OUTCOME_UNKNOWN,
  SCHEDULE_SUBMISSION_OUTCOME_UNKNOWN
} from './scheduled-session-store.js';

export interface ScheduledRunContext {
  readonly sessionId?: string;
  readonly release?: () => void;
  readonly awaitIdentity?: () => Promise<string>;
  readonly gitConfiguration?: import('@myagentroam/protocol').PersonalGitRuntime;
  readonly usageGrant?: import('@myagentroam/protocol').ModelUsageGrant | undefined;
  readonly secretEnvironment: Readonly<Record<string, string>>;
  readonly personalInstructions?: unknown;
  readonly executionContext: RunnerExecutionContext;
}

export type BeginScheduledSubmission = () => void;

export interface ScheduledSubmissionReceipt {
  readonly runId: string;
  // A new session may still be awaiting promotion; an identity failure does not invalidate the receipt.
  readonly sessionIdentity?: Promise<string | undefined>;
}

interface ScheduledSessionCoordinatorOptions {
  readonly store: () => ScheduledSessionStore;
  readonly busy: (task: ScheduledSessionTask) => boolean;
  readonly available?: () => boolean;
  readonly authorize: (
    task: ScheduledSessionTask,
    occurrenceId: string
  ) => Promise<ScheduledRunContext>;
  readonly submit: (
    task: ScheduledSessionTask,
    occurrenceId: string,
    context: ScheduledRunContext,
    begin: BeginScheduledSubmission
  ) => Promise<ScheduledSubmissionReceipt>;
  readonly sessionTitle: (sessionId: string) => string;
  readonly registeredSession?: (sessionId: string, workspaceId: string) => boolean;
  readonly sessionGroup?: (
    task: ScheduledSessionTask
  ) => import('@myagentroam/protocol').SessionGroup;
  readonly emitNotification: (payload: unknown) => void;
  readonly taskChanged?: (workspaceId: string) => void;
  readonly occurrenceChanged?: (workspaceId: string) => void;
  readonly now?: () => number;
}

/** Owns the clock, ordered admission and identity writeback for durable occurrences. */
export class ScheduledSessionCoordinator {
  readonly #now: () => number;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #stopping: Promise<void> | undefined;
  #closed = true;
  #startupAt = 0;
  #wake = false;
  readonly #identityBindings = new Set<Promise<void>>();
  readonly #recovered: { task: ScheduledSessionTask; occurrenceId: string }[] = [];

  constructor(private readonly options: ScheduledSessionCoordinatorOptions) {
    this.#now = options.now ?? Date.now;
  }

  executionTerminated(
    run: Pick<NodeAgentRun, 'source' | 'clientMessageId' | 'id'>,
    status: RunnerExecutionStatus,
    endedAt = this.#now(),
    reason?: string,
    nativeSessionId?: string
  ): void {
    if (run.source !== 'SCHEDULED') return;
    const store = this.options.store();
    const occurrence = store.occurrence(run.clientMessageId);
    if (occurrence === undefined) return;
    const finished = store.finish(
      run.clientMessageId,
      status === 'SUCCEEDED'
        ? 'SUCCEEDED'
        : status === 'INTERRUPTED' || status === 'CANCELLED'
          ? 'CANCELLED'
          : 'FAILED',
      status === 'SUCCEEDED' ? undefined : (reason ?? `SCHEDULE_RUN_${status}`),
      run.id,
      endedAt
    );
    if (!finished) return;
    if (nativeSessionId !== undefined)
      store.bindExecutionSession(run.clientMessageId, nativeSessionId);
    const task = store.getById(occurrence.task_id);
    if (task !== undefined) {
      this.options.occurrenceChanged?.(task.workspaceId);
      this.publishTaskNotification(
        { ...task, sessionId: nativeSessionId ?? occurrence.execution_session_id },
        run.clientMessageId,
        {
          kind: 'SCHEDULE_TERMINAL',
          outcome: status,
          runId: run.id
        }
      );
    }
  }

  executionStarted(
    run: Pick<NodeAgentRun, 'source' | 'clientMessageId' | 'id' | 'workspaceId'>,
    at: number,
    nativeSessionId: string | null
  ): void {
    if (
      run.source === 'SCHEDULED' &&
      this.options.store().started(run.clientMessageId, run.id, nativeSessionId, at)
    )
      this.options.occurrenceChanged?.(run.workspaceId);
  }
  private readonly notify = (
    task: ScheduledSessionTask,
    occurrenceId: string,
    code: string,
    status: 'SKIPPED' | 'FAILED'
  ): void =>
    this.publishTaskNotification(task, occurrenceId, {
      kind: status === 'FAILED' ? 'SCHEDULE_FAILED' : 'SCHEDULE_SKIPPED',
      code
    });
  private readonly publishTaskNotification = (
    task: ScheduledSessionTask,
    occurrenceId: string,
    event:
      | { readonly kind: 'SCHEDULE_FAILED' | 'SCHEDULE_SKIPPED'; readonly code: string }
      | {
          readonly kind: 'SCHEDULE_TERMINAL';
          readonly outcome: RunnerExecutionStatus;
          readonly runId: string;
        }
      | { readonly kind: 'SCHEDULE_PROPOSAL' }
  ): void => {
    const currentTask = this.options.store().getById(task.id);
    if (
      currentTask === undefined ||
      (event.kind !== 'SCHEDULE_PROPOSAL' && !currentTask.notifyOnTerminal)
    )
      return;
    const occurredAt = Date.now();
    const sessionId = task.sessionId;
    const target =
      sessionId !== null && this.options.registeredSession?.(sessionId, task.workspaceId) !== false
        ? {
            targetType: 'WORKSPACE_SESSION',
            sessionGroup: this.options.sessionGroup?.(task) ?? 'MAIN',
            sessionId,
            sessionTitle: this.options.sessionTitle(sessionId)
          }
        : {
            targetType: 'SCHEDULED_TASK',
            taskId: task.id,
            taskName: currentTask.name,
            reference: {
              kind: event.kind === 'SCHEDULE_PROPOSAL' ? 'proposal' : 'occurrence',
              id: occurrenceId
            }
          };
    const runId = event.kind === 'SCHEDULE_TERMINAL' ? event.runId : occurrenceId;
    this.options.emitNotification({
      event: {
        runId,
        sequence: 1,
        eventType: 'notification',
        payload: {
          ...target,
          userId: currentTask.ownerUserId,
          workspaceId: task.workspaceId,
          runId,
          notificationId:
            event.kind === 'SCHEDULE_TERMINAL'
              ? `schedule-terminal:${task.id}:${occurrenceId}`
              : event.kind === 'SCHEDULE_PROPOSAL'
                ? `schedule-proposal:${task.id}:${occurrenceId}`
                : `schedule:${task.id}:${occurrenceId}`,
          ...event,
          occurredAt
        },
        createdAt: occurredAt
      }
    });
  };
  readonly proposalCreated = (taskId: string, proposalId: string): void => {
    const task = this.options.store().getById(taskId);
    if (task !== undefined)
      this.publishTaskNotification(task, proposalId, { kind: 'SCHEDULE_PROPOSAL' });
  };
  /** Called only at Node startup, before admitting any new scheduled occurrence. */
  recoverInterrupted(): void {
    for (const recovered of this.options.store().recoverInterrupted())
      this.#recovered.push(recovered);
  }

  connected(): void {
    // Startup has no control connection yet. Send these best-effort alerts once it is ready.
    const workspaces = new Set<string>();
    for (const { task, occurrenceId } of this.#recovered.splice(0)) {
      workspaces.add(task.workspaceId);
      this.notify(task, occurrenceId, SCHEDULE_RESTART_OUTCOME_UNKNOWN, 'FAILED');
    }
    for (const workspaceId of workspaces) this.options.occurrenceChanged?.(workspaceId);
    this.changed();
  }

  start(): void {
    if (!this.#closed) return;
    this.#stopping = undefined;
    this.#closed = false;
    this.#startupAt = this.#now();
    this.#tick();
  }

  changed(): void {
    if (this.#closed) return;
    this.#wake = true;
    this.#arm();
  }

  stop(): Promise<void> | undefined {
    if (this.#closed) return this.#stopping;
    this.#closed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#running !== undefined || this.#identityBindings.size > 0) {
      this.#stopping = this.#drain();
      // Freeze does not await the drain; disposal later joins the original result.
      void this.#stopping.catch(() => undefined);
    }
    return this.#stopping;
  }

  async #drain(): Promise<void> {
    try {
      await this.#running;
    } finally {
      // An in-flight receipt may add a binding after the clock has stopped.
      await Promise.all(this.#identityBindings);
    }
  }

  #bindIdentity(
    task: ScheduledSessionTask,
    occurrenceId: string,
    identity: Promise<string | undefined>
  ): void {
    const binding = identity
      .then((sessionId) => {
        if (
          sessionId !== undefined &&
          this.options.store().bindExecutionSession(occurrenceId, sessionId)
        )
          this.options.occurrenceChanged?.(task.workspaceId);
      })
      .catch((error) => {
        nodeLog('schedule.identity.bind.failed', {
          occurrenceId,
          errorCode: safeErrorCode(error, 'SCHEDULE_IDENTITY_BIND_FAILED')
        });
      })
      .finally(() => this.#identityBindings.delete(binding));
    // Track writeback for shutdown, not as part of the next task's admission.
    this.#identityBindings.add(binding);
  }

  #arm(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#running || this.#closed) return;
    const store = this.options.store();
    const next = this.#wake
      ? this.#now()
      : Math.min(store.nextDueAt() ?? Infinity, store.nextWaitingDeadline() ?? Infinity);
    if (next === Infinity) return;
    const delay = Math.max(0, Math.min(next - this.#now(), 2_147_483_647));
    this.#timer = setTimeout(() => this.#tick(), delay);
    this.#timer.unref();
  }

  #tick(): void {
    if (this.#closed || this.#running) return;
    this.#wake = false;
    this.#running = this.#runDue().finally(() => {
      this.#running = undefined;
      this.#arm();
    });
  }

  async #runDue(): Promise<void> {
    const now = this.#now();
    const store = this.options.store();
    const waiting = store.waiting();
    for (const occurrence of waiting) {
      if (this.#closed) return;
      const task = store.getById(occurrence.task_id);
      if (task !== undefined) await this.#admit(task, occurrence.id, occurrence);
    }
    for (const task of store.listDue(now)) {
      if (this.#closed || task.nextRunAt === null) break;
      const occurrenceId = store.claim(task.id, task.nextRunAt, task.revision);
      if (occurrenceId === undefined) continue;
      this.options.taskChanged?.(task.workspaceId);
      const occurrence = store.occurrence(occurrenceId);
      if (occurrence !== undefined) await this.#admit(task, occurrenceId, occurrence);
    }
  }

  async #admit(
    task: ScheduledSessionTask,
    occurrenceId: string,
    occurrence: {
      due_at: number;
      expires_at: number | null;
      revision: number | null;
    }
  ): Promise<void> {
    const store = this.options.store();
    const { expires_at: deadline, due_at: dueAt } = occurrence;
    const mayWait = deadline !== null && deadline > dueAt;
    const availability = () =>
      this.options.busy(task)
        ? 'SCHEDULE_SESSION_BUSY'
        : this.options.available?.() === false
          ? 'SCHEDULE_CONTROL_UNAVAILABLE'
          : undefined;
    const unavailable = (code: string) => {
      if (mayWait && this.#now() < deadline) {
        if (store.waitForAvailability(occurrenceId, code))
          this.options.occurrenceChanged?.(task.workspaceId);
      } else if (store.finish(occurrenceId, 'SKIPPED', code)) {
        this.options.occurrenceChanged?.(task.workspaceId);
        this.notify(task, occurrenceId, code, 'SKIPPED');
      }
    };
    let failureCode: string | undefined;
    let submitting = false;
    let context: ScheduledRunContext | undefined;
    try {
      if (!task.enabled || task.revision !== occurrence.revision)
        failureCode = 'SCHEDULE_TASK_CHANGED';
      else if (deadline === null && dueAt < this.#startupAt)
        failureCode = 'SCHEDULE_NODE_RESTARTED';
      else if (
        deadline !== null &&
        (mayWait
          ? this.#now() >= deadline
          : dueAt < this.#startupAt || this.#now() >= dueAt + 60_000)
      )
        failureCode = 'SCHEDULE_EXPIRED';
      if (failureCode === undefined) {
        const before = availability();
        if (before !== undefined) return unavailable(before);
        context = await this.options.authorize(task, occurrenceId);
        const checkAdmission = () => {
          const currentTask = store.getById(task.id);
          if (this.#closed) throw new Error('SCHEDULE_NODE_STOPPED');
          if (currentTask?.revision !== task.revision || currentTask.enabled !== true)
            throw new Error('SCHEDULE_TASK_CHANGED');
          if (deadline !== null && this.#now() >= (mayWait ? deadline : dueAt + 60_000))
            throw new Error('SCHEDULE_EXPIRED');
          const after = availability();
          if (after !== undefined) throw new Error(after);
        };
        checkAdmission();
        // Session admission invokes this synchronously before accepting the input.
        const submitted = await this.options.submit(task, occurrenceId, context, () => {
          checkAdmission();
          if (!store.beginSubmission(occurrenceId, task.sessionId))
            throw new Error('SCHEDULE_TASK_CHANGED');
          submitting = true;
          this.options.occurrenceChanged?.(task.workspaceId);
        });
        const finished = store.finish(occurrenceId, 'SUBMITTED', undefined, submitted.runId);
        if (submitted.sessionIdentity !== undefined)
          this.#bindIdentity(task, occurrenceId, submitted.sessionIdentity);
        if (finished) this.options.occurrenceChanged?.(task.workspaceId);
      }
    } catch (error) {
      if (submitting) {
        // A persisted Run already owns completion, even if returning its receipt failed.
        const recorded = store.occurrence(occurrenceId);
        if (recorded?.run_id != null) {
          if (
            recorded.status === 'SUBMITTING' &&
            store.finish(occurrenceId, 'SUBMITTED', undefined, recorded.run_id)
          )
            this.options.occurrenceChanged?.(task.workspaceId);
          return;
        }
      }
      failureCode = submitting
        ? SCHEDULE_SUBMISSION_OUTCOME_UNKNOWN
        : error instanceof Error && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.message)
          ? error.message
          : 'SCHEDULE_EXECUTION_FAILED';
      if (
        !submitting &&
        [
          'SCHEDULE_SERVER_UNAVAILABLE',
          'SCHEDULE_CONTROL_UNAVAILABLE',
          'SCHEDULE_SESSION_BUSY'
        ].includes(failureCode)
      )
        return unavailable(failureCode);
    } finally {
      if (!submitting) context?.release?.();
    }
    if (failureCode !== undefined) {
      const status = submitting ? 'FAILED' : 'SKIPPED';
      if (store.finish(occurrenceId, status, failureCode)) {
        this.options.occurrenceChanged?.(task.workspaceId);
        this.notify(task, occurrenceId, failureCode, status);
      }
    }
  }
}
