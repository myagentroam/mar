import { describe, expect, it, vi } from 'vitest';
import { SessionExecution } from '../../src/sdk/session-execution.js';
import { DEFAULT_COMPACTION_FOCUS } from '../../src/runtime/compaction/history.js';
import { ExecutionToolSources } from '../../src/sdk/extension-tools.js';

function owner(kind: 'run' | 'compact') {
  return new SessionExecution(
    'session',
    'execution',
    'turn',
    kind,
    'user',
    {
      modelId: 'model',
      mode: 'run',
      models: new Map(),
      generation: 0,
      instruction: undefined
    },
    new Set()
  );
}

describe('execution program ownership', () => {
  it.each(['completed', 'failed', 'cancelled'] as const)(
    'settles the result without publishing an unpersisted terminal (%s)',
    async (mode) => {
      const execution = owner('run');
      const storageFailure = Object.assign(new Error('No space left'), { code: 'ENOSPC' });
      const originalFailure = new Error('Original execution failure');
      const release = vi.fn(async () => {});
      const publish = vi.fn(async () => {});
      const beforeFailure = vi.fn(async (_error: unknown) => {});
      const attempted: string[] = [];
      const local: string[] = [];
      execution.adoptLease(release);
      const handle = execution.handle(() => false);
      const consume = (async () => {
        for await (const event of handle) local.push(event.type);
      })();
      execution.start({
        scope: (action) => action(),
        prepareProgram: async () => ({
          run: async () => {
            if (mode === 'failed') throw originalFailure;
            if (mode === 'cancelled') execution.cancel(originalFailure);
          },
          performManualCompact: async (action) => action(undefined, execution.controller.signal),
          finalAnswer: () => 'answer',
          permissionStop: () => undefined
        }),
        beforeFailure,
        diagnostic: (error) => ({
          code: error === storageFailure ? 'ENOSPC' : 'ORIGINAL_FAILURE',
          message: 'Execution failed'
        }),
        emit: (event) =>
          execution.emit(event, {
            persist: async (full) => {
              attempted.push(full.type);
              throw storageFailure;
            },
            publish
          }),
        endParent: () => {},
        finalize: (failed) =>
          execution.finish({
            failed,
            reason: undefined,
            releaseImageBytes: () => {},
            revokeBindings: () => {},
            closeToolSources: () => {},
            detachAbort: () => {},
            endParent: () => {},
            deactivate: () => {}
          }),
        settle: () => {}
      });
      const result = await handle.result();
      await consume;
      expect(result.status).toBe(mode === 'cancelled' ? 'cancelled' : 'failed');
      if (mode !== 'cancelled')
        expect(result.errorCode).toBe(mode === 'completed' ? 'ENOSPC' : 'ORIGINAL_FAILURE');
      expect(beforeFailure).toHaveBeenCalledWith(
        mode === 'completed' ? storageFailure : originalFailure
      );
      expect(attempted).toEqual(
        mode === 'completed' ? ['execution.completed', 'execution.failed'] : [`execution.${mode}`]
      );
      expect(local).toEqual([]);
      expect(publish).not.toHaveBeenCalled();
      expect(handle.persistedEvents).toBe(false);
      expect(release).toHaveBeenCalledOnce();
    }
  );

  it('does not wait for an in-flight Host preview and does not start previews after a terminal', async () => {
    const execution = owner('run');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const invoked: Array<{ type: string; sequence: number }> = [];
    let previewFinished = false;
    const ports = {
      persist: async () => {},
      publish: async (event: import('../../src/runtime/events.js').AgentEvent) => {
        invoked.push({ type: event.type, sequence: event.sequence });
        if (event.type === 'tool.output') {
          entered.resolve();
          await release.promise;
          previewFinished = true;
        }
      }
    };
    const output = {
      type: 'tool.output' as const,
      toolName: 'exec' as const,
      callId: 'call',
      output: { processId: 'p', stdout: 'live', stderr: '', truncated: false }
    };
    const preview = execution.emit(output, ports);
    await entered.promise;
    await execution.emit({ type: 'execution.completed', finalAnswer: 'done' }, ports);
    expect(previewFinished).toBe(false);
    const late = execution.emit(output, ports);
    try {
      await Promise.resolve();
      expect(invoked.map((event) => event.type)).toEqual(['tool.output', 'execution.completed']);
      expect(invoked[0]!.sequence).toBeLessThan(invoked[1]!.sequence);
    } finally {
      release.resolve();
      await Promise.all([preview, late]);
    }
    expect(previewFinished).toBe(true);
  });
  it('cancels an intercepted input if cancellation wins before completion admission', async () => {
    const execution = owner('run');
    const emitted: string[] = [];
    execution.start({
      scope: (action) => action(),
      prepareProgram: async () => {
        queueMicrotask(() => execution.cancel());
        return { inputHandled: true };
      },
      beforeFailure: async () => {},
      diagnostic: () => ({ code: 'FAIL', message: 'failed' }),
      emit: async (event) => {
        emitted.push(event.type);
      },
      endParent: () => {},
      finalize: async () => {},
      settle: () => {}
    });
    await expect(execution.join()).resolves.toMatchObject({ status: 'cancelled' });
    expect(emitted).toEqual(['execution.cancelled']);
  });

  it('keeps the admitted completion when cancellation arrives during persistence', async () => {
    const execution = owner('run');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const committed: string[] = [];
    execution.adoptLease(async () => {});
    execution.start({
      scope: (action) => action(),
      prepareProgram: async () => ({
        run: async () => {},
        performManualCompact: async (action) => action(undefined, execution.controller.signal),
        finalAnswer: () => 'answer',
        permissionStop: () => undefined
      }),
      beforeFailure: async () => {},
      diagnostic: () => ({ code: 'FAIL', message: 'failed' }),
      emit: (event) =>
        execution.emit(event, {
          persist: async (full) => {
            entered.resolve();
            await release.promise;
            committed.push(full.type);
          }
        }),
      endParent: () => {},
      finalize: async () => {},
      settle: () => {}
    });
    await entered.promise;
    execution.cancel();
    release.resolve();
    await expect(execution.join()).resolves.toMatchObject({ status: 'completed' });
    expect(committed).toEqual(['execution.completed']);
  });

  it.each(['after-run', 'queued-terminal'] as const)(
    'honors cancellation before terminal admission (%s)',
    async (window) => {
      const execution = owner('run');
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const emitted: string[] = [];
      if (window === 'queued-terminal')
        void execution.orderEvent(async () => {
          entered.resolve();
          await release.promise;
        });
      execution.adoptLease(async () => {});
      execution.start({
        scope: (action) => action(),
        prepareProgram: async () => ({
          run: async () => {
            if (window === 'after-run') queueMicrotask(() => execution.cancel());
          },
          performManualCompact: async (action) => action(undefined, execution.controller.signal),
          finalAnswer: () => 'answer',
          permissionStop: () => undefined
        }),
        beforeFailure: async () => {},
        diagnostic: () => ({ code: 'FAIL', message: 'failed' }),
        emit: (event) =>
          execution.emit(event, {
            persist: async (full) => {
              emitted.push(full.type);
            }
          }),
        endParent: () => {},
        finalize: async () => {},
        settle: () => {}
      });
      if (window === 'queued-terminal') {
        await entered.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        execution.cancel();
        release.resolve();
      }
      await expect(execution.join()).resolves.toMatchObject({ status: 'cancelled' });
      expect(emitted).toEqual(['execution.cancelled']);
    }
  );

  it('revokes input views before detaching tool sources and still releases on Turn cleanup failure', async () => {
    const execution = owner('run');
    const view = execution.context;
    const toolSources = new ExecutionToolSources('execution', 'session', [], [], {
      revision: '1',
      servers: [],
      tools: []
    });
    const appended = { append: () => {} };
    const request = { read: () => [] };
    expect(Object.isFrozen(view)).toBe(true);
    expect(view.steer).toBeUndefined();
    expect(view.compactRequests).toBe(execution.compactRequests);
    execution.bindViews({ appendedMessages: appended, requestMessages: request, toolSources });
    execution.acceptSteer(async () => ({ status: 'notAccepted' }));
    expect(view.steer).toBeDefined();
    const error = new Error('turn close');
    const order: string[] = [];
    execution.adoptLease(async () => {
      order.push('lease');
    });
    vi.spyOn(execution, 'closeModelTurns').mockImplementation(async () => {
      order.push('turn');
      expect(view.toolSources).toBeUndefined();
      throw error;
    });
    await expect(
      execution.finish({
        failed: false,
        reason: error,
        releaseImageBytes: () => {
          order.push('images');
        },
        revokeBindings: () => {
          order.push('revoke');
          execution.revokeViews(error);
          expect(view.requestMessages).toBeUndefined();
          expect(view.appendedMessages).toBeUndefined();
          expect(view.steer).toBeUndefined();
          expect(view.compactRequests).toBeUndefined();
          expect(view.toolSources).toBe(toolSources);
        },
        closeToolSources: () => {
          order.push('tools');
          toolSources.close();
          execution.detachToolSources();
        },
        detachAbort: () => {
          order.push('abort');
        },
        endParent: () => {
          order.push('parent');
        },
        deactivate: () => {
          order.push('deactivate');
        }
      })
    ).rejects.toBe(error);
    expect(order).toEqual([
      'images',
      'revoke',
      'tools',
      'abort',
      'turn',
      'parent',
      'lease',
      'deactivate'
    ]);
  });

  it('runs manual Compact through its hook and owns terminal settlement', async () => {
    const execution = owner('compact');
    const run = vi.fn(async (_focus?: string, _signal?: AbortSignal) => {});
    const events: string[] = [];
    execution.start({
      scope: (action) => action(),
      prepareProgram: async () => ({
        run,
        performManualCompact: (action) => action(undefined, new AbortController().signal),
        finalAnswer: () => 'not returned',
        permissionStop: () => undefined
      }),
      beforeFailure: async () => {},
      diagnostic: () => ({ code: 'FAIL', message: 'failed' }),
      emit: async (event) => {
        events.push(event.type);
      },
      endParent: () => {},
      finalize: async () => {},
      settle: () => {}
    });
    await expect(execution.join()).resolves.toMatchObject({ status: 'completed', finalAnswer: '' });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toBe(DEFAULT_COMPACTION_FOCUS);
    expect(events).toEqual(['execution.completed']);
  });

  it('settles an input intercepted before a program exists without running a model', async () => {
    const execution = owner('run');
    const endParent = vi.fn();
    const events: string[] = [];
    execution.start({
      scope: (action) => action(),
      prepareProgram: async () => ({ inputHandled: true }),
      beforeFailure: async () => {},
      diagnostic: () => ({ code: 'FAIL', message: 'failed' }),
      emit: async (event) => {
        events.push(event.type);
      },
      endParent,
      finalize: async () => {},
      settle: () => {}
    });
    await expect(execution.join()).resolves.toMatchObject({
      status: 'completed',
      inputHandled: true
    });
    expect(events).toEqual(['execution.completed']);
    expect(endParent).not.toHaveBeenCalled();
  });
});
