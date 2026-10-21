import {
  conversationSegmentIdentityForItem,
  conversationSegments
} from './conversation-segment-service.js';
import type { NodeEnvelope, WorkbenchEventCategory } from '@myagentroam/protocol';
import type { FakeRunnerStatus } from '../fake-runner.js';
import type { CodexRunner } from '../runner/codex-runner.js';
import type { ClaudeCodeRunner } from '../runner/claude-code-runner.js';
import type { OpenCodeRunner } from '../runner/opencode-runner.js';
import { runConversationItemId, type NodeRuntimeState } from '../runtime-state.js';
import type { RunDomainState } from './run-domain-state.js';
import type { RunEventService } from './run-event-service.js';
import type { WorkspaceQueueWorkbenchService } from './workspace-queue-workbench-service.js';
import { marctlSessionProgress } from './session-recent-activity.js';
import {
  isNodeAgentRun,
  isNodeConversationTurn,
  isPlainRecord
} from '../runner/codex/conversation-parser.js';

export function workbenchPayloadSessionId(
  runtime: NodeRuntimeState,
  category: WorkbenchEventCategory,
  payload: unknown
): string | undefined {
  if (!isPlainRecord(payload)) return undefined;
  if (category === 'session') {
    if (isPlainRecord(payload.session)) {
      const id = payload.session.id;
      if (typeof id === 'string') return id;
    }
    return typeof payload.sessionId === 'string' ? payload.sessionId : undefined;
  }
  if (category === 'run' && isNodeAgentRun(payload.run)) return payload.run.sessionId;
  if (category === 'conversation') {
    if (isNodeConversationTurn(payload.turn)) return payload.turn.sessionId;
    if (typeof payload.sessionId === 'string') return payload.sessionId;
    if (isPlainRecord(payload.event)) {
      const runId = payload.event.runId;
      return typeof runId === 'string' ? runtime.getRun(runId)?.sessionId : undefined;
    }
  }
  if (category === 'queue') {
    const id = payload.sessionId;
    return typeof id === 'string' ? id : undefined;
  }
  return undefined;
}

interface NodeRunEventBridgeOptions {
  readonly modelUsage?: (runId: string, payload: unknown) => void;
  readonly bindModelUsage?: (runId: string) => void;
  readonly runtime: NodeRuntimeState;
  readonly state: RunDomainState;
  readonly events: RunEventService;
  readonly emitWorkbench: (category: WorkbenchEventCategory, payload: unknown) => void;
  readonly queues: WorkspaceQueueWorkbenchService;
  readonly codex: CodexRunner;
  readonly claude: ClaudeCodeRunner;
  readonly openCode: OpenCodeRunner;
  readonly send: (type: string, payload: unknown, replyTo?: string) => void;
}

/** Bridges process-local Run state to normalized control and Workbench events. */
export class NodeRunEventBridge {
  constructor(private readonly options: NodeRunEventBridgeOptions) {}

  /** The sole public projection boundary for normalized Run callbacks. */
  projectWorkbenchPayload(category: WorkbenchEventCategory, payload: unknown): unknown {
    if (
      category === 'conversation' &&
      isPlainRecord(payload) &&
      isPlainRecord(payload.event) &&
      payload.event.eventType !== 'notification'
    ) {
      const runId = typeof payload.event.runId === 'string' ? payload.event.runId : undefined;
      const sequence =
        typeof payload.event.sequence === 'number' ? payload.event.sequence : undefined;
      const turn =
        runId === undefined ? undefined : this.options.runtime.conversationTurnForRun(runId);
      if (turn === undefined) return;
      const rawPayload = isPlainRecord(payload.event.payload) ? payload.event.payload : undefined;
      const text =
        payload.event.eventType === 'text.delta' && typeof rawPayload?.text === 'string'
          ? rawPayload.text
          : undefined;
      const nativeItemId =
        typeof rawPayload?.itemId === 'string'
          ? rawPayload.itemId
          : typeof rawPayload?.approvalId === 'string'
            ? `approval:${rawPayload.approvalId}`
            : undefined;
      const item =
        text !== undefined && sequence !== undefined
          ? turn.items.find(
              (candidate) =>
                candidate.kind === 'assistant_message' && candidate.revision === sequence
            )
          : nativeItemId === undefined
            ? undefined
            : turn.items.find(
                (candidate) =>
                  candidate.id ===
                  runConversationItemId(
                    runId!,
                    nativeItemId,
                    typeof rawPayload?.kind === 'string' ? rawPayload.kind : undefined
                  )
              );
      if (text !== undefined && item?.kind === 'assistant_message') {
        const segment = conversationSegmentIdentityForItem(turn, item.id, item.kind);
        payload = {
          sessionId: turn.sessionId,
          delta: {
            turnId: turn.id,
            segmentId: segment.id,
            segmentIndex: segment.index,
            runId: turn.runId,
            itemId: item.id,
            text,
            createdAt:
              typeof payload.event.createdAt === 'number' ? payload.event.createdAt : Date.now()
          }
        };
      } else if (item !== undefined) {
        const segment = conversationSegmentIdentityForItem(turn, item.id, item.kind);
        payload = {
          sessionId: turn.sessionId,
          runId: turn.runId,
          ...(['assistant_message', 'tool_call', 'command_execution', 'file_change'].includes(
            item.kind
          ) &&
          (rawPayload?.append === undefined || item.status !== 'IN_PROGRESS')
            ? { progress: marctlSessionProgress(this.options.runtime, turn.sessionId) }
            : {}),
          item: {
            turnId: turn.id,
            itemId: item.id,
            kind: item.kind,
            status: item.status,
            payload: item.payload,
            startedAt: item.startedAt,
            completedAt: item.completedAt,
            segmentId: segment.id,
            segmentIndex: segment.index
          }
        };
      } else {
        if (payload.event.eventType !== 'run.started' && payload.event.eventType !== 'run.running')
          return;
        payload = { turn };
      }
    }
    if (
      category === 'conversation' &&
      isPlainRecord(payload) &&
      isNodeConversationTurn(payload.turn)
    )
      return { ...payload, segments: conversationSegments(payload.turn) };
    if (category === 'run' && isPlainRecord(payload) && isNodeAgentRun(payload.run))
      return {
        ...payload,
        progress: marctlSessionProgress(this.options.runtime, payload.run.sessionId)
      };
    return payload;
  }

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

  migrateRunnerSessionIdentity(sessionId: string, nativeSessionId: string): void {
    for (const [turnId, managed] of this.options.codex.execution.managedTurns) {
      if (managed.sessionId === sessionId)
        this.options.codex.execution.managedTurns.set(turnId, {
          ...managed,
          sessionId: nativeSessionId
        });
    }
    for (const [runId, managed] of this.options.codex.execution.runs) {
      if (managed.sessionId === sessionId)
        this.options.codex.execution.runs.set(runId, { ...managed, sessionId: nativeSessionId });
    }
    for (const [runId, managed] of this.options.claude.execution.runs) {
      if (managed.marSessionId === sessionId)
        this.options.claude.execution.runs.set(runId, {
          ...managed,
          marSessionId: nativeSessionId
        });
    }
    for (const [runId, managed] of this.options.openCode.execution) {
      if (managed.sessionId === sessionId)
        this.options.openCode.execution.set(runId, { ...managed, sessionId: nativeSessionId });
    }
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
