import type { CoreModelRequest } from './model-request.js';
import type { CoreCompactContext, CoreCompactResult } from './compaction.js';
import type { CorePromptInput, CorePromptResult } from './prompt-input.js';
import type { CoreModelEvent } from './model-stream.js';
import type { CorePromptComposition, CorePromptSectionInput } from './prompt-composition.js';
import type { CoreModelsApi } from './models.js';
import type {
  CoreAgentsApi,
  CoreAgentSpawnInput,
  CoreAgentWaitInput,
  CoreAgentWaitResult,
  CoreAgentMessageInput,
  CoreAgentTarget,
  CoreAgentSnapshot,
  CoreAgentSpawnResult,
  CoreAgentCompletion
} from './agents.js';
import type { CoreDataApi } from './data.js';
import type {
  CoreMcpApi,
  CoreMcpConnectInput,
  CoreMcpConnectionInput,
  CoreMcpConnectionRef,
  CoreMcpCatalog,
  CoreMcpCompletion
} from './mcp.js';
import type { CoreFilesApi, CoreFileOperations, CoreFileCompletion } from './files.js';
import type {
  CoreEnvironmentApi,
  CoreEnvironmentKey,
  CoreEnvironmentSet,
  CoreEnvironmentChange,
  CoreEnvironmentCompletion
} from './environment.js';
import type {
  CoreSettingsApi,
  CoreSettingsReadInput,
  CoreSettingsUpdate,
  CoreSettingsDescription,
  CoreSettingsSnapshot,
  CoreSettingsResult,
  CoreSettingsCompletion
} from './settings.js';
import type {
  CoreProcessesApi,
  CoreProcessInput,
  CoreProcessRunInput,
  CoreProcessHandle,
  CoreProcessResult,
  CoreProcessCompletion
} from './processes.js';
import type {
  CoreNetworkApi,
  CoreHttpRequest,
  CoreHttpResponse,
  CoreHttpCompletion
} from './network.js';
import type {
  CoreSessionApi,
  CoreAppendInput,
  CoreCompactInput,
  CoreSessionActionResult
} from './session-input.js';
import type { ToolCall, ToolExecutionResult } from '../tools/contracts.js';
import type { CoreHookOptions, CoreInterceptor } from './hooks.js';
import type { CoreOperationContext } from './operation.js';
import type { CoreDisposer, CoreResourceRegistration, CoreResourceScope } from './resources.js';
import type { CoreServiceRegistry } from './services.js';
import type {
  CoreToolRef,
  CoreToolInvocation,
  CoreToolCheck,
  CoreToolSpec,
  CoreToolCompletion,
  CoreToolFailure
} from './tools.js';

