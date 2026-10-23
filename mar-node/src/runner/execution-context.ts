import type { RunnerName } from '@myagentroam/protocol';
import type { MarAgentExecutionInput } from './mar-agent/execution-input.js';

export const RUNNER_EXECUTION_CONTEXT = Symbol('runner-execution-context');

/** Captured input is not evidence that the Runner has accepted its configuration. */
export type RunnerExecutionContext =
  | { readonly runner: 'mar-agent'; readonly runnerInput?: MarAgentExecutionInput }
  | { readonly runner: Exclude<RunnerName, 'mar-agent'> | 'fake'; readonly runnerInput?: never };
