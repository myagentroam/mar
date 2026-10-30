import { describe, expect, it } from 'vitest';
import {
  appendToolOutput,
  boundToolOutput,
  conversationItemSchema,
  toolOutputSchema,
  toolPresentationSchema
} from '../../src/index.js';

describe('tool presentation protocol', () => {
  it('bounds very large Unicode output without mutating the source or losing SOURCE', () => {
    const text = `${'😀'.repeat(500_001)}end`;
    const blocks = [{ channel: 'COMBINED' as const, text }];
    const result = boundToolOutput(blocks, 'SOURCE');
    expect(blocks[0]?.text).toBe(text);
    expect(result.blocks[0]?.text).toBe(`${'😀'.repeat(4_998)}end`);
    expect(result.truncation).toBe('SOURCE');
    expect(toolOutputSchema.safeParse(result).success).toBe(true);
  });
  it('bounds channel tails and preserves SOURCE across appends', () => {
    const first = boundToolOutput([{ channel: 'STDOUT', text: 'A'.repeat(10_000) }], 'SOURCE');
    const second = appendToolOutput(first, { blocks: [{ channel: 'STDOUT', text: '😀TAIL' }] });
    expect(second.truncation).toBe('SOURCE');
    expect(second.blocks[0]?.text).toHaveLength(10_000);
    expect(second.blocks[0]?.text.endsWith('😀TAIL')).toBe(true);
    expect(appendToolOutput(second, { blocks: [] })).toEqual(second);
    expect(() =>
      appendToolOutput(
        { blocks: [{ channel: 'COMBINED', text: 'x' }] },
        { blocks: [{ channel: 'STDOUT', text: 'y' }] }
      )
    ).toThrow();
  });
  it('enforces the aggregate byte budget after per-block bounds', () => {
    const output = boundToolOutput(
      ['TEXT', 'STDOUT', 'STDERR'].map((channel) => ({
        channel: channel as 'TEXT' | 'STDOUT' | 'STDERR',
        text: '\u0000'.repeat(10_000)
      }))
    );
    expect(new TextEncoder().encode(JSON.stringify(output)).length).toBeLessThanOrEqual(128 * 1024);
    expect(output.truncation).toBe('HEAD');
    expect(toolOutputSchema.safeParse(output).success).toBe(true);
  });
  it('bounds Read paths without treating them as successful file changes', () => {
    expect(
      toolPresentationSchema.parse({ kind: 'READ', paths: ['src/a.ts', '目录/b.ts'] })
    ).toEqual({ kind: 'READ', paths: ['src/a.ts', '目录/b.ts'] });
    for (const paths of [[''], ['x'.repeat(4097)], Array(17).fill('a'), [1]])
      expect(toolPresentationSchema.safeParse({ kind: 'READ', paths }).success).toBe(false);
  });
  it.each(['READ', 'WEB_SEARCH', 'WEB_FETCH', 'SKILL', 'SLEEP'] as const)(
    'preserves optional %s facts on ordinary tool_call items',
    (kind) => {
      const item = {
        id: 'tool',
        sessionId: 'session',
        turnId: 'turn',
        runId: null,
        parentItemId: null,
        sourceSequence: null,
        revision: 1,
        startedAt: null,
        completedAt: null,
        kind: 'tool_call',
        status: 'COMPLETED',
        payload: {
          namespace: 'mar-agent',
          title: 'Native tool',
          toolName: 'native',
          inputSummary: null,
          outputSummary: null,
          progressLabel: null,
          errorCode: null,
          truncated: false,
          toolPresentation: { kind }
        }
      };
      expect(conversationItemSchema.parse(item)).toEqual(item);
      delete (item.payload as { toolPresentation?: unknown }).toolPresentation;
      expect(conversationItemSchema.parse(item)).toEqual(item);
    }
  );
  it('accepts the maximum wait and integer elapsed time but rejects unsupported facts', () => {
    expect(
      toolPresentationSchema.parse({
        kind: 'SLEEP',
        durationMs: 1800000,
        elapsedMs: 0,
        wakeReason: 'steer',
        startedAt: '2026-10-20T00:00:00.000Z'
      })
    ).toBeDefined();
    for (const value of [
      { kind: 'SLEEP', durationMs: 1800001 },
      { kind: 'SLEEP', elapsedMs: 1.5 },
      { kind: 'SLEEP', wakeReason: 'exec_completed' },
      { kind: 'SLEEP', startedAt: 'local time' },
      { kind: 'WEB_SEARCH', sourceCount: -1 },
      {
        kind: 'WEB_SEARCH',
        sources: Array.from({ length: 21 }, () => ({ url: 'https://example.com/' }))
      },
      { kind: 'OTHER' }
    ])
      expect(toolPresentationSchema.safeParse(value).success).toBe(false);
  });
});