export interface CoreDomainOperations extends CoreFileOperations {
  'mcp.connect': { input: CoreMcpConnectInput; output: CoreMcpConnectionRef };
  'mcp.catalog': { input: CoreMcpConnectionInput; output: CoreMcpCatalog };
  'mcp.disconnect': { input: CoreMcpConnectionInput; output: void };
  'agent.spawn': { input: CoreAgentSpawnInput; output: CoreAgentSpawnResult };
  'agent.wait': { input: CoreAgentWaitInput; output: CoreAgentWaitResult };
  'agent.message': { input: CoreAgentMessageInput; output: CoreAgentSnapshot };
  'agent.cancel': { input: CoreAgentTarget; output: CoreAgentSnapshot };
  'environment.get': { input: CoreEnvironmentKey; output: string | undefined };
  'environment.set': { input: CoreEnvironmentSet; output: CoreEnvironmentChange };
  'settings.describe': { input: CoreSettingsReadInput; output: CoreSettingsDescription };
  'settings.read': { input: CoreSettingsReadInput; output: CoreSettingsSnapshot };
  'settings.update': { input: CoreSettingsUpdate; output: CoreSettingsResult };
  'process.spawn': { input: CoreProcessInput; output: CoreProcessHandle };
  'process.run': { input: CoreProcessRunInput; output: CoreProcessResult };
  'network.fetch': { input: CoreHttpRequest; output: CoreHttpResponse };
  'prompt.compose': { input: string; output: string };
  'prompt.submit': { input: CorePromptInput; output: CorePromptResult };
  'prompt.sections': { input: CorePromptComposition; output: CorePromptComposition };
  'prompt.section': { input: CorePromptSectionInput; output: string | null };
  'model.request': { input: CoreModelRequest; output: CoreModelRequest };
  'model.event': { input: CoreModelEvent; output: CoreModelEvent | undefined };
  'tool.invoke': { input: ToolCall; output: ToolExecutionResult };
  'session.append': { input: CoreAppendInput; output: CoreSessionActionResult };
  'session.compact': { input: CoreCompactInput; output: CoreSessionActionResult };
  'compact.generate': { input: CoreCompactContext; output: CoreCompactResult | undefined };
}
export interface CoreDomainFacts {
  'session.ending': {
    readonly sessionId: string;
    readonly reason: 'clear' | 'other';
    readonly resumable: boolean;
  };
  'session.ready': { readonly sessionId: string };
  'model.event': CoreModelEvent;
  'mcp.completed': CoreMcpCompletion;
  'agent.completed': CoreAgentCompletion;
  'environment.completed': CoreEnvironmentCompletion;
  'settings.completed': CoreSettingsCompletion;
  'process.completed': CoreProcessCompletion;
  'network.completed': CoreHttpCompletion;
  'files.completed': CoreFileCompletion;
  'tool.completed': CoreToolCompletion;
  'tool.failed': CoreToolFailure;
  'tool.attempt.completed': CoreToolCompletion;
  'tool.attempt.failed': CoreToolFailure;
}
export interface CoreHookRegistrar {
  intercept<Key extends keyof CoreDomainOperations>(
    key: Key,
    handler: CoreInterceptor<
      CoreDomainOperations[Key]['input'],
      CoreDomainOperations[Key]['output']
    >,
    options?: CoreHookOptions
  ): CoreResourceRegistration;
  observe<Key extends keyof CoreDomainFacts>(
    key: Key,
    handler: (fact: CoreDomainFacts[Key], call: CoreOperationContext) => void | Promise<void>,
    options?: CoreHookOptions
  ): CoreResourceRegistration;
}
export interface CoreCapabilitySnapshot {
  has(id: string): boolean;
  list(): readonly string[];
}
export interface CoreCommandSpec {
  readonly name: string;
  readonly description?: string;
  readonly override?: 'replace';
  handler(args: unknown, call: CoreOperationContext): unknown | Promise<unknown>;
}
export interface CorePromptSection {
  readonly id: string;
  readonly text: string;
}
export interface CoreAgentExtensionContext {
  readonly data?: Pick<CoreDataApi, 'store'>;
  readonly resources: CoreResourceScope;
  readonly services: CoreServiceRegistry;
  readonly capabilities: CoreCapabilitySnapshot;
  readonly bindings: Readonly<Record<string, unknown>>;
  readonly observability: { log(message: string): void };
}
export interface CoreSessionExtensionContext extends CoreAgentExtensionContext {
  readonly mcp?: CoreMcpApi;
  readonly agents?: CoreAgentsApi;
  readonly environment?: CoreEnvironmentApi;
  readonly settings?: CoreSettingsApi;
  readonly processes?: CoreProcessesApi;
  readonly network?: CoreNetworkApi;
  readonly files?: CoreFilesApi;
  readonly sessionId: string;
  readonly models?: CoreModelsApi;
  readonly data: CoreDataApi;
  readonly session?: CoreSessionApi;
  readonly hooks: CoreHookRegistrar;
  readonly tools: {
    register(spec: CoreToolSpec): CoreResourceRegistration;
    catalog(): readonly CoreToolRef[];
    check(call: CoreToolInvocation): Promise<CoreToolCheck>;
    invoke(call: CoreToolInvocation): Promise<ToolExecutionResult>;
  };
  readonly commands: {
    register(spec: CoreCommandSpec): CoreResourceRegistration;
    list(): readonly Pick<CoreCommandSpec, 'name' | 'description'>[];
    run(input: { readonly name: string; readonly args?: unknown }): Promise<unknown>;
  };
  readonly prompts: {
    register(section: CorePromptSection): CoreResourceRegistration;
    sections(): readonly CorePromptSection[];
    compose(system: string): Promise<string>;
    composeSections(input: CorePromptComposition): Promise<CorePromptComposition>;
    composeDefault(
      facts?: import('./prompt-composition.js').CorePromptFacts
    ): Promise<CorePromptComposition>;
  };
  readonly clock: {
    now(): number;
    sleep(input: { readonly durationMs: number; readonly signal?: AbortSignal }): Promise<void>;
    after(
      durationMs: number,
      callback: (call: CoreOperationContext) => void | Promise<void>
    ): CoreResourceRegistration;
    every(
      durationMs: number,
      callback: (call: CoreOperationContext) => void | Promise<void>
    ): CoreResourceRegistration;
  };
}
export interface CoreServiceDeclaration {
  readonly key: { readonly id: string; readonly scope: 'agent' | 'session' };
  readonly intent?: 'provide' | 'replace' | 'wrap';
}
export interface CoreServiceDependency {
  readonly key: { readonly id: string; readonly scope: 'agent' | 'session' };
  readonly optional?: boolean;
}
export interface CoreRuntimeExtension {
  readonly dataDirectory?: string;
  readonly id: string;
  readonly apiVersion: '1.0';
  readonly bindings?: Readonly<Record<string, unknown>>;
  readonly requires?: readonly { readonly id: string }[];
  readonly optional?: readonly { readonly id: string }[];
  readonly provides?: readonly CoreServiceDeclaration[];
  readonly serviceDependencies?: readonly CoreServiceDependency[];
  readonly failurePolicy?: 'disable-extension' | 'fail-composition';
  setup?(context: CoreAgentExtensionContext): void | CoreDisposer | Promise<void | CoreDisposer>;
  attachSession?(
    context: CoreSessionExtensionContext
  ): void | CoreDisposer | Promise<void | CoreDisposer>;
}
export interface CoreExtensionSnapshot {
  readonly revision: string;
  readonly extensions: readonly CoreRuntimeExtension[];
}
export interface CoreExtensionSource {
  resolve(input: { readonly signal: AbortSignal }): Promise<CoreExtensionSnapshot>;
}
export interface CoreExtensionDiagnostic {
  readonly code: string;
  readonly extensionId?: string;
  readonly sessionId?: string;
  readonly revision?: string;
  readonly operationId?: string;
  readonly message?: string;
}
