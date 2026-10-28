import type { NodeAgentRun } from '../runtime-model.js';
import type { RunnerExecutionStatus } from '../runner/contracts.js';
import type { RunnerImageAttachment } from '../service/run-attachment-service.js';
import type { NodeModelUsageService } from '../service/model-usage-service.js';
import type { GoalContinuationCoordinator } from '../service/goal-continuation-coordinator.js';
import type { ContinuousRunCoordinator } from '../service/continuous-run-coordinator.js';
import type { ScheduledSessionCoordinator } from '../service/scheduled-session-coordinator.js';
import type { GoalMcpBridge } from '../service/goal-mcp-bridge.js';
import type { ScheduleMcpBridge } from '../service/schedule-mcp-bridge.js';
import type { NotificationMcpBridge } from '../service/notification-mcp-bridge.js';
import type { NodeRunEventBridge } from '../service/node-run-event-bridge.js';
import type { NodeUpgradeCoordinator } from '../service/node-upgrade-coordinator.js';

/** Coordinates the execution-specific cross-domain terminal and release sequence. */
export class ExecutionLifecycle {
  constructor(
    private readonly databaseAvailable: () => boolean,
    private readonly scheduled: ScheduledSessionCoordinator,
    private readonly continuous: ContinuousRunCoordinator<RunnerImageAttachment>,
    private readonly goal: GoalContinuationCoordinator,
    private readonly usage: NodeModelUsageService,
    private readonly goalMcp: GoalMcpBridge,
    private readonly scheduleMcp: ScheduleMcpBridge,
    private readonly notificationMcp: NotificationMcpBridge,
    private readonly events: NodeRunEventBridge,
    private readonly upgrade: NodeUpgradeCoordinator
  ) {}

  terminal(run: NodeAgentRun, status: RunnerExecutionStatus): void {
    if (this.databaseAvailable()) this.scheduled.executionTerminated(run, status);
    this.continuous.runTerminated(run.sessionId);
  }

  revokeMcps(executionId: string): void {
    this.goalMcp.revoke(executionId);
    this.scheduleMcp.revoke(executionId);
    this.notificationMcp.revoke(executionId);
  }

  release(executionId: string): void {
    this.usage.release(executionId);
    this.goal.releaseExecution(executionId);
    this.revokeMcps(executionId);
    this.continuous.remove(executionId);
  }

  emitItem(runId: string, item: unknown): void {
    this.goal.executionProgress(runId, item);
    this.events.emitConversationItem(runId, item);
  }

  async dispatchQueue(sessionId: string, delayMs = 0): Promise<void> {
    if (this.upgrade.pending()) return;
    if (delayMs > 0) {
      this.continuous.schedule(sessionId, delayMs);
      return;
    }
    await this.continuous.dispatch(sessionId);
  }
}
