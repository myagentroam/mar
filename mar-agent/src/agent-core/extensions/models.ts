import type { MarAgentReasoningEffort } from '../model/configuration.js';
import type { ModelStopReason, ModelUsage, ModelTextBlock } from '../model/contracts.js';
import type { CoreModelMessage, CoreModelRequest, CoreRequestSnapshot } from './model-request.js';
import type { CoreOperationContext } from './operation.js';
import type { CoreModelEvent } from './model-stream.js';

export interface CoreModelDescription {
  readonly id: string;
  readonly name: string;
  /** Actual model service ID, distinct from the configuration ID and display name. */
  readonly modelId?: string;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly inputCapabilities: readonly string[];
  readonly reasoningEfforts: readonly MarAgentReasoningEffort[];
  readonly isDefault: boolean;
}
export type CoreModelTextBlock = ModelTextBlock;
export interface CoreGenerateInput {
  readonly signal?: AbortSignal;
  readonly requestSnapshot?: CoreRequestSnapshot;
  readonly modelId?: string;
  readonly system?: string | readonly CoreModelTextBlock[];
  readonly messages?: readonly CoreModelMessage[];
  readonly prompt?: string | readonly CoreModelTextBlock[];
  readonly retainToolCatalog?: boolean;
  readonly outputLimit?: number;
  readonly reasoningEffort?: MarAgentReasoningEffort;
}
export interface CoreGenerateResult {
  readonly outcome: 'text' | 'empty' | 'cancelled';
  readonly text: string;
  readonly stopReason: ModelStopReason;
  readonly usage?: Readonly<ModelUsage>;
}
export interface CoreModelsApi {
  list(): readonly CoreModelDescription[];
  generate(input: CoreGenerateInput): Promise<CoreGenerateResult>;
}
/** Application model configuration stays at the SDK boundary, not in plugin bindings or logs. */
export interface CoreModelsBackend {
  list(): readonly CoreModelDescription[];
  generate(
    input: CoreGenerateInput,
    call: CoreOperationContext,
    transform: (request: CoreModelRequest) => Promise<CoreModelRequest>,
    transformEvent: (
      event: CoreModelEvent,
      signal: AbortSignal
    ) => Promise<CoreModelEvent | undefined>,
    diagnoseCleanup?: (code: string) => void
  ): Promise<CoreGenerateResult>;
}
