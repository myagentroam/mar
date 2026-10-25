import type { MarAgentHost } from '../host/contracts.js';
import type { ExecutionMode } from '../runtime/contracts.js';
import type { AgentSkill } from '../runtime/context/instructions.js';
import type { SubagentController, SubagentLatestMessage } from '../subagent/scheduler.js';
import type { TodoStore } from './agent/todo.js';

export type ToolRuntimeEvent =
  | { type: 'sleep.started'; callId: string; durationMs: number; startedAt: string }
  | { type: 'todo.updated'; revision: number; items: readonly import('./agent/todo.js').TodoItem[] }
  | { type: 'user_input.requested'; requestId: string; questions: unknown[] }
  | { type: 'user_input.resolved'; requestId: string }
  | {
      type: 'subagent.started';
      agentId: string;
      description: string;
      modelId?: string;
      modelName?: string;
      reasoningEffort?: import('../model/configuration.js').MarAgentReasoningEffort;
    }
  | {
      type: 'subagent.completed';
      agentId: string;
      description: string;
      status: string;
      modelId?: string;
      modelName?: string;
      reasoningEffort?: import('../model/configuration.js').MarAgentReasoningEffort;
      latestMessage?: SubagentLatestMessage;
      errorCode?: string;
      errorMessage?: string;
    };

export interface ToolRuntimeImage {
  readonly mimeType: string;
  readonly data: Buffer;
}

export interface ToolRuntimeContext {
  host: MarAgentHost;
  imageStore?: import('../session/store/contracts.js').SessionStore;
  todo: TodoStore;
  requestSmartCompact?: () => void;
  subagents?: SubagentController;
  mode: ExecutionMode;
  sessionId: string;
  executionId: string;
  modelId?: string;
  signal: AbortSignal;
  waitInterrupt?: import('./wait.js').ToolWaitInterrupt | undefined;
  subagentMessages?: import('./wait.js').ToolWaitInterrupt;
  permissionPolicy?: import('./permissions.js').ExecutionToolPermissions;
  parentCallId?: string;
  writeToolResultResource?: import('./result-extensions.js').ToolResultResourceWriter;
  codeMode?: import('./contracts.js').ToolExecutionContext['codeMode'];
  skills: ReadonlyMap<string, AgentSkill>;
  recentImages?: readonly ToolRuntimeImage[];
  searchMcpTools?: (
    input: unknown,
    signal: AbortSignal
  ) => Promise<import('./contracts.js').ToolExecutionResult>;
  expectedMcpTool?: import('./contracts.js').McpToolCallContext['expectedTool'];
  invokeTool?: (
    call: import('./contracts.js').ToolCall,
    context: ToolRuntimeContext,
    caller: import('./contracts.js').ToolCaller
  ) => Promise<import('./contracts.js').ToolExecutionResult>;
  emit(event: ToolRuntimeEvent): Promise<void>;
}
