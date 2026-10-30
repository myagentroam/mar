import { describe, expect, it, vi } from 'vitest';
import { parseSse } from '../../src/model/sse.js';

const encoder = new TextEncoder();

function responseFromChunks(chunks: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      }
    })
  );
}

async function collect(response: Response, signal = new AbortController().signal) {
  const events: unknown[] = [];
  try {
    for await (const event of parseSse(response, signal)) events.push(event);
    return events;
  } finally {
    expect(response.body?.locked).toBe(false);
  }
}

function partitions(text: string): Uint8Array[][] {
  const bytes = encoder.encode(text);
  return [
    [bytes],
    ...Array.from({ length: bytes.length + 1 }, (_, cut) => [
      bytes.slice(0, cut),
      bytes.slice(cut)
    ]),
    Array.from(bytes, (byte) => Uint8Array.of(byte))
  ];
}

describe('incremental model SSE framing', () => {
  it('refreshes the default 180-second idle deadline when incoming bytes arrive', async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const cancel = vi.fn();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
        cancel
      })
    );
    let failure: unknown;
    const pending = collect(response, parent.signal).catch((error: unknown) => {
      failure = error;
    });
    try {
      await vi.advanceTimersByTimeAsync(179_999);
      expect(failure).toBeUndefined();
      expect(cancel).not.toHaveBeenCalled();
      controller.enqueue(encoder.encode(': heartbeat\n\n'));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(179_999);
      expect(failure).toBeUndefined();
      expect(cancel).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(failure).toMatchObject({
        code: 'MAR_AGENT_MODEL_TIMEOUT',
        retryable: true,
        details: { reason: 'MODEL_STREAM_IDLE_TIMEOUT' }
      });
      await pending;
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(response.body?.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      parent.abort();
      await pending;
      vi.useRealTimers();
    }
  });

  it.each([
    { name: 'LF', newline: '\n' },
    { name: 'CRLF', newline: '\r\n' }
  ])('parses the same complete frame at every byte cut with $name', async ({ newline }) => {
    const frame = 'data: {"ok":true}' + newline + newline;
    for (const chunks of partitions(frame)) {
      expect(await collect(responseFromChunks(chunks))).toEqual([{ ok: true }]);
    }
  });

  it.each([
    { name: 'LF', newline: '\n' },
    { name: 'CRLF', newline: '\r\n' },
    { name: 'mixed LF/CRLF', newline: '\r\n' }
  ])(
    'preserves multiple frames and multiline Unicode data with $name',
    async ({ name, newline }) => {
      const lastNewline = name === 'mixed LF/CRLF' ? '\n' : newline;
      const text =
        [
          ': heartbeat',
          '',
          'event: message',
          'id: ignored',
          'data: {"text":',
          'data: "你好🌍"}',
          '',
          'data:',
          '',
          'data: [DONE]',
          ''
        ].join(newline) +
        newline +
        'data: {"next":2}' +
        lastNewline +
        lastNewline;
      for (const chunks of partitions(text)) {
        expect(await collect(responseFromChunks(chunks))).toEqual([
          { text: '你好🌍' },
          { next: 2 }
        ]);
      }
    }
  );

  it.each(['', '\n', '\r\n', ': heartbeat\r\n\r\n'])(
    'accepts EOF without a pending data frame for %j',
    async (text) => {
      for (const chunks of partitions(text)) {
        expect(await collect(responseFromChunks(chunks))).toEqual([]);
      }
    }
  );

  it.each([
    'data: {"ok":true}',
    'data: {"ok":true}\n',
    'data: {"ok":true}\r',
    'data: {"ok":true}\r\n',
    'data: {"ok":true}\r\n\r'
  ])('rejects incomplete EOF at every byte cut for %j', async (text) => {
    for (const chunks of partitions(text)) {
      await expect(collect(responseFromChunks(chunks))).rejects.toMatchObject({
        code: 'MAR_AGENT_MODEL_PROTOCOL_ERROR',
        message: 'MAR_AGENT_MODEL_PROTOCOL_ERROR: Model SSE ended with an incomplete frame.'
      });
    }
  });

  it.each(['\n', '\r\n'])('rejects malformed JSON at every byte cut with %j', async (newline) => {
    for (const chunks of partitions('data: {broken}' + newline + newline)) {
      await expect(collect(responseFromChunks(chunks))).rejects.toMatchObject({
        code: 'MAR_AGENT_MODEL_PROTOCOL_ERROR',
        message: 'MAR_AGENT_MODEL_PROTOCOL_ERROR: Model SSE contained invalid JSON.'
      });
    }
  });

  it('publishes complete frames before rejecting an incomplete final frame', async () => {
    const response = responseFromChunks([
      encoder.encode('data: {"ok":true}\r\n\r'),
      encoder.encode('\ndata: {"next":2}\r\n')
    ]);
    const stream = parseSse(response, new AbortController().signal)[Symbol.asyncIterator]();
    try {
      expect(await stream.next()).toEqual({ done: false, value: { ok: true } });
      await expect(stream.next()).rejects.toThrow(/incomplete frame/);
    } finally {
      await stream.return?.();
      expect(response.body?.locked).toBe(false);
    }
  });

  it('preserves cancellation and releases a reader waiting after a trailing CR', async () => {
    let waiting!: () => void;
    const readPending = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"ok":true}\r\n\r'));
        },
        pull() {
          waiting();
        },
        cancel
      })
    );
    const controller = new AbortController();
    const reason = new Error('cancel pending CRLF');
    const pending = collect(response, controller.signal);
    try {
      await readPending;
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
      expect(cancel).toHaveBeenCalled();
    } finally {
      controller.abort(reason);
      await pending.catch(() => undefined);
    }
  });

  it('cancels and unlocks an open reader when a split frame is invalid', async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {broken}\r\n\r'));
          controller.enqueue(encoder.encode('\n'));
        },
        cancel
      })
    );
    await expect(collect(response)).rejects.toThrow(/invalid JSON/);
    expect(cancel).toHaveBeenCalled();
  });

  it('cancels and unlocks the reader when the consumer returns after a split frame', async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"ok":true}\r\n\r'));
          controller.enqueue(encoder.encode('\ndata: {"next":'));
        },
        cancel
      })
    );
    const stream = parseSse(response, new AbortController().signal)[Symbol.asyncIterator]();
    try {
      expect(await stream.next()).toEqual({ done: false, value: { ok: true } });
    } finally {
      await stream.return?.();
    }
    expect(cancel).toHaveBeenCalled();
    expect(response.body?.locked).toBe(false);
  });
});
