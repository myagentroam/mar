import { describe, expect, it } from 'vitest';
import { countModelTokens, truncateModelText } from '../../src/agent-core/runtime/token-budget.js';

describe('model token budget', () => {
  it('counts and bounds mixed code and multilingual tool output with a shared byte estimate', () => {
    const multilingualEvidence = '中文证据';
    const input = `${'const value = 123;\n'.repeat(2_000)}${`${multilingualEvidence}\n`.repeat(4_000)}`;
    const result = truncateModelText(input, 1_000);
    expect(result.truncated).toBe(true);
    expect(result.omittedTokens).toBeGreaterThan(0);
    expect(result.content).toContain('Warning: truncated output (original token count:');
    expect(result.content).toContain('Total output lines: 6000');
    expect(result.content).toContain('tokens of tool output omitted');
    expect(result.content).toContain('const value = 123;');
    expect(result.content).toContain(multilingualEvidence);
    expect(countModelTokens(result.content)).toBeLessThanOrEqual(1_000);
  });

  it('estimates UTF-8 bytes deterministically without interpreting special tokens', () => {
    for (const text of [
      '',
      'a',
      'abcd',
      'abcde',
      '中文',
      '\u{1f680}',
      '\ud800',
      '\udc00',
      'a\r\nb\t\u0000',
      '<|endoftext|>',
      '<|fim_prefix|>'
    ])
      expect(countModelTokens(text)).toBe(Math.ceil(Buffer.byteLength(text, 'utf8') / 4));
  });

  it('preserves exact-fit inputs and leaves their original code units untouched', () => {
    for (const text of ['', 'abcde', '中文', '\ud800', '<|endoftext|>']) {
      expect(truncateModelText(text, countModelTokens(text))).toEqual({
        content: text,
        truncated: false,
        omittedTokens: 0
      });
    }
  });

  it('bounds every small budget without splitting UTF-8 characters', () => {
    const content = `HEAD:${'a\u00e9中\u{1f680}'.repeat(200)}:TAIL`;
    for (let budget = 0; budget < 160; budget++) {
      const result = truncateModelText(content, budget);
      expect(result.truncated).toBe(true);
      expect(result.omittedTokens).toBeGreaterThan(0);
      expect(countModelTokens(result.content)).toBeLessThanOrEqual(budget);
      expect(result.content).not.toContain('\ufffd');
      expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(budget * 4);
      if (budget >= 40) {
        expect(result.content).toContain('Warning: truncated output (original token count:');
        expect(result.content).toContain('Total output lines: 1');
        expect(result.content).toContain('HEAD:');
        expect(result.content.endsWith(':TAIL')).toBe(true);
        expect(result.content).toContain('tokens of tool output omitted');
      }
    }
  });

  it('includes arbitrary omission labels in the same budget', () => {
    const content = 'source '.repeat(2_000);
    for (const label of ['evidence', '中文', 'long label '.repeat(100)]) {
      for (const budget of [0, 1, 8, 16, 32, 100, 400]) {
        const result = truncateModelText(content, budget, label);
        expect(result.truncated).toBe(true);
        expect(countModelTokens(result.content)).toBeLessThanOrEqual(budget);
      }
    }
  });

  it('uses caller-provided source diagnostics instead of serialized-envelope statistics', () => {
    const result = truncateModelText(
      '{"stdout":"line 1\\nline 2"}'.repeat(1_000),
      100,
      'tool output',
      {
        originalTokenCount: 4_321,
        totalLines: 2
      }
    );

    expect(result.content).toContain('original token count: 4321');
    expect(result.content).toContain('Total output lines: 2');
  });
});
