import { describe, expect, it } from 'vitest';
import { mergeConversationItemPayload } from '../../src/session/runtime/conversation-projection.js';

describe('public tool output reduction', () => {
  it('preserves input truncation when an output delta declares source truncation', () => {
    const frame = (text: string, truncation: Record<string, unknown>) => ({
      output: { text, truncated: truncation.output !== undefined },
      toolPresentation: {
        kind: 'EXECUTION',
        execution: {
          kind: 'SHELL',
          output: [{ channel: 'STDOUT', text }],
          truncation
        }
      }
    });
    const value = mergeConversationItemPayload(frame('before', { input: true }), {
      itemId: 'call',
      kind: 'command_execution',
      status: 'IN_PROGRESS',
      merge: true,
      append: 'output',
      payload: frame('after', { output: 'SOURCE' })
    });
    expect(value.toolPresentation).toMatchObject({
      execution: {
        output: [{ channel: 'STDOUT', text: 'beforeafter' }],
        truncation: { input: true, output: 'SOURCE' }
      }
    });
    expect(value.output).toEqual({ text: 'beforeafter', truncated: true });
  });
  it('appends each execution channel with bounded HEAD and replaces at terminal', () => {
    const frame = (stdout: string, stderr: string) => ({
      output: { text: stdout + stderr, truncated: false },
      outputPreview: stdout + stderr,
      toolPresentation: {
        kind: 'EXECUTION',
        execution: {
          kind: 'SHELL',
          output: [
            { channel: 'STDOUT', text: stdout },
            { channel: 'STDERR', text: stderr }
          ]
        }
      }
    });
    const update = (value: unknown, payload: Record<string, unknown>, append: boolean) =>
      mergeConversationItemPayload(value, {
        itemId: 'a',
        kind: 'command_execution',
        status: 'IN_PROGRESS',
        merge: true,
        payload,
        ...(append ? { append: 'output' as const } : {})
      });
    let value = update({}, frame('a'.repeat(9999), 'err'), true);
    value = update(value, frame('😀tail', '!'), true);
    expect(value.toolPresentation).toMatchObject({
      execution: {
        truncation: { output: 'HEAD' },
        output: [
          { channel: 'STDOUT', text: expect.stringMatching(/😀tail$/u) },
          { channel: 'STDERR', text: 'err!' }
        ]
      }
    });
    value = update(value, frame('final', ''), false);
    expect(value.toolPresentation).toMatchObject({
      execution: {
        output: [
          { channel: 'STDOUT', text: 'final' },
          { channel: 'STDERR', text: '' }
        ]
      }
    });
    expect(
      (value.toolPresentation as { execution: { truncation?: unknown } }).execution.truncation
    ).toBeUndefined();
  });
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
