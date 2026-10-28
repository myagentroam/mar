import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComputerUseDesktopLeaseService } from '../../src/computer-use/session.js';
import { ComputerUseError } from '../../src/computer-use/contracts.js';
import { PyAutoGuiComputerUseProvider } from '../../src/runner/mar-agent/computer-use.js';
import { createFakeComputerRuntime } from './support/computer-use-runtime.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  cleanups.push(async () => release());
  return { promise, release };
}

async function setup(options: ConstructorParameters<typeof PyAutoGuiComputerUseProvider>[1] = {}) {
  vi.stubEnv('DISPLAY', ':99');
  vi.stubEnv('WAYLAND_DISPLAY', undefined);
  const root = await mkdtemp(join(tmpdir(), 'mar-cu-async-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const runtimeExecutable = await createFakeComputerRuntime(root);
  const lease = new ComputerUseDesktopLeaseService();
  const provider = new PyAutoGuiComputerUseProvider(
    { enabled: true, runtimeExecutable },
    {
      lease,
      showControlIndicator: async () => ({ close: async () => {} }),
      ...options
    }
  );
  cleanups.push(() => provider.dispose());
  const execution = new AbortController();
  const binding = (await provider.bind({
    runId: 'run-1',
    sessionId: 'session-1',
    mode: 'run',
    enabled: true,
    modelSupportsImages: true,
    signal: execution.signal
  }))!;
  const call = async (name: string, args: Record<string, unknown>, signal: AbortSignal) => {
    const result = await binding.call({ callId: name, name, arguments: args }, signal);
    expect(result.data).toBeTypeOf('object');
    return { ...result, data: result.data as Record<string, unknown> };
  };
  const exec = (args: Record<string, unknown>, signal = new AbortController().signal) =>
    call('mcp__mar_computer__exec', args, signal);
  const wait = (args: Record<string, unknown>, signal = new AbortController().signal) =>
    call('mcp__mar_computer__wait', args, signal);
  const longCode = `import pathlib\npathlib.Path(${JSON.stringify(join(root, 'started'))}).write_text('started')\nwhile not pathlib.Path(${JSON.stringify(join(root, 'release'))}).exists(): time.sleep(0.01)\nlog('done')`;
  return { root, provider, lease, execution, binding, exec, wait, longCode };
}

describe('Computer Use managed asynchronous tasks', () => {
  it('yields without releasing the lease, rejects another operation and returns one retained result', async () => {
    const h = await setup();
    const starter = new AbortController();
    const running = await h.exec({ code: h.longCode, yieldMs: 0 }, starter.signal);
    expect(running.data).toMatchObject({ status: 'RUNNING', taskId: expect.any(String) });
    expect(running.images).toBeUndefined();
    expect(h.lease.holder()?.runId).toBe('run-1');
    const taskId = running.data!.taskId;
    starter.abort(); // The start call no longer owns cancellation after yielding.
    await vi.waitFor(async () =>
      expect(await readFile(join(h.root, 'started'), 'utf8')).toBe('started')
    );
    await expect(h.exec({ code: '', yieldMs: 0 })).rejects.toMatchObject({
      code: 'COMPUTER_SESSION_BUSY'
    });
    expect((await h.wait({ taskId, yieldMs: 0 })).data).toEqual(running.data);
    const waiter = new AbortController();
    const interrupted = h.wait({ taskId, yieldMs: 10000 }, waiter.signal);
    waiter.abort();
    await expect(interrupted).rejects.toMatchObject({ code: 'COMPUTER_WAIT_CANCELLED' });
    expect((await h.wait({ taskId, yieldMs: 0 })).data!.status).toBe('RUNNING');
    await writeFile(join(h.root, 'release'), 'release');
    const done = await h.wait({ taskId });
    expect(done.data).toMatchObject({
      taskId,
      status: 'COMPLETED',
      outcome: 'SUCCEEDED',
      logs: ['done']
    });
    expect(done.images).toHaveLength(1);
    expect(await h.wait({ taskId, action: 'cancel' })).toEqual(done);
    await expect(h.exec({ code: '', yieldMs: -1 })).rejects.toMatchObject({
      code: 'COMPUTER_INPUT_INVALID'
    });
    await expect(h.exec({ code: '', basedOnObservationId: 'stale' })).rejects.toMatchObject({
      code: 'COMPUTER_OBSERVATION_STALE'
    });
    expect(await h.wait({ taskId })).toEqual(done);
    const next = await h.exec({ code: '', basedOnObservationId: done.data!.observationId });
    expect(next.data!.status).toBe('COMPLETED');
    await expect(h.wait({ taskId })).rejects.toMatchObject({ code: 'COMPUTER_TASK_NOT_FOUND' });
  });

  it('cancels a sent task without cancelling the Run and requires a fresh observation', async () => {
    const h = await setup();
    const observed = await h.exec({ code: '' });
    const running = await h.exec({
      code: h.longCode,
      yieldMs: 0,
      basedOnObservationId: observed.data!.observationId
    });
    await vi.waitFor(async () =>
      expect(await readFile(join(h.root, 'started'), 'utf8')).toBe('started')
    );
    const result = await h.wait({ taskId: running.data!.taskId, action: 'cancel' });
    expect(result.data).toMatchObject({
      status: 'COMPLETED',
      outcome: 'OUTCOME_UNKNOWN',
      observationId: ''
    });
    expect(h.execution.signal.aborted).toBe(false);
    expect(await h.wait({ taskId: running.data!.taskId, action: 'cancel' })).toEqual(result);
    await expect(
      h.exec({ code: 'pass', basedOnObservationId: observed.data!.observationId })
    ).rejects.toMatchObject({ code: 'COMPUTER_OBSERVATION_STALE' });
    expect((await h.exec({ code: '' })).data!.outcome).toBe('SUCCEEDED');
  });

  it('keeps execution cancellation subscribed across tasks and drains before rebinding', async () => {
    const h = await setup();
    await h.exec({ code: '', yieldMs: 30000 });
    const task = await h.exec({ code: h.longCode, yieldMs: 0 });
    await vi.waitFor(async () =>
      expect(await readFile(join(h.root, 'started'), 'utf8')).toBe('started')
    );
    const result = h.wait({ taskId: task.data!.taskId });
    h.execution.abort();
    expect((await result).data!.outcome).toBe('OUTCOME_UNKNOWN');
    await expect(h.exec({ code: '' })).rejects.toMatchObject({ code: 'COMPUTER_UNAVAILABLE' });
    await h.binding.close();
    expect(h.lease.holder()).toBeUndefined();
    const next = (await h.provider.bind({
      runId: 'run-2',
      sessionId: 'session-1',
      mode: 'run',
      enabled: true,
      modelSupportsImages: true
    }))!;
    await expect(
      next.call(
        {
          callId: 'old-task',
          name: 'mcp__mar_computer__wait',
          arguments: { taskId: task.data!.taskId }
        },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'COMPUTER_TASK_NOT_FOUND' });
  });

  it('does not admit a task when the execution or start call was already cancelled', async () => {
    const h = await setup();
    const start = new AbortController();
    start.abort();
    await expect(h.exec({ code: '', yieldMs: 0 }, start.signal)).rejects.toMatchObject({
      code: 'COMPUTER_UNAVAILABLE'
    });
    expect(h.lease.holder()).toBeUndefined();
    await h.exec({ code: '' });
    h.execution.abort();
    await expect(h.exec({ code: '', yieldMs: 0 })).rejects.toMatchObject({
      code: 'COMPUTER_UNAVAILABLE'
    });
  });

  it('counts preparation in yield and does not release the lease before late resources close', async () => {
    const entered = gate();
    const release = gate();
    const closed = vi.fn(async () => {});
    const h = await setup({
      showControlIndicator: async () => {
        entered.release();
        await release.promise;
        return { close: closed };
      }
    });
    // Gates must release before provider cleanup, including on a failed assertion.
    cleanups.push(async () => release.release());
    const task = await h.exec({ code: 'raise Exception("must not run")', yieldMs: 0 });
    await entered.promise;
    expect(
      (await h.wait({ taskId: task.data!.taskId, action: 'cancel', yieldMs: 0 })).data!.status
    ).toBe('STOPPING');
    const closing = h.binding.close();
    expect(h.lease.holder()).toBeDefined();
    release.release();
    await closing;
    expect(closed).toHaveBeenCalledOnce();
    expect(h.lease.holder()).toBeUndefined();
    expect(await readFile(join(h.root, 'effects'), 'utf8')).toBe('');
  });

  it('does not publish a final observation or accept work until indicator cleanup completes', async () => {
    const closing = gate();
    const release = gate();
    const h = await setup({
      showControlIndicator: async () => ({
        close: async () => {
          closing.release();
          await release.promise;
        }
      })
    });
    cleanups.push(async () => release.release());
    const task = await h.exec({ code: '', yieldMs: 0 });
    await closing.promise;
    const pending = await h.wait({ taskId: task.data!.taskId, yieldMs: 0 });
    expect(pending.data!.status).toBe('RUNNING');
    expect(pending.data!.observationId).toBeUndefined();
    expect(pending.images).toBeUndefined();
    await expect(h.exec({ code: '' })).rejects.toMatchObject({ code: 'COMPUTER_SESSION_BUSY' });
    release.release();
    expect((await h.wait({ taskId: task.data!.taskId })).data!.outcome).toBe('SUCCEEDED');
  });

  it('retains preparation errors after yielding without an unhandled rejection', async () => {
    const h = await setup({
      showControlIndicator: async () => {
        throw new Error('fixture unavailable');
      }
    });
    const task = await h.exec({ code: '', yieldMs: 0 });
    await expect(h.wait({ taskId: task.data!.taskId })).rejects.toBeInstanceOf(ComputerUseError);
    await expect(h.wait({ taskId: task.data!.taskId })).rejects.toMatchObject({
      code: 'COMPUTER_CONTROL_INDICATOR_UNAVAILABLE'
    });
  });

  it('can cancel after desktop permission is lost without probing again', async () => {
    const h = await setup();
    const task = await h.exec({ code: h.longCode, yieldMs: 0 });
    await vi.waitFor(async () =>
      expect(await readFile(join(h.root, 'started'), 'utf8')).toBe('started')
    );
    await writeFile(join(h.root, 'options.json'), JSON.stringify({ input: false }));
    expect((await h.wait({ taskId: task.data!.taskId, action: 'cancel' })).data!.outcome).toBe(
      'OUTCOME_UNKNOWN'
    );
    await expect(h.exec({ code: '' })).rejects.toMatchObject({
      code: 'COMPUTER_INPUT_PERMISSION_DENIED'
    });
  });

  it('preserves the execution timeout after yielding and does not extend it on poll', async () => {
    const h = await setup();
    const task = await h.exec({ code: h.longCode, yieldMs: 0, timeoutMs: 80 });
    const done = await h.wait({ taskId: task.data!.taskId, yieldMs: 10000 });
    expect(done.data).toMatchObject({
      status: 'COMPLETED',
      outcome: 'OUTCOME_UNKNOWN',
      observationId: ''
    });
    expect((await h.exec({ code: '' })).data!.outcome).toBe('SUCCEEDED');
  });

  it('reset cancels a preparing task and blocks binds until cleanup has drained', async () => {
    const entered = gate();
    const release = gate();
    const close = vi.fn(async () => {});
    const h = await setup({
      showControlIndicator: async () => {
        entered.release();
        await release.promise;
        return { close };
      }
    });
    cleanups.push(async () => release.release());
    const task = await h.exec({ code: '', yieldMs: 0 });
    await entered.promise;
    const reset = h.provider.reset();
    await expect(
      h.provider.bind({
        runId: 'run-2',
        sessionId: 'session-1',
        mode: 'run',
        enabled: true,
        modelSupportsImages: true
      })
    ).rejects.toMatchObject({ code: 'COMPUTER_UNAVAILABLE' });
    expect(h.lease.holder()).toBeDefined();
    release.release();
    await reset;
    expect(close).toHaveBeenCalledOnce();
    expect(h.lease.holder()).toBeUndefined();
    await expect(h.wait({ taskId: task.data!.taskId })).rejects.toMatchObject({
      code: 'COMPUTER_UNAVAILABLE'
    });
  });

  it('retains the primary result and blocks new tasks after asynchronous cleanup failure', async () => {
    const h = await setup({
      showControlIndicator: async () => ({
        close: async () => {
          throw new Error('cleanup fixture');
        }
      })
    });
    const dispose = cleanups.pop()!;
    cleanups.push(async () => {
      await expect(dispose()).rejects.toMatchObject({ code: 'COMPUTER_CLEANUP_FAILED' });
    });
    const task = await h.exec({ code: '', yieldMs: 0 });
    const done = await h.wait({ taskId: task.data!.taskId });
    expect(done.data).toMatchObject({ outcome: 'SUCCEEDED', observationId: '' });
    expect(done.content).toContain('cleanup failed');
    expect(await h.wait({ taskId: task.data!.taskId, action: 'cancel' })).toEqual(done);
    await expect(h.exec({ code: '', yieldMs: 0 })).rejects.toMatchObject({
      code: 'COMPUTER_CLEANUP_FAILED'
    });
    expect(h.lease.holder()).toBeDefined();
  });

  it('validates wait input and isolates task IDs between simultaneous bindings', async () => {
    const h = await setup();
    const done = await h.exec({ code: '', yieldMs: 30000 });
    expect(done.data!.status).toBe('COMPLETED');
    for (const args of [
      { taskId: '' },
      { taskId: done.data!.taskId, yieldMs: -1 },
      { taskId: done.data!.taskId, action: 'stop' },
      { taskId: done.data!.taskId, yieldMs: 300001 },
      { taskId: done.data!.taskId, code: '' }
    ])
      await expect(h.wait(args)).rejects.toMatchObject({ code: 'COMPUTER_INPUT_INVALID' });
    expect(await h.wait({ taskId: done.data!.taskId })).toEqual(done);
    const other = (await h.provider.bind({
      runId: 'other-run',
      sessionId: 'other-session',
      mode: 'run',
      enabled: true,
      modelSupportsImages: true
    }))!;
    await expect(
      other.call(
        {
          callId: 'foreign',
          name: 'mcp__mar_computer__wait',
          arguments: { taskId: done.data!.taskId }
        },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'COMPUTER_TASK_NOT_FOUND' });
    await expect(
      other.call(
        { callId: 'busy', name: 'mcp__mar_computer__exec', arguments: { code: '' } },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'DESKTOP_BUSY' });
    expect(await h.wait({ taskId: done.data!.taskId })).toEqual(done);
  });
});
