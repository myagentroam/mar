import { sessionGroup } from '../session/session-presentation-service.js';
import type { RunEvent, WorkbenchEventCategory } from '@myagentroam/protocol';
import { permissionStopSchema, runPerformanceSchema } from '@myagentroam/protocol';
import type { NodeAgentSession } from '../session/contracts.js';
import type { RunnerExecutionStatus } from '../runner/contracts.js';
import { NodeMetrics, nodeLog } from '../operational.js';
import { NodeRuntimeState } from '../runtime-state.js';
import { isPlainRecord } from '../util/records.js';
import { isTerminalRunStatus } from '../session/runtime/type-guards.js';
import type {
  ExecutionTerminalInput,
  ExecutionTerminalResult
} from './continuous-run-coordinator.js';

const COALESCE_MS = 200;
const MAX_BATCH_CHARS = 16_384;

export interface RunEventServiceOptions {
  readonly runtime: NodeRuntimeState;
  readonly metrics: NodeMetrics;
  readonly isBootstrapSession: (sessionId: string) => boolean;
  readonly presentSession: (session: NodeAgentSession) => unknown;
  readonly rejectBootstrap: (sessionId: string, code: string) => void;
  readonly emitWorkbench: (category: WorkbenchEventCategory, payload: unknown) => void;
  readonly cleanupAttachments: (runId: string) => void;
  readonly refreshAttachments?: (sessionId: string) => void;
  readonly expireImages: (runId: string) => void;
  readonly scheduleContextRefresh: (sessionId: string) => void;
  readonly refreshWorkspaceSessions: (workspaceId: string) => Promise<void>;
  readonly dispatchQueue: (sessionId: string, delayMs?: number) => Promise<void>;
  readonly executionStarted?: (executionId: string) => void;
  readonly acceptExecutionTerminal: (input: ExecutionTerminalInput) => ExecutionTerminalResult;
  readonly publishGoalUpdate: (update: NonNullable<ExecutionTerminalResult['goalUpdate']>) => void;
  readonly publishQueueChange: (sessionId: string) => void;
  readonly releaseExecution: (executionId: string) => void;
  readonly onTerminalRun?: (
    run: import('../runtime-model.js').NodeAgentRun,
    status: RunnerExecutionStatus
  ) => void;
}

export class RunEventService {
  private readonly pendingText = new Map<
    string,
    { text: string; readonly itemId?: string; readonly timer: NodeJS.Timeout }
  >();

  constructor(private readonly options: RunEventServiceOptions) {}

  emit(runId: string, eventType: string, payload: unknown, status?: RunnerExecutionStatus): void {
    if (eventType === 'run.performance') {
      const run = this.options.runtime.getRun(runId);
      if (run === undefined || !isPlainRecord(payload)) return;
      const parsed = runPerformanceSchema.safeParse({ ...payload, runId: run.id });
      if (parsed.success && this.options.runtime.updateRunPerformance(runId, parsed.data)) {
        this.flushText(runId);
        this.emitWorkbench('conversation', {
          sessionId: run.sessionId,
          performance: parsed.data
        });
      }
      return;
    }
    if (
      eventType === 'text.delta' &&
      status === undefined &&
      isPlainRecord(payload) &&
      typeof payload.text === 'string'
    ) {
      this.enqueueText(
        runId,
        payload.text,
        typeof payload.itemId === 'string' ? payload.itemId : undefined
      );
      return;
    }
    this.flushText(runId);
    this.emitNow(runId, eventType, payload, status);
  }

  private emitWorkbench(category: WorkbenchEventCategory, payload: unknown): void {
    if (category === 'conversation' && isPlainRecord(payload) && 'turn' in payload) {
      this.options.emitWorkbench(category, { turn: payload.turn });
      return;
    }
    this.options.emitWorkbench(category, payload);
  }

  clear(): void {
    for (const pending of this.pendingText.values()) clearTimeout(pending.timer);
    this.pendingText.clear();
  }

  flushPendingText(runId: string): void {
    this.flushText(runId);
  }

  private enqueueText(runId: string, text: string, itemId?: string): void {
    if (text.length === 0) return;
    const pending = this.pendingText.get(runId);
    if (pending !== undefined && pending.itemId === itemId) {
      pending.text += text;
      if (pending.text.length >= MAX_BATCH_CHARS) this.flushText(runId);
      return;
    }
    if (pending !== undefined) this.flushText(runId);
    const timer = setTimeout(() => this.flushText(runId), COALESCE_MS);
    this.pendingText.set(runId, { text, ...(itemId === undefined ? {} : { itemId }), timer });
  }

  private flushText(runId: string): void {
    const pending = this.pendingText.get(runId);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.pendingText.delete(runId);
    this.emitNow(runId, 'text.delta', {
      text: pending.text,
      ...(pending.itemId === undefined ? {} : { itemId: pending.itemId })
    });
  }

