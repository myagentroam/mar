import type { ExecutionResult, RunInput } from './contracts.js';
import type { MarAgentEvent } from './events.js';

/** A live execution exposes streamed events separately from its terminal result. */
export interface ExecutionHandle extends AsyncIterable<MarAgentEvent> {
  readonly executionId: string;
  result(): Promise<ExecutionResult>;
  /** Signals abort; await result() to observe the terminal status and cleanup. */
  cancel(): void;
}
export type CompactInput = Partial<RunInput> & { readonly async?: boolean };
