import type { AgentReasoningEffort } from '../model/configuration.js';
import type { ModelStopReason, ModelUsage, ModelTextBlock } from '../model/contracts.js';
import type {
  ExtensionModelMessage,
  ExtensionModelRequest,
  ExtensionRequestSnapshot,
  DomainModelRequestOperations,
  DomainModelRequestFacts
} from './model-request.js';
import type { ExtensionOperationContext, ExtensionOperationRunner } from './operation.js';
import type { ExtensionModelEvent } from './model-stream.js';
import type { ExtensionHooks } from './hooks.js';

export interface ExtensionModelDescription {
  readonly id: string;
  readonly name: string;
  /** Actual model service ID, distinct from the configuration ID and display name. */
  readonly modelId?: string;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly inputCapabilities: readonly string[];
  readonly reasoningEfforts: readonly AgentReasoningEffort[];
  readonly isDefault: boolean;
}
export type ExtensionModelTextBlock = ModelTextBlock;
export interface ExtensionGenerateInput {
  readonly signal?: AbortSignal;
  readonly requestSnapshot?: ExtensionRequestSnapshot;
  readonly modelId?: string;
  readonly system?: string | readonly ExtensionModelTextBlock[];
  readonly messages?: readonly ExtensionModelMessage[];
  readonly prompt?: string | readonly ExtensionModelTextBlock[];
  readonly retainToolCatalog?: boolean;
  readonly outputLimit?: number;
  readonly reasoningEffort?: AgentReasoningEffort;
}
export interface ExtensionGenerateResult {
  readonly outcome: 'text' | 'empty' | 'cancelled';
  readonly text: string;
  readonly stopReason: ModelStopReason;
  readonly usage?: Readonly<ModelUsage>;
}
export interface ExtensionModelsApi {
  list(): readonly ExtensionModelDescription[];
  generate(input: ExtensionGenerateInput): Promise<ExtensionGenerateResult>;
}
/** Application model configuration stays at the SDK boundary, not in plugin bindings or logs. */
export interface ExtensionModelsBackend {
  list(): readonly ExtensionModelDescription[];
  generate(
    input: ExtensionGenerateInput,
    call: ExtensionOperationContext,
    transform: (request: ExtensionModelRequest) => Promise<ExtensionModelRequest>,
    transformEvent: (
      event: ExtensionModelEvent,
      signal: AbortSignal
    ) => Promise<ExtensionModelEvent | undefined>,
    diagnoseCleanup?: (code: string) => void
  ): Promise<ExtensionGenerateResult>;
}

/** Binds model requests to the owning Extension operation and its hook lane. */
export function bindCoreModels(
  backend: ExtensionModelsBackend,
  run: ExtensionOperationRunner,
  hooks: Pick<ExtensionHooks<DomainModelRequestOperations, DomainModelRequestFacts>, 'invoke'>,
  modelEvent: (
    event: ExtensionModelEvent,
    call: ExtensionOperationContext
  ) => Promise<ExtensionModelEvent | undefined>,
  diagnose: (code: string, call: ExtensionOperationContext) => void
): ExtensionModelsApi {
  return {
    list: () => backend.list(),
    generate: (input) =>
      run(
        (call) =>
          backend.generate(
            input,
            call,
            (request) => hooks.invoke('model.request', request, call, async (view) => view),
            (event, signal) => modelEvent(event, Object.freeze({ ...call, signal })),
            (code) => diagnose(code, call)
          ),
        input.signal
      )
  };
}
