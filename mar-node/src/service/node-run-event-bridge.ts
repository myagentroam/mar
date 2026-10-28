import type { WorkbenchEventCategory } from '@myagentroam/protocol';
import type { RunnerExecutionStatus } from '../runner/contracts.js';
import type { RunEventService } from './run-event-service.js';
import type { WorkspaceQueueWorkbenchService } from '../workspace/workspace-queue-workbench-service.js';
interface NodeRunEventBridgeOptions {
  readonly modelUsage?: (runId: string, payload: unknown) => void;
  readonly bindModelUsage?: (runId: string) => void;
  readonly events: RunEventService;
  readonly emitWorkbench: (category: WorkbenchEventCategory, payload: unknown) => void;
  readonly queues: WorkspaceQueueWorkbenchService;
  readonly send: (type: string, payload: unknown, replyTo?: string) => void;
}

/** Bridges process-local Run state to normalized control and Workbench events. */
export class NodeRunEventBridge {
  constructor(private readonly options: NodeRunEventBridgeOptions) {}

  emitConversationItem(runId: string, item: unknown): void {
    this.emitRun(runId, 'conversation.item', item);
  }

  publishApproval(input: {
    readonly runId: string;
    readonly approvalId: string;
    readonly payload: unknown;
    readonly expiresAt: number;
  }): void {
    this.options.send('approval.request', input);
    this.emitRun(input.runId, 'approval.request', input);
  }

  emitRun(
    runId: string,
    eventType: string,
    payload: unknown,
    status?: RunnerExecutionStatus
  ): void {
    if (eventType === 'run.started') this.options.bindModelUsage?.(runId);
    if (eventType === 'run.usage') {
      this.options.modelUsage?.(runId, payload);
      return;
    }
    this.options.events.emit(runId, eventType, payload, status);
  }

  emitQueue(workspaceId: string, sessionId: string): void {
    this.options.emitWorkbench('queue', {
      workspaceId,
      sessionId,
      queue: this.options.queues.present(workspaceId, sessionId)
    });
  }
}
