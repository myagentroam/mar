import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import type { NodeCapabilities } from '@myagentroam/protocol';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { NodeControlChannel } from '../../src/service/node-control-channel.js';

// Exercise real upgrade, control-frame and close behavior with deterministic deadlines.
describe('Node control connection recovery', () => {
  const capabilities: NodeCapabilities = {
    platform: 'windows',
    architecture: 'x64',
    nodeAppVersion: '0.13.22',
    nodeVersion: 'v22',
    codex: { available: false },
    claudeCode: { available: false }
  };
  let server: Server;
  let websocketServer: WebSocketServer;
  let channel: NodeControlChannel;
  let hangUpgrade: boolean;
  let stopped: boolean;
  let sockets: Set<Socket>;
  let onClose: Mock<(code: number, reason: string) => void>;
  let onConnecting: Mock<(attempt: number) => void>;
  let onReconnectScheduled: Mock<() => void>;

  beforeEach(async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
    });
    hangUpgrade = false;
    stopped = false;
    sockets = new Set();
    onClose = vi.fn();
    onConnecting = vi.fn();
    onReconnectScheduled = vi.fn();
    server = createServer();
    websocketServer = new WebSocketServer({ noServer: true, autoPong: false });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    server.on('upgrade', (request, socket, head) => {
      if (!hangUpgrade)
        websocketServer.handleUpgrade(request, socket, head, (websocket) => {
          websocketServer.emit('connection', websocket);
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    channel = new NodeControlChannel({
      config: () => ({
        serverUrl: `http://127.0.0.1:${address.port}`,
        nodeId: 'existing-node',
        credential: 'fixture',
        allowedRoots: []
      }),
      capabilities: () => capabilities,
      stopped: () => stopped,
      reconnect: true,
      reconnectDelay: (attempt) => 1_000 * 2 ** attempt,
      onConnecting,
      onReconnectScheduled,
      onMessage: vi.fn(),
      onClose
    });
  });

  afterEach(async () => {
    stopped = true;
    channel?.stop();
    for (const socket of websocketServer.clients) socket.terminate();
    for (const socket of sockets) socket.destroy();
    await Promise.all([
      new Promise<void>((resolve) => websocketServer.close(() => resolve())),
      new Promise<void>((resolve) => server.close(() => resolve()))
    ]);
    vi.useRealTimers();
  });

  async function open(): Promise<WebSocket> {
    const connection = once(websocketServer, 'connection');
    channel.connect();
    const [socket] = (await connection) as [WebSocket];
    const [raw] = await once(socket, 'message');
    expect(JSON.parse(raw.toString())).toMatchObject({
      type: 'authenticate',
      payload: { nodeId: 'existing-node', credential: 'fixture' }
    });
    return socket;
  }

  async function ready(socket: WebSocket): Promise<void> {
    const message = once(socket, 'message');
    expect(channel.ready(capabilities)).toBe(true);
    const [raw] = await message;
    expect(JSON.parse(raw.toString()).type).toBe('capabilities');
  }

  it('abandons a stalled upgrade and reconnects with the existing identity', async () => {
    hangUpgrade = true;
    const upgrading = once(server, 'upgrade');
    channel.connect();
    await upgrading;
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(onReconnectScheduled).toHaveBeenCalledTimes(1));
    expect(channel.connected()).toBe(false);
    hangUpgrade = false;
    const reconnected = once(websocketServer, 'connection');
    await vi.advanceTimersByTimeAsync(1_000);
    const [socket] = (await reconnected) as [WebSocket];
    const [raw] = await once(socket, 'message');
    expect(JSON.parse(raw.toString())).toMatchObject({
      type: 'authenticate',
      payload: { nodeId: 'existing-node', credential: 'fixture' }
    });
    await ready(socket);
    expect(channel.connected()).toBe(true);
  });

  it('times out authentication despite inbound frames and retains retry backoff', async () => {
    const socket = await open();
    socket.send('unrelated-frame');
    const closed = once(socket, 'close');
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(onReconnectScheduled).toHaveBeenCalledTimes(1));
    await closed;
    expect(channel.ready(capabilities)).toBe(false);
    const reconnected = once(websocketServer, 'connection');
    await vi.advanceTimersByTimeAsync(1_000);
    const [replacement] = (await reconnected) as [WebSocket];
    await once(replacement, 'message');
    expect(onConnecting.mock.calls.map(([attempt]) => attempt)).toEqual([0, 1]);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(onReconnectScheduled).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onConnecting).toHaveBeenCalledTimes(2);
  });

  it('terminates an authenticated connection that stops answering pings', async () => {
    const socket = await open();
    await ready(socket);
    const ping = once(socket, 'ping');
    await vi.advanceTimersByTimeAsync(15_000);
    await ping;
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(onReconnectScheduled).toHaveBeenCalledTimes(1));
    expect(channel.connected()).toBe(false);
  });

  it('requires pong confirmation even while business messages keep arriving', async () => {
    const socket = await open();
    await ready(socket);
    for (let i = 0; i < 3; i++) {
      const message = once(channel.connection() as WebSocket, 'message');
      socket.send('activity');
      await message;
      await vi.advanceTimersByTimeAsync(15_000);
    }
    await vi.waitFor(() => expect(onReconnectScheduled).toHaveBeenCalledTimes(1));
    expect(channel.connected()).toBe(false);
  });

  it('accepts a delayed matching pong without replacing the outstanding probe', async () => {
    const socket = await open();
    await ready(socket);
    const ping = once(socket, 'ping');
    await vi.advanceTimersByTimeAsync(15_000);
    const [payload] = await ping;
    await vi.advanceTimersByTimeAsync(15_000);
    const pong = once(channel.connection() as WebSocket, 'pong');
    socket.pong(payload);
    await pong;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(channel.connected()).toBe(true);
    expect(onReconnectScheduled).not.toHaveBeenCalled();
  });

  it.each([45_000, 45_001])(
    'rejects a matching pong after the %i ms wall-clock deadline before the interval runs',
    async (elapsed) => {
      const socket = await open();
      await ready(socket);
      const ping = once(socket, 'ping');
      await vi.advanceTimersByTimeAsync(15_000);
      const [payload] = await ping;

      // Move wall time without advancing the monotonic clock or running the liveness interval.
      vi.setSystemTime(Date.now() + elapsed - 15_000);
      const client = channel.connection() as WebSocket;
      const pong = once(client, 'pong');
      const closed = once(client, 'close');
      socket.pong(payload);
      await pong;

      expect(channel.connected()).toBe(false);
      await closed;
      expect(onReconnectScheduled).toHaveBeenCalledTimes(1);
    }
  );

  it('rejects a matching pong at the monotonic deadline after wall-clock rollback', async () => {
    const socket = await open();
    await ready(socket);
    const monotonicAtReady = performance.now();
    const ping = once(socket, 'ping');
    await vi.advanceTimersByTimeAsync(15_000);
    const [payload] = await ping;

    // Advance only the monotonic reading and roll wall time back, without running the interval.
    vi.setSystemTime(Date.now() - 60 * 60 * 1_000);
    const monotonicNow = vi.spyOn(performance, 'now').mockReturnValue(monotonicAtReady + 45_000);
    try {
      const client = channel.connection() as WebSocket;
      const pong = once(client, 'pong');
      const closed = once(client, 'close');
      socket.pong(payload);
      await pong;

      expect(channel.connected()).toBe(false);
      await closed;
      expect(onReconnectScheduled).toHaveBeenCalledTimes(1);
    } finally {
      monotonicNow.mockRestore();
    }
  });

  it('does not renew liveness with unrelated or replayed pong frames', async () => {
    const socket = await open();
    await ready(socket);
    const ping = once(socket, 'ping');
    await vi.advanceTimersByTimeAsync(15_000);
    const [confirmedPayload] = await ping;
    const pong = once(channel.connection() as WebSocket, 'pong');
    socket.pong(confirmedPayload);
    await pong;
    const nextPing = once(socket, 'ping');
    await vi.advanceTimersByTimeAsync(15_000);
    const [pendingPayload] = await nextPing;
    expect(pendingPayload).not.toEqual(confirmedPayload);
    for (let i = 0; i < 2; i++) {
      const unrelated = once(channel.connection() as WebSocket, 'pong');
      socket.pong('unrelated');
      await unrelated;
      const replayed = once(channel.connection() as WebSocket, 'pong');
      socket.pong(confirmedPayload);
      await replayed;
      await vi.advanceTimersByTimeAsync(15_000);
    }
    await vi.waitFor(() => expect(onReconnectScheduled).toHaveBeenCalledTimes(1));
    expect(channel.connected()).toBe(false);
  });

  it('shares the establishment deadline between the upgrade and authentication', async () => {
    hangUpgrade = true;
    const upgrading = once(server, 'upgrade');
    channel.connect();
    const [request, socket, head] = await upgrading;
    await vi.advanceTimersByTimeAsync(20_000);
    const connection = once(websocketServer, 'connection');
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit('connection', websocket);
    });
    const [websocket] = (await connection) as [WebSocket];
    await once(websocket, 'message');
    await vi.advanceTimersByTimeAsync(9_999);
    expect(onReconnectScheduled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(onReconnectScheduled).toHaveBeenCalledTimes(1));
  });

  it('keeps a healthy idle connection alive and clears its authentication deadline', async () => {
    const socket = await open();
    socket.on('ping', (data) => socket.pong(data));
    await ready(socket);
    for (let i = 0; i < 6; i++) {
      const pong = once(channel.connection() as WebSocket, 'pong');
      await vi.advanceTimersByTimeAsync(15_000);
      await pong;
    }
    expect(channel.connected()).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(onReconnectScheduled).not.toHaveBeenCalled();
  });

  it('keeps transport probes active while cleanup has muted business messages', async () => {
    const socket = await open();
    socket.on('ping', (payload) => socket.pong(payload));
    await ready(socket);
    channel.muteInbound();
    for (let i = 0; i < 6; i++) {
      const message = once(channel.connection() as WebSocket, 'message');
      socket.send('activity');
      await message;
      await vi.advanceTimersByTimeAsync(15_000);
    }
    expect(channel.connected()).toBe(true);
    expect(onReconnectScheduled).not.toHaveBeenCalled();
  });

  it('detects a connection left half open across a suspended clock', async () => {
    const socket = await open();
    await ready(socket);
    vi.setSystemTime(Date.now() + 4 * 60 * 60 * 1_000);
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => expect(onReconnectScheduled).toHaveBeenCalledTimes(1));
    expect(channel.connected()).toBe(false);
  });

  it('does not extend a dead connection lifetime when the system clock moves backward', async () => {
    const socket = await open();
    await ready(socket);
    vi.setSystemTime(Date.now() - 60 * 60 * 1_000);
    await vi.advanceTimersByTimeAsync(45_000);
    await vi.waitFor(() => expect(onReconnectScheduled).toHaveBeenCalledTimes(1));
    expect(channel.connected()).toBe(false);
  });

  it('stops all connection timers without admitting stale readiness or reconnecting', async () => {
    const socket = await open();
    await ready(socket);
    const connection = channel.connection();
    const ping = vi.fn();
    socket.on('ping', ping);
    channel.stop();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(channel.ready(capabilities, connection)).toBe(false);
    expect(channel.connected()).toBe(false);
    expect(onReconnectScheduled).not.toHaveBeenCalled();
    expect(ping).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up a stopped upgrade and cancels a pending reconnect', async () => {
    hangUpgrade = true;
    const upgrading = once(server, 'upgrade');
    channel.connect();
    await upgrading;
    channel.stop();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(onReconnectScheduled).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    hangUpgrade = false;
    const socket = await open();
    socket.terminate();
    await vi.waitFor(() => expect(onReconnectScheduled).toHaveBeenCalledTimes(1));
    channel.stop();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(onConnecting).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores retired readiness and close callbacks without leaking their queued events', async () => {
    const retired = await open();
    const retiredConnection = channel.connection();
    const closed = once(retired, 'close');
    channel.send('workbench.event', { retired: true });
    channel.close();
    const replacement = await open();
    const received: string[] = [];
    replacement.on('message', (raw) => received.push(JSON.parse(raw.toString()).type));
    expect(channel.ready(capabilities, retiredConnection)).toBe(false);
    await ready(replacement);
    await closed;
    // Let queued sends flush, then observe a following frame on the same outgoing transport.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const ping = once(replacement, 'ping');
    (channel.connection() as WebSocket).ping();
    await ping;
    expect(received).toEqual(['capabilities']);
    expect(channel.connected()).toBe(true);
    expect(onReconnectScheduled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(channel.connected()).toBe(true);
  });

  it('does not reconnect after its identity is taken over by another instance', async () => {
    const socket = await open();
    await ready(socket);
    socket.close(4000, 'NODE_CONNECTION_REPLACED');
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith(4000, 'NODE_CONNECTION_REPLACED'));
    await vi.advanceTimersByTimeAsync(90_000);
    expect(onReconnectScheduled).not.toHaveBeenCalled();
    expect(onConnecting).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
