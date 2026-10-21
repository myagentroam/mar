import type { NodeAgentRun } from '../runtime-model.js';
import type { FakeRunnerStatus } from '../fake-runner.js';
import type { ScheduledSessionTask } from './scheduled-session-store.js';
import {
  ScheduledSessionStore,
  SCHEDULE_RESTART_OUTCOME_UNKNOWN
} from './scheduled-session-store.js';

export interface ScheduledRunContext {
  readonly usageGrant?: import('@myagentroam/protocol').ModelUsageGrant | undefined;
  readonly secretEnvironment: Readonly<Record<string, string>>;
  readonly personalInstructions?: unknown;
  readonly marAgentModel?: unknown;
  readonly marAgentModels?: unknown;
  readonly marAgentCompact?: unknown;
  readonly marAgentRuntimeScopeId?: unknown;
}

interface ScheduledSessionCoordinatorOptions {
  readonly store: () => ScheduledSessionStore;
  readonly busy: (task: ScheduledSessionTask) => boolean;
  readonly authorize: (
    task: ScheduledSessionTask,
    occurrenceId: string
  ) => Promise<ScheduledRunContext>;
  readonly submit: (
    task: ScheduledSessionTask,
    occurrenceId: string,
    context: ScheduledRunContext
  ) => Promise<{ readonly runId: string }>;
  readonly sessionTitle: (sessionId: string) => string;
  readonly emitNotification: (payload: unknown) => void;
  readonly now?: () => number;
}

export class ScheduledSessionCoordinator {
  readonly #now: () => number;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #closed = true;
  readonly #recovered: { task: ScheduledSessionTask; occurrenceId: string }[] = [];

  constructor(private readonly options: ScheduledSessionCoordinatorOptions) {
    this.#now = options.now ?? Date.now;
  }

  executionTerminated(
    run: Pick<NodeAgentRun, 'source' | 'clientMessageId' | 'id'>,
    status: FakeRunnerStatus
  ): void {
    if (run.source !== 'SCHEDULED') return;
    const store = this.options.store();
    store.finish(
      run.clientMessageId,
      status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED',
      status === 'SUCCEEDED' ? undefined : `SCHEDULE_RUN_${status}`,
      run.id
    );
    const task = store.getById(run.clientMessageId.split(':', 1)[0]!);
    if (task !== undefined) {
      if (task.notifyOnTerminal)
        this.publishTaskNotification(task, run.clientMessageId, {
          kind: 'SCHEDULE_TERMINAL',
          outcome: status,
          runId: run.id
        });
      else if (status !== 'SUCCEEDED')
        this.notify(task, run.clientMessageId, `SCHEDULE_RUN_${status}`, 'FAILED');
    }
  }
  private readonly notify = (
    task: {
      readonly id: string;
      readonly ownerUserId: number;
      readonly workspaceId: string;
      readonly sessionId: string;
    },
    occurrenceId: string,
    code: string,
    status: 'SKIPPED' | 'FAILED'
  ): void =>
    this.publishTaskNotification(task, occurrenceId, {
      kind: status === 'FAILED' ? 'SCHEDULE_FAILED' : 'SCHEDULE_SKIPPED',
      code
    });
  private readonly publishTaskNotification = (
    task: {
      readonly id: string;
      readonly ownerUserId: number;
      readonly workspaceId: string;
      readonly sessionId: string;
    },
    occurrenceId: string,
    event:
      | { readonly kind: 'SCHEDULE_FAILED' | 'SCHEDULE_SKIPPED'; readonly code: string }
      | {
          readonly kind: 'SCHEDULE_TERMINAL';
          readonly outcome: FakeRunnerStatus;
          readonly runId: string;
        }
  ): void => {
    const occurredAt = Date.now();
    const recipient = this.options.store().getById(task.id)?.ownerUserId ?? task.ownerUserId;
    this.options.emitNotification({
      event: {
        runId: event.kind === 'SCHEDULE_TERMINAL' ? event.runId : occurrenceId,
        sequence: 1,
        eventType: 'notification',
        payload: {
          targetType: 'WORKSPACE_SESSION',
          userId: recipient,
          workspaceId: task.workspaceId,
          sessionId: task.sessionId,
          sessionTitle: this.options.sessionTitle(task.sessionId),
          runId: event.kind === 'SCHEDULE_TERMINAL' ? event.runId : occurrenceId,
          notificationId:
            event.kind === 'SCHEDULE_TERMINAL'
              ? `schedule-terminal:${task.id}:${occurrenceId}`
              : `schedule:${task.id}:${occurrenceId}`,
          ...event,
          occurredAt
        },
        createdAt: occurredAt
      }
    });
  };
  readonly proposalCreated = (sessionId: string, proposalId: string): void => {
    const task = this.options.store().get(sessionId);
    if (task === undefined) return;
    const occurredAt = Date.now();
    this.options.emitNotification({
      event: {
        runId: proposalId,
        sequence: 1,
        eventType: 'notification',
        payload: {
          targetType: 'WORKSPACE_SESSION',
          userId: task.ownerUserId,
          workspaceId: task.workspaceId,
          sessionId,
          sessionTitle: this.options.sessionTitle(sessionId),
          runId: proposalId,
          notificationId: `schedule-proposal:${task.id}:${proposalId}`,
          kind: 'SCHEDULE_PROPOSAL',
          occurredAt
        },
        createdAt: occurredAt
      }
    });
  };
  /** Called only at Node startup, before admitting any new scheduled occurrence. */
  recoverInterrupted(): void {
    for (const recovered of this.options.store().recoverInterrupted())
      this.#recovered.push(recovered);
  }

