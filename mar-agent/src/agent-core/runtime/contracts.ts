import type { MarAgentReasoningEffort } from '../model/configuration.js';
import type { ModelImage } from '../model/image.js';

/** @deprecated MAR Agent always executes tools directly through the Host. */
export type AccessMode = 'full-access';
export type ExecutionMode = 'run' | 'plan' | 'compact';
export interface RunInputImage extends ModelImage {
  name: string;
}
export interface MarAgentImageMetadata {
  name: string;
  mimeType: string;
  byteSize: number;
}
export interface RunInput {
  prompt: string;
  clientMessageId?: string;
  modelId?: string;
  reasoningEffort?: MarAgentReasoningEffort;
  /** @deprecated Accepted for source compatibility and otherwise ignored. */
  access?: AccessMode;
  permissionMode?: import('../tools/permissions.js').PermissionMode;
  images?: readonly RunInputImage[];
}
export interface ExecutionResult {
  executionId: string;
  status: 'completed' | 'failed' | 'cancelled';
  finalAnswer: string;
  permissionStop?: import('../tools/permissions.js').PermissionStop;
  /** The input hook answered without admitting input; no model Turn was requested. */
  inputHandled?: boolean;
  errorCode?: string;
  errorMessage?: string;
}
/** @deprecated Execution token budgets are no longer enforced. */
export interface RolloutBudgetOptions {
  limitTokens?: number;
  conserveAtRemainingTokens?: number;
  finalizeAtRemainingTokens?: number;
  samplingTokenWeight?: number;
  prefillTokenWeight?: number;
}
