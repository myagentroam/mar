import type { RunnerName } from '@myagentroam/protocol';

export const RUNNER_EXECUTION_CONTEXT = Symbol('runner-execution-context');

/** Captured input is not evidence that the Runner has accepted its configuration. */
export type RunnerExecutionContext =
  | { readonly runner: 'mar-agent'; readonly runnerInput?: unknown }
  | { readonly runner: Exclude<RunnerName, 'mar-agent'> | 'fake'; readonly runnerInput?: never };