  private emitNow(
    executionId: string,
    eventType: string,
    payload: unknown,
    status?: RunnerExecutionStatus
  ): void {
    const run = this.options.runtime.getRun(executionId);
    if (run === undefined) return;
    const runId = run.id;
    const targetTurn = this.options.runtime.conversationTurnForExecution(executionId);
    const currentTurn = this.options.runtime.conversationTurnForRun(runId);
    const targetsCurrentTurn =
      targetTurn === undefined || currentTurn === undefined || targetTurn.id === currentTurn.id;
    const terminalExecution = status !== undefined && isTerminalRunStatus(status);
    const currentExecutionId = this.options.runtime.currentExecutionId(runId);
    const terminalCurrentExecution =
      terminalExecution &&
      (currentExecutionId === executionId ||
        (currentExecutionId === undefined && executionId === runId));
    const event: RunEvent = {
      runId,
      sequence: this.options.runtime.lastRunSequence(runId) + 1,
      eventType,
      payload
    };
    if (eventType !== 'text.delta') {
      const errorCode =
        (eventType === 'run.failed' || eventType === 'run.rejected') &&
        isPlainRecord(payload) &&
        typeof payload.code === 'string'
          ? payload.code
          : undefined;
      nodeLog('run.event', {
        runId,
        eventType,
        status,
        ...(errorCode === undefined ? {} : { errorCode })
      });
    }
    if (status === 'FAILED') this.options.metrics.runnerFailed();
    let recorded: ReturnType<NodeRuntimeState['appendRunEvent']> = undefined;
    let finalStatus: RunnerExecutionStatus | undefined;
    let manuallyInterrupted = false;
    if (terminalExecution) {
      const parsedStop = isPlainRecord(payload)
        ? permissionStopSchema.safeParse(payload.permissionStop)
        : undefined;
      const result = this.options.acceptExecutionTerminal({
        executionId,
        sequence: event.sequence,
        eventType,
        payload,
        status: status as RunnerExecutionStatus,
        ...(parsedStop?.success ? { permissionStop: parsedStop.data } : {})
      });
      recorded = result.recorded;
      if (recorded === undefined) return;
      finalStatus = result.finalStatus;
      manuallyInterrupted = result.manuallyInterrupted;
      if (result.queueChangedSessionId !== undefined)
        this.options.publishQueueChange(result.queueChangedSessionId);
      if (result.goalUpdate !== undefined) this.options.publishGoalUpdate(result.goalUpdate);
    } else {
      try {
        recorded = this.options.runtime.appendRunEvent({
          runId: executionId,
          sequence: event.sequence,
          eventType,
          payload,
          ...(status === undefined ? {} : { status })
        });
      } catch {
        /* A stale Runner callback may race process-local Run cleanup. */
      }
    }
    if (eventType === 'run.started' || eventType === 'run.running')
      this.options.executionStarted?.(executionId);
    if (!terminalExecution) this.options.refreshAttachments?.(run.sessionId);
    const publicStatus = terminalExecution ? finalStatus : status;
    const notificationPayload = this.notificationPayload(
      runId,
      eventType,
      payload,
      publicStatus,
      manuallyInterrupted || !targetsCurrentTurn
    );
    if (publicStatus !== undefined) {
      const currentRun = this.options.runtime.getRun(runId);
      this.emitWorkbench('run', { run: currentRun });
      const session =
        currentRun === undefined
          ? undefined
          : this.options.runtime.getAgentSession(currentRun.sessionId);
      if (session !== undefined)
        this.emitWorkbench('session', { session: this.options.presentSession(session) });
    }
    const createdTurn =
      targetsCurrentTurn && targetTurn === undefined && currentTurn === undefined
        ? this.options.runtime.conversationTurnForRun(runId)
        : undefined;
    const projectedTurn =
      this.options.runtime.conversationTurnForExecution(executionId) ??
      this.options.runtime.conversationTurnForRun(runId);
    const previousGroups = new Map(targetTurn?.items.map((item) => [item.id, item.processGroup]));
    const correctedGroups =
      projectedTurn !== undefined &&
      projectedTurn.items.some(
        (item) =>
          previousGroups.has(item.id) &&
          (previousGroups.get(item.id)?.id !== item.processGroup?.id ||
            previousGroups.get(item.id)?.isStart !== item.processGroup?.isStart)
      );
    if (targetsCurrentTurn)
      this.emitWorkbench(
        'conversation',
        createdTurn === undefined && !correctedGroups
          ? {
              event: {
                ...event,
                ...(publicStatus === undefined ? {} : { status: publicStatus }),
                createdAt: recorded?.createdAt ?? Date.now()
              }
            }
          : { turn: createdTurn ?? projectedTurn }
      );
    else {
      const projectedTurn = this.options.runtime.conversationTurnForExecution(executionId);
      if (projectedTurn !== undefined) this.emitWorkbench('conversation', { turn: projectedTurn });
    }
    const occurredAt = recorded?.createdAt ?? Date.now();
    const terminalNotification =
      notificationPayload !== undefined && terminalCurrentExecution && finalStatus !== undefined;
    if (notificationPayload !== undefined && !terminalNotification) {
      this.emitNotification(runId, event, notificationPayload, occurredAt);
    }
    if (!terminalExecution) return;
    // A completed reply has already been delivered through its own stream event. Only a
    // continuing Run, an exceptional termination, or a pending item needs a final Turn update.
    if (
      targetsCurrentTurn &&
      createdTurn === undefined &&
      (finalStatus !== 'SUCCEEDED' ||
        targetTurn?.items.some(
          (item) => item.status === 'PENDING' || item.status === 'IN_PROGRESS'
        ))
    ) {
      const turn = this.options.runtime.conversationTurnForRun(runId);
      if (turn !== undefined) this.emitWorkbench('conversation', { turn });
    }
    this.options.cleanupAttachments(executionId);
    this.options.expireImages(executionId);
    this.options.releaseExecution(executionId);
    if (!terminalCurrentExecution) return;
    if (finalStatus === undefined) {
      void this.options.dispatchQueue(run.sessionId, status === 'FAILED' ? 15_000 : 0);
      return;
    }
    if (this.options.isBootstrapSession(run.sessionId)) {
      this.options.rejectBootstrap(run.sessionId, 'SESSION_START_FAILED');
      return;
    }
    this.options.scheduleContextRefresh(run.sessionId);
    this.options.onTerminalRun?.(run, finalStatus);
    const idleSnapshot = this.options.refreshWorkspaceSessions(run.workspaceId);
    this.options.runtime.removeTerminalRun(runId);
    this.options.refreshAttachments?.(run.sessionId);
    if (terminalNotification)
      void idleSnapshot
        .catch(() => undefined)
        .then(() => this.emitNotification(runId, event, notificationPayload!, occurredAt));
  }

