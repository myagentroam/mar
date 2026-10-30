import type { ExecutionPresentation } from '@myagentroam/protocol';

/** Execution metadata is independent of the public output body and its budget. */
export function shellExecution(inputTruncated = false): ExecutionPresentation {
  return {
    kind: 'EXECUTION',
    execution: {
      kind: 'SHELL',
      ...(inputTruncated ? { truncation: { input: true } } : {})
    }
  };
}
