import { describe, expect, it } from 'vitest';
import {
  transformCoreModelStream,
  type CoreModelEvent
} from '../../src/agent-core/extensions/model-stream.js';
import type { ModelEvent } from '../../src/agent-core/model/contracts.js';

describe('Extension model event boundary', () => {
  it('preserves the primary hook failure when upstream cleanup also fails', async () => {
    const primary = new Error('primary hook failure');
    const cleanup = new Error('upstream cleanup failure');
    let cleanupDiagnostics = 0;
    const iterator: AsyncIterator<ModelEvent> = {
      next: async () => ({ done: false, value: { type: 'completed', reason: 'completed' } }),
      return: async () => {
        throw cleanup;
      }
    };
    const stream = transformCoreModelStream(
      () => ({ [Symbol.asyncIterator]: () => iterator }),
      new AbortController().signal,
      async () => {
        throw primary;
      },
      () => {
        cleanupDiagnostics++;
      }
    );
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toBe(primary);
    expect(cleanupDiagnostics).toBe(1);
  });

  it('propagates upstream cleanup failure when there is no primary failure', async () => {
    const cleanup = new Error('cleanup failure');
    const iterator: AsyncIterator<ModelEvent> = {
      next: async () => ({ done: true, value: undefined }),
      return: async () => {
        throw cleanup;
      }
    };
    const stream = transformCoreModelStream(
      () => ({ [Symbol.asyncIterator]: () => iterator }),
      new AbortController().signal,
      async (event) => event
    );
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toBe(cleanup);
  });

  it('rejects malformed transformed events with a stable domain error', async () => {
    const start = async function* (): AsyncIterable<ModelEvent> {
      yield { type: 'completed', reason: 'completed' };
    };
    const stream = transformCoreModelStream(
      start,
      new AbortController().signal,
      async () => ({ type: 'text.completed', itemId: 'text', text: 42 }) as never
    );
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow(/EVENT_INVALID/);
  });
  it('pulls only at consumer demand and closes the upstream on consumer return', async () => {
    let pulls = 0;
    let closed = false;
    let signal!: AbortSignal;
    const start = async function* (value: AbortSignal): AsyncIterable<ModelEvent> {
      signal = value;
      try {
        for (let index = 0; index < 3; index++) {
          pulls++;
          yield { type: 'text.delta', itemId: 'text', phase: 'final_answer', delta: String(index) };
        }
      } finally {
        closed = true;
      }
    };
    const stream = transformCoreModelStream(start, new AbortController().signal, async (event) =>
      event.type === 'text.delta' ? { ...event, delta: `${event.delta}-changed` } : event
    );
    const iterator = stream[Symbol.asyncIterator]();
    expect(pulls).toBe(0);
    expect(await iterator.next()).toMatchObject({ value: { delta: '0-changed' } });
    expect(pulls).toBe(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(pulls).toBe(1);
    await iterator.return?.();
    expect(closed).toBe(true);
    expect(signal.aborted).toBe(true);
  });

  it('does not expose provider items and rejects another event opaque reference', async () => {
    const item: ModelEvent = {
      type: 'response.item',
      provider: 'ANTHROPIC_MESSAGES',
      contextKind: 'private',
      item: { signature: 'provider-private' }
    };
    const start = async function* (): AsyncIterable<ModelEvent> {
      yield item;
      yield { type: 'output.delta' };
    };
    let privateRef!: CoreModelEvent;
    const stream = transformCoreModelStream(start, new AbortController().signal, async (event) => {
      expect(JSON.stringify(event)).not.toContain('provider-private');
      if (event.type === 'opaque') privateRef = event;
      return privateRef;
    });
    const iterator = stream[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: item });
    await expect(iterator.next()).rejects.toThrow(/EVENT_INVALID/);
  });

  it('propagates hook failure and aborts the underlying request before cleanup', async () => {
    let aborted = false;
    const start = async function* (signal: AbortSignal): AsyncIterable<ModelEvent> {
      try {
        yield { type: 'completed', reason: 'completed' };
      } finally {
        aborted = signal.aborted;
      }
    };
    const stream = transformCoreModelStream(start, new AbortController().signal, async () => {
      throw new Error('hook failure');
    });
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow('hook failure');
    expect(aborted).toBe(true);
  });

  it('permits explicit event omission but never synthesizes usage or a terminal outcome', async () => {
    const start = async function* (): AsyncIterable<ModelEvent> {
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } };
      yield { type: 'completed', reason: 'completed' };
    };
    const events: ModelEvent[] = [];
    for await (const event of transformCoreModelStream(
      start,
      new AbortController().signal,
      async (event) => (event.type === 'completed' ? undefined : event)
    ))
      events.push(event);
    expect(events).toEqual([{ type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } }]);
  });

  it('does not deliver an event after cancellation while awaiting a hook', async () => {
    const controller = new AbortController();
    let aborted = false;
    const start = async function* (signal: AbortSignal): AsyncIterable<ModelEvent> {
      try {
        yield { type: 'completed', reason: 'completed' };
      } finally {
        aborted = signal.aborted;
      }
    };
    const stream = transformCoreModelStream(start, controller.signal, async (event) => {
      controller.abort();
      return event;
    });
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow();
    expect(aborted).toBe(true);
  });
});
