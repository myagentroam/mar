import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { directLocalProcessExecutor } from '../../src/host/local-process-executor.js';
import type { AgentEvent } from '../../src/runtime/events.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import { answer, call, cleanupCoreFixtures, fixture } from './support/core-extension-fixture.js';

afterEach(cleanupCoreFixtures);

describe('exec live output and model observation separation', () => {
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
