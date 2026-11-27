import { describe, expect, it, vi } from 'vitest';
import { NodeStreamMux, type NodeStreamHandler } from '../../src/node-stream-mux.js';
import { type NodeStream } from '../../src/node-stream.js';
import { decodeNodeStreamFrame, NODE_STREAM_WINDOW_BYTES } from '../../src/node-stream-wire.js';

function pair(
  accept: (
    request: { kind: string; grant: string },
    signal: AbortSignal
  ) => Promise<NodeStreamHandler | undefined>
) {
  let sentDataBytes = 0;
  const fullWindow = Promise.withResolvers<void>();
  const client = new NodeStreamMux({
    maxStreams: 4,
    async send(bytes) {
      node.receive(bytes);
      const frame = decodeNodeStreamFrame(bytes);
      if (frame.type === 'DATA' && frame.streamId === 1) {
        sentDataBytes += frame.bytes.length;
        if (sentDataBytes >= NODE_STREAM_WINDOW_BYTES) fullWindow.resolve();
      }
    }
  });
  const node = new NodeStreamMux({
    maxStreams: 4,
    accept,
    async send(bytes) {
      client.receive(bytes);
    }
  });
  return { client, node, fullWindow: fullWindow.promise, sentDataBytes: () => sentDataBytes };
}

async function collect(stream: NodeStream) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe('Node stream multiplexer', () => {
  it('bounds an unread file stream while an interactive stream completes on the same carrier', async () => {
    const resumeFile = Promise.withResolvers<void>();
    const receivedFile = Promise.withResolvers<Buffer>();
    const { client, fullWindow, sentDataBytes } = pair(async ({ kind }) => async (stream) => {
      if (kind === 'file') {
        await resumeFile.promise;
        const file = await collect(stream);
        receivedFile.resolve(file);
        await stream.write(Uint8Array.of(42));
      } else {
        for await (const chunk of stream) await stream.write(chunk);
      }
      await stream.endWrite();
    });
    const file = (await client.openStream({ kind: 'file', grant: 'file-ticket' }))!;
    const bytes = Buffer.alloc(NODE_STREAM_WINDOW_BYTES * 2 + 3, 0xba);
    const sendFile = file.write(bytes).then(() => file.endWrite());
    await fullWindow;
    expect(sentDataBytes()).toBe(NODE_STREAM_WINDOW_BYTES);

    const term = (await client.openStream({ kind: 'terminal', grant: 'terminal-ticket' }))!;
    await term.write(Buffer.from('hello'));
    await term.endWrite();
    expect((await collect(term)).toString()).toBe('hello');
    expect(sentDataBytes()).toBe(NODE_STREAM_WINDOW_BYTES);

    resumeFile.resolve();
    await sendFile;
    expect((await receivedFile.promise).equals(bytes)).toBe(true);
    expect(await collect(file)).toEqual(Buffer.from([42]));
    client.disconnect();
  });

  it('cancels a pending open without starting a late authorized handler', async () => {
    const authorization = Promise.withResolvers<NodeStreamHandler>();
    const started = Promise.withResolvers<AbortSignal>();
    let handled = false;
    const { client } = pair(async ({ grant }, signal) => {
      if (grant === 'slow') {
        started.resolve(signal);
        return authorization.promise;
      }
      if (grant === 'allowed')
        return async (stream) => {
          await stream.endWrite();
        };
      return undefined;
    });
    const abort = new AbortController();
    const opening = client.openStream({ kind: 'terminal', grant: 'slow' }, abort.signal);
    const nodeSignal = await started.promise;
    const cancelled = expect(opening).rejects.toThrow('NODE_STREAM_CANCELLED');
    abort.abort();
    await cancelled;
    expect(nodeSignal.aborted).toBe(true);
    authorization.resolve(async () => {
      handled = true;
    });
    await expect(client.openStream({ kind: 'terminal', grant: 'denied' })).rejects.toThrow(
      'RESOURCE_DENIED'
    );
    expect(handled).toBe(false);
    const unrelated = (await client.openStream({ kind: 'terminal', grant: 'allowed' }))!;
    await unrelated.endWrite();
    expect(await collect(unrelated)).toEqual(Buffer.alloc(0));
    client.disconnect();
  });

  it('rejects writes blocked on credit when the carrier disconnects', async () => {
    const { client, node, fullWindow } = pair(async () => async () => {});
    const stream = (await client.openStream({ kind: 'file', grant: 'allowed' }))!;
    const write = expect(stream.write(Buffer.alloc(NODE_STREAM_WINDOW_BYTES + 1))).rejects.toThrow(
      'NODE_STREAM_DISCONNECTED'
    );
    await fullWindow;
    client.disconnect();
    node.disconnect();
    await write;
    await expect(collect(stream)).rejects.toThrow('NODE_STREAM_DISCONNECTED');
    await stream.finished;
  });

  it('releases a stream lease after both halves end, leaving queued data readable', async () => {
    const sent = Promise.withResolvers<void>();
    const { client } = pair(async () => async (stream) => {
      await stream.write(Uint8Array.of(7));
      await stream.endWrite();
      sent.resolve();
    });
    const stream = (await client.openStream({ kind: 'file', grant: 'download' }))!;
    await sent.promise;
    const released = vi.fn();
    void stream.finished.then(released);
    await Promise.resolve();
    expect(released).not.toHaveBeenCalled();
    await stream.endWrite();
    await stream.finished;
    expect(released).toHaveBeenCalledOnce();
    expect(await collect(stream)).toEqual(Buffer.from([7]));
    client.disconnect();
  });
});
