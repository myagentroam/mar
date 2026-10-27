import type { ModelEvent } from '../model/contracts.js';
import type { ToolExecutionResult } from '../tools/contracts.js';

export type ClientToolCall = Extract<ModelEvent, { type: 'client_tool.call' }>;
export type ExecutedToolCall = {
  call: ClientToolCall;
  content: string;
  images?: ToolExecutionResult['images'];
  sourceImages?: ToolExecutionResult['images'];
  observations?: ToolExecutionResult['observations'];
  calls?: ToolExecutionResult['calls'];
} & ({ failed: false; output: ToolExecutionResult } | { failed: true; error: unknown });
