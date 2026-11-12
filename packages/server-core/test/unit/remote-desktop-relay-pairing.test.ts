import { EventEmitter, once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { RemoteDesktopAdmission } from '../../src/remote-desktop-admission.js';
import { RemoteDesktopRelayPairing } from '../../src/remote-desktop-relay-pairing.js';

class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: Buffer[] = [];
  pause = vi.fn();
  resume = vi.fn();
  terminate = vi.fn(() => {
    this.readyState = WebSocket.CLOSING;
  });
  send(data: Buffer, _options: unknown, done: () => void): void {
    this.sent.push(data);
    done();
  }
}
const page = { userId: 1, sessionHash: 'session-a', workbenchConnectionId: 'page-12345678' };
const binding = {
  ...page,
  attachmentId: 'attachment-a',
  requestId: 'request-a',
  nodeId: 'node-a',
  nodeGeneration: 'generation-a',
  desktopGeneration: 'desktop-a',
  topologyRevision: 1,
  mode: 'VIEW' as const,
  path: 'RELAY' as const
};
const ws = (value: Socket) => value as unknown as WebSocket;

function fixture() {
  const admission = new RemoteDesktopAdmission();
  expect(admission.reserve(binding, Date.now())).toBeDefined();
  expect(admission.dispatched(binding.attachmentId, Date.now())).toBe(true);
  const closed = vi.fn();
  const pairing = new RemoteDesktopRelayPairing({
    admission,
    maxFrameBytes: 8,
    maxInFlightBytes: 16,
    onClosed: closed
  });
  const tickets = pairing.prepare(binding.attachmentId)!;
  return { admission, pairing, tickets, closed };
}

