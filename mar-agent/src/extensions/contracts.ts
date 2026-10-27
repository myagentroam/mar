import type { ExtensionCommandSpec } from './commands.js';
import type { ExtensionPromptSection } from './prompt-composition.js';
import type { ExtensionCapabilitySnapshot } from './capabilities.js';
import type { ExtensionModelRequest } from './model-request.js';
import type { ExtensionCompactContext, ExtensionCompactResult } from './compaction.js';
import type { ExtensionPromptInput, ExtensionPromptResult } from './prompt-input.js';
import type { ExtensionModelEvent } from './model-stream.js';
import type {
  ExtensionPromptComposition,
  ExtensionPromptSectionInput
} from './prompt-composition.js';
import type { ExtensionModelsApi } from './models.js';
import type {
  ExtensionAgentsApi,
  ExtensionAgentSpawnInput,
  ExtensionAgentWaitInput,
  ExtensionAgentWaitResult,
  ExtensionAgentMessageInput,
  ExtensionAgentTarget,
  ExtensionAgentSnapshot,
  ExtensionAgentSpawnResult,
  ExtensionAgentCompletion
} from './agents.js';
import type { ExtensionDataApi } from './data.js';
import type {
  ExtensionMcpApi,
  ExtensionMcpConnectInput,
  ExtensionMcpConnectionInput,
  ExtensionMcpConnectionRef,
  ExtensionMcpCatalog,
  ExtensionMcpCompletion
} from './mcp.js';
import type {
  ExtensionFilesApi,
  ExtensionFileOperations,
  ExtensionFileCompletion
} from './files.js';
import type {
  ExtensionEnvironmentApi,
  ExtensionEnvironmentKey,
  ExtensionEnvironmentSet,
  ExtensionEnvironmentChange,
  ExtensionEnvironmentCompletion
} from './environment.js';
import type {
  ExtensionSettingsApi,
  ExtensionSettingsReadInput,
  ExtensionSettingsUpdate,
  ExtensionSettingsDescription,
  ExtensionSettingsSnapshot,
  ExtensionSettingsResult,
  ExtensionSettingsCompletion
} from './settings.js';
import type {
  ExtensionProcessesApi,
  ExtensionProcessInput,
  ExtensionProcessRunInput,
  ExtensionProcessHandle,
  ExtensionProcessResult,
  ExtensionProcessCompletion
} from './processes.js';
import type {
  ExtensionNetworkApi,
  ExtensionHttpRequest,
  ExtensionHttpResponse,
  ExtensionHttpCompletion
} from './network.js';
import type {
  ExtensionSessionApi,
  ExtensionAppendInput,
  ExtensionCompactInput,
  ExtensionSessionActionResult
} from './session-input.js';
import type { ToolCall, ToolExecutionResult } from '../tools/contracts.js';
import type { ExtensionHookOptions, ExtensionInterceptor } from './hooks.js';
import type { ExtensionOperationContext } from './operation.js';
import type {
  ExtensionDisposer,
  ExtensionResourceRegistration,
  ExtensionResourceScope
} from './resources.js';
import type { ExtensionServiceRegistry } from './services.js';
import type {
  ExtensionToolRef,
  ExtensionToolInvocation,
  ExtensionToolCheck,
  ExtensionToolSpec,
  ExtensionToolCompletion,
  ExtensionToolFailure
} from './tools.js';

import type { DomainAgentOperations, DomainAgentFacts } from './agents.js';
import type { DomainCompactOperations, DomainCompactFacts } from './compaction.js';
import type { DomainEnvironmentOperations, DomainEnvironmentFacts } from './environment.js';
import type { DomainFileOperations, DomainFileFacts } from './files.js';
import type { DomainMcpOperations, DomainMcpFacts } from './mcp.js';
import type { DomainModelRequestOperations, DomainModelRequestFacts } from './model-request.js';
import type { DomainModelStreamOperations, DomainModelStreamFacts } from './model-stream.js';
import type { DomainNetworkOperations, DomainNetworkFacts } from './network.js';
import type { DomainProcessOperations, DomainProcessFacts } from './processes.js';
import type {
  DomainPromptCompositionOperations,
  DomainPromptCompositionFacts
} from './prompt-composition.js';
import type { DomainPromptInputOperations, DomainPromptInputFacts } from './prompt-input.js';
import type { DomainSessionOperations, DomainSessionFacts } from './session-input.js';
import type { DomainSettingsOperations, DomainSettingsFacts } from './settings.js';
import type { DomainToolOperations, DomainToolFacts } from './tools.js';

export interface ExtensionDomainOperations
  extends
    DomainAgentOperations,
    DomainCompactOperations,
    DomainEnvironmentOperations,
    DomainFileOperations,
    DomainMcpOperations,
    DomainModelRequestOperations,
    DomainModelStreamOperations,
    DomainNetworkOperations,
    DomainProcessOperations,
    DomainPromptCompositionOperations,
    DomainPromptInputOperations,
    DomainSessionOperations,
    DomainSettingsOperations,
    DomainToolOperations {}
