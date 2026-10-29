import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAgentHost } from '../../src/host/local-agent-host.js';
import type { LocalProcessExecutor } from '../../src/host/local-process-executor.js';
import type { ToolExecutionContext } from '../../src/sdk/types.js';
import {
  execToolInput,
  execToolDefinition,
  execWaitToolDefinition,
  formatExecResult,
  type ExecResult
} from '../../src/tools/local/exec.js';
import { parseContextGcExecResult } from '../../src/session/context-gc-replacements.js';
import { TOOL_EXECUTION_LIMITS } from '../../src/tools/execution-limits.js';
import { createToolWaitInterrupt } from '../../src/tools/wait.js';

const hosts: LocalAgentHost[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const child of children.splice(0)) child.emit('close', 0, null);
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const context = (): ToolExecutionContext => ({
  sessionId: 'session',
  executionId: 'first',
  mode: 'run',
  signal: new AbortController().signal
});
async function fixture(processExecutor?: LocalProcessExecutor) {
  const root = await mkdtemp(join(tmpdir(), 'mar-exec-wait-'));
  roots.push(root);
  const host = new LocalAgentHost({
    homeDirectory: root,
    workspace: root,
    ...(processExecutor === undefined
      ? {}
      : {
          processExecutor: {
            async spawn(request) {
              const child = await processExecutor.spawn(request);
              children.push(child);
              return child;
            }
          }
        })
  });
  hosts.push(host);
  const call = async (name: string, args: unknown, ctx = context()) =>
    (await host.executeTool({ name, arguments: args }, ctx)).data as ExecResult;
  return { call, host };
}
const command = (script: string) => `"${process.execPath}" -e ${JSON.stringify(script)}`;

