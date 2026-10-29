import { describe, expect, it, vi } from 'vitest';
import { NodeLifecycle } from '../../src/application/node-lifecycle.js';

function shutdown(dispose: () => Promise<void> = async () => {}) {
  return {
    waitForRecovery: async () => {},
    drainInput: async () => {},
    closeResume: async () => {},
    capture: () => 'snapshot',
    dispose,
    publish: async (_snapshot: string) => {},
    diagnose: vi.fn()
  };
}

describe('NodeLifecycle', () => {
  it('freezes immediately and waits for startup before disposing once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const lifecycle = new NodeLifecycle(
      async () => {
        order.push('start');
        await gate;
        order.push('started');
      },
      () => {
        order.push('freeze');
      },
      {
        ...shutdown(async () => {
          order.push('dispose');
        }),
        capture: () => {
          order.push('capture');
          return 'snapshot';
        },
        publish: async () => {
          order.push('publish');
        }
      }
    );
    const starting = lifecycle.start();
    const stopping = lifecycle.stop(true);
    expect(lifecycle.stop()).toBe(stopping);
    expect(order).toEqual(['start', 'freeze']);
    expect(lifecycle.stopped).toBe(true);
    release();
    await Promise.all([starting, stopping]);
    expect(order).toEqual(['start', 'freeze', 'started', 'capture', 'dispose', 'publish']);
  });

  it('cleans up a failed startup and preserves its original error', async () => {
    const failure = new Error('startup failed');
    const cleanup = vi.fn(async () => {
      throw new Error('cleanup failed');
    });
    const lifecycle = new NodeLifecycle(
      async () => {
        throw failure;
      },
      vi.fn(),
      shutdown(cleanup)
    );
    await expect(lifecycle.start()).rejects.toBe(failure);
    expect(lifecycle.stopped).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('does not publish a handoff when draining fails, but still closes and disposes', async () => {
    const failure = new Error('input drain failed');
    const closeResume = vi.fn(async () => {});
    const dispose = vi.fn(async () => {});
    const publish = vi.fn(async () => {});
    const capture = vi.fn(() => 'snapshot');
    const lifecycle = new NodeLifecycle(async () => {}, vi.fn(), {
      ...shutdown(),
      drainInput: async () => {
        throw failure;
      },
      closeResume,
      capture,
      dispose,
      publish
    });
    await expect(lifecycle.stop(true)).rejects.toBe(failure);
    expect(closeResume).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(capture).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('does not restart after a new stop while waiting for an earlier stop', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const start = vi.fn(async () => {});
    const lifecycle = new NodeLifecycle(
      start,
      vi.fn(),
      shutdown(async () => {
        await gate;
      })
    );
    const firstStop = lifecycle.stop();
    const restarting = lifecycle.start();
    const secondStop = lifecycle.stop();
    release();
    await Promise.all([firstStop, secondStop]);
    await expect(restarting).rejects.toThrow('NODE_STOPPED');
    expect(start).not.toHaveBeenCalled();
  });

  it.each([
    'waitForRecovery',
    'drainInput',
    'closeResume',
    'capture',
    'dispose',
    'publish'
  ] as const)(
    'reports the failing %s stage without replacing the original error',
    async (stage) => {
      const failure = new Error('SHUTDOWN_FIXTURE_FAILED');
      const hooks = shutdown();
      const publish = vi.fn(hooks.publish);
      const dispose = vi.fn(hooks.dispose);
      const lifecycle = new NodeLifecycle(async () => {}, vi.fn(), {
        ...hooks,
        publish,
        dispose,
        [stage]: () => {
          throw failure;
        }
      });
      await expect(lifecycle.stop(true)).rejects.toBe(failure);
      expect(hooks.diagnose).toHaveBeenCalledExactlyOnceWith(stage, failure);
      if (stage !== 'dispose') expect(dispose).toHaveBeenCalledOnce();
      if (stage !== 'publish') expect(publish).not.toHaveBeenCalled();
    }
  );

  it('reports secondary cleanup failures while preserving the first failure', async () => {
    const first = new Error('INPUT_DRAIN_FAILED');
    const second = new Error('DISPOSE_FAILED');
    const hooks = shutdown();
    const publish = vi.fn(hooks.publish);
    const lifecycle = new NodeLifecycle(async () => {}, vi.fn(), {
      ...hooks,
      drainInput: async () => {
        throw first;
      },
      dispose: async () => {
        throw second;
      },
      publish
    });
    await expect(lifecycle.stop(true)).rejects.toBe(first);
    expect(hooks.diagnose.mock.calls).toEqual([
      ['drainInput', first],
      ['dispose', second]
    ]);
    expect(publish).not.toHaveBeenCalled();
  });

  it('never publishes a handoff when a shutdown hook rejects without an error value', async () => {
    const hooks = shutdown();
    const publish = vi.fn(hooks.publish);
    const lifecycle = new NodeLifecycle(async () => {}, vi.fn(), {
      ...hooks,
      dispose: async () => Promise.reject(),
      publish
    });
    await expect(lifecycle.stop(true)).rejects.toBeUndefined();
    expect(hooks.diagnose).toHaveBeenCalledExactlyOnceWith('dispose', undefined);
    expect(publish).not.toHaveBeenCalled();
  });

  it('still closes and disposes when failure diagnostics throw', async () => {
    const hooks = shutdown();
    const closeResume = vi.fn(hooks.closeResume);
    const dispose = vi.fn(hooks.dispose);
    const publish = vi.fn(hooks.publish);
    const failure = new Error('INPUT_DRAIN_FAILED');
    hooks.diagnose.mockImplementation(() => {
      throw new Error('LOG_STORAGE_FAILED');
    });
    const lifecycle = new NodeLifecycle(async () => {}, vi.fn(), {
      ...hooks,
      closeResume,
      dispose,
      publish,
      drainInput: async () => {
        throw failure;
      }
    });
    await expect(lifecycle.stop(true)).rejects.toBe(failure);
    expect(closeResume).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
  });
});