export interface ExtensionDomainFacts
  extends
    DomainAgentFacts,
    DomainCompactFacts,
    DomainEnvironmentFacts,
    DomainFileFacts,
    DomainMcpFacts,
    DomainModelRequestFacts,
    DomainModelStreamFacts,
    DomainNetworkFacts,
    DomainProcessFacts,
    DomainPromptCompositionFacts,
    DomainPromptInputFacts,
    DomainSessionFacts,
    DomainSettingsFacts,
    DomainToolFacts {}
export interface ExtensionHookRegistrar {
  intercept<Key extends keyof ExtensionDomainOperations>(
    key: Key,
    handler: ExtensionInterceptor<
      ExtensionDomainOperations[Key]['input'],
      ExtensionDomainOperations[Key]['output']
    >,
    options?: ExtensionHookOptions
  ): ExtensionResourceRegistration;
  observe<Key extends keyof ExtensionDomainFacts>(
    key: Key,
    handler: (
      fact: ExtensionDomainFacts[Key],
      call: ExtensionOperationContext
    ) => void | Promise<void>,
    options?: ExtensionHookOptions
  ): ExtensionResourceRegistration;
}
export type { ExtensionCapabilitySnapshot } from './capabilities.js';
export type { ExtensionCommandSpec } from './commands.js';
export type { ExtensionPromptSection } from './prompt-composition.js';
export interface AgentExtensionContext {
  readonly data?: Pick<ExtensionDataApi, 'store'>;
  readonly resources: ExtensionResourceScope;
  readonly services: ExtensionServiceRegistry;
  readonly capabilities: ExtensionCapabilitySnapshot;
  readonly bindings: Readonly<Record<string, unknown>>;
  readonly observability: { log(message: string): void };
}
export interface SessionExtensionContext extends AgentExtensionContext {
  readonly mcp?: ExtensionMcpApi;
  readonly agents?: ExtensionAgentsApi;
  readonly environment?: ExtensionEnvironmentApi;
  readonly settings?: ExtensionSettingsApi;
  readonly processes?: ExtensionProcessesApi;
  readonly network?: ExtensionNetworkApi;
  readonly files?: ExtensionFilesApi;
  readonly sessionId: string;
  readonly models?: ExtensionModelsApi;
  readonly data: ExtensionDataApi;
  readonly session?: ExtensionSessionApi;
  readonly hooks: ExtensionHookRegistrar;
  readonly tools: {
    register(spec: ExtensionToolSpec): ExtensionResourceRegistration;
    catalog(): readonly ExtensionToolRef[];
    check(call: ExtensionToolInvocation): Promise<ExtensionToolCheck>;
    invoke(call: ExtensionToolInvocation): Promise<ToolExecutionResult>;
  };
  readonly commands: {
    register(spec: ExtensionCommandSpec): ExtensionResourceRegistration;
    list(): readonly Pick<ExtensionCommandSpec, 'name' | 'description'>[];
    run(input: { readonly name: string; readonly args?: unknown }): Promise<unknown>;
  };
  readonly prompts: {
    register(section: ExtensionPromptSection): ExtensionResourceRegistration;
    sections(): readonly ExtensionPromptSection[];
    compose(system: string): Promise<string>;
    composeSections(input: ExtensionPromptComposition): Promise<ExtensionPromptComposition>;
    composeDefault(
      facts?: import('./prompt-composition.js').ExtensionPromptFacts
    ): Promise<ExtensionPromptComposition>;
  };
  readonly clock: {
    now(): number;
    sleep(input: { readonly durationMs: number; readonly signal?: AbortSignal }): Promise<void>;
    after(
      durationMs: number,
      callback: (call: ExtensionOperationContext) => void | Promise<void>
    ): ExtensionResourceRegistration;
    every(
      durationMs: number,
      callback: (call: ExtensionOperationContext) => void | Promise<void>
    ): ExtensionResourceRegistration;
  };
}
export interface ExtensionServiceDeclaration {
  readonly key: { readonly id: string; readonly scope: 'agent' | 'session' };
  readonly intent?: 'provide' | 'replace' | 'wrap';
}
export interface ExtensionServiceDependency {
  readonly key: { readonly id: string; readonly scope: 'agent' | 'session' };
  readonly optional?: boolean;
}
export interface AgentExtension {
  readonly dataDirectory?: string;
  readonly id: string;
  readonly apiVersion: '1.0';
  readonly bindings?: Readonly<Record<string, unknown>>;
  readonly requires?: readonly { readonly id: string }[];
  readonly optional?: readonly { readonly id: string }[];
  readonly provides?: readonly ExtensionServiceDeclaration[];
  readonly serviceDependencies?: readonly ExtensionServiceDependency[];
  readonly failurePolicy?: 'disable-extension' | 'fail-composition';
  setup?(
    context: AgentExtensionContext
  ): void | ExtensionDisposer | Promise<void | ExtensionDisposer>;
  attachSession?(
    context: SessionExtensionContext
  ): void | ExtensionDisposer | Promise<void | ExtensionDisposer>;
}
export interface ExtensionSnapshot {
  readonly revision: string;
  readonly extensions: readonly AgentExtension[];
}
export interface ExtensionSource {
  resolve(input: { readonly signal: AbortSignal }): Promise<ExtensionSnapshot>;
}
export interface ExtensionDiagnostic {
  readonly code: string;
  readonly extensionId?: string;
  readonly sessionId?: string;
  readonly revision?: string;
  readonly operationId?: string;
  readonly message?: string;
}