describe('exec_wait', () => {
  it('reports cumulative display snapshots across successive polls', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null
    });
    const { host } = await fixture({
      async spawn() {
        return child as unknown as ChildProcessWithoutNullStreams;
      }
    });
    const first = await host.executeTool(
      { name: 'exec', arguments: { command: 'fixture', yieldMs: 0 } },
      context()
    );
    const processId = (first.data as ExecResult).processId;
    child.stdout.write('first');
    const poll1 = await host.executeTool(
      { name: 'exec_wait', arguments: { processId, yieldMs: 0 } },
      context()
    );
    child.stdout.write(' second');
    const poll2 = await host.executeTool(
      { name: 'exec_wait', arguments: { processId, yieldMs: 0 } },
      context()
    );
    expect(poll1.eventData).toMatchObject({ displayOutput: { stdout: 'first' } });
    expect(poll2.eventData).toMatchObject({ displayOutput: { stdout: 'first second' } });
    expect(poll2.data).toMatchObject({ stdout: ' second' });
    expect(poll2.eventData).toMatchObject({
      executionSource: { kind: 'SHELL', text: 'fixture', truncated: false }
    });
    expect(poll2.data).not.toHaveProperty('executionSource');
    child.exitCode = 0;
    child.emit('close', 0, null);
  });

  it('includes process start errors in the public display tail', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null
    });
    const { host } = await fixture({
      async spawn() {
        return child as unknown as ChildProcessWithoutNullStreams;
      }
    });
    const first = await host.executeTool(
      { name: 'exec', arguments: { command: 'fixture', yieldMs: 0 } },
      context()
    );
    child.emit('error', new Error('Unable to start fixture'));
    child.exitCode = 1;
    child.emit('close', 1, null);
    const result = await host.executeTool(
      {
        name: 'exec_wait',
        arguments: { processId: (first.data as ExecResult).processId, yieldMs: 1000 }
      },
      context()
    );
    expect(result.eventData).toMatchObject({
      displayOutput: { stderr: 'Unable to start fixture' }
    });
  });

  it('replays display tails in cached events without adding them to model or guest data', async () => {
    const { host } = await fixture();
    const started = await host.executeTool(
      {
        name: 'exec',
        arguments: {
          command: command("process.stdout.write('中'.repeat(4000) + 'END')"),
          yieldMs: 10000
        }
      },
      context()
    );
    const result = started.data as ExecResult;
    expect(result).not.toHaveProperty('displayOutput');
    expect(started.content).not.toContain('displayOutput');
    const display = started.eventData?.displayOutput as {
      stdout: string;
      stdoutDroppedBytes: number;
    };
    expect(display.stdout.endsWith('END')).toBe(true);
    expect(display.stdout).not.toContain('\ufffd');
    expect(display.stdoutDroppedBytes).toBeGreaterThan(0);
    const cached = await host.executeTool(
      {
        name: 'exec_wait',
        arguments: { processId: result.processId, yieldMs: 0 }
      },
      context()
    );
    expect(cached.data).toMatchObject({ cached: true });
    expect(cached.eventData?.displayOutput).toEqual(display);
    expect(cached.data).not.toHaveProperty('displayOutput');
  });

  it.each(['stdout', 'stderr'] as const)(
    'returns buffered %s with a pending steer, without treating output as completion or replaying it',
    async (stream) => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null as number | null
      });
      const { call } = await fixture({
        async spawn() {
          return child as unknown as ChildProcessWithoutNullStreams;
        }
      });
      try {
        const started = await call('exec', { command: 'ignored', yieldMs: 0 });
        child[stream].write('ready');
        const ctx = { ...context(), waitInterrupt: createToolWaitInterrupt(() => true) };
        expect(
          await call('exec_wait', { processId: started.processId, yieldMs: 300000 }, ctx)
        ).toMatchObject({
          status: 'running',
          waitOutcome: 'interrupted',
          reason: 'steer',
          [stream]: 'ready'
        });
        expect(
          await call('exec_wait', { processId: started.processId, yieldMs: 300000 }, ctx)
        ).toMatchObject({
          status: 'running',
          waitOutcome: 'interrupted',
          reason: 'steer',
          [stream]: ''
        });
      } finally {
        child.exitCode = 0;
        child.emit('close', 0, null);
      }
    }
  );

  it.each(['exec', 'exec_wait'])(
    'aggregates output throughout the %s wait while publishing live snapshots without consuming it',
    async (name) => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null as number | null
      });
      const { call } = await fixture({
        async spawn() {
          return child as unknown as ChildProcessWithoutNullStreams;
        }
      });
      const started =
        name === 'exec_wait' ? await call('exec', { command: 'fixture', yieldMs: 0 }) : undefined;
      vi.useFakeTimers();
      const snapshots: unknown[] = [];
      const ctx = {
        ...context(),
        onOutput: async (output: unknown) => {
          snapshots.push(output);
        }
      };
      let settled = false;
      const waiting = call(
        name,
        name === 'exec'
          ? { command: 'fixture', yieldMs: 1000 }
          : { processId: started!.processId, yieldMs: 1000 },
        ctx
      ).then((result) => {
        settled = true;
        return result;
      });
      await vi.waitFor(() => expect(child.stdout.listenerCount('data')).toBe(1));
      await vi.advanceTimersByTimeAsync(0);
      child.stdout.write('first');
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(false);
      expect(snapshots).toContainEqual(expect.objectContaining({ stdout: 'first', stderr: '' }));
      child.stderr.write('warning');
      child.stdout.write('-second');
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(false);
      expect(snapshots.at(-1)).toMatchObject({
        mode: 'delta',
        stdout: '-second',
        stderr: 'warning',
        displayOutput: { stdout: 'first-second', stderr: 'warning' }
      });
      child.exitCode = 0;
      child.emit('exit', 0, null);
      child.stdout.write('-tail');
      await vi.advanceTimersByTimeAsync(20);
      expect(settled).toBe(false);
      child.emit('close', 0, null);
      expect(await waiting).toMatchObject({
        status: 'completed',
        waitOutcome: 'completion',
        stdout: 'first-second-tail',
        stderr: 'warning',
        exitCode: 0
      });
      const count = snapshots.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(snapshots).toHaveLength(count);
    }
  );

  it('keeps a fixed poll deadline despite output, then returns only new bounded output on the next poll', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null
    });
    const { call } = await fixture({
      async spawn() {
        return child as unknown as ChildProcessWithoutNullStreams;
      }
    });
    const started = await call('exec', { command: 'fixture', yieldMs: 0 });
    vi.useFakeTimers();
    const onOutput = vi.fn(async () => {});
    const waiting = call(
      'exec_wait',
      { processId: started.processId, yieldMs: 1000 },
      { ...context(), onOutput }
    );
    for (let i = 0; i < 10; i++) {
      child.stdout.write('🙂'.repeat(5000));
      await vi.advanceTimersByTimeAsync(100);
    }
    const result = await waiting;
    expect(result).toMatchObject({
      status: 'running',
      waitOutcome: 'timeout',
      stdoutBytes: 200000,
      truncated: false
    });
    expect(result.stdout).toBe('🙂'.repeat(50000));
    expect(onOutput.mock.calls.length).toBeLessThanOrEqual(10);
    expect(onOutput.mock.calls.length).toBeGreaterThan(0);
    for (const [snapshot] of onOutput.mock.calls as unknown as [ExecResult][]) {
      expect(Buffer.byteLength(snapshot.stdout)).toBeLessThanOrEqual(
        TOOL_EXECUTION_LIMITS.execProgressMaxOutputBytes
      );
      expect(snapshot.stdout).not.toContain('�');
      expect(snapshot.truncated).toBe(true);
      expect(snapshot).toMatchObject({
        mode: 'snapshot',
        displayOutput: { stdoutDroppedBytes: expect.any(Number) }
      });
    }
    child.stdout.write('next');
    expect(await call('exec_wait', { processId: started.processId, yieldMs: 0 })).toMatchObject({
      stdout: 'next',
      waitOutcome: 'snapshot'
    });
    child.exitCode = 0;
    child.emit('close', 0, null);
  });

  it('resynchronizes after slow-consumer frame overflow with the contiguous display tail', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null
    });
    const { call } = await fixture({
      async spawn() {
        return child as unknown as ChildProcessWithoutNullStreams;
      }
    });
    const started = await call('exec', { command: 'fixture', yieldMs: 0 });
    vi.useFakeTimers();
    let release!: () => void;
    const onOutput = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          })
      )
      .mockImplementation(async () => {});
    const waiting = call(
      'exec_wait',
      { processId: started.processId, yieldMs: 5000 },
      { ...context(), onOutput }
    );
    await vi.advanceTimersByTimeAsync(0);
    child.stdout.write('old');
    await vi.advanceTimersByTimeAsync(100);
    expect(onOutput).toHaveBeenCalledTimes(1);
    child.stdout.write('x'.repeat(50_000) + 'TAIL');
    child.stderr.write('warning');
    release();
    await vi.advanceTimersByTimeAsync(200);
    expect(onOutput).toHaveBeenCalledTimes(2);
    expect(onOutput.mock.calls[1]?.[0]).toMatchObject({
      mode: 'snapshot',
      truncated: true,
      stdout: expect.stringMatching(/TAIL$/u),
      stderr: 'warning',
      displayOutput: { stdout: expect.stringMatching(/TAIL$/u), stderr: 'warning' }
    });
    expect(onOutput.mock.calls[1]?.[0].stdout).not.toContain('old');
    child.exitCode = 0;
    child.emit('close', 0, null);
    await waiting;
  });

  it.each(['cancel', 'steer'] as const)(
    'coalesces slow display observers and releases a %s wait without losing output',
    async (reason) => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null as number | null
      });
      const { call } = await fixture({
        async spawn() {
          return child as unknown as ChildProcessWithoutNullStreams;
        }
      });
      const started = await call('exec', { command: 'fixture', yieldMs: 0 });
      vi.useFakeTimers();
      let release!: () => void;
      const onOutput = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          })
      );
      const abort = new AbortController();
      let pending = false;
      const waitInterrupt = createToolWaitInterrupt(() => pending);
      const waiting = call(
        'exec_wait',
        { processId: started.processId, yieldMs: 10000 },
        { ...context(), signal: abort.signal, waitInterrupt, onOutput }
      );
      const result =
        reason === 'cancel' ? expect(waiting).rejects.toThrow('stop waiting') : waiting;
      child.stdout.write('first');
      await vi.advanceTimersByTimeAsync(100);
      for (let i = 0; i < 10; i++) {
        child.stdout.write('.');
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(onOutput).toHaveBeenCalledTimes(1);
      if (reason === 'cancel') abort.abort(new Error('stop waiting'));
      else {
        pending = true;
        waitInterrupt.notify();
      }
      const output = await result;
      if (reason === 'steer')
        expect(output).toMatchObject({
          waitOutcome: 'interrupted',
          reason: 'steer',
          stdout: 'first..........'
        });
      release();
      await vi.advanceTimersByTimeAsync(1000);
      expect(onOutput).toHaveBeenCalledTimes(1);
      expect(await call('exec_wait', { processId: started.processId, yieldMs: 0 })).toMatchObject({
        stdout: reason === 'cancel' ? 'first..........' : '',
        status: 'running'
      });
      child.exitCode = 0;
      child.emit('close', 0, null);
    }
  );

  it.each(['slow', 'rejected'] as const)(
    'does not extend a wait deadline or fail a process for a %s display observer',
    async (delivery) => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null as number | null
      });
      const { call } = await fixture({
        async spawn() {
          return child as unknown as ChildProcessWithoutNullStreams;
        }
      });
      const started = await call('exec', { command: 'fixture', yieldMs: 0 });
      vi.useFakeTimers();
      let release = () => {};
      const onOutput = vi.fn(() =>
        delivery === 'rejected'
          ? Promise.reject(new Error('display unavailable'))
          : new Promise<void>((resolve) => {
              release = resolve;
            })
      );
      const waiting = call(
        'exec_wait',
        { processId: started.processId, yieldMs: 1000 },
        { ...context(), onOutput }
      );
      child.stdout.write('progress');
      await vi.advanceTimersByTimeAsync(1000);
      expect(await waiting).toMatchObject({
        status: 'running',
        waitOutcome: 'timeout',
        stdout: 'progress'
      });
      release();
      child.stdout.write('tail');
      child.exitCode = 7;
      child.emit('close', 7, null);
      expect(
        await call('exec_wait', { processId: started.processId, yieldMs: 1000 })
      ).toMatchObject({
        status: 'completed',
        waitOutcome: 'completion',
        stdout: 'tail',
        exitCode: 7
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(onOutput).toHaveBeenCalledTimes(1);
    }
  );

  it('distinguishes initial and poll timeout, snapshot, steer, and terminal replay without cancelling the process', async () => {
    const { call } = await fixture();
    let pending = false;
    const waitInterrupt = createToolWaitInterrupt(() => pending);
    const ctx = { ...context(), waitInterrupt };
    const initial = await call(
      'exec',
      {
        command: command(
          "process.stdin.once('data', () => process.exit(0)); process.stdin.resume();"
        ),
        yieldMs: 10
      },
      ctx
    );
    expect(initial).toMatchObject({ status: 'running', waitOutcome: 'timeout' });
    const processId = initial.processId;
    expect(await call('exec_wait', { processId, yieldMs: 0 }, ctx)).toMatchObject({
      status: 'running',
      waitOutcome: 'snapshot'
    });
    expect(await call('exec_wait', { processId, yieldMs: 10 }, ctx)).toMatchObject({
      status: 'running',
      waitOutcome: 'timeout'
    });
    pending = true;
    waitInterrupt.notify();
    const interrupted = await call('exec_wait', { processId, yieldMs: 300000 }, ctx);
    expect(interrupted).toMatchObject({
      processId,
      status: 'running',
      waitOutcome: 'interrupted',
      reason: 'steer'
    });
    expect(ctx.signal.aborted).toBe(false);
    const written = await call('exec_wait', { processId, action: 'write', data: 'finish' }, ctx);
    expect(written).not.toHaveProperty('waitOutcome');
    pending = false;
    const final = await call('exec_wait', { processId, yieldMs: 10000 }, ctx);
    expect(final).toMatchObject({ status: 'completed', waitOutcome: 'completion', exitCode: 0 });
    expect(final).not.toHaveProperty('reason');
    pending = true;
    expect(await call('exec_wait', { processId, yieldMs: 10000 }, ctx)).toMatchObject({
      status: 'completed',
      waitOutcome: 'completion',
      cached: true
    });
    expect(await call('exec_wait', { processId, yieldMs: 0 }, ctx)).toMatchObject({
      status: 'completed',
      waitOutcome: 'snapshot',
      cached: true
    });
  });

  it.each([
    {},
    { status: 'running' as const, stdoutBytes: 100, stderrBytes: 50 },
    { status: 'cancelled' as const, cached: true },
    { stderr: 'warning', stderrBytes: 7 },
    { stdout: '中文🙂', stdoutBytes: 10 },
    { truncated: true, stdoutBytes: 100, stdoutDroppedBytes: 93 }
  ])('shares compact model output without changing process or GC facts: %j', (overrides) => {
    const original: ExecResult = {
      status: 'completed',
      processId: 'process',
      stdout: 'example',
      stderr: '',
      exitCode: 0,
      truncated: false,
      stdoutBytes: 7,
      stderrBytes: 0,
      stdoutDroppedBytes: 0,
      stderrDroppedBytes: 0,
      cached: false,
      ...overrides
    };
    const snapshot = structuredClone(original);
    const formatted = formatExecResult(original);
    const visible = JSON.parse(formatted.content);
    expect(formatted.data).toBe(original);
    expect(original).toEqual(snapshot);
    expect(visible).toMatchObject({
      status: original.status,
      processId: 'process',
      stdout: original.stdout
    });
    expect(visible).not.toHaveProperty('stderrDroppedBytes');
    expect(visible.stderr).toBe(original.stderr || undefined);
    expect(visible.cached).toBe(original.cached || undefined);
    if (!original.truncated) expect(visible).not.toHaveProperty('truncated');
    if (original.truncated || original.stdoutBytes !== Buffer.byteLength(original.stdout))
      expect(visible.stdoutBytes).toBe(original.stdoutBytes);
    else expect(visible).not.toHaveProperty('stdoutBytes');
    const { cached: _cached, ...facts } = original;
    expect(parseContextGcExecResult(formatted.content)).toMatchObject(facts);
  });

  it.each(['stderr', 'truncated', 'stdoutBytes', 'stdoutDroppedBytes'])(
    'does not replace an invalid declared %s with a compact-output default',
    (field) => {
      expect(
        parseContextGcExecResult(
          JSON.stringify({ status: 'completed', stdout: 'example', [field]: null })
        )
      ).toBeUndefined();
    }
  );

  it('requires exact cumulative byte counts for truncated exec output', () => {
    expect(
      parseContextGcExecResult(
        JSON.stringify({ status: 'completed', stdout: 'example', truncated: true })
      )
    ).toBeUndefined();
  });

  it.each([undefined, null])(
    'keeps a direct process running past the former default timeout when timeoutMs is %s',
    async (timeoutMs) => {
      const { call } = await fixture();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        let started: ExecResult | undefined;
        const starting = call('exec', {
          command: command('process.stdin.resume()'),
          yieldMs: 0,
          ...(timeoutMs === undefined ? {} : { timeoutMs })
        }).then((result) => {
          started = result;
        });
        await vi.waitFor(() => expect(started).toBeDefined(), { timeout: 5000 });
        await starting;
        expect(started!.status).toBe('running');
        await vi.advanceTimersByTimeAsync(120_001);
        expect(
          await call(
            'exec_wait',
            { processId: started!.processId, yieldMs: 0 },
            { ...context(), executionId: 'second' }
          )
        ).toMatchObject({ status: 'running' });
        vi.useRealTimers();
        expect(
          await call('exec_wait', { processId: started!.processId, action: 'cancel' })
        ).toMatchObject({ status: 'cancelled' });
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it('terminates only at an explicit process timeout even when the poll window is longer', async () => {
    const { call } = await fixture();
    const started = await call('exec', {
      command: command('process.stdin.resume()'),
      yieldMs: 0,
      timeoutMs: 250
    });
    expect(started.status).toBe('running');
    const result = await call('exec_wait', { processId: started.processId, yieldMs: 10_000 });
    expect(result.status).toBe('cancelled');
    expect(await call('exec_wait', { processId: started.processId, yieldMs: 0 })).toMatchObject({
      status: 'cancelled',
      cached: true
    });
  });

  it('uses the shared default and five-minute wait limit without the start cap', () => {
    expect(execToolDefinition.inputSchema.properties.timeoutMs).toMatchObject({
      maximum: TOOL_EXECUTION_LIMITS.execMaxTimeoutMs,
      description: expect.stringContaining('Omitted means no process timeout')
    });
    expect(execToolDefinition.inputSchema.properties.timeoutMs).not.toHaveProperty('default');
    expect(execWaitToolDefinition.allowedCallers).toEqual(['direct', 'programmatic']);
    expect(execWaitToolDefinition.inputSchema).toMatchObject({
      required: ['processId'],
      properties: {
        yieldMs: {
          default: TOOL_EXECUTION_LIMITS.execDefaultYieldMs,
          maximum: TOOL_EXECUTION_LIMITS.execMaxPollYieldMs
        }
      }
    });
    expect(execToolInput('exec_wait', { processId: 'p' })).toEqual({
      action: 'poll',
      processId: 'p',
      yieldMs: 10_000
    });
    expect(execToolInput('exec_wait', { processId: 'p', yieldMs: null })).toEqual({
      action: 'poll',
      processId: 'p',
      yieldMs: 10_000
    });
    expect(execToolInput('exec_wait', { processId: 'p', yieldMs: 300_000 })).toEqual({
      action: 'poll',
      processId: 'p',
      yieldMs: 300_000
    });
  });

  it('waits by default, writes stdin and shares terminal snapshots across executions', async () => {
    const { call } = await fixture();
    const started = await call('exec', {
      command: command(
        'process.stdin.once("data", d => { process.stdout.write(d); process.exit(0); });'
      ),
      yieldMs: 0
    });
    const processId = started.processId;
    expect(await call('exec_wait', { processId, yieldMs: 0 })).toMatchObject({ status: 'running' });
    await call('exec_wait', { action: 'write', processId, data: 'hello\n' });
    let result: ExecResult;
    let output = '';
    do {
      result = await call('exec_wait', { processId });
      output += result.stdout;
    } while (result.status === 'running');
    expect(output).toBe('hello\n');
    expect(result.exitCode).toBe(0);
    expect(
      await call('exec_wait', { processId }, { ...context(), executionId: 'second' })
    ).toMatchObject({ cached: true, stdout: 'hello\n' });
    await expect(
      call('exec_wait', { processId }, { ...context(), sessionId: 'other' })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_PROCESS_NOT_FOUND' });
    await call('exec_wait', { processId, action: 'cancel' });
    await expect(call('exec_wait', { processId })).rejects.toMatchObject({
      code: 'MAR_AGENT_PROCESS_NOT_FOUND'
    });
  });

  it('aborting a wait keeps the process alive; explicit cancel terminates it', async () => {
    const { call } = await fixture();
    const { processId } = await call('exec', {
      command: command('setInterval(() => {}, 1000)'),
      yieldMs: 0
    });
    const abort = new AbortController();
    const waiting = call('exec_wait', { processId }, { ...context(), signal: abort.signal });
    abort.abort(new Error('stop waiting'));
    await expect(waiting).rejects.toThrow('stop waiting');
    expect(await call('exec_wait', { processId, yieldMs: 0 })).toMatchObject({ status: 'running' });
    expect(await call('exec_wait', { processId, action: 'cancel' })).toMatchObject({
      status: 'cancelled'
    });
  });

  it('ignores an undeclared legacy start action while executing the declared command', async () => {
    const { call } = await fixture();
    let result = await call('exec', {
      action: 'start',
      command: command('process.stdout.write("compatible start")'),
      yieldMs: 0
    });
    let output = result.stdout ?? '';
    while (result.status === 'running') {
      result = await call('exec_wait', { processId: result.processId });
      output += result.stdout ?? '';
    }
    expect(result).toMatchObject({ status: 'completed', exitCode: 0 });
    expect(output).toBe('compatible start');
  });

  it.each([{ command: 'echo no' }, { cwd: '.' }, { timeoutMs: 1000 }])(
    'ignores undeclared wait fields %j without bypassing process lookup',
    async (extra) => {
      const { call } = await fixture();
      await expect(call('exec_wait', { processId: 'missing', ...extra })).rejects.toMatchObject({
        code: 'MAR_AGENT_PROCESS_NOT_FOUND'
      });
    }
  );

  it.each([
    ['exec', { action: 'poll', processId: 'missing' }],
    ['exec_wait', { processId: 'missing', action: 'start' }],
    ['exec_wait', { processId: 'missing', action: 'write' }],
    ['exec_wait', {}]
  ])('rejects invalid %s input %j', async (name, args) => {
    const { call } = await fixture();
    await expect(call(name as string, args)).rejects.toMatchObject({
      code: 'MAR_AGENT_TOOL_INPUT_INVALID'
    });
  });
});
