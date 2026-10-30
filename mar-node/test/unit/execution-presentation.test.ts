import { describe, expect, it } from 'vitest';
import { executionPresentationSchema } from '@myagentroam/protocol';
import { shellExecution } from '../../src/runner/execution-presentation.js';

describe('execution metadata presentation', () => {
  it('projects shell metadata without a second output owner', () => {
    const result = shellExecution();
    expect(result).toEqual({ kind: 'EXECUTION', execution: { kind: 'SHELL' } });
    expect(executionPresentationSchema.safeParse(result).success).toBe(true);
  });

  it('retains input clipping independently of output', () => {
    const result = shellExecution(true);
    expect(result).toEqual({
      kind: 'EXECUTION',
      execution: { kind: 'SHELL', truncation: { input: true } }
    });
    expect(executionPresentationSchema.safeParse(result).success).toBe(true);
  });
});
