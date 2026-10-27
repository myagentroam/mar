import type { ModelUsage } from '../../model/contracts.js';

export interface ExtensionCompactDiagnostic {
  readonly modelId: string;
  readonly providerModelId?: string;
  readonly reasoningEffort: string;
  readonly state: 'STARTED' | 'SUCCEEDED' | 'DECLINED' | 'FAILED';
  readonly inputTokensEstimateBefore: number;
  readonly inputTokensEstimateAfter: number;
  readonly modelRequests: number;
  readonly elapsedMs: number;
  readonly reason?: 'INPUT_BUDGET_EXHAUSTED' | 'MODEL_INCOMPLETE' | 'MODEL_FAILED';
  readonly errorCode?: string;
  readonly trigger?: 'manual' | 'automatic';
  readonly causeCode?: string;
  readonly errorReason?: string;
  readonly httpStatus?: number;
  readonly retryable?: boolean;
  readonly transport?: 'HTTP' | 'WEBSOCKET';
}

export interface ExtensionCompactResult {
  readonly summary: string;
  readonly usage?: Readonly<ModelUsage>;
}
