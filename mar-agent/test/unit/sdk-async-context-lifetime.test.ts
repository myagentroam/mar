import { describe, expect, it } from 'vitest';
import type { SessionExtensionContext } from '../../src/extensions/contracts.js';
import type { ToolRuntimeContext } from '../../src/tools/runtime-context.js';
import type { ExtensionOperationContext } from '../../src/extensions/operation.js';
import { ExecutionToolSources } from '../../src/sdk/extension-tools.js';
import { CompactCoordinator } from '../../src/runtime/compaction/coordinator.js';
import { createSessionToolScheduler } from '../../src/tools/scheduler.js';
import { SessionInputCoordinator } from '../../src/extensions/session-input.js';
import { trackAsyncContexts } from './support/async-contexts.js';
import {
  fixture,
  answer,
  call,
  agents,
  cleanupCoreFixtures
} from './support/core-extension-fixture.js';

describe('SDK async context ownership', () => {
  it.each([false, true])(
    'releases Session and Agent contexts across repeated lifetimes (cleanup failure: %s)',
    async (failCleanup) => {
      const contexts = trackAsyncContexts();
      try {
        let baseline: typeof contexts.active | undefined;
        for (let round = 0; round < 3; round++) {
          let context!: SessionExtensionContext;
          const { agent, session } = await fixture(
            [
              {
                id: 'context-lifetime',
                apiVersion: '1.0',
                attachSession(value) {
                  context = value;
                  if (failCleanup)
                    value.resources.effect(() => () => {
                      throw new Error('cleanup failed');
                    });
                  value.hooks.intercept('model.request', (request, _call, next) => next(request));
                  value.tools.register({
                    name: 'probe',
                    description: 'Read through a physical tool frame.',
                    inputSchema: { type: 'object' },
                    async execute() {
                      return value.tools.invoke({
                        name: 'read',
                        arguments: { reads: [{ path: 'input.txt' }] }
                      });
                    }
                  });
                }
              }
            ],
            (_request, index) => (index % 2 === 0 ? call('probe', {}) : answer()),
            false,
            false,
            {
              mcp: {
                async connect() {
                  return {
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
                    },
                    async call() {
                      return { content: 'MCP_OK' };
                    },
                    async close() {}
                  };
                }
              }
            }
          );
          for (let index = 0; index < 2; index++) {
            expect(await session.run({ prompt: 'probe' }).result()).toHaveProperty(
              'status',
              'completed'
            );
          }
          expect(
            await context.session!.append({ content: 'note', delivery: 'immediate' })
          ).toHaveProperty('status', 'committed');
          const registration = context.mcp!.register({ id: 'server', configuration: {} });
          await registration.ready;
          const connection = await context.mcp!.connect({ server: registration.ref });
          const catalog = await context.mcp!.catalog({ connection });
          expect(
            await context.mcp!.call({ tool: catalog.tools[0]!, arguments: {} })
          ).toHaveProperty('content', 'MCP_OK');
          if (failCleanup) await expect(agent.dispose()).rejects.toThrow();
          else await agent.dispose();
          agents.splice(agents.indexOf(agent), 1);
          baseline ??= new Set(contexts.active);
          expect(contexts.active.size).toBe(baseline.size);
          for (const context of contexts.active) expect(baseline.has(context)).toBe(true);
        }
      } finally {
        try {
          await cleanupCoreFixtures();
        } finally {
          contexts.restore();
        }
      }
    }
  );

  it('keeps an active input context during partial retirement and releases it only after full retirement joins', async () => {
    const contexts = trackAsyncContexts();
    const inputs = new SessionInputCoordinator();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const source: ExtensionOperationContext = {
      operationId: 'operation',
      sessionId: 'session',
      sessionEpoch: 1,
      ownerInstanceId: 'owner',
      actor: 'extension',
      entry: 'native-api',
      signal: new AbortController().signal
    };
    const pending = inputs.performAppend(
      { content: 'note', delivery: 'immediate' },
      source,
      (request, call, next) => next(request, call),
      async () => {
        started.resolve();
        await finish.promise;
        expect(inputs.executing).toBe(true);
        return { changed: true };
      }
    );
    try {
      await started.promise;
      await inputs.retire('another-owner');
      expect(contexts.active.size).toBe(1);
      let retired = false;
      const retiring = inputs.retire().then(() => {
        retired = true;
      });
      await Promise.resolve();
      expect(retired).toBe(false);
      expect(contexts.active.size).toBe(1);
      finish.resolve();
      await pending;
      await retiring;
      expect(contexts.active.size).toBe(0);
    } finally {
      finish.resolve();
      await pending;
      await inputs.retire();
      contexts.restore();
    }
  });

  it('releases idle scheduler context without breaking a parallel job or its nested serial work', async () => {
    const contexts = trackAsyncContexts();
    const schedule = createSessionToolScheduler();
    const definition = {
      name: 'serial',
      description: 'Serial',
      inputSchema: { type: 'object' },
      parallelSafety: 'serial' as const
    };
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let running: Promise<unknown>[] = [];
    try {
      running = [
        schedule(undefined, async () => {
          started.resolve();
          await finish.promise;
          return schedule(definition, async () => 'nested');
        }),
        schedule(undefined, async () => 'parallel')
      ];
      await started.promise;
      expect(await running[1]).toBe('parallel');
      expect(contexts.active.size).toBe(1);
      finish.resolve();
      expect(await running[0]).toBe('nested');
      expect(contexts.active.size).toBe(0);
      expect(await schedule(definition, async () => 'next')).toBe('next');
      expect(contexts.active.size).toBe(0);
    } finally {
      finish.resolve();
      await Promise.allSettled(running);
      contexts.restore();
    }
  });

  it('preserves parallel retained physical frames after close until the last callback settles', async () => {
    const contexts = trackAsyncContexts();
    const definition = { name: 'probe', description: 'Probe', inputSchema: { type: 'object' } };
    const sources = new ExecutionToolSources('execution', 'session', [definition], [definition], {
      revision: 'catalog',
      servers: [],
      tools: []
    });
    const context = {
      executionId: 'execution',
      sessionId: 'session',
      signal: new AbortController().signal
    } as ToolRuntimeContext;
    const call = { executionId: 'execution', sessionId: 'session' } as ExtensionOperationContext;
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    let running: Promise<unknown>[] = [];
    try {
      running = [first, second].map((gate) =>
        sources.withFrame(context, async () => {
          await gate.promise;
          expect(sources.bindings[0]!.available!(call)).toBe(true);
        })
      );
      sources.close();
      first.resolve();
      await running[0];
      expect(contexts.active.size).toBe(1);
      second.resolve();
      await running[1];
      expect(contexts.active.size).toBe(0);
      expect(sources.bindings[0]!.available!(call)).toBe(false);
    } finally {
      first.resolve();
      second.resolve();
      await Promise.allSettled(running);
      sources.close();
      contexts.restore();
    }
  });

  it.each(['success', 'failure', 'cancel'] as const)(
    'releases Compact context after %s and permits a new flight',
    async (outcome) => {
      const contexts = trackAsyncContexts();
      const coordinator = new CompactCoordinator();
      const ready = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const failure = new Error('compact failed');
      try {
        const flight = coordinator.start('first', undefined, async (_prepare, signal) => {
          expect(() => coordinator.assertNotReentrant()).toThrow();
          ready.resolve();
          await finish.promise;
          expect(() => coordinator.assertNotReentrant()).toThrow();
          signal.throwIfAborted();
          if (outcome === 'failure') throw failure;
          return true;
        });
        await ready.promise;
        expect(contexts.active.size).toBe(1);
        const closing = outcome === 'cancel' ? coordinator.close(failure) : undefined;
        finish.resolve();
        if (outcome === 'success') expect(await coordinator.checkpoint(true)).toBe(true);
        else if (outcome === 'failure')
          await expect(coordinator.checkpoint(true)).rejects.toBe(failure);
        else {
          await closing;
          await expect(flight.result).rejects.toBe(failure);
        }
        expect(contexts.active.size).toBe(0);
        coordinator.start('second', undefined, async () => false);
        expect(await coordinator.checkpoint(true)).toBe(false);
        expect(contexts.active.size).toBe(0);
      } finally {
        finish.resolve();
        await coordinator.close(failure);
        contexts.restore();
      }
    }
  );
});
