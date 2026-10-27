/** Execution metadata is independent of explicit model observations. */
export interface CodeToolCallRecord {
  callId: string;
  toolName: string;
  input: unknown;
  status: 'running' | 'completed' | 'failed';
  resultExtensions?: readonly import('../tools/result-extension-contract.js').ToolResultExtension[];
  result?: { content: string; data?: unknown; truncated?: boolean };
  error?: { code: string; message: string };
}

export type CodeObservation =
  | {
      type: 'tool_result';
      id: string;
      source: { callId: string; toolName: string; input: unknown };
      outcome: 'completed' | 'failed';
      result: { content: string; data?: unknown; truncated?: boolean; imageIndices?: number[] };
    }
  | {
      type: 'value';
      id: string;
      format: 'text' | 'json' | 'image';
      value: string;
      truncated?: boolean;
      imageIndices?: number[];
    };
