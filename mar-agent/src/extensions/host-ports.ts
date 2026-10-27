import type { ToolCall, ToolExecutionResult, McpCatalogTool } from '../tools/contracts.js';
import type { ExtensionOperationContext } from './operation.js';
import type { ExtensionToolRef } from './tools.js';
import type { ExtensionFilesBackend } from './files.js';
import type { ExtensionNetworkBackend } from './network.js';
import type { ExtensionProcessesBackend } from './processes.js';
import type { ExtensionEnvironmentBackend } from './environment.js';

export interface AgentHostExtensionPorts {
  readonly tools?: AgentHostToolsBackend;
  readonly mcp?: import('./mcp.js').ExtensionMcpBackend;
  readonly environment?: ExtensionEnvironmentBackend;
  readonly processes?: ExtensionProcessesBackend;
  readonly network?: ExtensionNetworkBackend;
  readonly files?: ExtensionFilesBackend;
}

/** A captured application-owned handler, never author-supplied invocation authority. */
export interface AgentHostToolSource extends ExtensionToolRef {
  readonly mcp?: McpCatalogTool;
  available?(call: ExtensionOperationContext): boolean;
  execute(input: ToolCall, call: ExtensionOperationContext): Promise<ToolExecutionResult>;
}
export interface AgentHostToolsBackend {
  catalog(sessionId: string, executionId?: string): readonly AgentHostToolSource[];
}
