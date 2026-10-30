import { describe, expect, it } from 'vitest';
import { mergeConversationItemPayload } from '../../src/session/runtime/conversation-projection.js';
import { MarAgentConversationNormalizer } from '../../src/runner/mar-agent/conversation-normalizer.js';
import type { AgentEvent } from '@myagentroam/agent';

describe('public tool output reduction', () => {
  it.each(['code_exec', 'code_exec_wait'])(
    'does not replace %s output with failure diagnostics',
    (name) => {
      const normalizer = new MarAgentConversationNormalizer();
      const event = (value: Record<string, unknown>) =>
        ({
          eventId: 'event',
          timestamp: '2026-01-01T00:00:00.000Z',
          sessionId: 'session',
          executionId: 'execution',
          turnId: 'turn',
          callId: 'call',
          toolName: name,
          ...value
        }) as AgentEvent;
      const [started] = normalizer.normalize(
        event({
          type: 'tool.started',
          input: name === 'code_exec' ? { code: 'run()' } : { cellId: 'cell' }
        })
      );
      if (name === 'code_exec')
        normalizer.normalize(
          event({
            type: 'tool.started',
            callId: 'child',
            parentCallId: 'call',
            toolName: 'exec',
            input: { command: 'run' }
          })
        );
      const [output] = normalizer.normalize(
        event({
          type: 'tool.output',
          outputTruncation: 'HEAD',
          ...(name === 'code_exec'
            ? { callId: 'child', parentCallId: 'call', toolName: 'exec' }
            : {}),
          output: {
            processId: 'p',
            mode: 'snapshot',
            stdout: 'tail',
            stderr: '',
            truncated: true,
            displayOutput: {
              stdout: 'tail',
              stderr: '',
              stdoutDroppedBytes: 9,
              stderrDroppedBytes: 0
            }
          }
        })
      );
      const [failed] = normalizer.normalize(
        event({ type: 'tool.failed', code: 'FAILED', message: 'diagnostic' })
      );
      expect(started && output && failed).toBeTruthy();
      let payload = mergeConversationItemPayload({}, { ...started!, merge: true });
      payload = mergeConversationItemPayload(payload, { ...output!, merge: true });
      payload = mergeConversationItemPayload(payload, { ...failed!, merge: true });
      expect(payload.output).toEqual({
        blocks: [{ channel: 'STDOUT', text: 'tail' }],
        truncation: 'HEAD'
      });
      expect(failed!.payload).not.toHaveProperty('output');
      expect(payload.toolPresentation).toMatchObject({
        execution: { error: { message: 'diagnostic' } }
      });
    }
  );
  it('replaces snapshots, keeps empty append, and rejects channel-switch deltas', () => {
    const frame = (
      blocks: Array<{ channel: 'COMBINED' | 'STDOUT'; text: string }>,
      append = false
    ) => ({
      itemId: 'call',
      kind: 'tool_call' as const,
      status: 'IN_PROGRESS' as const,
      merge: true,
      ...(append ? { append: 'output' as const } : {}),
      payload: { output: { blocks } }
    });
    let value = mergeConversationItemPayload({}, frame([{ channel: 'COMBINED', text: 'a' }]));
    value = mergeConversationItemPayload(value, frame([], true));
    expect(value.output).toEqual({ blocks: [{ channel: 'COMBINED', text: 'a' }] });
    expect(() =>
      mergeConversationItemPayload(value, frame([{ channel: 'STDOUT', text: 'b' }], true))
    ).toThrow();
    value = mergeConversationItemPayload(value, frame([{ channel: 'STDOUT', text: 'b' }]));
    expect(value.output).toEqual({ blocks: [{ channel: 'STDOUT', text: 'b' }] });
    value = mergeConversationItemPayload(value, frame([]));
    expect(value.output).toEqual({ blocks: [] });
  });
  it('preserves input truncation when an output delta declares source truncation', () => {
    const frame = (text: string, truncation: Record<string, unknown>) => ({
      output: {
        blocks: [{ channel: 'STDOUT', text }],
        ...(truncation.output ? { truncation: truncation.output } : {})
      },
      toolPresentation: {
        kind: 'EXECUTION',
        execution: {
          kind: 'SHELL',
          truncation: truncation.input ? { input: true } : undefined
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
        truncation: { input: true }
      }
    });
    expect(value.output).toEqual({
      blocks: [{ channel: 'STDOUT', text: 'beforeafter' }],
      truncation: 'SOURCE'
    });
  });
  it('appends each execution channel with bounded HEAD and replaces at terminal', () => {
    const frame = (stdout: string, stderr: string) => ({
      output: {
        blocks: [
          { channel: 'STDOUT', text: stdout },
          { channel: 'STDERR', text: stderr }
        ]
      },
      toolPresentation: {
        kind: 'EXECUTION',
        execution: {
          kind: 'SHELL'
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
    expect(value.output).toMatchObject({
      truncation: 'HEAD',
      blocks: [
        { channel: 'STDOUT', text: expect.stringMatching(/😀tail$/u) },
        { channel: 'STDERR', text: 'err!' }
      ]
    });
    value = update(value, frame('final', ''), false);
    expect(value.output).toMatchObject({
      blocks: [
        { channel: 'STDOUT', text: 'final' },
        { channel: 'STDERR', text: '' }
      ]
    });
    expect((value.output as { truncation?: unknown }).truncation).toBeUndefined();
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
