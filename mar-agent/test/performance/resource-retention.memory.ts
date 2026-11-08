import { setImmediate } from 'node:timers/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { queryObjects } from 'node:v8';
import { describe, expect, it, vi } from 'vitest';
import {
  ExtensionResourceScope,
  type ExtensionResourceRegistration
} from '../../src/extensions/resources.js';
import { ExtensionHooks } from '../../src/extensions/hooks.js';
import { ExtensionTools } from '../../src/extensions/tools.js';
import { extensionToolRuntime } from '../../src/sdk/extension-tool-runtime.js';
import { ExecutionToolSources } from '../../src/sdk/extension-tools.js';
import { SessionInputCoordinator } from '../../src/extensions/session-input.js';
import {
  bindCoreNetwork,
  type ExtensionHttpResponse,
  type DomainNetworkOperations,
  type DomainNetworkFacts
} from '../../src/extensions/network.js';
import {
  bindCoreProcesses,
  type ExtensionProcessHandle,
  type DomainProcessOperations,
  type DomainProcessFacts
} from '../../src/extensions/processes.js';
import type { SessionExtensionContext } from '../../src/extensions/contracts.js';
import {
  fixture,
  answer,
  agents,
  cleanupCoreFixtures
} from '../unit/support/core-extension-fixture.js';

