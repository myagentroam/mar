import { describe, expect, it } from 'vitest';
import { conversationItemSchema, toolPresentationSchema } from '../../src/index.js';

describe('tool presentation protocol', () => {
  it.each(['WEB_SEARCH', 'WEB_FETCH', 'SKILL', 'SLEEP'] as const)(
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
