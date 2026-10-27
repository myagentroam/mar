import { extensionToolRuntime } from '../../src/sdk/extension-tool-runtime.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecTool } from '../../src/host/local-exec-tool.js';
import { WorkspacePathResolver } from '../../src/tools/shared/path-resolver.js';
import {
  directLocalProcessExecutor,
  type LocalProcessSpawnRequest
} from '../../src/host/local-process-executor.js';
import { LocalAgentHost } from '../../src/host.js';
import { ExtensionManager } from '../../src/extensions/manager.js';
import type { SessionExtensionContext } from '../../src/extensions/contracts.js';
import type { ExtensionProcessHandle } from '../../src/extensions/processes.js';
import {
  fixture as sdkFixture,
  answer,
  call,
  cleanupCoreFixtures
} from './support/core-extension-fixture.js';

const roots: string[] = [];
const managers: ExtensionManager[] = [];
const tools: ExecTool[] = [];
afterEach(async () => {
  await cleanupCoreFixtures();
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  await Promise.all(tools.splice(0).map((tool) => tool.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(maxProcesses = 8, wrap = false) {
  const root = await mkdtemp(join(tmpdir(), 'mar-core-process-'));
  roots.push(root);
  const requests: LocalProcessSpawnRequest[] = [];
  const pids: number[] = [];
  const tool = new ExecTool(
    new WorkspacePathResolver(root),
    undefined,
    maxProcesses,
    { ...process.env, CORE_BASE: 'base' },
    undefined,
    {
      async spawn(request) {
        requests.push(request);
        const child = await directLocalProcessExecutor.spawn(request);
        if (child.pid) pids.push(child.pid);
        return child;
      }
    }
  );
  tools.push(tool);
  let context!: SessionExtensionContext;
  const facts: unknown[] = [];
  const manager = new ExtensionManager({
    toolRuntime: extensionToolRuntime,
    extensions: [
      {
        id: 'processes',
        apiVersion: '1.0',
        attachSession(value) {
          context = value;
          value.hooks.observe('process.completed', (fact) => {
            facts.push(fact);
          });
          if (wrap)
            value.hooks.intercept('process.run', async (input, _call, next) => ({
              ...(await next(input)),
              code: 0
            }));
        }
      }
    ],
    capabilities: ['processes'],
    busyExcept: () => false,
    hostPorts: { processes: { spawn: (input, call) => tool.spawn(input, call) } }
  });
  managers.push(manager);
  await manager.prepare('session', new AbortController().signal);
  return { root, tool, manager, context, requests, pids, facts };
}
const node = (script: string) => ({ executable: process.execPath, argv: ['-e', script] });
async function bytes(stream: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
async function complete(handle: ExtensionProcessHandle) {
  return Promise.all([handle.wait(), bytes(handle.stdout), bytes(handle.stderr)]);
}
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function exited(pid: number) {
  expect(() => process.kill(pid, 0)).toThrow();
}

describe('Core native managed processes', () => {
  it('runs argv without a shell and preserves binary input/output, environment, cwd, and nonzero exit', async () => {
    const { context, root, requests, facts } = await fixture(8, true);
    const input = Uint8Array.from([0, 255, 128, 1]);
    const result = await context.processes!.run({
      ...node(
        "process.stdin.on('data', x => process.stdout.write(x)); process.stdin.on('end', () => { process.stderr.write(JSON.stringify([process.argv[1], process.env.CORE_BASE, process.cwd()])); process.exitCode = 7; });"
      ),
      argv: [
        '-e',
        "process.stdin.on('data', x => process.stdout.write(x)); process.stdin.on('end', () => { process.stderr.write(JSON.stringify([process.argv[1], process.env.CORE_BASE, process.cwd()])); process.exitCode = 7; });",
        'a; $(echo never)'
      ],
      input,
      env: { CORE_BASE: 'override' }
    });
    expect(Buffer.from(result.stdout)).toEqual(Buffer.from(input));
    expect(JSON.parse(Buffer.from(result.stderr).toString())).toEqual([
      'a; $(echo never)',
      'override',
      root
    ]);
    expect(result).toMatchObject({ code: 0, signal: null, truncated: false, timedOut: false });
    expect(facts).toEqual([
      expect.objectContaining({
        processId: result.processId,
        code: 7,
        signal: null,
        truncated: false,
        timedOut: false
      })
    ]);
    expect(requests[0]).toMatchObject({
      shell: false,
      owner: { sessionId: 'session', operationId: expect.any(String) }
    });
    expect(requests[0]!.owner).not.toHaveProperty('executionId');
    expect(process.env.CORE_BASE).toBeUndefined();
  });

  it('closes absent stdin and drains both outputs while retaining only the configured prefixes', async () => {
    const { context } = await fixture();
    const result = await context.processes!.run({
      ...node(
        "process.stdin.on('end', () => { process.stdout.write(Buffer.alloc(200000, 255)); process.stderr.write(Buffer.alloc(180000, 128)); }); process.stdin.resume();"
      ),
      outputLimitBytes: 13
    });
    expect(result.stdout).toEqual(new Uint8Array(13).fill(255));
    expect(result.stderr).toEqual(new Uint8Array(13).fill(128));
    expect(result).toMatchObject({
      code: 0,
      stdoutBytes: 200000,
      stderrBytes: 180000,
      truncated: true
    });
    const empty = await context.processes!.run({
      ...node("process.stdout.write('x')"),
      outputLimitBytes: 0
    });
    expect(empty.stdout.length).toBe(0);
    expect(empty.stdoutBytes).toBe(1);
  });

  it('preserves unread raw output beyond legacy clipping and keeps a spawn alive after its hook returns', async () => {
    const { context, tool } = await fixture();
    const handle = await context.processes!.spawn(
      node(
        "process.stdout.write(Buffer.alloc(5 * 1024 * 1024 + 17, 173)); process.stderr.write('tail');"
      )
    );
    expect(tool.listSessionResources('session')).toEqual([]);
    await expect(
      tool.execute({ action: 'poll', processId: handle.processId })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_PROCESS_NOT_FOUND' });
    await pause(100);
    const [exit, stdout, stderr] = await complete(handle);
    expect(exit).toEqual({ code: 0, signal: null });
    expect(stdout.length).toBe(5 * 1024 * 1024 + 17);
    expect(stdout.every((value) => value === 173)).toBe(true);
    expect(stderr.toString()).toBe('tail');
    await handle.cancel();
  });

  it('does not drop a small exited process output when consumption is delayed beyond tool grace', async () => {
    const { context } = await fixture();
    const handle = await context.processes!.spawn(
      node("process.stdout.write('late-read'); process.stderr.write('other');")
    );
    expect(await handle.wait()).toEqual({ code: 0, signal: null });
    await pause(1100);
    expect((await bytes(handle.stdout)).toString()).toBe('late-read');
    expect((await bytes(handle.stderr)).toString()).toBe('other');
    await handle.cancel();
  });

  it('shares real admission limits with exec and releases capacity after cancellation', async () => {
    const { context, tool, pids } = await fixture(1);
    const handle = await context.processes!.spawn(node('setInterval(() => {}, 1000)'));
    await expect(tool.execute({ command: 'unused' })).rejects.toMatchObject({
      code: 'MAR_AGENT_PROCESS_LIMIT'
    });
    await expect(context.processes!.spawn(node(''))).rejects.toMatchObject({
      code: 'MAR_AGENT_PROCESS_LIMIT'
    });
    await handle.cancel();
    await handle.cancel();
    exited(pids[0]!);
    const next = await context.processes!.run(node('process.exitCode = 3'));
    expect(next.code).toBe(3);
  });

  it('serializes concurrent pulls and terminates the whole process on early iterator return', async () => {
    const { context, pids } = await fixture();
    const handle = await context.processes!.spawn(
      node(
        "process.stdout.write('a'); setTimeout(() => process.stdout.write('b'), 100); setInterval(() => {}, 1000)"
      )
    );
    const iterator = handle.stdout[Symbol.asyncIterator]();
    const [a, b] = await Promise.all([iterator.next(), iterator.next()]);
    expect(Buffer.from(a.value!).toString()).toBe('a');
    expect(Buffer.from(b.value!).toString()).toBe('b');
    await iterator.return!();
    exited(pids[0]!);
    expect((await handle.wait()).code).toBeNull();
  });

  it.runIf(process.platform === 'linux')(
    'terminates pipe-owning descendants after the direct parent already exited',
    async () => {
      const { context } = await fixture();
      const descendant =
        "process.on('SIGTERM', () => {}); process.stdout.write(process.pid + '\\n'); setInterval(() => {}, 1000);";
      const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', process.stdout, process.stderr] }); setTimeout(() => process.exit(0), 100);`;
      const handle = await context.processes!.spawn(node(parent));
      try {
        const chunk = await handle.stdout[Symbol.asyncIterator]().next();
        const pid = Number(Buffer.from(chunk.value!).toString().trim());
        expect(pid).toBeGreaterThan(0);
        expect(await handle.wait()).toEqual({ code: 0, signal: null });
        await handle.cancel();
        let stopped = false;
        for (let attempt = 0; attempt < 10 && !stopped; attempt++) {
          const state = await readFile(`/proc/${pid}/stat`, 'utf8').catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT' || error.code === 'ESRCH') return undefined;
              throw error;
            }
          );
          // Container PID 1 may not reap an orphan immediately; a zombie cannot keep doing work.
          stopped = state === undefined || state.split(') ')[1]?.startsWith('Z') === true;
          if (!stopped) await pause(20);
        }
        expect(stopped).toBe(true);
      } finally {
        await handle.cancel();
      }
    }
  );

  it('propagates child cancellation, stops actual OS work, and leaves the instance usable', async () => {
    const { context, pids } = await fixture();
    const controller = new AbortController();
    const reason = new Error('cancel-process');
    const handle = await context.processes!.spawn({
      ...node('setInterval(() => {}, 1000)'),
      signal: controller.signal
    });
    const waiting = handle.wait();
    const assertion = expect(waiting).rejects.toBe(reason);
    controller.abort(reason);
    await assertion;
    await handle.cancel();
    exited(pids[0]!);
    expect((await context.processes!.run(node(''))).code).toBe(0);
  });

  it('marks timeout separately from exit and preserves explicit cancellation reasons', async () => {
    const { context, pids } = await fixture();
    const result = await context.processes!.run({
      ...node('setInterval(() => {}, 1000)'),
      timeoutMs: 50
    });
    expect(result).toMatchObject({ timedOut: true, code: null });
    exited(pids[0]!);
    const controller = new AbortController();
    const reason = new Error('cancel-run');
    const pending = context.processes!.run({
      ...node('setInterval(() => {}, 1000)'),
      signal: controller.signal
    });
    const assertion = expect(pending).rejects.toBe(reason);
    await pause(50);
    controller.abort(reason);
    await assertion;
  });

  it('retirement joins children and in-flight reads without late effects or stale handles', async () => {
    const { context, manager, pids } = await fixture();
    const handle = await context.processes!.spawn(node('setInterval(() => {}, 1000)'));
    const pending = handle.stdout[Symbol.asyncIterator]().next();
    const settled = pending.catch((error) => error);
    await manager.dispose();
    await settled;
    exited(pids[0]!);
    await expect(context.processes!.spawn(node(''))).rejects.toMatchObject({
      code: 'MAR_AGENT_EXTENSION_RETIRED'
    });
  });

  it('rejects invalid input and real spawn failures without poisoning shared capacity', async () => {
    const { context } = await fixture(1);
    await expect(context.processes!.run({ executable: '' })).rejects.toMatchObject({
      code: 'MAR_AGENT_PROCESS_INPUT_INVALID'
    });
    await expect(
      context.processes!.run({ ...node(''), env: { 'bad=name': 'x' } })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_PROCESS_INPUT_INVALID' });
    await expect(context.processes!.run({ ...node(''), timeoutMs: 0 })).rejects.toMatchObject({
      code: 'MAR_AGENT_PROCESS_INPUT_INVALID'
    });
    await expect(
      context.processes!.spawn({ executable: 'mar-core-missing-executable-463a' })
    ).rejects.toMatchObject({
      code: 'MAR_AGENT_PROCESS_START_FAILED',
      details: { reasonCode: 'ENOENT' }
    });
    expect((await context.processes!.run(node(''))).code).toBe(0);
  });

  it('copies mutable argv, env and byte input before asynchronous admission', async () => {
    const { context } = await fixture();
    const input = {
      ...node(
        "process.stdin.on('data', x => process.stdout.write(x)); process.stdin.on('end', () => process.stderr.write(process.env.CORE_COPY));"
      ),
      env: { CORE_COPY: 'original' },
      input: new Uint8Array([1, 2, 3])
    };
    const pending = context.processes!.run(input);
    input.argv[1] = 'process.exitCode=6';
    input.env.CORE_COPY = 'mutated';
    input.input.fill(9);
    const result = await pending;
    expect(result.stdout).toEqual(new Uint8Array([1, 2, 3]));
    expect(Buffer.from(result.stderr).toString()).toBe('original');
  });

  it('overrides bound execution environment only for explicit values and never leaks it into idle starts', async () => {
    const { root } = await fixture();
    const host = new LocalAgentHost({
      homeDirectory: root,
      workspace: root,
      environment: { ...process.env, CORE_BINDING: 'base' }
    });
    const binding = host.bindExecutionExtensions({
      environment: { CORE_BINDING: 'bound', CORE_PRIVATE: 'private' }
    });
    const signal = new AbortController().signal;
    await host.listExecutionExtensions({
      sessionId: 'session',
      executionId: 'execution',
      claimExecutionScope: true
    });
    const operation = {
      operationId: 'operation',
      sessionId: 'session',
      sessionEpoch: 1,
      executionId: 'execution',
      actor: 'extension' as const,
      entry: 'native-api' as const,
      signal
    };
    try {
      const handle = await host.extensionPorts.processes!.spawn(
        {
          ...node(
            'process.stdout.write(JSON.stringify([process.env.CORE_BINDING, process.env.CORE_PRIVATE]));'
          ),
          env: { CORE_BINDING: 'explicit' }
        },
        operation
      );
      const [, stdout] = await complete(handle);
      await handle.cancel();
      expect(JSON.parse(stdout.toString())).toEqual(['explicit', 'private']);
      host.unbindExecutionMcp(binding);
      const { executionId: _executionId, ...idle } = operation;
      const next = await host.extensionPorts.processes!.spawn(
        node(
          'process.stdout.write(JSON.stringify([process.env.CORE_BINDING, process.env.CORE_PRIVATE]));'
        ),
        idle
      );
      const [, idleOutput] = await complete(next);
      expect(JSON.parse(idleOutput.toString())).toEqual(['base', null]);
      await next.cancel();
    } finally {
      await host.dispose();
    }
  });

  it('does not invent a facade when the Host has no native process port', async () => {
    let context!: SessionExtensionContext;
    const manager = new ExtensionManager({
      toolRuntime: extensionToolRuntime,
      extensions: [
        {
          id: 'none',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
          }
        }
      ],
      capabilities: [],
      busyExcept: () => false
    });
    managers.push(manager);
    await manager.prepare('empty', new AbortController().signal);
    expect(context.processes).toBeUndefined();
  });

  it('handles an asynchronous executor returning an already-exited child instead of waiting forever', async () => {
    let context!: SessionExtensionContext;
    const { session } = await sdkFixture(
      [
        {
          id: 'already-exited',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
          }
        }
      ],
      answer,
      false,
      false,
      {
        processExecutor: {
          async spawn(request) {
            const child = await directLocalProcessExecutor.spawn(request);
            child.stdin.end();
            await new Promise<void>((resolve) => child.once('exit', () => resolve()));
            return child;
          }
        }
      }
    );
    await session.run({ prompt: 'initialize' }).result();
    const handle = await context.processes!.spawn(node('process.exitCode=7'));
    expect(await Promise.race([handle.wait(), pause(100).then(() => 'hung')])).toEqual({
      code: 7,
      signal: null
    });
    await handle.cancel();
  });

  it('preserves a primary stream failure when independent handle cleanup also fails', async () => {
    const primary = new Error('primary-stream-failure');
    const cleanup = new Error('cleanup-failure');
    let context!: SessionExtensionContext;
    const manager = new ExtensionManager({
      toolRuntime: extensionToolRuntime,
      extensions: [
        {
          id: 'fault',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
          }
        }
      ],
      capabilities: ['processes'],
      busyExcept: () => false,
      hostPorts: {
        processes: {
          async spawn() {
            return {
              processId: 'fault',
              stdout: {
                // eslint-disable-next-line require-yield -- This fixture fails or waits for cancellation without emitting model events.
                async *[Symbol.asyncIterator]() {
                  throw primary;
                }
              },
              stderr: { async *[Symbol.asyncIterator]() {} },
              wait: async () => ({ code: 0, signal: null }),
              cancel: async () => {
                throw cleanup;
              }
            };
          }
        }
      }
    });
    await manager.prepare('fault', new AbortController().signal);
    await expect(context.processes!.run(node(''))).rejects.toBe(primary);
    expect(manager.diagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'MAR_AGENT_PROCESS_CLEANUP_FAILED' })
      ])
    );
    await expect(manager.dispose()).rejects.toMatchObject({
      code: 'MAR_AGENT_EXTENSION_CLEANUP_FAILED'
    });
  });

  it('cleans a late executor result when retirement happens during async spawn', async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let pid!: number;
    let context!: SessionExtensionContext;
    const { agent, session } = await sdkFixture(
      [
        {
          id: 'late',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
          }
        }
      ],
      answer,
      false,
      false,
      {
        processExecutor: {
          async spawn(request) {
            entered();
            await gate;
            const child = await directLocalProcessExecutor.spawn(request);
            pid = child.pid!;
            return child;
          }
        }
      }
    );
    await session.run({ prompt: 'initialize' }).result();
    const pending = context.processes!.spawn(node('setInterval(() => {}, 1000)'));
    const settled = pending.catch((error) => error);
    await started;
    const disposing = agent.dispose();
    release();
    await disposing;
    expect(await settled).toBeInstanceOf(Error);
    exited(pid);
  });

  it('preserves caller cancellation when an asynchronous executor rejects during startup', async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let context!: SessionExtensionContext;
    const { session } = await sdkFixture(
      [
        {
          id: 'startup-cancel',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
          }
        }
      ],
      answer,
      false,
      false,
      {
        processExecutor: {
          async spawn(request) {
            entered();
            await new Promise<never>((_resolve, reject) =>
              request.signal!.addEventListener(
                'abort',
                () => reject(new Error('executor stopped')),
                { once: true }
              )
            );
            throw new Error('unreachable');
          }
        }
      }
    );
    await session.run({ prompt: 'initialize' }).result();
    const controller = new AbortController();
    const reason = new Error('caller-cancelled-startup');
    const pending = context.processes!.spawn({ ...node(''), signal: controller.signal });
    const assertion = expect(pending).rejects.toBe(reason);
    await started;
    controller.abort(reason);
    await assertion;
  });

  it.each(['rejected', 'invalid'])('releases a spawn handle when wait fails (%s)', async (mode) => {
    let context!: SessionExtensionContext;
    let cancelled = 0;
    const primary = new Error('wait-failed');
    const manager = new ExtensionManager({
      toolRuntime: extensionToolRuntime,
      extensions: [
        {
          id: 'wait-fault',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
          }
        }
      ],
      capabilities: ['processes'],
      busyExcept: () => false,
      hostPorts: {
        processes: {
          async spawn() {
            return {
              processId: 'wait-fault',
              stdout: { async *[Symbol.asyncIterator]() {} },
              stderr: { async *[Symbol.asyncIterator]() {} },
              wait: async () => {
                if (mode === 'rejected') throw primary;
                return { code: 0 } as never;
              },
              cancel: async () => {
                cancelled++;
              }
            };
          }
        }
      }
    });
    managers.push(manager);
    await manager.prepare('wait-fault', new AbortController().signal);
    const handle = await context.processes!.spawn(node(''));
    if (mode === 'rejected') await expect(handle.wait()).rejects.toBe(primary);
    else
      await expect(handle.wait()).rejects.toMatchObject({
        code: 'MAR_AGENT_PROCESS_OUTPUT_INVALID'
      });
    expect(cancelled).toBe(1);
  });

  it('reports cleanup-only failure as a stable domain error without exposing the backend message', async () => {
    let context!: SessionExtensionContext;
    const manager = new ExtensionManager({
      toolRuntime: extensionToolRuntime,
      extensions: [
        {
          id: 'cleanup-fault',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
          }
        }
      ],
      capabilities: ['processes'],
      busyExcept: () => false,
      hostPorts: {
        processes: {
          async spawn() {
            return {
              processId: 'cleanup-fault',
              stdout: { async *[Symbol.asyncIterator]() {} },
              stderr: { async *[Symbol.asyncIterator]() {} },
              wait: async () => ({ code: 0, signal: null }),
              cancel: async () => {
                throw new Error('private-backend-detail');
              }
            };
          }
        }
      }
    });
    await manager.prepare('cleanup-fault', new AbortController().signal);
    const error = await context.processes!.run(node('')).catch((error) => error);
    expect(error).toMatchObject({ code: 'MAR_AGENT_PROCESS_CLEANUP_FAILED' });
    expect(error.message).not.toContain('private-backend-detail');
    await expect(manager.dispose()).rejects.toMatchObject({
      code: 'MAR_AGENT_EXTENSION_CLEANUP_FAILED'
    });
  });

  it.each([false, true])(
    'uses the same SDK lineage for model/Code Mode and idle calls (Code Mode=%s)',
    async (codeMode) => {
      let context!: SessionExtensionContext;
      const requests: LocalProcessSpawnRequest[] = [];
      const { session, host, adapter } = await sdkFixture(
        [
          {
            id: 'sdk-process',
            apiVersion: '1.0',
            attachSession(value) {
              context = value;
              value.tools.register({
                name: 'process_probe',
                description: 'Run raw process',
                inputSchema: { type: 'object' },
                execute: async () => {
                  const result = await value.processes!.run(
                    node("process.stdout.write('process-ok')")
                  );
                  return { content: Buffer.from(result.stdout).toString() };
                }
              });
            }
          }
        ],
        (_request, index) =>
          index === 0
            ? codeMode
              ? call('code_exec', 'observe.result(await tools.process_probe({}));')
              : call('process_probe', {})
            : answer(),
        codeMode,
        false,
        {
          processExecutor: {
            async spawn(request) {
              requests.push(request);
              return directLocalProcessExecutor.spawn(request);
            }
          }
        }
      );
      const outcome = await session.run({ prompt: 'probe' }).result();
      expect(outcome.status).toBe('completed');
      const modelProcess = requests.find((request) =>
        request.args?.includes("process.stdout.write('process-ok')")
      )!;
      expect(modelProcess.owner).toMatchObject({
        sessionId: session.id,
        executionId: outcome.executionId,
        operationId: expect.any(String),
        ownerInstanceId: expect.any(String)
      });
      const history = JSON.stringify(adapter.requests.at(-1)!.messages);
      expect((await context.processes!.run(node(''))).code).toBe(0);
      expect(requests.at(-1)!.owner).not.toHaveProperty('executionId');
      expect(context.capabilities.has('processes')).toBe(true);
      expect(JSON.stringify(adapter.requests.at(-1)!.messages)).toBe(history);
      expect((await host.listSessionResources!(session.id)).processes).toEqual([]);
    }
  );
});
