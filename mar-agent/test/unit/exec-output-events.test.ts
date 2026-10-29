import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { directLocalProcessExecutor } from '../../src/host/local-process-executor.js';
import type { AgentEvent } from '../../src/runtime/events.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import { TOOL_EXECUTION_LIMITS } from '../../src/tools/execution-limits.js';
import { answer, call, cleanupCoreFixtures, fixture } from './support/core-extension-fixture.js';

afterEach(cleanupCoreFixtures);

describe('exec live output and model observation separation', () => {
  it.each([
    [false, false],
    [true, false],
    [true, true]
  ] as const)(
    'retains earlier child output during a retained wait (revisit first: %s, large: %s)',
    async (revisitFirst, large) => {
      const limit = TOOL_EXECUTION_LIMITS.execProgressMaxOutputBytes;
      const characters = large ? Math.floor((limit * 3) / 4) - 4 : 1;
      const oneText = 'A'.repeat(characters) + (large ? '🦊' : '');
      const twoText = 'B'.repeat(characters) + (large ? '🐱' : '');
      const expected = large ? 'A'.repeat(limit - characters - 8) + '🦊' + twoText : 'AB';
      const makeChild = () =>
        Object.assign(new EventEmitter(), {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          exitCode: null as number | null
        });
      const one = makeChild();
      const two = makeChild();
      let cellId = '';
      const f = await fixture(
        [],
        (_request, index) => {
          if (index === 0)
            return call('code_exec', {
              code: revisitFirst
                ? '// @options: {"yieldMs":0}\nconst r=await tools.exec({command:"one",yieldMs:1000}); await tools.exec({command:"two",yieldMs:4000}); await tools.exec_wait({processId:r.data.processId,yieldMs:4000});'
                : '// @options: {"yieldMs":0}\nawait tools.exec({command:"one",yieldMs:4000}); const r=await tools.exec({command:"two",yieldMs:1000}); await tools.exec_wait({processId:r.data.processId,yieldMs:4000});'
            });
          if (index === 2)
            return call('code_exec_wait', { cellId, yieldMs: 4000 }).map((event) =>
              event.type === 'client_tool.call' ? { ...event, callId: 'later-wait' } : event
            );
          return answer();
        },
        true,
        false,
        {
          processExecutor: {
            async spawn(request) {
              return request.command === 'one'
                ? (one as unknown as ChildProcessWithoutNullStreams)
                : request.command === 'two'
                  ? (two as unknown as ChildProcessWithoutNullStreams)
                  : directLocalProcessExecutor.spawn(request);
            }
          }
        }
      );
      const first = f.session.run({ prompt: 'Start.' });
      const firstEvents: AgentEvent[] = [];
      const collectingFirst = (async () => {
        for await (const event of first) firstEvents.push(event);
      })();
      try {
        await vi.waitFor(() => expect(one.stdout.listenerCount('data')).toBe(1));
        await first.result();
        await collectingFirst;
        const completed = firstEvents.find(
          (event) => event.type === 'tool.completed' && event.toolName === 'code_exec'
        );
        if (!completed || completed.type !== 'tool.completed') throw new Error('missing cell');
        cellId = (completed.data as { cellId: string }).cellId;
        const second = f.session.run({ prompt: 'Wait.' });
        const events: AgentEvent[] = [];
        const collecting = (async () => {
          for await (const event of second) events.push(event);
        })();
        await vi.waitFor(() =>
          expect(
            events.some((event) => event.type === 'tool.started' && event.callId === 'later-wait')
          ).toBe(true)
        );
        one.stdout.write(oneText);
        await vi.waitFor(() =>
          expect(events).toContainEqual(
            expect.objectContaining({
              type: 'tool.output',
              callId: 'later-wait',
              output: expect.objectContaining({ mode: 'delta', stdout: oneText })
            })
          )
        );
        if (!revisitFirst) {
          one.exitCode = 0;
          one.emit('close', 0, null);
        }
        await vi.waitFor(() => expect(two.stdout.listenerCount('data')).toBe(1), { timeout: 2500 });
        two.stdout.write(twoText);
        await vi.waitFor(() =>
          expect(events).toContainEqual(
            expect.objectContaining({
              type: 'tool.output',
              callId: 'later-wait',
              output: expect.objectContaining({ mode: 'delta', stdout: twoText })
            })
          )
        );
        if (revisitFirst) {
          two.exitCode = 0;
          two.emit('close', 0, null);
        }
        await vi.waitFor(
          () =>
            expect(events).toContainEqual(
              expect.objectContaining({
                type: 'tool.output',
                callId: 'later-wait',
                output: expect.objectContaining({
                  mode: 'snapshot',
                  stdout: expected,
                  truncated: large,
                  displayOutput: expect.objectContaining({
                    stdoutDroppedBytes: large ? 2 * (characters + 4) - limit : 0,
                    stderrDroppedBytes: 0
                  })
                })
              })
            ),
          { timeout: 2500 }
        );
        one.exitCode = 0;
        one.emit('close', 0, null);
        two.exitCode = 0;
        two.emit('close', 0, null);
        await second.result();
        await collecting;
      } finally {
        one.exitCode = 0;
        one.emit('close', 0, null);
        two.exitCode = 0;
        two.emit('close', 0, null);
      }
    }
  );
  it('does not report a false HEAD when a retained wait receives an overlapping process snapshot', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null
    });
    let cellId = '';
    const f = await fixture(
      [],
      (_request, index) => {
        if (index === 0)
          return call('code_exec', {
            code: '// @options: {"yieldMs":0}\nconst r = await tools.exec({command:"fixture",yieldMs:1000}); await tools.exec_wait({processId:r.data.processId,yieldMs:4000});'
          });
        if (index === 2)
          return call('code_exec_wait', { cellId, yieldMs: 4000 }).map((event) =>
            event.type === 'client_tool.call' ? { ...event, callId: 'later-wait' } : event
          );
        return answer();
      },
      true,
      false,
      {
        processExecutor: {
          async spawn(request) {
            return request.command === 'fixture'
              ? (child as unknown as ChildProcessWithoutNullStreams)
              : directLocalProcessExecutor.spawn(request);
          }
        }
      }
    );
    const first = f.session.run({ prompt: 'Start.' });
    const firstEvents: AgentEvent[] = [];
    const collectingFirst = (async () => {
      for await (const event of first) firstEvents.push(event);
    })();
    try {
      await vi.waitFor(() => expect(child.stdout.listenerCount('data')).toBe(1));
      await first.result();
      await collectingFirst;
      const completed = firstEvents.find(
        (event) => event.type === 'tool.completed' && event.toolName === 'code_exec'
      );
      if (!completed || completed.type !== 'tool.completed') throw new Error('missing cell');
      cellId = (completed.data as { cellId: string }).cellId;
      const second = f.session.run({ prompt: 'Wait.' });
      const events: AgentEvent[] = [];
      const collecting = (async () => {
        for await (const event of second) events.push(event);
      })();
      await vi.waitFor(() =>
        expect(
          events.some((event) => event.type === 'tool.started' && event.callId === 'later-wait')
        ).toBe(true)
      );
      child.stdout.write('a');
      await vi.waitFor(() =>
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'tool.output',
            callId: 'later-wait',
            output: expect.objectContaining({ mode: 'delta', stdout: 'a' })
          })
        )
      );
      await vi.waitFor(
        () =>
          expect(events).toContainEqual(
            expect.objectContaining({
              type: 'tool.output',
              callId: 'later-wait',
              output: expect.objectContaining({
                mode: 'snapshot',
                stdout: 'a',
                truncated: false,
                displayOutput: expect.objectContaining({ stdoutDroppedBytes: 0 })
              })
            })
          ),
        { timeout: 2500 }
      );
      child.exitCode = 0;
      child.emit('close', 0, null);
      await second.result();
      await collecting;
    } finally {
      child.exitCode = 0;
      child.emit('close', 0, null);
    }
  });
  it('forwards retained Code Mode output to the waiting call in a later execution', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null
    });
    let cellId = '';
    const f = await fixture(
      [],
      (_request, index) => {
        if (index === 0)
          return call('code_exec', {
            code: '// @options: {"yieldMs":0}\nobserve.result(await tools.exec({command:"fixture",yieldMs:5000}));'
          });
        if (index === 2)
          return call('code_exec_wait', { cellId, yieldMs: 4000 }).map((event) =>
            event.type === 'client_tool.call' ? { ...event, callId: 'later-wait' } : event
          );
        return answer();
      },
      true,
      false,
      {
        processExecutor: {
          async spawn(request) {
            return request.command === 'fixture'
              ? (child as unknown as ChildProcessWithoutNullStreams)
              : directLocalProcessExecutor.spawn(request);
          }
        }
      }
    );
    const first = f.session.run({ prompt: 'Start.' });
    const firstEvents: AgentEvent[] = [];
    const collectingFirst = (async () => {
      for await (const event of first) firstEvents.push(event);
    })();
    try {
      await vi.waitFor(() => expect(child.stdout.listenerCount('data')).toBe(1));
      expect(await first.result()).toMatchObject({ status: 'completed' });
      await collectingFirst;
      const completed = firstEvents.find(
        (event) => event.type === 'tool.completed' && event.toolName === 'code_exec'
      );
      if (!completed || completed.type !== 'tool.completed') throw new Error('missing cell');
      cellId = (completed.data as { cellId: string }).cellId;
      const second = f.session.run({ prompt: 'Wait.' });
      const secondEvents: AgentEvent[] = [];
      const collectingSecond = (async () => {
        for await (const event of second) secondEvents.push(event);
      })();
      await vi.waitFor(() =>
        expect(
          secondEvents.some(
            (event) => event.type === 'tool.started' && event.callId === 'later-wait'
          )
        ).toBe(true)
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      child.stdout.write('new-run-output');
      child.stderr.write('new-run-error');
      await vi.waitFor(
        () =>
          expect(secondEvents).toContainEqual(
            expect.objectContaining({
              type: 'tool.output',
              callId: 'later-wait',
              toolName: 'code_exec_wait',
              output: expect.objectContaining({
                mode: 'delta',
                stdout: 'new-run-output',
                stderr: 'new-run-error'
              })
            })
          ),
        { timeout: 1500 }
      );
      expect(
        firstEvents.some(
          (event) => event.type === 'tool.output' && event.output.stdout.includes('new-run-output')
        )
      ).toBe(false);
      child.exitCode = 0;
      child.emit('close', 0, null);
      expect(await second.result()).toMatchObject({ status: 'completed' });
      await collectingSecond;
    } finally {
      child.exitCode = 0;
      child.emit('close', 0, null);
    }
  });
  it('publishes real UTF-8-safe incremental frames with distinct stdout and stderr', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null
    });
    const f = await fixture(
      [],
      (_request, index) =>
        index === 0 ? call('exec', { command: 'fixture', yieldMs: 2000 }) : answer(),
      false,
      false,
      {
        processExecutor: {
          async spawn() {
            return child as unknown as ChildProcessWithoutNullStreams;
          }
        }
      }
    );
    const events: AgentEvent[] = [];
    const execution = f.session.run({ prompt: 'Run.' });
    const collecting = (async () => {
      for await (const event of execution) events.push(event);
    })();
    try {
      await vi.waitFor(() => expect(child.stdout.listenerCount('data')).toBe(1));
      const word = Buffer.from('中');
      child.stdout.write(word.subarray(0, 1));
      child.stdout.write(word.subarray(1));
      child.stderr.write('err');
      await vi.waitFor(() =>
        expect(events.filter((event) => event.type === 'tool.output')).toHaveLength(1)
      );
      child.stdout.write(' tail');
      await vi.waitFor(() =>
        expect(events.filter((event) => event.type === 'tool.output')).toHaveLength(2)
      );
      const frames = events.filter((event) => event.type === 'tool.output');
      expect(frames).toMatchObject([
        { output: { mode: 'delta', stdout: '中', stderr: 'err' } },
        { output: { mode: 'delta', stdout: ' tail', stderr: '' } }
      ]);
    } finally {
      child.exitCode = 0;
      child.emit('close', 0, null);
      await execution.result();
      await collecting;
    }
  });
  it('keeps a UTF-8 safe bounded display tail independent of model output', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null
    });
    const f = await fixture(
      [],
      (_request, index) =>
        index === 0 ? call('exec', { command: 'fixture', yieldMs: 2000 }) : answer(),
      false,
      false,
      {
        processExecutor: {
          async spawn() {
            return child as unknown as ChildProcessWithoutNullStreams;
          }
        }
      }
    );
    const events: AgentEvent[] = [];
    const execution = f.session.run({ prompt: 'Run.' });
    const collecting = (async () => {
      for await (const event of execution) events.push(event);
    })();
    try {
      await vi.waitFor(() => expect(child.stdout.listenerCount('data')).toBe(1));
      child.stdout.write('中'.repeat(4000) + 'TAIL');
      child.exitCode = 0;
      child.emit('close', 0, null);
      await execution.result();
      await collecting;
      const final = events.find(
        (event) => event.type === 'tool.completed' && event.toolName === 'exec'
      );
      expect(final?.type).toBe('tool.completed');
      if (final?.type !== 'tool.completed') throw new Error('missing result');
      const data = final.data as { displayOutput: { stdout: string; stdoutDroppedBytes: number } };
      expect(data.displayOutput.stdout.endsWith('TAIL')).toBe(true);
      expect(data.displayOutput.stdout).not.toContain('\ufffd');
      expect(Buffer.byteLength(data.displayOutput.stdout)).toBeLessThanOrEqual(8192);
      expect(data.displayOutput.stdoutDroppedBytes).toBeGreaterThan(0);
      expect(
        f.adapter.requests.at(-1)!.messages.findLast((m) => m.role === 'tool')?.content
      ).not.toContain('displayOutput');
    } finally {
      child.exitCode = 0;
      child.emit('close', 0, null);
      await execution.result();
      await collecting;
    }
  });

  it('does not make the next model request wait for slow Host display delivery', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null
    });
    const f = await fixture(
      [],
      (_request, index) =>
        index === 0 ? call('exec', { command: 'fixture', yieldMs: 2000 }) : answer(),
      false,
      false,
      {
        processExecutor: {
          async spawn() {
            return child as unknown as ChildProcessWithoutNullStreams;
          }
        }
      }
    );
    const display = Promise.withResolvers<void>();
    let publishing = false;
    const observer = vi.spyOn(f.host, 'emit').mockImplementation(async (event) => {
      if (event.type === 'tool.output') {
        publishing = true;
        await display.promise;
      }
    });
    const execution = f.session.run({ prompt: 'Keep display delivery independent.' });
    const collecting = (async () => {
      for await (const event of execution) expect(event.executionId).toBe(execution.executionId);
    })();
    try {
      await vi.waitFor(() => expect(child.stdout.listenerCount('data')).toBe(1));
      child.stdout.write('live only');
      await vi.waitFor(() => expect(publishing).toBe(true));
      child.exitCode = 0;
      child.emit('close', 0, null);
      await vi.waitFor(() => expect(f.adapter.requests).toHaveLength(2));
      expect(await execution.result()).toMatchObject({ status: 'completed' });
    } finally {
      display.resolve();
      child.exitCode = 0;
      child.emit('close', 0, null);
      await execution.result();
      await collecting;
      observer.mockRestore();
    }
  });

  it.each([false, true])(
    'does not retain display snapshots for an idle iterator (already subscribed: %s)',
    async (subscribed) => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null as number | null
      });
      const f = await fixture(
        [],
        (_request, index) =>
          index === 0 ? call('exec', { command: 'fixture', yieldMs: 2000 }) : answer(),
        false,
        false,
        {
          processExecutor: {
            async spawn() {
              return child as unknown as ChildProcessWithoutNullStreams;
            }
          }
        }
      );
      const published: AgentEvent[] = [];
      const observer = vi.spyOn(f.host, 'emit').mockImplementation(async (event) => {
        published.push(event);
      });
      const execution = f.session.run({ prompt: 'Run without reading live previews.' });
      let iterator = subscribed ? execution[Symbol.asyncIterator]() : undefined;
      try {
        await vi.waitFor(() => expect(child.stdout.listenerCount('data')).toBe(1));
        child.stdout.write('live only');
        await vi.waitFor(() =>
          expect(published.some((event) => event.type === 'tool.output')).toBe(true)
        );
        iterator ??= execution[Symbol.asyncIterator]();
        child.exitCode = 0;
        child.emit('close', 0, null);
        expect(await execution.result()).toMatchObject({ status: 'completed' });
        const buffered = [];
        for (let next = await iterator.next(); !next.done; next = await iterator.next())
          buffered.push(next.value);
        expect(buffered.some((event) => event.type === 'tool.output')).toBe(false);
        expect(
          buffered.find((event) => event.type === 'tool.completed' && event.toolName === 'exec')
        ).toMatchObject({ data: { stdout: 'live only', exitCode: 0 } });
      } finally {
        child.exitCode = 0;
        child.emit('close', 0, null);
        await execution.result();
        observer.mockRestore();
      }
    }
  );

  it.each(['direct', 'observed', 'unobserved', 'retained'] as const)(
    'publishes live output while %s waits, without extra model requests or durable snapshots',
    async (mode) => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null as number | null
      });
      const input = { command: 'fixture', login: false, yieldMs: 2000 };
      const f = await fixture(
        [],
        (_request, index) =>
          index === 0
            ? call(
                mode === 'direct' ? 'exec' : 'code_exec',
                mode === 'direct'
                  ? input
                  : {
                      code:
                        `// @options: ${JSON.stringify({ yieldMs: mode === 'retained' ? 0 : 2000 })}\n` +
                        (mode === 'unobserved'
                          ? `await tools.exec(${JSON.stringify(input)});`
                          : `observe.result(await tools.exec(${JSON.stringify(input)}));`)
                    }
              )
            : index === 1 && mode === 'retained'
              ? call('code_exec_wait', {
                  cellId: JSON.parse(
                    _request.messages.findLast((message) => message.role === 'tool')!.content
                  ).cellId,
                  yieldMs: 2000
                }).map((event) =>
                  event.type === 'client_tool.call' ? { ...event, callId: 'wait-call' } : event
                )
              : answer(),
        mode !== 'direct',
        false,
        {
          processExecutor: {
            async spawn(request) {
              if (request.command !== 'fixture') return directLocalProcessExecutor.spawn(request);
              return child as unknown as ChildProcessWithoutNullStreams;
            }
          }
        }
      );
      const events: AgentEvent[] = [];
      const execution = f.session.run({ prompt: 'Run the fixture.' });
      const collecting = (async () => {
        for await (const event of execution) events.push(event);
      })();
      try {
        await vi.waitFor(() => expect(child.stdout.listenerCount('data')).toBe(1));
        child.stdout.write('display-first');
        child.stderr.write('warning');
        await vi.waitFor(() =>
          expect(events.some((event) => event.type === 'tool.output')).toBe(true)
        );
        const progress = events.find((event) => event.type === 'tool.output');
        expect(progress).toMatchObject({
          type: 'tool.output',
          toolName: 'exec',
          output: {
            stdout: 'display-first',
            stderr: 'warning',
            truncated: false,
            displayOutput: { stdout: 'display-first', stderr: 'warning', stdoutDroppedBytes: 0 }
          }
        });
        expect(progress && 'parentCallId' in progress ? progress.parentCallId : undefined).toBe(
          mode === 'direct' ? undefined : 'call'
        );
        expect(
          events.some((event) => event.type === 'tool.completed' && event.toolName !== 'code_exec')
        ).toBe(false);
        expect(f.adapter.requests).toHaveLength(mode === 'retained' ? 2 : 1);

        child.stdout.write('-tail');
        child.exitCode = 0;
        child.emit('close', 0, null);
        expect(await execution.result()).toMatchObject({
          status: 'completed',
          finalAnswer: 'done'
        });
        await collecting;
        expect(f.adapter.requests).toHaveLength(mode === 'retained' ? 3 : 2);
        const modelResult = f.adapter.requests
          .at(-1)!
          .messages.findLast((message) => message.role === 'tool');
        expect(modelResult?.content).not.toContain('displayOutput');
        if (mode === 'unobserved') expect(modelResult?.content).not.toContain('display-first');
        else expect(modelResult?.content).toContain('display-first-tail');
        const final = events.find(
          (event) => event.type === 'tool.completed' && event.toolName === 'exec'
        );
        expect(final).toMatchObject({
          data: {
            stdout: 'display-first-tail',
            stderr: 'warning',
            waitOutcome: 'completion',
            displayOutput: { stdout: 'display-first-tail', stderr: 'warning' }
          }
        });
        const store = await JsonlSessionStore.open(f.home);
        try {
          const records = await store.read(f.session.id);
          expect(records.some((record) => record.type === 'tool.output')).toBe(false);
          expect(records.some((record) => record.type === 'tool.completed')).toBe(true);
        } finally {
          await store.close();
        }
      } finally {
        child.exitCode = 0;
        child.emit('close', 0, null);
        await execution.result();
        await collecting;
      }
    }
  );
});
