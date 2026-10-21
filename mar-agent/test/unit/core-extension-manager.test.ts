import { describe, expect, it, vi } from 'vitest';
import { ExtensionManager } from '../../src/agent-core/extensions/manager.js';
import type {
  CoreExtensionSnapshot,
  CoreRuntimeExtension,
  CoreSessionExtensionContext
} from '../../src/agent-core/extensions/contracts.js';
import type { CoreServiceKey } from '../../src/agent-core/extensions/services.js';
const signal = () => new AbortController().signal;

describe('Extension composition admission', () => {
  it.each(['dispose', 'cancelled'] as const)(
    'rejects %s admission before waiting behind a disposer that joins the caller',
    async (mode) => {
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const manager = new ExtensionManager({
        extensions: [
          {
            id: 'owned-child',
            apiVersion: '1.0',
            attachSession: () => async () => {
              entered();
              await gate;
            }
          }
        ],
        capabilities: [],
        busyExcept: () => false
      });
      await manager.prepare('parent', signal());
      const cleanup = mode === 'dispose' ? manager.dispose() : manager.clearSession('parent');
      await started;
      const preparation = manager.prepare(
        'child',
        mode === 'cancelled' ? AbortSignal.abort() : signal()
      );
      const rejected = preparation.then(
        () => false,
        () => true
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        expect(
          await Promise.race([
            rejected,
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => resolve(false), 100);
            })
          ])
        ).toBe(true);
        expect(manager.session('child')).toBeUndefined();
      } finally {
        clearTimeout(timer);
        release();
        await cleanup;
        await rejected;
        await manager.dispose();
      }
    }
  );

  it.each(['command', 'tool', 'intercept', 'observe'] as const)(
    '%s callback retirement cancels nested calls through another active facade',
    async (kind) => {
      let consumer!: CoreSessionExtensionContext;
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let callbackSignal!: AbortSignal;
      let nestedError: unknown;
      const callback = async (
        call: import('../../src/agent-core/extensions/operation.js').CoreOperationContext
      ) => {
        callbackSignal = call.signal;
        entered();
        await gate;
        try {
          await consumer.data.state.write('late', true);
        } catch (error) {
          nestedError = error;
        }
      };
      const manager = new ExtensionManager({
        extensions: [
          {
            id: 'consumer',
            apiVersion: '1.0',
            attachSession(context) {
              consumer = context;
            }
          },
          {
            id: 'provider',
            apiVersion: '1.0',
            attachSession(context) {
              if (kind === 'command')
                context.commands.register({
                  name: 'probe',
                  handler: (_args, call) => callback(call)
                });
              else if (kind === 'tool')
                context.tools.register({
                  name: 'probe',
                  description: 'Probe',
                  inputSchema: { type: 'object' },
                  async execute(_input, call) {
                    await callback(call);
                    return { content: 'done' };
                  }
                });
              else if (kind === 'intercept')
                context.hooks.intercept('prompt.compose', async (input, call, next) => {
                  await callback(call);
                  return next(input);
                });
              else context.hooks.observe('agent.completed', (_fact, call) => callback(call));
            }
          }
        ],
        capabilities: [],
        busyExcept: () => false
      });
      try {
        const runtime = await manager.prepare('s', signal());
        const pending = (
          kind === 'command'
            ? consumer.commands.run({ name: 'probe' })
            : kind === 'tool'
              ? consumer.tools.invoke({ name: 'probe', arguments: {} })
              : kind === 'intercept'
                ? consumer.prompts.compose('system')
                : runtime.operations.run(
                    {
                      sessionId: 's',
                      sessionEpoch: 0,
                      actor: 'sdk',
                      entry: 'native-api',
                      signal: signal()
                    },
                    (call) =>
                      runtime.hooks.emit(
                        'agent.completed',
                        { operation: 'spawn', agentId: 'child', status: 'completed' },
                        call
                      )
                  )
        ).then(
          () => undefined,
          (error: unknown) => error
        );
        await started;
        runtime.scopes[1]!.retire();
        expect(callbackSignal.aborted).toBe(true);
        release();
        await pending;
        expect(nestedError).toBeDefined();
        expect(await consumer.data.state.read('late')).toBeUndefined();
        await expect(consumer.data.state.write('fresh', true)).resolves.toBe(1);
      } finally {
        release();
        await manager.dispose();
      }
    }
  );

  it('dispatches a managed timer as native ingress while its Code Mode creator is still active', async () => {
    let context!: CoreSessionExtensionContext;
    let timerCall:
      import('../../src/agent-core/extensions/operation.js').CoreOperationContext | undefined;
    let timerError: unknown;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const manager = new ExtensionManager({
      extensions: [
        {
          id: 'timer',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.tools.register({
              name: 'direct_only',
              description: 'Direct only',
              inputSchema: { type: 'object' },
              allowedCallers: ['direct'],
              execute: () => ({ content: 'native' })
            });
            value.tools.register({
              name: 'creator',
              description: 'Creator',
              inputSchema: { type: 'object' },
              async execute() {
                value.clock.after(0, async (call) => {
                  timerCall = call;
                  try {
                    await value.tools.invoke({ name: 'direct_only', arguments: {} });
                  } catch (error) {
                    timerError = error;
                  } finally {
                    finish();
                  }
                });
                await finished;
                return { content: 'done' };
              }
            });
          }
        }
      ],
      capabilities: [],
      busyExcept: () => false
    });
    try {
      const runtime = await manager.prepare('s', signal());
      await runtime.operations.enter(
        {
          sessionId: 's',
          sessionEpoch: 0,
          executionId: 'real-parent',
          actor: 'code-mode',
          entry: 'programmatic',
          signal: signal()
        },
        () => context.tools.invoke({ name: 'creator', arguments: {} })
      );
      expect(timerCall).toMatchObject({ actor: 'extension', entry: 'native-api' });
      expect(timerCall!.executionId).toBeUndefined();
      expect(timerCall!.parentOperationId).toBeUndefined();
      expect(timerError).toBeUndefined();
    } finally {
      finish();
      await manager.dispose();
    }
  });

  it('isolates a failed state observer and cancels its accepted borrowed work before joining', async () => {
    let consumer!: CoreSessionExtensionContext;
    let provider!: CoreSessionExtensionContext;
    const primary = new Error('state observer failed');
    const safety = new AbortController();
    let nested: Promise<unknown> | undefined;
    const manager = new ExtensionManager({
      extensions: [
        {
          id: 'consumer',
          apiVersion: '1.0',
          attachSession(context) {
            consumer = context;
          }
        },
        {
          id: 'provider',
          apiVersion: '1.0',
          attachSession(context) {
            provider = context;
          }
        }
      ],
      capabilities: [],
      busyExcept: () => false
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await manager.prepare('s', signal());
      provider.data.state.watch(async () => {
        nested = consumer.clock.sleep({ durationMs: 60_000, signal: safety.signal }).then(
          () => undefined,
          (error: unknown) => error
        );
        await consumer.clock.sleep({ durationMs: 0 });
        throw primary;
      });
      await expect(
        Promise.race([
          provider.data.state.write('committed', true),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Observer descendants did not join.')), 2000);
          })
        ])
      ).resolves.toBe(1);
      expect(await nested).toBe(primary);
      expect(await provider.data.state.read('committed')).toBe(true);
      expect(manager.diagnostics()).toContainEqual(
        expect.objectContaining({ code: 'MAR_AGENT_EXTENSION_STATE_OBSERVER_FAILED' })
      );
      await expect(consumer.data.state.write('independent', true)).resolves.toBe(1);
    } finally {
      if (timer) clearTimeout(timer);
      safety.abort();
      await nested;
      await manager.dispose();
    }
  });

  it.each(['clear', 'replace', 'dispose'] as const)(
    'retires the entire Session runtime without extension instances on %s',
    async (action) => {
      let revision = '1';
      const manager = new ExtensionManager({
        extensions: { resolve: async () => ({ revision, extensions: [] }) },
        capabilities: [],
        busyExcept: () => false
      });
      const old = await manager.prepare('s', signal());
      expect(() => old.assertLive()).not.toThrow();
      if (action === 'clear') await manager.clearSession('s');
      else if (action === 'replace') {
        revision = '2';
        const next = await manager.prepare('s', signal());
        expect(next).not.toBe(old);
        expect(() => next.assertLive()).not.toThrow();
      } else await manager.dispose();
      expect(() => old.assertLive()).toThrow(/retired/);
      expect(() => old.capture()).toThrow(/retired/);
      expect(() => old.pin()).toThrow(/retired/);
      await manager.dispose();
    }
  );

  it.each(['setup', 'attachSession'] as const)(
    'keeps admission faulted when %s initialization cleanup fails',
    async (phase) => {
      const manager = new ExtensionManager({
        extensions: [
          {
            id: 'broken-init',
            apiVersion: '1.0',
            [phase]: (context: CoreSessionExtensionContext) => {
              context.resources.effect(() => () => {
                throw new Error('cleanup');
              });
              throw new Error('initialization');
            }
          }
        ],
        capabilities: [],
        busyExcept: () => false
      });
      await expect(manager.prepare('s', signal())).rejects.toThrow(/CLEANUP_FAILED/);
      await expect(manager.prepare('s', signal())).rejects.toThrow(/CLEANUP_FAILED/);
      expect(manager.diagnostics()).toContainEqual(
        expect.objectContaining({
          code: 'MAR_AGENT_EXTENSION_INITIALIZATION_FAILED',
          extensionId: 'broken-init'
        })
      );
      await expect(manager.dispose()).rejects.toThrow(/CLEANUP_FAILED/);
    }
  );

  it('reinitializes the original revision after refresh cancellation during retirement', async () => {
    let revision = '1';
    let setupCount = 0;
    let release!: () => void;
    let retiring!: () => void;
    const started = new Promise<void>((resolve) => {
      retiring = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const key: CoreServiceKey<number> = { id: 'counter', scope: 'agent' };
    const manager = new ExtensionManager({
      extensions: {
        resolve: async () => ({
          revision,
          extensions: [
            {
              id: 'provider',
              apiVersion: '1.0',
              provides: [{ key }],
              setup(context) {
                setupCount++;
                context.services.provide(key, setupCount);
                return async () => {
                  retiring();
                  await waiting;
                };
              }
            },
            {
              id: 'consumer',
              apiVersion: '1.0',
              serviceDependencies: [{ key }],
              attachSession(context) {
                expect(context.services.consume(key)).toBe(setupCount);
              }
            }
          ]
        })
      },
      capabilities: [],
      busyExcept: () => false
    });
    await manager.prepare('s', signal());
    revision = '2';
    const controller = new AbortController();
    const refreshing = manager.prepare('s', controller.signal);
    const outcome = refreshing.catch((error) => error);
    await started;
    controller.abort();
    release();
    expect(await outcome).toBeInstanceOf(Error);
    revision = '1';
    await manager.prepare('s', signal());
    expect(setupCount).toBe(2);
    expect(manager.diagnostics()).not.toContainEqual(
      expect.objectContaining({ code: 'MAR_AGENT_EXTENSION_DEPENDENCY_MISSING' })
    );
    await manager.dispose();
  });

  it('does not resume a partly retired composition after cleanup fails', async () => {
    let revision = '1';
    const manager = new ExtensionManager({
      extensions: {
        resolve: async () => ({
          revision,
          extensions: [
            {
              id: 'bad-release',
              apiVersion: '1.0',
              setup: () => () => {
                throw new Error('cleanup');
              }
            }
          ]
        })
      },
      capabilities: [],
      busyExcept: () => false
    });
    await manager.prepare('s', signal());
    revision = '2';
    await expect(manager.prepare('s', signal())).rejects.toThrow(/CLEANUP_FAILED/);
    await expect(manager.prepare('s', signal())).rejects.toThrow(/CLEANUP_FAILED/);
    await expect(manager.dispose()).rejects.toThrow(/CLEANUP_FAILED/);
  });

  it('holds a generation while retained callers reference it and reloads after final release', async () => {
    let revision = '1';
    const manager = new ExtensionManager({
      extensions: { resolve: async () => ({ revision, extensions: [] }) },
      capabilities: [],
      busyExcept: () => false
    });
    const session = await manager.prepare('s', signal());
    const release = session.pin();
    revision = '2';
    expect(await manager.prepare('s', signal())).toBe(session);
    expect(manager.revision).toBe('1');
    release();
    release();
    expect(await manager.prepare('s', signal())).not.toBe(session);
    expect(manager.revision).toBe('2');
    await manager.dispose();
  });

  it('disables dependency cycles and their required consumers without disabling unrelated extensions', async () => {
    const a: CoreServiceKey<number> = { id: 'a', scope: 'agent' };
    const b: CoreServiceKey<number> = { id: 'b', scope: 'agent' };
    const seen: string[] = [];
    const manager = new ExtensionManager({
      extensions: [
        {
          id: 'a',
          apiVersion: '1.0',
          provides: [{ key: a }],
          serviceDependencies: [{ key: b }],
          setup: () => {
            seen.push('a');
          }
        },
        {
          id: 'b',
          apiVersion: '1.0',
          provides: [{ key: b }],
          serviceDependencies: [{ key: a }],
          setup: () => {
            seen.push('b');
          }
        },
        {
          id: 'dependent',
          apiVersion: '1.0',
          serviceDependencies: [{ key: a }],
          setup: () => {
            seen.push('dependent');
          }
        },
        {
          id: 'unrelated',
          apiVersion: '1.0',
          setup: () => {
            seen.push('unrelated');
          }
        }
      ],
      capabilities: [],
      busyExcept: () => false
    });
    await manager.prepare('s', signal());
    await manager.prepare('s', signal());
    expect(seen).toEqual(['unrelated']);
    expect(
      manager
        .diagnostics()
        .filter((diagnostic) => diagnostic.code === 'MAR_AGENT_EXTENSION_DEPENDENCY_CYCLE')
    ).toHaveLength(3);
    await manager.dispose();
  });

  it('attributes asynchronous acquisition failures and allows explicit initialization APIs before activation', async () => {
    const initialized: string[] = [];
    const manager = new ExtensionManager({
      extensions: [
        {
          id: 'bad-resource',
          apiVersion: '1.0',
          setup(context) {
            context.resources.effect(async () => {
              throw new Error('private resource failure');
            });
          }
        },
        {
          id: 'init',
          apiVersion: '1.0',
          async attachSession(context) {
            context.tools.register({
              name: 'init',
              description: 'Initialize',
              inputSchema: { type: 'object' },
              execute: () => ({ content: 'ready' })
            });
            initialized.push((await context.tools.invoke({ name: 'init', arguments: {} })).content);
          }
        }
      ],
      capabilities: [],
      busyExcept: () => false
    });
    await manager.prepare('s', signal());
    expect(initialized).toEqual(['ready']);
    expect(manager.diagnostics()).toEqual([
      expect.objectContaining({
        extensionId: 'bad-resource',
        code: 'MAR_AGENT_EXTENSION_INITIALIZATION_FAILED'
      })
    ]);
    await manager.dispose();
  });

  it('sets up once, attaches per Session, reuses generations and reloads at the next admission', async () => {
    const setup = vi.fn();
    const attach = vi.fn();
    const release = vi.fn();
    let snapshot: CoreExtensionSnapshot = {
      revision: '1',
      extensions: [
        {
          id: 'a',
          apiVersion: '1.0',
          setup,
          attachSession: (context) => {
            attach(context.sessionId);
            return release;
          }
        }
      ]
    };
    const manager = new ExtensionManager({
      extensions: { resolve: async () => snapshot },
      capabilities: [],
      busyExcept: () => false
    });
    expect(setup).not.toHaveBeenCalled();
    const first = await manager.prepare('s1', signal());
    expect(await manager.prepare('s1', signal())).toBe(first);
    await manager.prepare('s2', signal());
    expect(setup).toHaveBeenCalledTimes(1);
    expect(attach.mock.calls).toEqual([['s1'], ['s2']]);
    snapshot = { ...snapshot, revision: '2' };
    expect(await manager.prepare('s1', signal())).not.toBe(first);
    expect(release).toHaveBeenCalledTimes(2);
    expect(setup).toHaveBeenCalledTimes(2);
    await manager.dispose();
  });

  it('does not repeat failed setup or leak a failed Session instance into another Session', async () => {
    const setupFailure = vi.fn(() => {
      throw new Error('secret');
    });
    const attachFailure = vi.fn((context: CoreSessionExtensionContext) => {
      if (context.sessionId === 'bad') throw new Error('session error');
    });
    const extensions: CoreRuntimeExtension[] = [
      { id: 'failed', apiVersion: '1.0', setup: setupFailure },
      { id: 'session', apiVersion: '1.0', attachSession: attachFailure }
    ];
    const manager = new ExtensionManager({ extensions, capabilities: [], busyExcept: () => false });
    await manager.prepare('bad', signal());
    await manager.prepare('bad', signal());
    await manager.prepare('good', signal());
    expect(setupFailure).toHaveBeenCalledTimes(1);
    expect(attachFailure).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(manager.diagnostics())).not.toContain('secret');
    await manager.dispose();
  });

  it('preserves a working composition when source resolution or preflight rejects a snapshot', async () => {
    let failing = false;
    let duplicate = false;
    const setup = vi.fn();
    const extension: CoreRuntimeExtension = { id: 'a', apiVersion: '1.0', setup };
    const manager = new ExtensionManager({
      extensions: {
        resolve: async () => {
          if (failing) throw new Error('source unavailable');
          return {
            revision: duplicate ? '2' : '1',
            extensions: duplicate ? [extension, extension] : [extension]
          };
        }
      },
      capabilities: [],
      busyExcept: () => false
    });
    const original = await manager.prepare('s', signal());
    failing = true;
    await expect(manager.prepare('s', signal())).rejects.toThrow('source unavailable');
    failing = false;
    duplicate = true;
    await expect(manager.prepare('s', signal())).rejects.toThrow(/SOURCE_INVALID/);
    expect(manager.session('s')).toBe(original);
    expect(setup).toHaveBeenCalledTimes(1);
    await manager.dispose();
  });

  it('defers Agent-wide replacement while another Session is busy', async () => {
    let revision = '1';
    let busy = false;
    const manager = new ExtensionManager({
      extensions: { resolve: async () => ({ revision, extensions: [] }) },
      capabilities: [],
      busyExcept: () => busy
    });
    const old = await manager.prepare('s', signal());
    revision = '2';
    busy = true;
    expect(await manager.prepare('s', signal())).toBe(old);
    expect(manager.revision).toBe('1');
    expect(manager.diagnostics().at(-1)?.code).toBe('MAR_AGENT_EXTENSION_UPDATE_PENDING');
    busy = false;
    expect(await manager.prepare('s', signal())).not.toBe(old);
    expect(manager.revision).toBe('2');
    await manager.dispose();
  });

  it('orders providers before consumers and gives bindings only to their own contexts', async () => {
    const key: CoreServiceKey<number> = { id: 'number', scope: 'agent' };
    const seen: number[] = [];
    const manager = new ExtensionManager({
      extensions: [
        {
          id: 'consumer',
          apiVersion: '1.0',
          serviceDependencies: [{ key }],
          setup: (context) => {
            seen.push(context.services.consume(key)!);
            expect(context.bindings).toEqual({});
          }
        },
        {
          id: 'provider',
          apiVersion: '1.0',
          provides: [{ key }],
          bindings: { amount: 7 },
          setup: (context) => {
            context.services.provide(key, context.bindings.amount as number);
          }
        }
      ],
      capabilities: [],
      busyExcept: () => false
    });
    await manager.prepare('s', signal());
    expect(seen).toEqual([7]);
    await manager.dispose();
  });

  it('isolates instance tools, commands and prompt sections with real scoped calls', async () => {
    const contexts = new Map<string, CoreSessionExtensionContext>();
    const manager = new ExtensionManager({
      extensions: [
        {
          id: 'counter',
          apiVersion: '1.0',
          attachSession(context) {
            contexts.set(context.sessionId, context);
            let value = 0;
            context.tools.register({
              name: 'count',
              description: 'count',
              inputSchema: { type: 'object' },
              execute: () => ({ content: String(++value) })
            });
            context.commands.register({
              name: 'run',
              handler: () => context.tools.invoke({ name: 'count', arguments: {} })
            });
            context.prompts.register({ id: 'policy', text: 'Extension policy.' });
          }
        }
      ],
      capabilities: [],
      busyExcept: () => false
    });
    await manager.prepare('a', signal());
    await manager.prepare('b', signal());
    expect(await contexts.get('a')!.commands.run({ name: 'run' })).toEqual({ content: '1' });
    expect(await contexts.get('a')!.tools.invoke({ name: 'count', arguments: {} })).toEqual({
      content: '2'
    });
    expect(await contexts.get('b')!.tools.invoke({ name: 'count', arguments: {} })).toEqual({
      content: '1'
    });
    expect(await contexts.get('a')!.prompts.compose('System')).toBe('System\n\nExtension policy.');
    const stale = contexts.get('a')!;
    await manager.clearSession('a');
    await expect(stale.tools.invoke({ name: 'count', arguments: {} })).rejects.toThrow(/RETIRED/);
    expect((await manager.prepare('a', signal())).epoch).toBe(1);
    await manager.dispose();
  });

  it('caches strict failures but retries cancelled initialization on a later admission', async () => {
    const failed = vi.fn(() => {
      throw new Error('failure');
    });
    const manager = new ExtensionManager({
      extensions: [
        { id: 'strict', apiVersion: '1.0', failurePolicy: 'fail-composition', setup: failed }
      ],
      capabilities: [],
      busyExcept: () => false
    });
    await expect(manager.prepare('s', signal())).rejects.toThrow(/COMPOSITION_FAILED/);
    await expect(manager.prepare('s', signal())).rejects.toThrow(/COMPOSITION_FAILED/);
    expect(failed).toHaveBeenCalledTimes(1);
    await manager.dispose();
    const controller = new AbortController();
    const setup = vi.fn(() => {
      if (setup.mock.calls.length === 1) controller.abort();
    });
    const cancelled = new ExtensionManager({
      extensions: [{ id: 'a', apiVersion: '1.0', setup }],
      capabilities: [],
      busyExcept: () => false
    });
    await expect(cancelled.prepare('s', controller.signal)).rejects.toThrow();
    await cancelled.prepare('s', signal());
    expect(setup).toHaveBeenCalledTimes(2);
    await cancelled.dispose();
  });
});