  connected(): void {
    // Startup has no control connection yet. Send these best-effort alerts once it is ready.
    for (const { task, occurrenceId } of this.#recovered.splice(0)) {
      this.notify(task, occurrenceId, SCHEDULE_RESTART_OUTCOME_UNKNOWN, 'FAILED');
    }
  }

  start(): void {
    if (!this.#closed) return;
    this.#closed = false;
    void this.#tick(true);
  }

  changed(): void {
    if (!this.#closed) this.#arm();
  }

  stop(): Promise<void> | undefined {
    this.#closed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    return this.#running;
  }

  #arm(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#running || this.#closed) return;
    const next = this.options.store().nextDueAt();
    if (next === null) return;
    const delay = Math.max(0, Math.min(next - this.#now(), 2_147_483_647));
    this.#timer = setTimeout(() => void this.#tick(false), delay);
    this.#timer.unref();
  }

  #tick(initial: boolean): void {
    if (this.#closed || this.#running) return;
    this.#running = this.#runDue(initial).finally(() => {
      this.#running = undefined;
      this.#arm();
    });
  }

  async #runDue(initial: boolean): Promise<void> {
    const now = this.#now();
    for (const task of this.options.store().listDue(now)) {
      if (this.#closed || task.nextRunAt === null) break;
      const occurrenceId = this.options
        .store()
        .claim(task.sessionId, task.nextRunAt, task.revision);
      if (occurrenceId === undefined) continue;
      let failureCode: string | undefined;
      let submitting = false;
      try {
        if (initial && task.nextRunAt < now) failureCode = 'SCHEDULE_NODE_RESTARTED';
        else if (this.options.busy(task)) failureCode = 'SCHEDULE_SESSION_BUSY';
        if (failureCode === undefined) {
          const context = await this.options.authorize(task, occurrenceId);
          const currentTask = this.options.store().get(task.sessionId);
          if (this.#closed) failureCode = 'SCHEDULE_NODE_STOPPED';
          else if (currentTask?.revision !== task.revision || currentTask.enabled !== true)
            failureCode = 'SCHEDULE_TASK_CHANGED';
          else if (this.options.busy(task)) failureCode = 'SCHEDULE_SESSION_BUSY';
          else {
            submitting = true;
            const submitted = await this.options.submit(task, occurrenceId, context);
            this.options.store().finish(occurrenceId, 'SUBMITTED', undefined, submitted.runId);
          }
        }
      } catch (error) {
        failureCode =
          error instanceof Error && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.message)
            ? error.message
            : 'SCHEDULE_EXECUTION_FAILED';
      }
      if (failureCode !== undefined) {
        const status = submitting && failureCode !== 'SCHEDULE_SESSION_BUSY' ? 'FAILED' : 'SKIPPED';
        this.options.store().finish(occurrenceId, status, failureCode);
        this.notify(task, occurrenceId, failureCode, status);
      }
    }
  }
}