  private emitNotification(
    runId: string,
    event: RunEvent,
    payload: Record<string, unknown>,
    occurredAt: number
  ): void {
    nodeLog('run.event', { runId, eventType: 'notification' });
    this.emitWorkbench('conversation', {
      event: {
        runId,
        sequence: event.sequence,
        eventType: 'notification',
        payload: { ...payload, occurredAt },
        createdAt: occurredAt
      }
    });
  }

  private notificationPayload(
    runId: string,
    eventType: string,
    payload: unknown,
    status?: RunnerExecutionStatus,
    suppressTerminal = false
  ): Record<string, unknown> | undefined {
    if (eventType === 'notification') return undefined;
    const run = this.options.runtime.getRun(runId);
    if (run === undefined) return undefined;
    if (run.suppressNotifications === true) return undefined;
    if (run.source === 'SCHEDULED' && eventType === 'approval.request') return undefined;
    const session = this.options.runtime.getAgentSession(run.sessionId);
    if (session === undefined) return undefined;
    const base = {
      targetType: 'WORKSPACE_SESSION',
      userId: run.initiatedByUserId,
      workspaceId: run.workspaceId,
      sessionId: run.sessionId,
      sessionTitle: session.customTitle ?? session.runnerTitle ?? session.id,
      sessionGroup: sessionGroup(session),
      runId
    };
    if (!Number.isSafeInteger(base.userId)) return undefined;
    if (status !== undefined && isTerminalRunStatus(status)) {
      if (run.source === 'SCHEDULED') return undefined;
      if (suppressTerminal) return undefined;
      return {
        ...base,
        notificationId: `run:${run.workspaceId}:${runId}`,
        kind: 'RUN_TERMINAL',
        outcome: status
      };
    }
    if (eventType === 'approval.request' && isPlainRecord(payload)) {
      const approvalId = payload.approvalId;
      if (typeof approvalId !== 'string') return undefined;
      return {
        ...base,
        notificationId: `approval:${run.workspaceId}:${runId}:${approvalId}`,
        kind: 'APPROVAL_REQUIRED'
      };
    }
    if (eventType !== 'conversation.item' || !isPlainRecord(payload)) return undefined;
    if (payload.kind === 'plan' && typeof payload.itemId === 'string')
      return {
        ...base,
        notificationId: `plan:${run.workspaceId}:${runId}:${payload.itemId}`,
        kind: 'PLAN_READY'
      };
    if (
      payload.kind === 'user_input_request' &&
      typeof payload.itemId === 'string' &&
      isPlainRecord(payload.payload) &&
      Array.isArray(payload.payload.questions) &&
      payload.payload.questions.length > 0
    )
      return {
        ...base,
        notificationId: `user-input:${run.workspaceId}:${runId}:${payload.itemId}`,
        kind: 'USER_INPUT_REQUIRED'
      };
    return undefined;
  }
}
