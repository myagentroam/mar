export { MarAgentError } from './agent-core/error.js';
export {
  MAR_AGENT_HOST_API_VERSION,
  negotiateHost,
  type HostDescription,
  type MarAgentHostCapability
} from './agent-core/host/contracts.js';
export type {
  PermissionMode,
  ToolApprovalRequest,
  ToolApprovalDecision,
  ToolApprovalHandler,
  ToolPermission,
  PermissionStop
} from './agent-core/tools/permissions.js';
export type {
  ToolResultExtension,
  FileChangeEvidence
} from './agent-core/tools/result-extensions.js';
export { parseToolResultExtensions } from './agent-core/tools/result-extensions.js';
export type {
  ToolResultResourceInput,
  ToolResultResourcePage
} from './agent-core/session/tool-result-resources.js';

export type {
  HostExecutionExtensions,
  HostSessionResourceSnapshot,
  HostSkill,
  MarAgentHost
} from './agent-core/host/contracts.js';
export {
  LocalAgentHost,
  selectExecutionShell,
  type LocalAgentExecutionExtensions,
  type LocalAgentExecutionMcpBinding,
  type LocalAgentMcpBinding
} from './agent-core/host/local-agent-host.js';
export type {
  LocalProcessExecutor,
  LocalProcessSpawnRequest
} from './agent-core/host/local-process-executor.js';
export {
  SecretValue,
  marAgentReasoningEffortSchema,
  parseModelCatalog,
  resolveModelDefaultReasoningEffort,
  type MarAgentModelConfiguration,
  type MarAgentReasoningEffort,
  type ModelCatalog,
  type ModelCredential,
  type ModelCredentialAcquireReason,
  type ModelCredentialProvider,
  type ResponsesTransport
} from './agent-core/model/configuration.js';
export { testMarAgentModelTransport } from './agent-core/model/transport-test.js';
export type {
  AccessMode,
  ExecutionMode,
  ExecutionResult,
  MarAgentImageMetadata,
  RolloutBudgetOptions,
  RunInput,
  RunInputImage
} from './agent-core/runtime/contracts.js';
export type { MarAgentEvent } from './agent-core/runtime/events.js';
export { createMarAgent } from './agent-core/sdk/agent.js';
export {
  generateModelText,
  type GenerateModelTextInput,
  type GenerateModelTextResult
} from './shared/model-text.js';
export type {
  CoreAgentExtensionContext,
  CoreSessionExtensionContext,
  CoreRuntimeExtension,
  CoreExtensionSnapshot,
  CoreExtensionSource,
  CoreExtensionDiagnostic,
  CoreDomainOperations,
  CoreDomainFacts,
  CoreHookRegistrar,
  CoreCapabilitySnapshot,
  CoreCommandSpec,
  CorePromptSection,
  CoreServiceDeclaration,
  CoreServiceDependency
} from './agent-core/extensions/contracts.js';
export type {
  CoreDisposer,
  CoreResourceRegistration,
  CoreResourceScope
} from './agent-core/extensions/resources.js';
export type { CoreHookOptions, CoreInterceptor } from './agent-core/extensions/hooks.js';
export type { CoreOperationContext } from './agent-core/extensions/operation.js';
export type {
  CoreCompactContext,
  CoreCompactDiagnostic,
  CoreCompactMessage,
  CoreCompactResult
} from './agent-core/extensions/compaction.js';
export { buildCompactionInput as buildCompactEvidence } from './agent-core/runtime/compaction/history.js';
export { countModelTokens } from './agent-core/runtime/token-budget.js';
export type { CoreServiceKey, CoreServiceRegistry } from './agent-core/extensions/services.js';
export type {
  CoreToolSpec,
  CoreToolRef,
  CoreToolInvocation,
  CoreToolCheck,
  CoreToolAttempt,
  CoreToolCompletion,
  CoreToolFailure
} from './agent-core/extensions/tools.js';
export type {
  CoreModelMessage,
  CoreModelRequest,
  CoreRequestSnapshot
} from './agent-core/extensions/model-request.js';
export type { CoreModelEvent } from './agent-core/extensions/model-stream.js';
export type {
  CorePromptPart,
  CorePromptFacts,
  CorePromptComposition,
  CorePromptSectionInput
} from './agent-core/extensions/prompt-composition.js';
export type {
  CoreFilesApi,
  CoreFilesBackend,
  CoreFilePath,
  CoreFileWrite,
  CoreFileRemove,
  CoreFileTransfer,
  CoreFileType,
  CoreFileInfo,
  CoreFileEntry,
  CoreFileCompletion
} from './agent-core/extensions/files.js';
export type {
  CoreHostExtensionPorts,
  CoreHostToolSource,
  CoreHostToolsBackend
} from './agent-core/host/contracts.js';
export type {
  CoreEnvironmentApi,
  CoreEnvironmentBackend,
  CoreEnvironmentKey,
  CoreEnvironmentSet,
  CoreEnvironmentChange,
  CoreEnvironmentCompletion
} from './agent-core/extensions/environment.js';
export type {
  CoreMcpApi,
  CoreMcpBackend,
  CoreMcpConnectionBackend,
  CoreMcpToolCall,
  CoreMcpServerDefinition,
  CoreMcpServerRef,
  CoreMcpServerRegistration,
  CoreMcpConnectionRef,
  CoreMcpConnectInput,
  CoreMcpConnectionInput,
  CoreMcpCallInput,
  CoreMcpCatalog,
  CoreMcpCompletion
} from './agent-core/extensions/mcp.js';
export type {
  CoreAgentsApi,
  CoreAgentsBackend,
  CoreAgentSpawnInput,
  CoreAgentTarget,
  CoreAgentWaitInput,
  CoreAgentWaitResult,
  CoreAgentManySnapshot,
  CoreAgentMessageInput,
  CoreAgentSnapshot,
  CoreAgentHandledResult,
  CoreAgentSpawnResult,
  CoreAgentCompletion
} from './agent-core/extensions/agents.js';
export type {
  CoreSettingsApi,
  CoreSettingsBackend,
  CoreSettingsReadInput,
  CoreSettingsUpdate,
  CoreSettingsDescription,
  CoreSettingDefinition,
  CoreSettingsSnapshot,
  CoreSettingsResult,
  CoreSettingsCompletion
} from './agent-core/extensions/settings.js';
export type {
  CoreNetworkApi,
  CoreNetworkBackend,
  CoreHttpRequest,
  CoreHttpResponse,
  CoreHttpCompletion
} from './agent-core/extensions/network.js';
export type {
  CoreSessionApi,
  CoreSessionReceipt,
  CoreSessionInspection,
  CoreSessionDescription,
  CoreSessionMessages,
  CoreSessionMessagesInput,
  CoreSessionMessage,
  CoreSessionOperationStatus,
  CoreAppendInput,
  CoreSubmitInput,
  CoreInputSource,
  CoreCompactInput,
  CoreSessionActionResult
} from './agent-core/extensions/session-input.js';
export type { CorePromptInput, CorePromptResult } from './agent-core/extensions/prompt-input.js';
export type {
  CoreModelsApi,
  CoreModelDescription,
  CoreModelTextBlock,
  CoreGenerateInput,
  CoreGenerateResult
} from './agent-core/extensions/models.js';
export type {
  CoreDataApi,
  CoreJsonValue,
  CoreCheckpoint,
  CoreCheckpointApi,
  CoreStateApi,
  CoreStateChange,
  CoreStoreApi,
  CoreStoreCommit
} from './agent-core/extensions/data.js';
export { generateSessionTitle, type GenerateSessionTitleInput } from './shared/auto-title.js';
export type {
  CoreProcessesApi,
  CoreProcessesBackend,
  CoreProcessInput,
  CoreProcessRunInput,
  CoreProcessHandle,
  CoreProcessExit,
  CoreProcessResult,
  CoreProcessCompletion
} from './agent-core/extensions/processes.js';
export type {
  CreateMarAgentOptions,
  CreateSessionInput,
  ExecutionHandle,
  CompactInput,
  SteerInput,
  SteerResult,
  MarAgent,
  MarAgentSession,
  SessionTitleUpdateInput
} from './agent-core/sdk/types.js';
export {
  openMarAgentSessionCatalog,
  type MarAgentContextUsage,
  type MarAgentHistoryEntry,
  type MarAgentHistoryPage,
  type MarAgentSessionCatalog,
  type MarAgentSessionDeleteResult,
  type MarAgentSessionImage,
  type MarAgentSessionPage,
  type MarAgentSessionSummary
} from './agent-core/session/catalog.js';
export type { SessionListInput, SessionSource } from './agent-core/session/types.js';
export type {
  SessionStore,
  SessionImageResource,
  SessionStoreMaintenance,
  SessionStoreSession,
  SessionRecordInput,
  SessionStoreCompactInput,
  SessionRecord,
  SessionExecutionState,
  CompactHistoryMessage,
  CompactUserInput,
  SessionInputImage,
  SessionInputImageMetadata,
  SessionInputImageData,
  RestoredSessionInputImage,
  CodeModeStateEntry,
  TodoSnapshot,
  TodoItem,
  CodeToolCallRecord,
  CodeObservation,
  ModelMessage,
  ModelUsage,
  ModelInputMetadata,
  ModelTextBlock,
  ModelContextualBlock,
  EnvironmentContextState,
  ContextGcCheckpointDraft,
  ContextGcBase,
  ContextGcPlatform,
  ContextGcEconomicsPolicy,
  ContextGcMetrics,
  ContextGcReplacement,
  ContextGcTarget,
  ContextGcReadItemReplacement,
  ContextGcWebToolName,
  ContextGcSubagentToolName,
  AvailableToolResultResource
} from './agent-core/session/store/contracts.js';
export type { OpenMarAgentSessionCatalogInput } from './agent-core/session/catalog.js';
export type {
  ApplyPatchFileResult,
  ApplyPatchResult,
  ApplyPatchPartialResult,
  ClientToolDefinition,
  MarAgentToolArtifact,
  MarAgentToolImageArtifact,
  McpCatalogTool,
  McpToolCallContext,
  McpToolCatalog,
  McpToolCatalogContext,
  ToolCall,
  ToolCaller,
  ToolExecutionContext,
  ToolExecutionResult
} from './agent-core/tools/contracts.js';
export {
  MCP_DEFINITION_LIMITS,
  assertMcpToolCatalog,
  assertMcpToolDefinition
} from './agent-core/tools/mcp/catalog.js';
export type { WorkspacePathMount } from './agent-core/tools/shared/path-resolver.js';

export type {
  CodeModeEngine,
  CodeModeEngineFactory,
  CreateCodeModeEngine
} from './agent-core/tools/code-mode/engine.js';

export type {
  ModelRequestUsage,
  ModelUsageObservation,
  ModelUsageObserver
} from './agent-core/model/usage-observer.js';
