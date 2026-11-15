import { describe, expect, it } from 'vitest';
import { execToolInput, parseExecInput } from '../../src/tools/local/exec.js';
import { TOOL_EXECUTION_LIMITS } from '../../src/tools/execution-limits.js';

describe('exec input diagnostics', () => {
  it.each([
    ['exec', null, 'object'],
    ['exec_wait', [], 'object'],
    ['exec', {}, 'command'],
    ['exec', { command: '   ' }, 'command'],
    ['exec', { command: 123 }, 'command'],
    ['exec', { command: 'test', cwd: false }, 'cwd'],
    ['exec', { command: 'test', login: 'PRIVATE_VALUE' }, 'login'],
    ['exec', { command: 'test', yieldMs: -1 }, 'yieldMs'],
    ['exec', { command: 'test', timeoutMs: 0 }, 'timeoutMs'],
    ['exec_wait', {}, 'processId'],
    ['exec_wait', { processId: 123 }, 'processId'],
    ['exec_wait', { processId: 'p', action: 'PRIVATE_VALUE' }, 'action'],
    ['exec_wait', { processId: 'p', yieldMs: 1.5 }, 'yieldMs'],
    ['exec_wait', { processId: 'p', action: 'write' }, 'data'],
    ['exec_wait', { processId: 'p', action: 'write', data: false }, 'data']
  ] as const)('identifies the invalid field for %s %#', (name, input, field) => {
    let error: unknown;
    try {
      execToolInput(name, input);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: 'MAR_AGENT_TOOL_INPUT_INVALID',
      message: expect.stringContaining(field)
    });
    expect((error as Error).message).not.toBe('Exec input is invalid.');
    expect((error as Error).message).not.toContain('PRIVATE_VALUE');
  });

  it('describes allowed fields without echoing unknown names or parameter values', () => {
    let error: unknown;
    try {
      execToolInput('exec', {
        command: 'PRIVATE_COMMAND',
        ['PRIVATE_FIELD'.repeat(1000)]: 'PRIVATE_VALUE'
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: 'MAR_AGENT_TOOL_INPUT_INVALID',
      message: expect.stringContaining('command')
    });
    const message = (error as Error).message;
    expect(message).toContain('Unexpected fields');
    expect(message).not.toContain('PRIVATE_');
    expect(message.length).toBeLessThan(200);
  });

  it('retains defaults, nullable option omission, empty stdin and numeric caps', () => {
    expect(
      execToolInput('exec', {
        command: 'test',
        cwd: null,
        login: null,
        timeoutMs: null,
        yieldMs: null
      })
    ).toEqual({ command: 'test' });
    expect(execToolInput('exec', { command: 'test', timeoutMs: 1e10, yieldMs: 1e10 })).toEqual({
      command: 'test',
      timeoutMs: TOOL_EXECUTION_LIMITS.execMaxTimeoutMs,
      yieldMs: TOOL_EXECUTION_LIMITS.execMaxYieldMs
    });
    expect(execToolInput('exec_wait', { processId: 'p', action: null, yieldMs: null })).toEqual({
      action: 'poll',
      processId: 'p',
      yieldMs: TOOL_EXECUTION_LIMITS.execDefaultYieldMs
    });
    expect(execToolInput('exec_wait', { processId: 'p', yieldMs: 1e10 })).toMatchObject({
      yieldMs: TOOL_EXECUTION_LIMITS.execMaxPollYieldMs
    });
    expect(execToolInput('exec_wait', { processId: 'p', action: 'write', data: '' })).toEqual({
      action: 'write',
      processId: 'p',
      data: ''
    });
    expect(execToolInput('exec_wait', { processId: 'p', action: 'cancel' })).toEqual({
      action: 'cancel',
      processId: 'p'
    });
  });

  it('also diagnoses the shared internal entry point without coercing action values', () => {
    expect(() => parseExecInput({ action: 'start' })).toThrow(/command/);
    expect(() => parseExecInput({ action: 'PRIVATE_VALUE' })).toThrow(/action/);
    expect(() => parseExecInput({ action: ['poll'], processId: 'p' })).toThrow(/action/);
    expect(parseExecInput({ action: 'start', command: 'test' })).toEqual({
      action: 'start',
      command: 'test'
    });
  });
});
