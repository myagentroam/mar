import { describe, expect, it } from 'vitest';
import { mergeConversationItemPayload } from '../../src/session/runtime/conversation-projection.js';

describe('public tool output reduction', () => {
  it.each(['command_execution', 'tool_call'])(
    'appends deltas and replaces snapshots and terminal output for %s',
    (kind) => {
      const update = (current: unknown, text: string, truncated: boolean, append = false) =>
        mergeConversationItemPayload(current, {
          itemId: 'call',
          kind,
          status: 'IN_PROGRESS',
          merge: true,
          payload: { output: { text, truncated } },
          ...(append ? { append: 'output' as const } : {})
        });
      let value: Record<string, unknown> = { inputSummary: 'input', truncated: true };
      value = update(value, 'one', false, true);
      value = update(value, 'two', false, true);
      expect(value.output).toEqual({ text: 'onetwo', truncated: false });
      value = update(value, 'snapshot', true);
      expect(value.output).toEqual({ text: 'snapshot', truncated: true });
      value = update(value, 'snapshot', false);
      expect(value.output).toEqual({ text: 'snapshot', truncated: false });
      value = update(value, '!', false, true);
      expect(value.output).toEqual({ text: 'snapshot!', truncated: false });
      value = update(value, 'final', false);
      expect(value.output).toEqual({ text: 'final', truncated: false });
      expect(value.truncated).toBe(true);
      value = update(value, 'x'.repeat(10_100), false, true);
      expect((value.output as { text: string }).text.length).toBeLessThanOrEqual(10_000);
      expect((value.output as { truncated: boolean }).truncated).toBe(true);
      value = update(value, '😀newest', false, true);
      value = update(value, '-tail', false, true);
      expect(value.output).toMatchObject({
        text: expect.stringMatching(/😀newest-tail$/u),
        truncated: true
      });
      expect((value.output as { text: string }).text).not.toMatch(/^[\uDC00-\uDFFF]/u);
      value = update(value, 'short', true);
      expect(value.output).toEqual({ text: 'short', truncated: true });
    }
  );
});
