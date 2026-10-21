import type { RunEvent, WorkbenchEventCategory } from '@myagentroam/protocol';
import {
  permissionStopSchema,
  runPerformanceSchema,
  type PermissionStop
} from '@myagentroam/protocol';
import type { NodeAgentSession } from '../database.js';
import type { FakeRunnerStatus } from '../fake-runner.js';
import { NodeMetrics, nodeLog } from '../operational.js';
import { NodeRuntimeState } from '../runtime-state.js';
import { isPlainRecord, isTerminalRunStatus } from '../util/node-operation-parsers.js';
import { RunDomainState } from './run-domain-state.js';

const COALESCE_MS = 200;
const MAX_BATCH_CHARS = 16_384;

export interface RunEventServiceOptions {
  readonly runtime: NodeRuntimeState;
  readonly metrics: NodeMetrics;
  readonly state: RunDomainState;
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
  readonly executionTerminating?: (
    executionId: string,
    status: FakeRunnerStatus,
    permissionStop?: PermissionStop
  ) => void;
  readonly keepRunActive?: (sessionId: string) => boolean;
  readonly releaseExecution: (executionId: string) => void;
  readonly onTerminalRun?: (
    run: import('../runtime-model.js').NodeAgentRun,
    status: FakeRunnerStatus
  ) => void;
}

export class RunEventService {
  private readonly pendingText = new Map<
    string,
    { text: string; readonly itemId?: string; readonly timer: NodeJS.Timeout }
  >();

  constructor(private readonly options: RunEventServiceOptions) {}

  emit(runId: string, eventType: string, payload: unknown, status?: FakeRunnerStatus): void {
    if (eventType === 'run.performance') {
      const run = this.options.runtime.getRun(runId);
      if (run === undefined || !isPlainRecord(payload)) return;
      const parsed = runPerformanceSchema.safeParse({ ...payload, runId: run.id });
      if (parsed.success && this.options.runtime.updateRunPerformance(runId, parsed.data)) {
        this.flushText(runId);
        this.options.emitWorkbench('conversation', {
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
    status?: FakeRunnerStatus
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
    if (eventType === 'run.started' || eventType === 'run.running')
      this.options.executionStarted?.(executionId);
    if (!terminalExecution) this.options.refreshAttachments?.(run.sessionId);
    let finalStatus: FakeRunnerStatus | undefined;
    let manuallyInterrupted = false;
    if (terminalCurrentExecution) {
      const parsedStop = isPlainRecord(payload)
        ? permissionStopSchema.safeParse(payload.permissionStop)
        : undefined;
      const permissionStop = parsedStop?.success ? parsedStop.data : undefined;
      if (permissionStop !== undefined) this.options.runtime.pauseSessionQueue(run.sessionId);
      this.options.executionTerminating?.(executionId, status as FakeRunnerStatus, permissionStop);
      this.options.state.active.delete(executionId);
      const interrupted = this.options.state.interruptRequested.delete(executionId);
      manuallyInterrupted = interrupted;
      const queue = this.options.runtime.sessionQueue(run.sessionId);
      const continues =
        permissionStop === undefined &&
        ((!queue.paused && queue.itemIds.length > 0) ||
          this.options.keepRunActive?.(run.sessionId) === true);
      if (!continues) {
        finalStatus =
          status === 'CANCELLED' || interrupted ? 'INTERRUPTED' : (status as FakeRunnerStatus);
        if (
          finalStatus === 'SUCCEEDED' ||
          finalStatus === 'FAILED' ||
          finalStatus === 'INTERRUPTED'
        )
          this.options.runtime.finishRun(runId, finalStatus);
      }
    }
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
      this.options.emitWorkbench('run', { run: currentRun });
      const session =
        currentRun === undefined
          ? undefined
          : this.options.runtime.getAgentSession(currentRun.sessionId);
      if (session !== undefined)
        this.options.emitWorkbench('session', { session: this.options.presentSession(session) });
    }
    const createdTurn =
      targetsCurrentTurn && targetTurn === undefined && currentTurn === undefined
        ? this.options.runtime.conversationTurnForRun(runId)
        : undefined;
    if (targetsCurrentTurn)
      this.options.emitWorkbench(
        'conversation',
        createdTurn === undefined
          ? {
              event: {
                ...event,
                ...(publicStatus === undefined ? {} : { status: publicStatus }),
                createdAt: recorded?.createdAt ?? Date.now()
              }
            }
          : { turn: createdTurn }
      );
    else {
      const projectedTurn = this.options.runtime.conversationTurnForExecution(executionId);
      if (projectedTurn !== undefined)
        this.options.emitWorkbench('conversation', { turn: projectedTurn });
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
      if (turn !== undefined) this.options.emitWorkbench('conversation', { turn });
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
    this.options.emitWorkbench('conversation', {
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
    status?: FakeRunnerStatus,
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
