import type { ResourcePublisher, ResourceStore } from '../runtime/resource-publication.js';
import type { ExecutionMode } from '../runtime/contracts.js';
import type { AgentSkill } from '../runtime/context/instructions.js';
import type { TodoStore } from './agent/todo.js';
import type {
  McpToolCallContext,
  ToolCall,
  ToolExecutionContext,
  ToolExecutionResult
} from './contracts.js';

export interface ToolHost extends ResourcePublisher {
  executeTool(call: ToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult>;
  requestUserInput?(
    input: { requestId: string; questions: unknown[] },
    signal: AbortSignal
  ): Promise<Record<string, unknown>>;
  callMcpTool?(
    call: ToolCall,
    signal: AbortSignal,
    context?: McpToolCallContext
  ): Promise<ToolExecutionResult>;
}

export interface ToolImageStore extends ResourceStore {
  readResource(
    sessionId: string,
    resourceId: string
  ): Promise<{ mimeType: string; dataBase64: string } | undefined>;
}

export type ToolRuntimeEvent =
  | {
      type: 'tool.updated';
      toolName: string;
      callId: string;
      parentCallId?: string;
      data: Readonly<Record<string, unknown>>;
    }
  | {
      type: 'tool.output';
      toolName: 'exec' | 'exec_wait' | 'code_exec_wait';
      callId: string;
      parentCallId?: string;
      output: import('./contracts.js').ExecOutputSnapshot;
    }
  | { type: 'sleep.started'; callId: string; durationMs: number; startedAt: string }
  | { type: 'todo.updated'; revision: number; items: readonly import('./agent/todo.js').TodoItem[] }
  | { type: 'user_input.requested'; requestId: string; questions: unknown[] }
  | { type: 'user_input.resolved'; requestId: string };

export interface ToolRuntimeImage {
  readonly mimeType: string;
  readonly data: Buffer;
}

export interface ToolRuntimeContext {
  host: ToolHost;
  imageStore?: ToolImageStore;
  todo: TodoStore;
  requestSmartCompact?: () => void;
  mode: ExecutionMode;
  sessionId: string;
  executionId: string;
  modelId?: string;
  signal: AbortSignal;
  waitInterrupt?: import('./wait.js').ToolWaitInterrupt | undefined;
  contextUpdates?: import('./wait.js').ToolWaitInterrupt;
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
