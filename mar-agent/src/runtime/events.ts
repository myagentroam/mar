import type { AgentReasoningEffort } from '../model/configuration.js';
import type { CodeCellEventData, AgentToolArtifact } from '../tools/contracts.js';
import type { ExecutionMode } from './contracts.js';

export interface AgentEventBase {
  eventId: string;
  sequence: number;
  timestamp: string;
  sessionId: string;
  executionId: string;
  turnId?: string;
}

export interface CompactSnapshotAnchor {
  readonly kind: 'message' | 'tool';
  readonly id: string;
}
export type AgentEvent = AgentEventBase &
  (
    | {
        type: 'input.received';
        entry: import('../session/user-history.js').AgentUserHistoryEntry;
      }
    | {
        type: 'execution.started';
        mode: ExecutionMode;
        permissionMode?: import('../tools/permission-contract.js').PermissionMode;
      }
    | {
        type: 'message.started';
        itemId: string;
        phase: 'commentary' | 'final_answer';
      }
    | {
        type: 'message.delta';
        itemId: string;
        phase: 'commentary' | 'final_answer';
        delta: string;
      }
    | {
        type: 'message.completed';
        itemId: string;
        phase: 'commentary' | 'final_answer';
        text: string;
        modelId: string;
        modelName: string;
      }
    | {
        type: 'model.performance';
        latencyMs?: number | undefined;
        outputTokens?: number | undefined;
        outputDurationMs?: number | undefined;
        tokensPerSecond?: number | undefined;
      }
    | {
        /** Legacy history event; new executions publish model.performance instead. */
        type: 'message.performance';
        itemId: string;
        ttftMs: number;
        outputTokens?: number | undefined;
        outputDurationMs?: number | undefined;
        tokensPerSecond?: number | undefined;
      }
    | { type: 'plan.completed'; itemId: string; text: string }
    | {
        type: 'reasoning.completed';
        itemId: string;
        representation: 'summary' | 'visible_thinking' | 'unspecified';
        text: string;
      }
    | {
        /** Legacy persisted event; the Catalog exposes standard tool events instead. */
        type: 'hosted_tool.updated';
        itemId: string;
        kind: 'WEB_SEARCH' | 'WEB_FETCH';
        status: 'RUNNING' | 'COMPLETED' | 'FAILED';
        summary: {
          query?: string | undefined;
          url?: string | undefined;
          title?: string | undefined;
          sources?:
            | readonly { url: string; title?: string | undefined; snippet?: string | undefined }[]
            | undefined;
          sourcesTruncated?: boolean | undefined;
        };
      }
    | { type: 'citation.added'; id: string; url: string; title?: string }
    | {
        type: 'tool.started';
        toolName: string;
        callId: string;
        parentCallId?: string;
        input?: unknown;
        data?: import('./public-tool-metadata.js').PublicToolMetadata;
        truncated?: boolean;
      }
    | {
        type: 'tool.output';
        toolName: 'exec' | 'exec_wait' | 'code_exec_wait';
        callId: string;
        parentCallId?: string;
        output: import('../tools/contracts.js').ExecOutputSnapshot;
        outputTruncation?: 'HEAD' | 'SOURCE';
      }
    | {
        type: 'tool.completed';
        resultExtensions?: readonly import('../tools/result-extension-contract.js').ToolResultExtension[];
        toolName: string;
        callId: string;
        parentCallId?: string;
        summary: string;
        truncated?: boolean;
        summaryTruncated?: boolean;
        outputTruncation?: 'HEAD' | 'SOURCE';
        artifacts?: readonly AgentToolArtifact[];
        data?:
          | CodeCellEventData
          | import('../tools/contracts.js').ExecResult
          | Omit<import('../tools/contracts.js').ExecResult, 'stdout' | 'stderr'>
          | import('../tools/contracts.js').ApplyPatchResult
          | import('../tools/contracts.js').ReadEventData
          | import('../tools/contracts.js').ViewImageResult
          | import('../tools/contracts.js').SleepResult
          | Readonly<Record<string, unknown>>
          | import('./public-tool-metadata.js').PublicToolMetadata;
      }
    | {
        type: 'tool.failed';
        resultExtensions?: readonly import('../tools/result-extension-contract.js').ToolResultExtension[];
        data?: CodeCellEventData | import('../tools/contracts.js').ApplyPatchPartialResult;
        toolName: string;
        callId: string;
        parentCallId?: string;
        code: string;
        message?: string;
        permissionStop?: import('../tools/permission-contract.js').PermissionStop;
        truncated?: boolean;
        outputTruncation?: 'HEAD' | 'SOURCE';
      }
    | {
        type: 'sleep.started';
        callId: string;
        durationMs: number;
        startedAt: string;
      }
    | {
        type: 'usage.updated';
        purpose?: 'compact';
        inputTokens?: number | undefined;
        contextInputTokens?: number | undefined;
        outputTokens?: number | undefined;
        cacheReadTokens?: number | undefined;
        cacheWriteTokens?: number | undefined;
      }
    | {
        type: 'todo.updated';
        revision: number;
        items: readonly import('../tools/contracts.js').TodoItem[];
      }
    | { type: 'user_input.requested'; requestId: string; questions: unknown[] }
    | { type: 'user_input.resolved'; requestId: string }
    | {
        type: 'subagent.started';
        agentId: string;
        description: string;
        modelId?: string;
        modelName?: string;
        reasoningEffort?: AgentReasoningEffort;
      }
    | {
        type: 'subagent.completed';
        permissionStop?: import('../tools/permission-contract.js').PermissionStop;
        agentId: string;
        description?: string;
        status: string;
        modelId?: string;
        modelName?: string;
        reasoningEffort?: AgentReasoningEffort;
        /** Historical event fields retained for reading existing session records. */
        latestMessage?: unknown;
        latestActivity?: unknown;
        errorCode?: string;
        errorMessage?: string;
      }
    | {
        type: 'execution.completed';
        permissionStop?: import('../tools/permission-contract.js').PermissionStop;
      }
    | { type: 'execution.failed'; code: string; message?: string }
    | { type: 'execution.cancelled' }
    | {
        type: 'context.compacting';
        compactionId: string;
        async?: boolean;
        stage?: 'GENERATING' | 'READY' | 'WAITING';
        anchorRecordId?: string;
        anchor?: CompactSnapshotAnchor;
      }
    | {
        type: 'context.compacted';
        compactionId: string;
        async?: boolean;
        retainedContext?: boolean;
        anchorRecordId?: string;
        anchor?: CompactSnapshotAnchor;
      }
    | {
        type: 'context.compact_failed';
        compactionId: string;
        code: string;
        async?: boolean;
        cancelled?: boolean;
        anchorRecordId?: string;
        anchor?: CompactSnapshotAnchor;
      }
  );

export type EventPayload<T = AgentEvent> = T extends AgentEvent
  ? Omit<T, 'eventId' | 'sequence' | 'timestamp' | 'sessionId' | 'executionId' | 'turnId'>
  : never;
