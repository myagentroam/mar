export type {
  ExtensionCompactContext,
  ExtensionCompactDiagnostic,
  ExtensionCompactMessage,
  ExtensionCompactResult
} from './extensions/compaction.js';
export type {
  AgentExtension,
  AgentExtensionContext,
  ExtensionCapabilitySnapshot,
  ExtensionCommandSpec,
  ExtensionDiagnostic,
  ExtensionDomainFacts,
  ExtensionDomainOperations,
  ExtensionHookRegistrar,
  ExtensionPromptSection,
  ExtensionServiceDeclaration,
  ExtensionServiceDependency,
  ExtensionSnapshot,
  ExtensionSource,
  SessionExtensionContext
} from './extensions/contracts.js';
export type {
  ExtensionCheckpoint,
  ExtensionCheckpointApi,
  ExtensionDataApi,
  ExtensionJsonValue,
  ExtensionStateApi,
  ExtensionStateChange,
  ExtensionStoreApi,
  ExtensionStoreCommit
} from './extensions/data.js';
export type {
  ExtensionEnvironmentApi,
  ExtensionEnvironmentBackend,
  ExtensionEnvironmentChange,
  ExtensionEnvironmentCompletion,
  ExtensionEnvironmentKey,
  ExtensionEnvironmentSet
} from './extensions/environment.js';
export type {
  ExtensionFileCompletion,
  ExtensionFileEntry,
  ExtensionFileInfo,
  ExtensionFilePath,
  ExtensionFileRemove,
  ExtensionFilesApi,
  ExtensionFilesBackend,
  ExtensionFileTransfer,
  ExtensionFileType,
  ExtensionFileWrite
} from './extensions/files.js';
export type { ExtensionHookOptions, ExtensionInterceptor } from './extensions/hooks.js';
export type {
  ExtensionMcpApi,
  ExtensionMcpBackend,
  ExtensionMcpCallInput,
  ExtensionMcpCatalog,
  ExtensionMcpCompletion,
  ExtensionMcpConnectInput,
  ExtensionMcpConnectionBackend,
  ExtensionMcpConnectionInput,
  ExtensionMcpConnectionRef,
  ExtensionMcpServerDefinition,
  ExtensionMcpServerRef,
  ExtensionMcpServerRegistration,
  ExtensionMcpToolCall
} from './extensions/mcp.js';
export type {
  ExtensionModelMessage,
  ExtensionModelRequest,
  ExtensionRequestSnapshot
} from './extensions/model-request.js';
export type { ExtensionModelEvent } from './extensions/model-stream.js';
export type {
  ExtensionGenerateInput,
  ExtensionGenerateResult,
  ExtensionModelDescription,
  ExtensionModelsApi,
  ExtensionModelTextBlock
} from './extensions/models.js';
export type {
  ExtensionHttpCompletion,
  ExtensionHttpRequest,
  ExtensionHttpResponse,
  ExtensionNetworkApi,
  ExtensionNetworkBackend
} from './extensions/network.js';
export type { ExtensionOperationContext } from './extensions/operation.js';
export type {
  ExtensionProcessCompletion,
  ExtensionProcessesApi,
  ExtensionProcessesBackend,
  ExtensionProcessExit,
  ExtensionProcessHandle,
  ExtensionProcessInput,
  ExtensionProcessResult,
  ExtensionProcessRunInput
} from './extensions/processes.js';
export type {
  ExtensionPromptComposition,
  ExtensionPromptFacts,
  ExtensionPromptSectionInput
} from './extensions/prompt-composition.js';
export type { ExtensionPromptInput, ExtensionPromptResult } from './extensions/prompt-input.js';
export type {
  ExtensionDisposer,
  ExtensionResourceRegistration,
  ExtensionResourceScope
} from './extensions/resources.js';
export type {
  ExtensionServiceConsumer,
  ExtensionServiceKey,
  ExtensionServiceRegistry
} from './extensions/services.js';
export { SESSION_CONTEXT_PROVIDER } from './extensions/session-context.js';
export type {
  ExtensionSessionContextItem,
  ExtensionSessionContextProvider
} from './extensions/session-context.js';
export { waitForToolCondition } from './runtime/wait.js';
export type { ToolWaitInterrupt } from './runtime/wait.js';
export type {
  ExtensionAppendInput,
  ExtensionCompactInput,
  ExtensionInputSource,
  ExtensionSessionActionResult,
  ExtensionSessionApi,
  ExtensionSessionDescription,
  ExtensionSessionInspection,
  ExtensionSessionMessage,
  ExtensionSessionMessages,
  ExtensionSessionMessagesInput,
  ExtensionSessionOperationStatus,
  ExtensionSessionReceipt,
  ExtensionSubmitInput
} from './extensions/session-input.js';
export type {
  ExtensionSettingDefinition,
  ExtensionSettingsApi,
  ExtensionSettingsBackend,
  ExtensionSettingsCompletion,
  ExtensionSettingsDescription,
  ExtensionSettingsReadInput,
  ExtensionSettingsResult,
  ExtensionSettingsSnapshot,
  ExtensionSettingsUpdate
} from './extensions/settings.js';
export type {
  ExtensionToolAttempt,
  ExtensionToolCheck,
  ExtensionToolCompletion,
  ExtensionToolFailure,
  ExtensionToolInvocation,
  ExtensionToolRef,
  ExtensionToolSpec
} from './extensions/tools.js';
export type { PromptPart } from './prompts/prompt-sections.js';