describe('long-lived resource owner retention', () => {
  it.each(['effect', 'hook', 'tool', 'one-shot timer'] as const)(
    'releases %s payloads while both the scope and closed handles remain reachable',
    async (kind) => {
      class Payload {
        readonly bytes = Buffer.alloc(16 * 1024);
        touch() {
          this.bytes[0]++;
        }
      }
      const scope = new ExtensionResourceScope();
      const hooks = new ExtensionHooks();
      const tools = new ExtensionTools(undefined, undefined, extensionToolRuntime.validateCallers);
      const handles: ExtensionResourceRegistration[] = [];
      if (kind === 'one-shot timer')
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
      scope.activate();
      const cycle = async () => {
        for (let index = 0; index < 20; index++) {
          const payload = new Payload();
          const handle =
            kind === 'effect'
              ? scope.effect(() => () => payload.touch())
              : kind === 'hook'
                ? hooks.intercept(scope, 'model.request', async (request, _call, next) => {
                    payload.touch();
                    return next(request);
                  })
                : kind === 'tool'
                  ? tools.register(scope, 'owner', {
                      name: 'probe',
                      description: 'Probe',
                      inputSchema: { type: 'object' },
                      execute: () => {
                        payload.touch();
                        return { content: 'done' };
                      }
                    })
                  : scope.after(1, () => payload.touch());
          handles.push(handle);
          await handle.ready;
          if (kind === 'one-shot timer') await vi.advanceTimersByTimeAsync(10);
          else await handle.dispose();
        }
      };
      try {
        await cycle();
        for (let round = 0; round < 3; round++) {
          await cycle();
          await setImmediate();
          expect(queryObjects(Payload)).toBe(0);
        }
        await scope.ready();
        for (const handle of handles) await handle.dispose();
        expect(scope.state).toBe('ACTIVE');
        expect(handles).toHaveLength(80);
      } finally {
        await scope.dispose();
        hooks.dispose();
        if (kind === 'one-shot timer') vi.useRealTimers();
      }
    }
  );

  it('does not let a closed registration retain its former scope owner', async () => {
    class Owner extends ExtensionResourceScope {}
    const create = async () => {
      const scope = new Owner();
      const handle = scope.effect(() => () => {});
      await handle.ready;
      await handle.dispose();
      await scope.dispose();
      return handle;
    };
    const handles = [];
    for (let round = 0; round < 3; round++) {
      handles.push(await create());
      await setImmediate();
      expect(queryObjects(Owner)).toBe(0);
    }
    for (const handle of handles) await handle.dispose();
  });

  it('does not accumulate failed acquisitions when callers only observe readiness', async () => {
    const scope = new ExtensionResourceScope();
    const failure = new Error('acquire failed');
    scope.activate();
    const cycle = async () => {
      for (let index = 0; index < 20; index++) {
        const resource = scope.effect(() => {
          throw failure;
        });
        await expect(resource.ready).rejects.toBe(failure);
      }
    };
    try {
      await cycle();
      await setImmediate();
      const baseline = queryObjects(AsyncLocalStorage);
      for (let round = 0; round < 3; round++) {
        await cycle();
        await setImmediate();
        expect(queryObjects(AsyncLocalStorage)).toBe(baseline);
      }
      await expect(scope.ready()).rejects.toBe(failure);
    } finally {
      await scope.dispose();
    }
  });

  it('releases failed disposer payloads while retaining the same observable failure', async () => {
    class Payload {
      readonly bytes = Buffer.alloc(16 * 1024);
      touch() {
        this.bytes[0]++;
      }
    }
    const scope = new ExtensionResourceScope();
    const failure = new Error('release failed');
    const handles: ExtensionResourceRegistration[] = [];
    const cycle = async () => {
      for (let index = 0; index < 20; index++) {
        const payload = new Payload();
        const handle = scope.effect(() => () => {
          payload.touch();
          throw failure;
        });
        handles.push(handle);
        await handle.ready;
        await expect(handle.dispose()).rejects.toBe(failure);
      }
    };
    try {
      await cycle();
      for (let round = 0; round < 3; round++) {
        await cycle();
        await setImmediate();
        expect(queryObjects(Payload)).toBe(0);
      }
      for (const handle of handles) await expect(handle.dispose()).rejects.toBe(failure);
      await expect(scope.dispose()).rejects.toMatchObject({
        code: 'MAR_AGENT_EXTENSION_CLEANUP_FAILED',
        details: { failures: handles.length }
      });
    } finally {
      await scope.dispose().catch(() => undefined);
    }
  });

  it('releases disposer closures even when each creates its own cached failure', async () => {
    class Payload {
      readonly bytes = Buffer.alloc(16 * 1024);
      touch() {
        this.bytes[0]++;
      }
    }
    const scope = new ExtensionResourceScope();
    const handles: ExtensionResourceRegistration[] = [];
    const cycle = async () => {
      for (let index = 0; index < 20; index++) {
        const payload = new Payload();
        const handle = scope.effect(() => () => {
          payload.touch();
          throw new Error('release failed');
        });
        handles.push(handle);
        await handle.ready;
        await handle.dispose().catch((error) => expect(error.message).toBe('release failed'));
      }
    };
    try {
      await cycle();
      await setImmediate();
      expect(queryObjects(Payload)).toBe(0);
      for (const handle of handles)
        await handle.dispose().catch((error) => expect(error.message).toBe('release failed'));
    } finally {
      await scope.dispose().catch(() => undefined);
    }
  });

  it('does not retain a retired owner handler through retained opaque refs and an old API', async () => {
    class Handler {
      readonly bytes = Buffer.alloc(16 * 1024);
      execute() {
        this.bytes[0]++;
        return { content: 'done' };
      }
    }
    let context!: SessionExtensionContext;
    const refs = [];
    try {
      const { agent, session } = await fixture(
        [
          {
            id: 'retention',
            apiVersion: '1.0',
            attachSession(value) {
              context = value;
            }
          }
        ],
        () => answer()
      );
      await session.run({ prompt: 'initialize' }).result();
      const cycle = async () => {
        for (let index = 0; index < 10; index++) {
          const handler = new Handler();
          const resource = context.tools.register({
            name: 'probe',
            description: 'Probe',
            inputSchema: { type: 'object' },
            execute: () => handler.execute()
          });
          await resource.ready;
          refs.push(context.tools.catalog().find((ref) => ref.definition.name === 'probe')!);
          await resource.dispose();
        }
      };
      await cycle();
      for (let round = 0; round < 3; round++) {
        await cycle();
        await setImmediate();
        // Captured handlers intentionally remain callable while their owner is active.
        expect(queryObjects(Handler)).toBe(refs.length);
      }
      await agent.dispose();
      await setImmediate();
      expect(queryObjects(Handler)).toBe(0);
      expect(refs).toHaveLength(40);
    } finally {
      await cleanupCoreFixtures();
    }
  });

  it('releases a failed extension owner handler while its Session and captured refs remain alive', async () => {
    class Handler {
      execute() {
        return { content: 'failed owner' };
      }
    }
    let context!: SessionExtensionContext;
    const refs: ReturnType<SessionExtensionContext['tools']['catalog']>[number][] = [];
    try {
      const { session } = await fixture(
        [
          {
            id: 'failed-owner',
            apiVersion: '1.0',
            async attachSession(value) {
              const handler = new Handler();
              const resource = value.tools.register({
                name: 'probe',
                description: 'Probe',
                inputSchema: { type: 'object' },
                execute: () => handler.execute()
              });
              await resource.ready;
              refs.push(value.tools.catalog().find((ref) => ref.definition.name === 'probe')!);
              await resource.dispose();
              throw new Error('attach failed');
            }
          },
          {
            id: 'live-owner',
            apiVersion: '1.0',
            attachSession(value) {
              context = value;
            }
          }
        ],
        () => answer()
      );
      await session.run({ prompt: 'initialize' }).result();
      expect(refs).toHaveLength(1);
      await expect(
        context.tools.invoke({ name: 'probe', ref: refs[0]!, arguments: {} })
      ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_NOT_AVAILABLE' });
      await setImmediate();
      expect(queryObjects(Handler)).toBe(0);
      await session.run({ prompt: 'still alive' }).result();
    } finally {
      await cleanupCoreFixtures();
    }
  });

  it.each(['native', 'wrap', 'replace'] as const)(
    'does not retain completed Execution source graphs through captured refs (%s)',
    async (kind) => {
      let context!: SessionExtensionContext;
      let capture = false;
      const refs: ReturnType<SessionExtensionContext['tools']['catalog']>[number][] = [];
      try {
        const { session, adapter } = await fixture(
          [
            {
              id: 'execution-retention',
              apiVersion: '1.0',
              attachSession(value) {
                context = value;
                if (kind !== 'native')
                  value.tools.register({
                    name: 'read',
                    description: 'Read',
                    inputSchema: { type: 'object' },
                    override: kind,
                    execute: (input, _call, next) =>
                      kind === 'wrap' ? next(input) : { content: 'replacement' }
                  });
                value.hooks.intercept('model.request', (request, _call, next) => {
                  if (capture)
                    refs.push(value.tools.catalog().find((ref) => ref.definition.name === 'read')!);
                  return next(request);
                });
              }
            }
          ],
          () => answer()
        );
        await session.run({ prompt: 'warm up' }).result();
        // The Fake adapter archives requests with Execution-local usage callbacks.
        adapter.requests.length = 0;
        await setImmediate();
        const baseline = queryObjects(ExecutionToolSources);
        capture = true;
        for (let round = 0; round < 3; round++) {
          for (let index = 0; index < 10; index++) {
            await session.run({ prompt: 'capture' }).result();
            adapter.requests.length = 0;
          }
          await setImmediate();
          expect(queryObjects(ExecutionToolSources)).toBe(baseline);
        }
        expect(refs).toHaveLength(30);
        const old = context.tools.invoke({
          name: 'read',
          ref: refs[0]!,
          arguments: { path: 'input.txt' }
        });
        if (kind === 'replace') await expect(old).resolves.toHaveProperty('content', 'replacement');
        else await expect(old).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_NOT_AVAILABLE' });
      } finally {
        await cleanupCoreFixtures();
      }
    }
  );

  it.each(['committed', 'cancelled'] as const)(
    'keeps only receipts for settled Session input history (%s)',
    async (mode) => {
      class Payload {
        readonly bytes = Buffer.alloc(16 * 1024);
        touch() {
          this.bytes[0]++;
        }
      }
      const inputs = new SessionInputCoordinator();
      let sequence = 0;
      const cycle = async () => {
        for (let index = 0; index < 20; index++) {
          const payload = new Payload();
          if (mode === 'cancelled') {
            const controller = new AbortController();
            const entry = inputs.accept(
              { kind: 'append', input: { content: 'input' } },
              {
                operationId: `input-${++sequence}`,
                sessionId: 'session',
                sessionEpoch: 0,
                signal: controller.signal,
                actor: 'extension',
                entry: 'native-api'
              },
              async () => {
                payload.touch();
                return { changed: true };
              },
              'queued'
            );
            controller.abort();
            await entry.terminal;
            continue;
          }
          await inputs.performAppend(
            { content: 'input', visibility: 'model' },
            {
              operationId: `input-${++sequence}`,
              sessionId: 'session',
              sessionEpoch: 0,
              signal: new AbortController().signal,
              actor: 'extension',
              entry: 'native-api',
              publishEventData: async () => {
                payload.touch();
              }
            },
            async (request, call, next) => {
              payload.touch();
              return next(request, call);
            },
            async () => ({ changed: true, recordId: `record-${sequence}` })
          );
        }
      };
      try {
        for (let round = 0; round < 3; round++) {
          await cycle();
          await setImmediate();
          expect(queryObjects(Payload)).toBe(0);
          expect(inputs.inspect()).toHaveLength(sequence);
          expect(inputs.inspect().at(-1)).toMatchObject({
            status: mode,
            ...(mode === 'committed' ? { recordId: `record-${sequence}` } : {})
          });
        }
      } finally {
        await inputs.retire();
      }
    }
  );

  it.each(['close', 'return', 'exhaust', 'owner', 'failure'] as const)(
    'detaches closed HTTP response facades from transport leases (%s)',
    async (mode) => {
      const failure = new Error('close failed');
      class Lease implements ExtensionHttpResponse {
        readonly url = 'https://memory.invalid';
        readonly status = 200;
        readonly statusText = 'OK';
        readonly redirected = false;
        readonly headers = [];
        readonly bytes = Buffer.alloc(16 * 1024);
        readonly body = { [Symbol.asyncIterator]: () => this.read() };
        async *read() {
          yield this.bytes;
        }
        async close() {
          this.bytes[0]++;
          if (mode === 'failure') throw failure;
        }
      }
      const scope = new ExtensionResourceScope();
      scope.activate();
      const hooks = new ExtensionHooks<DomainNetworkOperations, DomainNetworkFacts>();
      const api = bindCoreNetwork(
        { fetch: async () => new Lease() },
        (run) =>
          scope.run((signal) =>
            run({
              operationId: 'fetch',
              sessionId: 'session',
              sessionEpoch: 0,
              actor: 'extension',
              entry: 'native-api',
              signal
            })
          ),
        scope,
        hooks,
        () => {}
      );
      const responses: ExtensionHttpResponse[] = [];
      const cycle = async () => {
        for (let index = 0; index < 20; index++) {
          const response = await api.fetch({ url: 'https://memory.invalid' });
          responses.push(response);
          if (mode === 'failure') await expect(response.close()).rejects.toBe(failure);
          else if (mode === 'close') await response.close();
          else if (mode === 'return') await response.body[Symbol.asyncIterator]().return!();
          else if (mode === 'exhaust')
            for await (const bytes of response.body) expect(bytes).toHaveLength(16 * 1024);
        }
      };
      try {
        await cycle();
        if (mode === 'owner') await scope.dispose();
        await setImmediate();
        expect(queryObjects(Lease)).toBe(0);
        for (const response of responses) {
          expect(await response.body[Symbol.asyncIterator]().next()).toMatchObject({ done: true });
          if (mode === 'failure') await expect(response.close()).rejects.toBe(failure);
          else await response.close();
        }
        expect(responses).toHaveLength(20);
      } finally {
        await scope.dispose().catch((error) => {
          if (mode !== 'failure') throw error;
        });
        hooks.dispose();
      }
    }
  );

  it.each(['cancel', 'return', 'exhaust', 'owner', 'wait-failure', 'cleanup-failure'] as const)(
    'detaches settled process facades without dropping unread output (%s)',
    async (mode) => {
      const failure = new Error('process failed');
      class Lease implements ExtensionProcessHandle {
        readonly processId = 'process';
        readonly bytes = Buffer.alloc(16 * 1024);
        cancelled = false;
        readonly stdout = { [Symbol.asyncIterator]: () => this.read() };
        readonly stderr = { [Symbol.asyncIterator]: () => this.read() };
        async *read() {
          yield this.bytes;
        }
        async wait() {
          if (mode === 'wait-failure') throw failure;
          return { code: this.cancelled ? null : 0, signal: null };
        }
        async cancel() {
          this.cancelled = true;
          if (mode === 'cleanup-failure') throw failure;
        }
      }
      const scope = new ExtensionResourceScope();
      scope.activate();
      const hooks = new ExtensionHooks<DomainProcessOperations, DomainProcessFacts>();
      const api = bindCoreProcesses(
        { spawn: async () => new Lease() },
        (run) =>
          scope.run((signal) =>
            run({
              operationId: 'spawn',
              sessionId: 'session',
              sessionEpoch: 0,
              actor: 'extension',
              entry: 'native-api',
              signal
            })
          ),
        scope,
        hooks,
        () => {}
      );
      const handles: ExtensionProcessHandle[] = [];
      const cycle = async () => {
        for (let index = 0; index < 10; index++) {
          const handle = await api.spawn({ executable: 'fake' });
          handles.push(handle);
          if (mode === 'cancel') await handle.cancel();
          else if (mode === 'return') await handle.stdout[Symbol.asyncIterator]().return!();
          else if (mode === 'cleanup-failure')
            await expect(handle.cancel()).rejects.toMatchObject({
              code: 'MAR_AGENT_PROCESS_CLEANUP_FAILED'
            });
          else if (mode === 'wait-failure') await expect(handle.wait()).rejects.toBe(failure);
          else if (mode === 'exhaust') {
            expect(await handle.wait()).toMatchObject({ code: 0 });
            for await (const bytes of handle.stdout) expect(bytes).toHaveLength(16 * 1024);
            for await (const bytes of handle.stderr) expect(bytes).toHaveLength(16 * 1024);
          }
        }
      };
      try {
        await cycle();
        if (mode === 'owner') await scope.dispose();
        await setImmediate();
        expect(queryObjects(Lease)).toBe(0);
        for (const handle of handles) {
          if (mode === 'owner')
            await expect(handle.wait()).rejects.toMatchObject({
              code: 'MAR_AGENT_EXTENSION_RETIRED'
            });
          else if (mode === 'wait-failure') await expect(handle.wait()).rejects.toBe(failure);
          else expect(await handle.wait()).toMatchObject({ code: mode === 'exhaust' ? 0 : null });
          expect(await handle.stdout[Symbol.asyncIterator]().next()).toMatchObject({ done: true });
          if (mode === 'cleanup-failure')
            await expect(handle.cancel()).rejects.toMatchObject({
              code: 'MAR_AGENT_PROCESS_CLEANUP_FAILED'
            });
          else await handle.cancel();
        }
      } finally {
        await scope.dispose().catch((error) => {
          if (mode !== 'cleanup-failure') throw error;
        });
        hooks.dispose();
      }
    }
  );

  it.each([false, true, 'own-error'] as const)(
    'does not retain disconnected MCP leases through refs (close failure: %s)',
    async (failClose) => {
      const failure = new Error('close failed');
      let closes = 0;
      class Lease {
        readonly bytes = Buffer.alloc(16 * 1024);
        async catalog() {
          return {
            revision: 'catalog',
            servers: [{ id: 'server', name: 'Server' }],
            tools: [
              {
                definition: {
                  name: 'query',
                  description: 'Query',
                  inputSchema: { type: 'object' }
                },
                serverId: 'server',
                rawName: 'query',
                sourceIdentity: 'source',
                definitionRevision: 'definition',
                lifetime: 'session',
                exposure: 'direct'
              }
            ]
          };
        }
        async call() {
          this.bytes[0]++;
          return { content: 'done' };
        }
        async close() {
          this.bytes[0] = 0;
          closes++;
          if (failClose) throw failClose === 'own-error' ? new Error('close failed') : failure;
        }
      }
      let context!: SessionExtensionContext;
      const refs: unknown[] = [];
      let failedAgent: (typeof agents)[number] | undefined;
      try {
        const { agent, session } = await fixture(
          [
            {
              id: 'retention',
              apiVersion: '1.0',
              attachSession(value) {
                context = value;
              }
            }
          ],
          () => answer(),
          false,
          false,
          {
            mcp: {
              async connect() {
                return new Lease();
              }
            }
          }
        );
        if (failClose) failedAgent = agent;
        await session.run({ prompt: 'initialize' }).result();
        const declaration = context.mcp!.register({ id: 'server', configuration: {} });
        await declaration.ready;
        const cycle = async () => {
          for (let index = 0; index < 10; index++) {
            const connection = await context.mcp!.connect({ server: declaration.ref });
            const catalog = await context.mcp!.catalog({ connection });
            refs.push(connection, ...catalog.tools);
            if (failClose) {
              const error = await context
                .mcp!.disconnect({ connection })
                .catch((error: unknown) => error);
              expect(error).toMatchObject({ code: 'MAR_AGENT_MCP_CLEANUP_FAILED' });
              await expect(context.mcp!.disconnect({ connection })).rejects.toBe(error);
            } else {
              await context.mcp!.disconnect({ connection });
              await context.mcp!.disconnect({ connection });
            }
          }
        };
        await cycle();
        for (let round = 0; round < 3; round++) {
          await cycle();
          await setImmediate();
          expect(queryObjects(Lease)).toBe(0);
        }
        expect(refs).toHaveLength(80);
        expect(closes).toBe(40);
        expect(context.mcp!.connections()).toHaveLength(0);
        if (failClose)
          await expect(agent.dispose()).rejects.toMatchObject({
            code: 'MAR_AGENT_EXTENSION_CLEANUP_FAILED'
          });
      } finally {
        if (failedAgent) {
          await failedAgent.dispose().catch(() => undefined);
          // Do not mask an earlier assertion with the deliberately failed fixture cleanup.
          const index = agents.indexOf(failedAgent);
          if (index !== -1) agents.splice(index, 1);
        }
        await cleanupCoreFixtures();
      }
    }
  );
});
