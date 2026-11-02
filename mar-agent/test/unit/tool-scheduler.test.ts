import { describe, expect, it } from 'vitest';
import type { ClientToolDefinition } from '../../src/model/contracts.js';
import { execToolDefinition } from '../../src/tools/local/exec.js';
import {
  createToolCallScheduler,
  createSessionToolScheduler,
  scheduleToolCallBatch,
  withIndependentSessionTools
} from '../../src/tools/scheduler.js';
import { BUILTIN_TOOL_DEFINITIONS } from '../../src/tools/registry.js';

function definition(
  name: string,
  parallelSafety?: ClientToolDefinition['parallelSafety']
): ClientToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    ...(parallelSafety ? { parallelSafety } : {})
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushPromises() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

describe('tool call scheduler', () => {
  it('releases a serial Session barrier after cancellation', async () => {
    const schedule = createSessionToolScheduler();
    const controller = new AbortController();
    const started = deferred<void>();
    const events: string[] = [];
    const cancelled = schedule(definition('serial', 'serial'), async () => {
      events.push('serial');
      started.resolve();
      await new Promise<void>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
          once: true
        });
      });
    });
    const after = schedule(definition('after', 'safe'), async () => {
      events.push('after');
    });
    await started.promise;
    expect(events).toEqual(['serial']);
    controller.abort(new Error('cancelled'));
    await expect(cancelled).rejects.toThrow('cancelled');
    await after;
    expect(events).toEqual(['serial', 'after']);
  });

  it('keeps a nested serial barrier within its safe parent domain', async () => {
    const schedule = createSessionToolScheduler();
    const gate = deferred<void>();
    const entered = deferred<void>();
    const events: string[] = [];
    const sibling = schedule(definition('sibling', 'safe'), async () => {
      events.push('sibling');
      await gate.promise;
      events.push('sibling-done');
    });
    const parent = schedule(definition('parent', 'safe'), async () => {
      await schedule(definition('nested', 'serial'), async () => {
        events.push('nested');
        entered.resolve();
      });
    });
    try {
      await entered.promise;
      expect(events).toEqual(['sibling', 'nested']);
    } finally {
      gate.resolve();
      await Promise.all([parent, sibling]);
    }
    expect(events).toEqual(['sibling', 'nested', 'sibling-done']);
  });

  it('runs unmarked and unknown incremental and Session calls concurrently', async () => {
    const gate = deferred<void>();
    const started: string[] = [];
    const host = definition('host');
    const incremental = createToolCallScheduler([host], async (call: { name: string }) => {
      started.push(call.name);
      await gate.promise;
    });
    const session = createSessionToolScheduler();
    const pending = [
      incremental({ name: 'host' }),
      incremental({ name: 'mcp__external__tool' }),
      session(host, async () => {
        started.push('session-host');
        await gate.promise;
      }),
      session(undefined, async () => {
        started.push('session-unknown');
        await gate.promise;
      })
    ];
    try {
      await flushPromises();
      expect(started).toEqual(['host', 'mcp__external__tool', 'session-host', 'session-unknown']);
    } finally {
      gate.resolve();
      await Promise.all(pending);
    }
  });

  it('keeps independent callbacks behind the creator barrier and permits their own nested delegation', async () => {
    const schedule = createSessionToolScheduler();
    const serial = definition('serial', 'serial');
    const gate = deferred<void>();
    const began = deferred<void>();
    const started: string[] = [];
    let independent: Promise<unknown> | undefined;
    const parent = schedule(serial, async () => {
      started.push('creator');
      independent = withIndependentSessionTools(() =>
        schedule(serial, async () => {
          started.push('independent');
          await schedule(serial, async () => {
            started.push('independent-child');
          });
        })
      );
      began.resolve();
      await gate.promise;
    });
    try {
      await began.promise;
      await flushPromises();
      expect(started).toEqual(['creator']);
    } finally {
      gate.resolve();
    }
    await parent;
    await independent;
    expect(started).toEqual(['creator', 'independent', 'independent-child']);
  });

  it('delegates nested calls without waiting on the enclosing serial lease', async () => {
    const schedule = createSessionToolScheduler();
    const serial = definition('serial', 'serial');
    const started: string[] = [];
    const nested = schedule(serial, async () => {
      started.push('outer');
      return schedule(serial, async () => {
        started.push('inner');
        return 'done';
      });
    });
    const sibling = schedule(serial, async () => {
      started.push('sibling');
    });
    await expect(nested).resolves.toBe('done');
    await sibling;
    expect(started).toEqual(['outer', 'inner', 'sibling']);
  }, 1000);

  it('preserves nested sibling barriers and joins accepted children before releasing the parent', async () => {
    const schedule = createSessionToolScheduler();
    const serial = definition('serial', 'serial');
    const safe = definition('safe', 'safe');
    const gate = deferred<void>();
    const started: string[] = [];
    const parent = schedule(serial, async () => {
      void schedule(safe, async () => {
        started.push('read');
        await gate.promise;
      });
      void schedule(serial, async () => {
        started.push('write');
      });
    });
    const sibling = schedule(serial, async () => {
      started.push('sibling');
    });
    await flushPromises();
    expect(started).toEqual(['read']);
    gate.resolve();
    await Promise.all([parent, sibling]);
    expect(started).toEqual(['read', 'write', 'sibling']);
  });

  it('forwards only the call and never leaks array indexes into execution options', async () => {
    await scheduleToolCallBatch(
      [{ name: 'safe' }, { name: 'safe' }, { name: 'serial' }],
      [definition('safe', 'safe'), definition('serial', 'serial')],
      async (call, ...unexpected: unknown[]) => {
        expect(unexpected).toEqual([]);
        return call.name;
      }
    );
  });

  it('preserves barriers and recovers from individual failures for incremental Code Mode calls', async () => {
    const read = deferred<string>();
    const serial = deferred<string>();
    const started: string[] = [];
    const schedule = createToolCallScheduler(
      [definition('safe', 'safe'), definition('serial', 'serial')],
      async (call: { name: string; id: string }) => {
        started.push(call.id);
        if (call.id === 'read') return read.promise;
        if (call.id === 'write') return serial.promise;
        if (call.id === 'error') throw new Error('expected tool failure');
        return call.id;
      }
    );
    const first = schedule({ name: 'safe', id: 'read' });
    const second = schedule({ name: 'serial', id: 'write' });
    const third = schedule({ name: 'safe', id: 'after' });
    await flushPromises();
    expect(started).toEqual(['read']);
    read.resolve('read');
    await first;
    await flushPromises();
    expect(started).toEqual(['read', 'write']);
    serial.resolve('write');
    await Promise.all([second, third]);
    expect(started).toEqual(['read', 'write', 'after']);
    await expect(schedule({ name: 'serial', id: 'error' })).rejects.toThrow(
      'expected tool failure'
    );
    await expect(schedule({ name: 'safe', id: 'recovered' })).resolves.toBe('recovered');
  });

  it('runs consecutive safe calls concurrently and preserves model order', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const started: string[] = [];
    const result = scheduleToolCallBatch(
      [
        { callId: '1', name: 'safe' },
        { callId: '2', name: 'safe' }
      ],
      [definition('safe', 'safe')],
      async (call) => {
        started.push(call.callId);
        return call.callId === '1' ? first.promise : second.promise;
      }
    );

    await flushPromises();
    expect(started).toEqual(['1', '2']);
    second.resolve('second');
    first.resolve('first');
    await expect(result).resolves.toEqual(['first', 'second']);
  });

  it('runs multiple exec calls concurrently while preserving model order', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const started: string[] = [];
    const result = scheduleToolCallBatch(
      [
        { callId: 'exec-1', name: 'exec' },
        { callId: 'exec-2', name: 'exec' }
      ],
      [execToolDefinition],
      async (call) => {
        started.push(call.callId);
        return call.callId === 'exec-1' ? first.promise : second.promise;
      }
    );

    await flushPromises();
    expect(started).toEqual(['exec-1', 'exec-2']);
    second.resolve('second');
    first.resolve('first');
    await expect(result).resolves.toEqual(['first', 'second']);
  });

  it('keeps serial barriers while unknown tools run concurrently', async () => {
    const safe = deferred<string>();
    const serial = deferred<string>();
    const unknown = deferred<string>();
    const started: string[] = [];
    const result = scheduleToolCallBatch(
      [
        { callId: 'safe-1', name: 'safe' },
        { callId: 'serial', name: 'serial' },
        { callId: 'safe-2', name: 'safe' },
        { callId: 'unknown', name: 'unknown' },
        { callId: 'safe-3', name: 'safe' }
      ],
      [definition('safe', 'safe'), definition('serial', 'serial')],
      async (call) => {
        started.push(call.callId);
        if (call.callId === 'safe-1') return safe.promise;
        if (call.callId === 'serial') return serial.promise;
        if (call.callId === 'unknown') return unknown.promise;
        return call.callId;
      }
    );

    await flushPromises();
    expect(started).toEqual(['safe-1']);
    safe.resolve('safe-1');
    await flushPromises();
    expect(started).toEqual(['safe-1', 'serial']);
    serial.resolve('serial');
    await flushPromises();
    expect(started).toEqual(['safe-1', 'serial', 'safe-2', 'unknown', 'safe-3']);
    unknown.resolve('unknown');
    await expect(result).resolves.toEqual(['safe-1', 'serial', 'safe-2', 'unknown', 'safe-3']);
    expect(started).toEqual(['safe-1', 'serial', 'safe-2', 'unknown', 'safe-3']);
  });

  it('classifies built-in tools explicitly', () => {
    const safety = new Map(
      BUILTIN_TOOL_DEFINITIONS.map((tool) => [tool.name, tool.parallelSafety])
    );

    for (const name of [
      'skill',
      'read',
      'view_image',
      'todo_read',
      'exec',
      'exec_wait',
      'code_exec_wait',
      'apply_patch',
      'question',
      'todo_write',
      'sleep',
      'tool_search',
      'code_exec',
      'smart_compact'
    ])
      expect(safety.get(name), name).toBe('safe');
  });
});
