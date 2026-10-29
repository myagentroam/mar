import type { ToolCall, ToolExecutionResult } from '../contracts.js';
import type { CodeModeStateEntry, CodeModeStateMutation } from '../../session/code-state.js';

export type ProgrammaticToolResult = Omit<ToolExecutionResult, 'content'> & { content?: string };

export interface CodeModeCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly inputMode: 'json' | 'freeform';
}

/** A trusted, replaceable worker-side engine; no engine handles cross this interface. */
export interface CodeModeEngine {
  execute(input: {
    code: string;
    tools: readonly string[];
    catalog: readonly CodeModeCatalogEntry[];
    state: readonly CodeModeStateEntry[];
    signal: AbortSignal;
    limits: {
      memoryBytes: number;
      stackBytes: number;
      /** Cumulative synchronous guest execution budget; asynchronous waiting is excluded. */
      timeoutMs: number;
      outputBytes: number;
      stateEntries: number;
      stateMutations: number;
      stateKeyBytes: number;
      stateValueBytes: number;
      stateTotalBytes: number;
      sleepMs: number;
    };
    onToolCall(call: ToolCall): Promise<ProgrammaticToolResult>;
    onText(value: string, originalBytes?: number): void;
    onImage(value: unknown): void;
    onObserve(
      value:
        | { type: 'tool_result'; operationId: string }
        | {
            type: 'value';
            format: 'text' | 'json';
            value: string;
            originalBytes: number;
            /** Public display tail, independent of the model capture budget. */
            displayValue?: string;
          }
        | { type: 'image'; value: unknown }
    ): void;
    onYield(): void;
  }): Promise<{ readonly stateMutations: readonly CodeModeStateMutation[] }>;
  dispose(): Promise<void>;
}

/** Only the Local Host may supply this descriptor; it is never part of model tool input. */
export interface CodeModeEngineFactory {
  readonly moduleUrl: string;
  readonly runtimeDirectories: readonly string[];
  readonly options?: Readonly<Record<string, unknown>>;
}

export type CreateCodeModeEngine = (
  options: Readonly<Record<string, unknown>>
) => Promise<CodeModeEngine>;
