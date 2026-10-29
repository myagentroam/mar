import { describe, expect, it } from 'vitest';
import { executionPresentationSchema } from '@myagentroam/protocol';
import { boundExecutionPresentation } from '../../src/runner/execution-presentation.js';

describe('bounded execution presentation', () => {
  it('bounds very large Unicode output before aggregation without mutating the source', () => {
    const output = `${'😀'.repeat(500_001)}end`;
    const source = {
      kind: 'SHELL' as const,
      output: [{ channel: 'COMBINED' as const, text: output }],
      truncation: { output: 'SOURCE' as const }
    };
    const result = boundExecutionPresentation(source);
    expect(source.output[0]?.text).toBe(output);
    expect(result.presentation.execution.output?.[0]?.text.endsWith('end')).toBe(true);
    expect(result.presentation.execution.truncation?.output).toBe('SOURCE');
    expect(result.truncated).toBe(true);
    expect(executionPresentationSchema.safeParse(result.presentation).success).toBe(true);
  });

  it('bounds escaped output including JSON overhead', () => {
    const result = boundExecutionPresentation({
      kind: 'CODE',
      output: [
        { channel: 'STDOUT', text: '\u0001'.repeat(10_000) },
        { channel: 'STDERR', text: '\u0002'.repeat(10_000) },
        { channel: 'TEXT', text: '\u0003'.repeat(10_000) }
      ]
    });
    expect(Buffer.byteLength(JSON.stringify(result.presentation))).toBeLessThanOrEqual(128 * 1024);
    expect(result.truncated).toBe(true);
    expect(executionPresentationSchema.safeParse(result.presentation).success).toBe(true);
  });
});