describe('Remote Desktop authenticated relay handoff', () => {
  it('retains early frames through a real two-socket authorization handoff', async () => {
    const f = fixture();
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test listener');
    let count = 0;
    server.on('connection', (socket) => {
      if (count++ === 0) {
        socket.once('message', () => {
          expect(
            f.pairing.attachBrowser(binding.attachmentId, f.tickets.browserTicket, page, socket)
          ).toBe(true);
        });
      } else {
        expect(
          f.pairing.attachNode(
            binding.attachmentId,
            f.tickets.nodeTicket,
            'node-a',
            'generation-a',
            socket
          )
        ).toBe(true);
      }
    });
    const url = `ws://127.0.0.1:${address.port}`;
    const browser = new WebSocket(url);
    await once(browser, 'open');
    browser.send('AUTH');
    browser.send('OPEN');
    await vi.waitFor(() => expect(count).toBe(1));
    const node = new WebSocket(url);
    const message = once(node, 'message');
    await once(node, 'open');
    const [open, binary] = await message;
    expect((open as Buffer).toString()).toBe('OPEN');
    expect(binary).toBe(false);
    const browserClosed = once(browser, 'close');
    const nodeClosed = once(node, 'close');
    f.pairing.cancel(binding.attachmentId);
    await Promise.all([browserClosed, nodeClosed]);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    expect(f.admission.get(binding.attachmentId)?.phase).toBe('CLOSING');
  });

  it('binds distinct one-use tickets to page and Node generation without consuming them on rejection', () => {
    const f = fixture();
    const browser = new Socket();
    const node = new Socket();
    const duplicate = new Socket();
    expect(f.tickets.browserTicket).not.toBe(f.tickets.nodeTicket);
    expect(
      f.pairing.attachBrowser(
        binding.attachmentId,
        f.tickets.browserTicket,
        { ...page, sessionHash: 'other' },
        ws(browser)
      )
    ).toBe(false);
    expect(
      f.pairing.attachNode(
        binding.attachmentId,
        f.tickets.nodeTicket,
        'node-a',
        'generation-new',
        ws(node)
      )
    ).toBe(false);
    expect(
      f.pairing.attachBrowser(binding.attachmentId, f.tickets.browserTicket, page, ws(browser))
    ).toBe(true);
    expect(
      f.pairing.attachBrowser(binding.attachmentId, f.tickets.browserTicket, page, ws(duplicate))
    ).toBe(false);
    expect(
      f.pairing.attachNode(
        binding.attachmentId,
        f.tickets.nodeTicket,
        'node-a',
        'generation-a',
        ws(node)
      )
    ).toBe(true);
    expect(browser.pause).toHaveBeenCalledOnce();
    expect(node.pause).toHaveBeenCalledOnce();
    expect(browser.resume).toHaveBeenCalledOnce();
    expect(node.resume).toHaveBeenCalledOnce();
    f.pairing.cancel(binding.attachmentId);
    expect(f.closed).toHaveBeenCalledOnce();
    expect(f.admission.get(binding.attachmentId)?.phase).toBe('CLOSING');
    expect(f.pairing.prepare(binding.attachmentId)).toBeUndefined();
    expect(f.admission.countNode('node-a')).toBe(1);
    expect(f.admission.settled(binding.attachmentId, 'node-a', 'generation-new')).toBe(false);
    expect(f.admission.settled(binding.attachmentId, 'node-a', 'generation-a')).toBe(true);
    f.pairing.close();
  });

  it('buffers already-decoded frames while awaiting the second side and copies their live byte ranges', () => {
    const f = fixture();
    const browser = new Socket();
    const node = new Socket();
    expect(
      f.pairing.attachBrowser(binding.attachmentId, f.tickets.browserTicket, page, ws(browser))
    ).toBe(true);
    const bytes = Uint8Array.from([9, 1, 2, 9]);
    browser.emit('message', Buffer.from(bytes.buffer, 1, 2), true);
    browser.emit('message', Buffer.from('OPEN'), false);
    bytes.fill(0);
    expect(
      f.pairing.attachNode(
        binding.attachmentId,
        f.tickets.nodeTicket,
        'node-a',
        'generation-a',
        ws(node)
      )
    ).toBe(true);
    expect(node.sent.map((data) => Array.from(data))).toEqual([
      [1, 2],
      [79, 80, 69, 78]
    ]);
    f.pairing.close();
  });

  it('terminates its pending socket on bounded preread overflow without freeing admission', () => {
    const f = fixture();
    const browser = new Socket();
    f.pairing.attachBrowser(binding.attachmentId, f.tickets.browserTicket, page, ws(browser));
    browser.emit('message', Buffer.alloc(8), true);
    browser.emit('message', Buffer.alloc(8), true);
    browser.emit('message', Buffer.alloc(0), true);
    expect(browser.terminate).toHaveBeenCalledOnce();
    expect(f.closed).toHaveBeenCalledOnce();
    expect(f.admission.countNode('node-a')).toBe(1);
  });

  it('expires an incomplete pair and refuses replay', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const node = new Socket();
      const browser = new Socket();
      f.pairing.attachNode(
        binding.attachmentId,
        f.tickets.nodeTicket,
        'node-a',
        'generation-a',
        ws(node)
      );
      await vi.advanceTimersByTimeAsync(15_000);
      expect(node.terminate).toHaveBeenCalledOnce();
      expect(f.closed).toHaveBeenCalledOnce();
      expect(
        f.pairing.attachBrowser(binding.attachmentId, f.tickets.browserTicket, page, ws(browser))
      ).toBe(false);
      expect(f.admission.get(binding.attachmentId)?.phase).toBe('CLOSING');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not allow paired sockets to prolong OPEN and only accepts a Node-confirmed open', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const node = new Socket();
      const browser = new Socket();
      f.pairing.attachBrowser(binding.attachmentId, f.tickets.browserTicket, page, ws(browser));
      f.pairing.attachNode(
        binding.attachmentId,
        f.tickets.nodeTicket,
        'node-a',
        'generation-a',
        ws(node)
      );
      expect(f.pairing.opened(binding.attachmentId)).toBe(false);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(browser.terminate).toHaveBeenCalledOnce();
      expect(node.terminate).toHaveBeenCalledOnce();
      expect(f.admission.get(binding.attachmentId)?.phase).toBe('CLOSING');
    } finally {
      vi.useRealTimers();
    }
  });
});
