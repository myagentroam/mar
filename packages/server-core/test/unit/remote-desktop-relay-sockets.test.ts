import { EventEmitter, once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { RemoteDesktopAdmission } from '../../src/remote-desktop-admission.js';
import { RemoteDesktopRelayPairing } from '../../src/remote-desktop-relay-pairing.js';
import { RemoteDesktopRelaySockets } from '../../src/remote-desktop-relay-sockets.js';

const identity = { userId: 1, sessionHash: 'session-a', workbenchConnectionId: 'page-12345678' };
const attachmentId = 'attachment-123';
async function fixture() {
  const admission = new RemoteDesktopAdmission();
  admission.reserve(
    {
      ...identity,
      attachmentId,
      requestId: 'request-123',
      nodeId: 'node-a',
      nodeGeneration: 'generation-a',
      desktopGeneration: 'desktop-a',
      topologyRevision: 1,
      mode: 'VIEW',
      path: 'RELAY'
    },
    Date.now()
  );
  expect(admission.dispatched(attachmentId, Date.now())).toBe(true);
  const pairing = new RemoteDesktopRelayPairing({
    admission,
    maxFrameBytes: 16384,
    maxInFlightBytes: 65536,
    onClosed: vi.fn()
  });
  const tickets = pairing.prepare(attachmentId)!;
  let generation = 'generation-a';
  const authenticateNode = vi.fn(async (_id: string, _credential: string) => ({
    id: 'node-a',
    disabled: false
  }));
  const sockets = new RemoteDesktopRelaySockets({
    pairing,
    ownsPage: (user, id) =>
      user.sessionHash === identity.sessionHash && id === identity.workbenchConnectionId,
    authenticateNode,
    currentNodeGeneration: () => generation
  });
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', (socket, request) => {
    if (request.url === '/node') sockets.attachNode(socket);
    else sockets.attachBrowser(socket, identity);
  });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No listener');
  const url = `ws://127.0.0.1:${address.port}`;
  const close = async () => {
    sockets.close();
    pairing.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return {
    admission,
    pairing,
    tickets,
    authenticateNode,
    url,
    close,
    setGeneration: (value: string) => {
      generation = value;
    }
  };
}

describe('Remote Desktop relay authenticated socket handoff', () => {
  it('preserves OPEN immediately following browser authentication on real sockets', async () => {
    const f = await fixture();
    const node = new WebSocket(`${f.url}/node`);
    const browser = new WebSocket(`${f.url}/browser`);
    try {
      await Promise.all([once(node, 'open'), once(browser, 'open')]);
      const received = once(node, 'message');
      node.send(
        JSON.stringify({
          type: 'desktop.relay.node',
          nodeId: 'node-a',
          nodeGeneration: 'generation-a',
          attachmentId,
          ticket: f.tickets.nodeTicket,
          credential: 'secret'
        })
      );
      browser.send(
        JSON.stringify({
          type: 'desktop.relay.browser',
          workbenchConnectionId: identity.workbenchConnectionId,
          attachmentId,
          ticket: f.tickets.browserTicket
        })
      );
      browser.send('OPEN');
      const [data, binary] = await received;
      expect((data as Buffer).toString()).toBe('OPEN');
      expect(binary).toBe(false);
      expect(f.authenticateNode).toHaveBeenCalledWith('node-a', 'secret');
    } finally {
      node.terminate();
      browser.terminate();
      await f.close();
    }
  });

  it('rejects a Node generation replaced while credential verification is in flight', async () => {
    const f = await fixture();
    let resolve!: (node: { id: string; disabled: boolean }) => void;
    f.authenticateNode.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const node = new WebSocket(`${f.url}/node`);
    try {
      await once(node, 'open');
      const closed = once(node, 'close');
      node.send(
        JSON.stringify({
          type: 'desktop.relay.node',
          nodeId: 'node-a',
          nodeGeneration: 'generation-a',
          attachmentId,
          ticket: f.tickets.nodeTicket,
          credential: 'secret'
        })
      );
      await vi.waitFor(() => expect(resolve).toBeDefined());
      f.setGeneration('generation-b');
      resolve({ id: 'node-a', disabled: false });
      await closed;
      expect(f.admission.get(attachmentId)?.phase).toBe('RESERVED');
    } finally {
      node.terminate();
      await f.close();
    }
  });

  it('rejects an unowned page before handing its socket to the pairing', async () => {
    const f = await fixture();
    const browser = new WebSocket(`${f.url}/browser`);
    try {
      await once(browser, 'open');
      const closed = once(browser, 'close');
      browser.send(
        JSON.stringify({
          type: 'desktop.relay.browser',
          workbenchConnectionId: 'page-another',
          attachmentId,
          ticket: f.tickets.browserTicket
        })
      );
      await closed;
      expect(f.admission.get(attachmentId)?.phase).toBe('RESERVED');
    } finally {
      browser.terminate();
      await f.close();
    }
  });

  it('terminates each unauthenticated socket at its deadline without a global count limit', () => {
    vi.useFakeTimers();
    class PendingSocket extends EventEmitter {
      readyState: number = WebSocket.OPEN;
      terminate = vi.fn(() => {
        this.readyState = WebSocket.CLOSED;
        this.emit('close');
      });
      pause = vi.fn();
    }
    const sockets = new RemoteDesktopRelaySockets({
      pairing: { attachBrowser: vi.fn(), attachNode: vi.fn() },
      ownsPage: () => true,
      authenticateNode: vi.fn(async () => undefined),
      currentNodeGeneration: () => undefined
    });
    try {
      const pending = Array.from({ length: 65 }, () => new PendingSocket());
      for (const socket of pending) sockets.attachNode(socket as unknown as WebSocket);
      expect(pending[64]!.terminate).not.toHaveBeenCalled();
      expect(pending[0]!.terminate).not.toHaveBeenCalled();
      vi.advanceTimersByTime(5000);
      expect(pending.every((socket) => socket.terminate.mock.calls.length === 1)).toBe(true);
    } finally {
      sockets.close();
      vi.useRealTimers();
    }
  });
});
