import { extensionToolRuntime } from '../../src/sdk/extension-tool-runtime.js';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalSessionEnvironment } from '../../src/host/local-session-environment.js';
import { ExtensionManager } from '../../src/extensions/manager.js';
import type { SessionExtensionContext } from '../../src/extensions/contracts.js';
import type { ExtensionOperationContext } from '../../src/extensions/operation.js';
import type { ExtensionEnvironmentBackend } from '../../src/extensions/environment.js';
import type { LocalProcessSpawnRequest } from '../../src/host/local-process-executor.js';
import { directLocalProcessExecutor } from '../../src/host/local-process-executor.js';
import { fixture, answer, call, cleanupCoreFixtures } from './support/core-extension-fixture.js';

const managers: ExtensionManager[] = [];
afterEach(async () => {
  await cleanupCoreFixtures();
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
});
function operation(sessionId = 'session', executionId?: string): ExtensionOperationContext {
  return {
    operationId: 'operation',
    sessionId,
    sessionEpoch: 1,
    actor: 'extension',
    entry: 'native-api',
    signal: new AbortController().signal,
    ...(executionId ? { executionId } : {})
  };
}
const node = (script: string) => ({ executable: process.execPath, argv: ['-e', script] });
async function sdkFixture(codeMode = false) {
  let context!: SessionExtensionContext;
  const starts: LocalProcessSpawnRequest[] = [];
  const facts: unknown[] = [];
  const sdk = await fixture(
    [
      {
        id: 'environment',
        apiVersion: '1.0',
        attachSession(value) {
          context = value;
          value.hooks.observe('environment.completed', (fact) => {
            facts.push(fact);
          });
          value.tools.register({
            name: 'env_probe',
            description: 'Set and inspect scoped process environment',
            inputSchema: { type: 'object' },
            execute: async () => {
              await value.environment!.set({ key: 'CORE_EXTENSION_ENV', value: 'scoped' });
              const result = await value.processes!.run(
                node("process.stdout.write(process.env.CORE_EXTENSION_ENV ?? 'missing')")
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
          ? call('code_exec', { code: 'observe.result(await tools.env_probe({}));' })
          : call('env_probe', {})
        : answer(),
    codeMode,
    false,
    {
      environment: { ...process.env, CORE_EXTENSION_ENV: 'base', CORE_LOWER_ENV: 'base-lower' },
      processExecutor: {
        async spawn(request) {
          starts.push(request);
          return directLocalProcessExecutor.spawn(request);
        }
      }
    }
  );
  await sdk.session.run({ prompt: 'initialize environment' }).result();
  return { ...sdk, context, starts, facts };
}

describe('Core scoped environment', () => {
  it.each([false, true])(
    'projects real values into model/Code Mode and idle raw starts without changing process.env (%s)',
    async (codeMode) => {
      const { context, starts, facts, adapter } = await sdkFixture(codeMode);
      expect(context.capabilities.has('environment')).toBe(true);
      expect(await context.environment!.get({ key: 'CORE_EXTENSION_ENV' })).toBe('scoped');
      expect(process.env.CORE_EXTENSION_ENV).toBeUndefined();
      const history = JSON.stringify(adapter.requests.at(-1)!.messages);
      const result = await context.processes!.run(
        node("process.stdout.write(process.env.CORE_EXTENSION_ENV ?? 'missing')")
      );
      expect(Buffer.from(result.stdout).toString()).toBe('scoped');
      expect(starts.at(-1)!.owner).not.toHaveProperty('executionId');
      expect(starts.at(-1)!.environment.CORE_EXTENSION_ENV).toBe('scoped');
      expect(facts).toEqual(
        expect.arrayContaining([{ operation: 'set', changed: true }, { operation: 'get' }])
      );
      expect(JSON.stringify(facts)).not.toContain('scoped');
      expect(JSON.stringify(adapter.requests.at(-1)!.messages)).toBe(history);
    }
  );

  it('uses the same overlay for legacy exec and new Code Mode worker starts', async () => {
    const { context, host, starts, session } = await sdkFixture();
    await context.environment!.set({ key: 'CORE_EXTENSION_ENV', value: 'next-worker' });
    const execution = {
      sessionId: session.id,
      executionId: 'manual',
      mode: 'run' as const,
      signal: new AbortController().signal
    };
    const result = await host.executeTool(
      {
        name: 'exec',
        arguments: {
          command: `${JSON.stringify(process.execPath)} -e "process.stdout.write(process.env.CORE_EXTENSION_ENV)"`,
          yieldMs: 5000
        }
      },
      execution
    );
    expect(result.data).toMatchObject({ status: 'completed', stdout: 'next-worker' });
    await host.executeTool(
      { name: 'code_exec', arguments: { code: 'observe.text("worker");' } },
      {
        ...execution,
        codeMode: { tools: [], invoke: async () => ({ content: '' }) }
      }
    );
    const worker = starts.findLast((request) => request.runtimeDirectories !== undefined)!;
    expect(worker.environment.CORE_EXTENSION_ENV).toBe('next-worker');
    expect(worker.environmentKeys).toContain('CORE_EXTENSION_ENV');
  });

  it('merges base, live execution, Session overlay and explicit env in order and retains unset tombstones', async () => {
    const { context, host, session } = await sdkFixture();
    const binding = host.bindExecutionExtensions({
      environment: { CORE_EXTENSION_ENV: 'execution', CORE_PRIVATE_ENV: 'private' }
    });
    await host.listExecutionExtensions({
      sessionId: session.id,
      executionId: 'bound',
      claimExecutionScope: true
    });
    const call = operation(session.id, 'bound');
    expect(await host.extensionPorts.environment!.get({ key: 'CORE_PRIVATE_ENV' }, call)).toBe(
      'private'
    );
    await context.environment!.set({ key: 'CORE_PRIVATE_ENV' });
    expect(
      await host.extensionPorts.environment!.get({ key: 'CORE_PRIVATE_ENV' }, call)
    ).toBeUndefined();
    const script =
      'process.stdout.write(JSON.stringify([process.env.CORE_EXTENSION_ENV, process.env.CORE_PRIVATE_ENV]));';
    const raw = await host.extensionPorts.processes!.spawn(
      { ...node(script), env: { CORE_EXTENSION_ENV: 'explicit' } },
      call
    );
    const chunks: Uint8Array[] = [];
    for await (const chunk of raw.stdout) chunks.push(chunk);
    expect(await raw.wait()).toEqual({ code: 0, signal: null });
    await raw.cancel();
    expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual(['explicit', null]);
    host.unbindExecutionMcp(binding);
    expect(
      await host.extensionPorts.environment!.get({ key: 'CORE_PRIVATE_ENV' }, call)
    ).toBeUndefined();
    expect(await context.environment!.set({ key: 'CORE_PRIVATE_ENV' })).toEqual({ changed: false });
  });

  it('isolates Sessions and resets the overlay on clear while retiring stale facades', async () => {
    const { context, agent, session, home, host } = await sdkFixture();
    const second = await agent.createSession({ workspace: home, title: 'Other environment' });
    expect(
      await host.extensionPorts.environment!.get(
        { key: 'CORE_EXTENSION_ENV' },
        operation(second.id)
      )
    ).toBe('base');
    await agent.clearSession(session.id);
    expect(
      await host.extensionPorts.environment!.get(
        { key: 'CORE_EXTENSION_ENV' },
        operation(session.id)
      )
    ).toBe('base');
    await expect(context.environment!.get({ key: 'CORE_EXTENSION_ENV' })).rejects.toMatchObject({
      code: 'MAR_AGENT_EXTENSION_RETIRED'
    });
  });

  it('does not change a process that was started before the overlay write', async () => {
    const { context } = await sdkFixture();
    const raw = await context.processes!.spawn(
      node(
        "process.stdout.write('ready'); setTimeout(() => { process.stderr.write(process.env.CORE_EXTENSION_ENV); }, 100);"
      )
    );
    const iterator = raw.stdout[Symbol.asyncIterator]();
    expect(Buffer.from((await iterator.next()).value!).toString()).toBe('ready');
    await context.environment!.set({ key: 'CORE_EXTENSION_ENV', value: 'future' });
    const chunks: Uint8Array[] = [];
    for await (const chunk of raw.stderr) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe('scoped');
    await raw.wait();
    await raw.cancel();
  });

  it('honors Windows case folding without duplicates and keeps POSIX names case-sensitive', async () => {
    const win = new LocalSessionEnvironment(
      { Path: 'base', FOO: 'base' },
      () => ({ path: 'execution' }),
      'win32'
    );
    const call = operation('win', 'execution');
    expect(await win.get({ key: 'PATH' }, call)).toBe('execution');
    await win.set({ key: 'pAtH', value: 'overlay' }, call);
    expect(await win.get({ key: 'path' }, call)).toBe('overlay');
    const result = win.forProcess({
      command: 'unused',
      cwd: '.',
      detached: false,
      environment: { Path: 'base' },
      environmentKeys: ['Path'],
      environmentOverrides: { PATH: 'explicit' },
      owner: { sessionId: 'win', executionId: 'execution' }
    });
    expect(Object.keys(result.environment).filter((key) => key.toLowerCase() === 'path')).toEqual([
      'PATH'
    ]);
    expect(result.environment.PATH).toBe('explicit');
    expect(result.environmentKeys).toEqual(['PATH']);
    const fresh = new LocalSessionEnvironment({ Path: 'base' }, () => undefined, 'win32');
    const explicit = fresh.forProcess({
      command: 'unused',
      cwd: '.',
      detached: false,
      environment: { Path: 'base', path: 'explicit' },
      environmentKeys: ['path'],
      environmentOverrides: { path: 'explicit' },
      owner: { sessionId: 'fresh' }
    });
    expect(explicit.environment).toEqual({ path: 'explicit' });
    const posix = new LocalSessionEnvironment({ KEY: 'upper' }, () => undefined, 'linux');
    await posix.set({ key: 'key', value: 'lower' }, operation());
    expect(await posix.get({ key: 'KEY' }, operation())).toBe('upper');
    expect(await posix.get({ key: 'key' }, operation())).toBe('lower');
    expect(await posix.get({ key: 'toString' }, operation())).toBeUndefined();
  });

  it('rejects invalid names/values and cancelled writes before committing without adding a variable whitelist', async () => {
    const { context } = await sdkFixture();
    await expect(context.environment!.set({ key: 'bad=name', value: 'x' })).rejects.toMatchObject({
      code: 'MAR_AGENT_ENVIRONMENT_INPUT_INVALID'
    });
    await expect(
      context.environment!.set({ key: 'allowed', value: 'bad\0value' })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_ENVIRONMENT_INPUT_INVALID' });
    await context.environment!.set({ key: 'ordinary-name.with.dot', value: 'accepted' });
    expect(await context.environment!.get({ key: 'ordinary-name.with.dot' })).toBe('accepted');
    const controller = new AbortController();
    const reason = new Error('cancel-env');
    controller.abort(reason);
    await expect(
      context.environment!.set({
        key: 'CORE_EXTENSION_ENV',
        value: 'late',
        signal: controller.signal
      })
    ).rejects.toBe(reason);
    expect(await context.environment!.get({ key: 'CORE_EXTENSION_ENV' })).toBe('scoped');
  });

  it('keeps original leaf changes when a Hook wraps the result and permits explicit repeated next', async () => {
    const { context, facts } = await sdkFixture();
    const hook = context.hooks.intercept('environment.set', async (input, _call, next) => {
      await next(input);
      await next(input);
      return { changed: false };
    });
    expect(await context.environment!.set({ key: 'CORE_EXTENSION_ENV', value: 'wrapped' })).toEqual(
      { changed: false }
    );
    expect(facts.slice(-2)).toEqual([
      { operation: 'set', changed: true },
      { operation: 'set', changed: false }
    ]);
    await hook.dispose();
    expect(await context.environment!.get({ key: 'CORE_EXTENSION_ENV' })).toBe('wrapped');
  });

  it('does not expose a fake environment facade on an older Host', async () => {
    let context!: SessionExtensionContext;
    const manager = new ExtensionManager({
      toolRuntime: extensionToolRuntime,
      extensions: [
        {
          id: 'old-host',
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
    await manager.prepare('session', new AbortController().signal);
    expect(context.environment).toBeUndefined();
    expect(context.capabilities.has('environment')).toBe(false);
  });

  it('captures the original changed value once instead of re-reading a mutable backend result getter', async () => {
    let context!: SessionExtensionContext;
    let reads = 0;
    const facts: unknown[] = [];
    const environment: ExtensionEnvironmentBackend = {
      get: async () => undefined,
      set: async () => ({
        get changed() {
          reads++;
          return reads === 1;
        }
      })
    };
    const manager = new ExtensionManager({
      toolRuntime: extensionToolRuntime,
      extensions: [
        {
          id: 'getter-env',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.hooks.observe('environment.completed', (fact) => {
              facts.push(fact);
            });
          }
        }
      ],
      capabilities: ['environment'],
      hostPorts: { environment },
      busyExcept: () => false
    });
    managers.push(manager);
    await manager.prepare('session', new AbortController().signal);
    expect(await context.environment!.set({ key: 'CORE_CHANGE', value: 'x' })).toEqual({
      changed: true
    });
    expect(reads).toBe(1);
    expect(facts).toEqual([{ operation: 'set', changed: true }]);
  });
});
