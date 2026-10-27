import type { AgentHostExtensionPorts } from '../extensions/host-ports.js';
import type { AgentEvent } from '../runtime/events.js';
import type {
  ClientToolDefinition,
  McpToolCallContext,
  McpToolCatalog,
  McpToolCatalogContext,
  ToolCall,
  ToolExecutionContext,
  ToolExecutionResult
} from '../tools/contracts.js';

import { AgentError } from '../error.js';
import type { ExtensionFilesBackend } from '../extensions/files.js';
import type { ExtensionNetworkBackend } from '../extensions/network.js';
import type { ExtensionProcessesBackend } from '../extensions/processes.js';
import type { ExtensionEnvironmentBackend } from '../extensions/environment.js';
import type { ExtensionOperationContext } from '../extensions/operation.js';
import type { ExtensionToolRef } from '../extensions/tools.js';

export const AGENT_HOST_API_VERSION = '1.0';

import type { HostDescription, AgentHostCapability } from './description.js';
export type { HostDescription, AgentHostCapability } from './description.js';

const requiredCapabilities: readonly AgentHostCapability[] = [
  'workspace.read',
  'workspace.patch',
  'process.manage',
  'user-input.request',
  'event.publish'
];

export function negotiateHost(description: HostDescription): HostDescription {
  const match = /^(\d+)\.(\d+)$/.exec(description.apiVersion);
  const missing = requiredCapabilities.filter(
    (capability) => !description.capabilities.includes(capability)
  );
  if (match === null || Number(match[1]) !== 1 || Number(match[2]) < 0 || missing.length > 0)
    throw new AgentError('MAR_AGENT_HOST_INCOMPATIBLE', 'Host API is incompatible.', {
      details: { expected: AGENT_HOST_API_VERSION, actual: description.apiVersion, missing }
    });
  return description;
}

import type { HostSkill } from './skill-contract.js';
export type { HostSkill } from './skill-contract.js';
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
/** The Host owns workspace/tool effects; SessionStore is injected or defaults to SDK-owned JSONL. */
export interface AgentHost {
  /** Independent model consumption facts, including child and auxiliary calls. */
  modelUsage?: import('../model/usage.js').ModelUsageObserver | undefined;
  publishModelResource?: (
    image: import('../session/resource-contract.js').SessionResource,
    context: { sessionId: string; executionId: string; homeDirectory: string }
  ) => Promise<{ url: string; urlExpiresAt: number } | undefined>;
  readonly extensionPorts?: AgentHostExtensionPorts;
  describe(): Promise<HostDescription>;
  executeTool(call: ToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult>;
  listExecutionExtensions?(context: McpToolCatalogContext): Promise<HostExecutionExtensions>;
  listSessionSkills?(
    context: Pick<McpToolCatalogContext, 'sessionId' | 'modelId'>
  ): Promise<readonly HostSkill[]>;
  emit(event: AgentEvent): Promise<void> | void;
  requestToolApproval?: import('../tools/permission-contract.js').ToolApprovalHandler | undefined;
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
export type {
  AgentHostExtensionPorts,
  AgentHostToolSource,
  AgentHostToolsBackend
} from '../extensions/host-ports.js';
