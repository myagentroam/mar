import type { NodeEnvelope, WorkbenchEventCategory } from '@myagentroam/protocol';
import type { FakeRunnerStatus } from '../fake-runner.js';
import type { NodeRuntimeState } from '../runtime-state.js';
import type { RunDomainState } from './run-domain-state.js';
import type { RunEventService } from './run-event-service.js';
import type { WorkspaceQueueWorkbenchService } from './workspace-queue-workbench-service.js';
interface NodeRunEventBridgeOptions {
  readonly modelUsage?: (runId: string, payload: unknown) => void;
  readonly bindModelUsage?: (runId: string) => void;
  readonly runtime: NodeRuntimeState;
  readonly state: RunDomainState;
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

  emitRun(runId: string, eventType: string, payload: unknown, status?: FakeRunnerStatus): void {
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

  reconcile(envelope: NodeEnvelope): void {
    const payload = envelope.payload as { runIds?: unknown };
    if (!Array.isArray(payload.runIds) || payload.runIds.some((id) => typeof id !== 'string')) {
      this.options.send('error', { code: 'MESSAGE_INVALID' }, envelope.id);
      return;
    }
    for (const runId of payload.runIds) {
      const known = this.options.state.active.has(runId);
      this.options.runtime.reconcileRun(runId, known);
      this.options.send('lease.reconcile', { runId, known });
    }
    this.options.send('ack', { type: 'runs.reconcile' }, envelope.id);
  }
}
