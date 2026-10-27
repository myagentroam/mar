export type { ExtensionEnvironmentBackend } from './extensions/environment.js';
export type { ExtensionFilesBackend } from './extensions/files.js';
export type { ExtensionMcpBackend, ExtensionMcpConnectionBackend } from './extensions/mcp.js';
export type { ExtensionNetworkBackend } from './extensions/network.js';
export type { ExtensionProcessesBackend } from './extensions/processes.js';
export { AGENT_HOST_API_VERSION, negotiateHost } from './host/contracts.js';
export type {
  AgentHost,
  AgentHostCapability,
  AgentHostExtensionPorts,
  AgentHostToolsBackend,
  AgentHostToolSource,
  HostDescription,
  HostExecutionExtensions,
  HostSessionResourceSnapshot,
  HostSkill
} from './host/contracts.js';
export type {
  LocalAgentExecutionExtensions,
  LocalAgentExecutionMcpBinding,
  LocalAgentMcpBinding
} from './host/local-agent-host.js';
export { LocalAgentHost, selectExecutionShell } from './host/local-agent-host.js';
export type {
  LocalProcessExecutor,
  LocalProcessSpawnRequest
} from './host/local-process-executor.js';
export type {
  ModelRequestUsage,
  ModelUsageObservation,
  ModelUsageObserver
} from './model/usage-observer.js';
export type { SessionResource } from './session/store/contracts.js';
export type {
  CodeModeEngine,
  CodeModeEngineFactory,
  CreateCodeModeEngine
} from './tools/code-mode/engine.js';
export type {
  ClientToolDefinition,
  McpCatalogTool,
  McpToolCallContext,
  McpToolCatalog,
  McpToolCatalogContext,
  ToolCall,
  ToolCaller,
  ToolExecutionContext,
  ToolExecutionResult
} from './tools/contracts.js';
export {
  assertMcpToolCatalog,
  assertMcpToolDefinition,
  MCP_DEFINITION_LIMITS
} from './tools/mcp/catalog.js';
export type {
  PermissionMode,
  PermissionStop,
  ToolApprovalDecision,
  ToolApprovalHandler,
  ToolApprovalRequest,
  ToolPermission
} from './tools/permissions.js';
export type { WorkspacePathMount } from './tools/shared/path-resolver.js';
