import type { AgentReasoningEffort } from '../model/configuration.js';
import type { ModelImage } from '../model/image-contract.js';

export type ExecutionMode = 'run' | 'plan' | 'compact';
export interface RunInputImage extends ModelImage {
  name: string;
}
export interface AgentImageMetadata {
  name: string;
  mimeType: string;
  byteSize: number;
}
export interface RunInput {
  prompt: string;
  clientMessageId?: string;
  modelId?: string;
  reasoningEffort?: AgentReasoningEffort;
  permissionMode?: import('../tools/permission-contract.js').PermissionMode;
  images?: readonly RunInputImage[];
}
export interface ExecutionResult {
  executionId: string;
  status: 'completed' | 'failed' | 'cancelled';
  finalAnswer: string;
  permissionStop?: import('../tools/permission-contract.js').PermissionStop;
  /** The input hook answered without admitting input; no model Turn was requested. */
  inputHandled?: boolean;
  errorCode?: string;
  errorMessage?: string;
}
