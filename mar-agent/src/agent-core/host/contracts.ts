import type { MarAgentEvent } from '../runtime/events.js';
import type {
  ClientToolDefinition,
  McpToolCallContext,
  McpToolCatalog,
  McpToolCatalogContext,
  ToolCall,
  ToolExecutionContext,
  ToolExecutionResult
} from '../tools/contracts.js';

import { MarAgentError } from '../error.js';
import type { CoreFilesBackend } from '../extensions/files.js';
import type { CoreNetworkBackend } from '../extensions/network.js';
import type { CoreProcessesBackend } from '../extensions/processes.js';
import type { CoreEnvironmentBackend } from '../extensions/environment.js';
import type { CoreOperationContext } from '../extensions/operation.js';
import type { CoreToolRef } from '../extensions/tools.js';

export const MAR_AGENT_HOST_API_VERSION = '1.0';

export type MarAgentHostCapability =
  | 'workspace.read'
  | 'workspace.patch'
  | 'process.manage'
  | 'code.execute'
  | 'user-input.request'
  | 'event.publish'
  | 'session.store'
  | 'mcp.tools'
  | 'image.read';

export interface HostDescription {
  apiVersion: string;
  mode: 'normal' | 'node';
  homeDirectory: string;
  platform: 'linux' | 'darwin' | 'win32';
  architecture?: string;
  shell?: { readonly name: string; readonly path: string };
  guaranteedCommands?: Readonly<Record<string, string>>;
  capabilities: readonly MarAgentHostCapability[];
  limits: { maxProcesses: number; maxOutputBytes: number; maxExecutionMs: number };
}

const requiredCapabilities: readonly MarAgentHostCapability[] = [
  'workspace.read',
  'workspace.patch',
  'process.manage',
  'user-input.request',
  'event.publish',
  'session.store'
];

export function negotiateHost(description: HostDescription): HostDescription {
  const match = /^(\d+)\.(\d+)$/.exec(description.apiVersion);
  const missing = requiredCapabilities.filter(
    (capability) => !description.capabilities.includes(capability)
  );
  if (match === null || Number(match[1]) !== 1 || Number(match[2]) < 0 || missing.length > 0)
    throw new MarAgentError('MAR_AGENT_HOST_INCOMPATIBLE', 'Host API is incompatible.', {
      details: { expected: MAR_AGENT_HOST_API_VERSION, actual: description.apiVersion, missing }
    });
  return description;
}

export interface HostSkill {
  readonly name: string;
  readonly description: string;
  readonly requiredTools: readonly string[];
  load(): Promise<string>;
}
export interface HostExecutionExtensions {
  readonly tools?: readonly ClientToolDefinition[];
  readonly skills?: readonly HostSkill[];
}
export interface HostSessionResourceSnapshot {
  codeCells?: readonly {
    cellId: string;
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    executionId: string;
  }[];
  idleTtlMs?: number;
  processes: readonly {
    processId: string;
    status: 'running' | 'completed' | 'cancelled';
    command: string;
    cwd: string;
  }[];
}
/** The Host owns workspace/tool effects; the SDK owns JSONL storage beneath its supplied HOME. */
export interface MarAgentHost {
  /** Independent model consumption facts, including child and auxiliary calls. */
  modelUsage?: import('../model/usage-observer.js').ModelUsageObserver | undefined;
  readonly extensionPorts?: CoreHostExtensionPorts;
  describe(): Promise<HostDescription>;
  executeTool(call: ToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult>;
  listExecutionExtensions?(context: McpToolCatalogContext): Promise<HostExecutionExtensions>;
  listSessionSkills?(
    context: Pick<McpToolCatalogContext, 'sessionId' | 'modelId'>
  ): Promise<readonly HostSkill[]>;
  emit(event: MarAgentEvent): Promise<void> | void;
  requestToolApproval?: import('../tools/permissions.js').ToolApprovalHandler | undefined;
  requestUserInput?(
    input: { requestId: string; questions: unknown[] },
    signal: AbortSignal
  ): Promise<Record<string, unknown>>;
  listMcpTools?(context?: McpToolCatalogContext): Promise<readonly ClientToolDefinition[]>;
  listMcpToolCatalog?(context: McpToolCatalogContext): Promise<McpToolCatalog>;
  callMcpTool?(
    call: ToolCall,
    signal: AbortSignal,
    context?: McpToolCallContext
  ): Promise<ToolExecutionResult>;
  listSessionResources?(sessionId: string): Promise<HostSessionResourceSnapshot>;
  disposeSessionResources?(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
}
export interface CoreHostExtensionPorts {
  readonly tools?: CoreHostToolsBackend;
  readonly mcp?: import('../extensions/mcp.js').CoreMcpBackend;
  readonly environment?: CoreEnvironmentBackend;
  readonly processes?: CoreProcessesBackend;
  readonly network?: CoreNetworkBackend;
  readonly files?: CoreFilesBackend;
}

/** A captured application-owned handler, never author-supplied invocation authority. */
export interface CoreHostToolSource extends CoreToolRef {
  readonly mcp?: import('../tools/contracts.js').McpCatalogTool;
  available?(call: CoreOperationContext): boolean;
  execute(input: ToolCall, call: CoreOperationContext): Promise<ToolExecutionResult>;
}
export interface CoreHostToolsBackend {
  catalog(sessionId: string, executionId?: string): readonly CoreHostToolSource[];
}
