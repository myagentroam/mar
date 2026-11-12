import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { once } from 'node:events';
import { RemoteDesktopRelayPair } from '../../src/remote-desktop-relay-pair.js';

class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly sent: Array<{ data: Buffer; binary: boolean; done: (error?: Error) => void }> = [];
  readonly resume = vi.fn();
  readonly terminate = vi.fn(() => {
    this.readyState = WebSocket.CLOSING;
  });
  send(data: Buffer, options: { binary: boolean }, done: (error?: Error) => void): void {
    this.sent.push({ data, binary: options.binary, done });
  }
}

function fixture(maxInFlightBytes = 24) {
  const browser = new Socket();
  const node = new Socket();
  const closed = vi.fn();
  const pair = new RemoteDesktopRelayPair(
    browser as unknown as WebSocket,
    node as unknown as WebSocket,
    {
      maxFrameBytes: 8,
      maxInFlightBytes,
      browserPreRead: [],
      nodePreRead: [],
      onClosed: closed
    }
  );
  return { browser, node, closed, pair };
}

describe('Remote Desktop opaque relay pair', () => {
  it('forwards real WebSocket text and binary frames through an isolated local listener', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test listener');
    const accepted: WebSocket[] = [];
    server.on('connection', (socket) => {
      socket.pause();
      accepted.push(socket);
    });
    const browser = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const node = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await Promise.all([once(browser, 'open'), once(node, 'open')]);
    await vi.waitFor(() => expect(accepted).toHaveLength(2));
    const closed = vi.fn();
    const pair = new RemoteDesktopRelayPair(accepted[0]!, accepted[1]!, {
      maxFrameBytes: 64,
      maxInFlightBytes: 128,
      browserPreRead: [],
      nodePreRead: [],
      onClosed: closed
    });
    try {
      const nodeMessage = once(node, 'message');
      browser.send('OPEN');
      const [text, textBinary] = await nodeMessage;
      expect((text as Buffer).toString()).toBe('OPEN');
      expect(textBinary).toBe(false);
      const browserMessage = once(browser, 'message');
      node.send(Buffer.from([0, 1, 255]));
      const [bytes, binary] = await browserMessage;
      expect(Array.from(bytes as Buffer)).toEqual([0, 1, 255]);
      expect(binary).toBe(true);
    } finally {
      const closedBrowser = once(browser, 'close');
      const closedNode = once(node, 'close');
      pair.close();
      await Promise.all([closedBrowser, closedNode]);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
    expect(closed).toHaveBeenCalledOnce();
  });

  it('preserves per-direction order, binary flags and copies reused backing storage', () => {
    const f = fixture();
    const shared = Uint8Array.from([9, 1, 2, 8]);
    f.browser.emit('message', Buffer.from(shared.buffer, 1, 2), true);
    shared.fill(7);
    f.browser.emit('message', Buffer.from('OPEN'), false);
    expect(f.node.sent.map(({ data, binary }) => [Array.from(data), binary])).toEqual([
      [[1, 2], true],
      [[79, 80, 69, 78], false]
    ]);
    f.node.emit('message', Buffer.from([3, 4]), true);
    expect(Array.from(f.browser.sent[0]!.data)).toEqual([3, 4]);
    const arrayBuffer = Uint8Array.from([5, 6]).buffer;
    f.node.emit('message', arrayBuffer, true);
    new Uint8Array(arrayBuffer).fill(0);
    expect(Array.from(f.browser.sent[1]!.data)).toEqual([5, 6]);
    expect(f.browser.resume).toHaveBeenCalledOnce();
    expect(f.node.resume).toHaveBeenCalledOnce();
    f.pair.close();
    expect(f.closed).toHaveBeenCalledOnce();
  });

  it('forwards bounded preread before resuming either connection', () => {
    const browser = new Socket();
    const node = new Socket();
    const bytes = Uint8Array.from([9, 2, 3, 9]);
    const pair = new RemoteDesktopRelayPair(
      browser as unknown as WebSocket,
      node as unknown as WebSocket,
      {
        maxFrameBytes: 8,
        maxInFlightBytes: 12,
        browserPreRead: [{ data: Buffer.from(bytes.buffer, 1, 2), binary: true }],
        nodePreRead: [{ data: Buffer.from('ok'), binary: false }],
        onClosed: vi.fn()
      }
    );
    bytes.fill(0);
    expect(Array.from(node.sent[0]!.data)).toEqual([2, 3]);
    expect(browser.sent[0]!.data.toString()).toBe('ok');
    expect(browser.resume).toHaveBeenCalledOnce();
    pair.close();
  });

  it('closes both ends once when frames or asynchronous in-flight bytes exceed limits', () => {
    const f = fixture(8);
    f.browser.emit('message', Buffer.alloc(5), true);
    f.browser.emit('message', Buffer.alloc(4), true);
    expect(f.browser.terminate).toHaveBeenCalledOnce();
    expect(f.node.terminate).toHaveBeenCalledOnce();
    expect(f.closed).toHaveBeenCalledOnce();
    f.node.sent[0]!.done();
    f.pair.close();
    expect(f.closed).toHaveBeenCalledOnce();
    const oversized = fixture();
    oversized.node.emit('message', Buffer.alloc(9), true);
    expect(oversized.closed).toHaveBeenCalledOnce();
  });

  it('releases the byte budget on send completion and closes on late send error', () => {
    const f = fixture(8);
    f.browser.emit('message', Buffer.alloc(8), true);
    f.node.sent[0]!.done();
    f.browser.emit('message', Buffer.alloc(8), true);
    expect(f.node.sent).toHaveLength(2);
    f.node.sent[1]!.done(new Error('failure'));
    expect(f.closed).toHaveBeenCalledOnce();
    f.browser.emit('error', new Error('late'));
    f.node.emit('close');
    expect(f.closed).toHaveBeenCalledOnce();
  });

  it('bounds the number of empty in-flight frames as well as their byte size', () => {
    const f = fixture(8);
    f.browser.emit('message', Buffer.alloc(0), true);
    f.browser.emit('message', Buffer.alloc(0), true);
    expect(f.node.sent).toHaveLength(1);
    expect(f.closed).toHaveBeenCalledOnce();
  });
});
