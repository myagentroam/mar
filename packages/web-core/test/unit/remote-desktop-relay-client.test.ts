import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRemoteDesktopRelayClient } from '../../src/service/remote-desktop-relay-client.js';

class Socket extends EventTarget {
  static OPEN = 1;
  readyState = 0;
  binaryType = 'arraybuffer';
  bufferedAmount = 0;
  readonly sent: unknown[] = [];
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }
  receive(data: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}
function fixture() {
  vi.stubGlobal('window', { location: { origin: 'https://example.test' } });
  vi.stubGlobal('WebSocket', Socket);
  const raw = new Socket();
  const createSocket = vi.fn(() => raw as unknown as WebSocket);
  const send = vi.fn((_message: unknown) => true);
  const signal = new AbortController();
  const onDisconnected = vi.fn();
  const client = createRemoteDesktopRelayClient({
    send,
    createSocket,
    connectionId: () => 'connection-12345678',
    randomId: () => 'request-12345678'
  });
  const input = {
    nodeId: 'node',
    nodeGeneration: 'generation-12345678',
    desktopGeneration: 'desktop-12345678',
    topologyRevision: 3,
    mode: 'CONTROL' as const,
    signal: signal.signal,
    onDisconnected
  };
  const prepared = {
    type: 'desktop.relay.prepared' as const,
    requestId: 'request-12345678',
    attachmentId: 'attachment-12345678',
    ticket: 't'.repeat(32),
    grant: 'g'.repeat(32),
    openExpiresAt: Date.now() + 15000,
    expiresAt: Date.now() + 30000
  };
  return { raw, createSocket, send, signal, onDisconnected, client, input, prepared };
}
afterEach(() => vi.unstubAllGlobals());
describe('remote desktop Relay client', () => {
  it('uses the settled Node code when data closes before the control event', async () => {
    const f = fixture();
    const pending = f.client.attach(f.input);
    f.client.handle(f.prepared);
    await vi.waitFor(() => expect(f.createSocket).toHaveBeenCalledOnce());
    f.raw.open();
    f.raw.close();
    const failure = await pending.catch((error) => error);
    expect(failure.code).toBe('DESKTOP_TRANSPORT_ERROR');
    f.client.handle({
      type: 'desktop.relay.settled',
      attachmentId: f.prepared.attachmentId,
      code: 'DESKTOP_TOPOLOGY_UNAVAILABLE'
    });
    expect(await failure.settlement).toBe(true);
    expect(failure.confirmedCode).toBe('DESKTOP_TOPOLOGY_UNAVAILABLE');
    expect(failure.code).toBe('DESKTOP_TRANSPORT_ERROR');
    f.client.close();
  });
  it('allows retry after a definitely unsubmitted error but not an ambiguous error', async () => {
    const f = fixture();
    const first = f.client.attach(f.input);
    f.client.handle({
      type: 'desktop.relay.error',
      requestId: f.prepared.requestId,
      code: 'DESKTOP_TOPOLOGY_UNAVAILABLE',
      message: 'Desktop topology is unavailable.',
      settled: true
    });
    const failure = await first.catch((error) => error);
    expect(failure.code).toBe('DESKTOP_TOPOLOGY_UNAVAILABLE');
    expect(await failure.settlement).toBe(true);
    const second = f.client.attach(f.input);
    f.client.handle({
      type: 'desktop.relay.error',
      requestId: f.prepared.requestId,
      code: 'NODE_OFFLINE',
      message: 'Node is unavailable.'
    });
    const ambiguous = await second.catch((error) => error);
    expect(await ambiguous.settlement).toBe(false);
    await expect(f.client.attach(f.input)).rejects.toMatchObject({
      code: 'DESKTOP_CONTROL_UNAVAILABLE'
    });
    f.client.close();
  });
  it('authenticates first, sends OPEN next, and transfers adjacent RFB bytes once', async () => {
    const f = fixture();
    const attaching = f.client.attach(f.input);
    f.client.handle(f.prepared);
    await vi.waitFor(() => expect(f.createSocket).toHaveBeenCalledOnce());
    expect(f.createSocket).toHaveBeenCalledWith('wss://example.test/api/desktop/relay');
    f.raw.open();
    expect(f.raw.sent.map((frame) => JSON.parse(frame as string))).toEqual([
      {
        type: 'desktop.relay.browser',
        attachmentId: f.prepared.attachmentId,
        workbenchConnectionId: 'connection-12345678',
        ticket: f.prepared.ticket
      },
      { type: 'OPEN', attachmentId: f.prepared.attachmentId, grant: f.prepared.grant }
    ]);
    f.raw.receive(JSON.stringify({ type: 'ATTACHED', attachmentId: f.prepared.attachmentId }));
    f.raw.receive(new Uint8Array([7, 8]).buffer);
    const handle = (await attaching)!;
    const received: number[][] = [];
    handle.channel.onmessage = (event) => received.push([...new Uint8Array(event.data)]);
    await vi.waitFor(() => expect(received).toEqual([[7, 8]]));
    handle.ready();
    handle.ready();
    expect(
      f.send.mock.calls.filter(([m]) => (m as { type: string }).type === 'desktop.ready')
    ).toHaveLength(1);
    handle.close();
    expect(f.send).toHaveBeenCalledWith({
      type: 'desktop.relay.cancel',
      attachmentId: f.prepared.attachmentId
    });
    expect(f.raw.readyState).toBe(3);
  });
  it('cancels a late grant after the page aborts without creating a socket', async () => {
    const f = fixture();
    const attaching = f.client.attach(f.input);
    f.signal.abort();
    await expect(attaching).rejects.toMatchObject({ code: 'DESKTOP_CONTROL_UNAVAILABLE' });
    f.client.handle(f.prepared);
    expect(f.createSocket).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledWith({
      type: 'desktop.relay.cancel',
      attachmentId: f.prepared.attachmentId
    });
  });
  it('closes the socket and fences ready on server revocation during OPEN', async () => {
    const f = fixture();
    const attaching = f.client.attach(f.input);
    f.client.handle(f.prepared);
    await vi.waitFor(() => expect(f.createSocket).toHaveBeenCalledOnce());
    f.client.handle({
      type: 'desktop.relay.closed',
      attachmentId: f.prepared.attachmentId,
      code: 'DESKTOP_LOCKED'
    });
    await expect(attaching).rejects.toMatchObject({ code: 'DESKTOP_TRANSPORT_ERROR' });
    expect(f.raw.readyState).toBe(3);
    expect(f.onDisconnected).toHaveBeenCalledWith('DESKTOP_LOCKED');
    expect(f.send).not.toHaveBeenCalledWith({
      type: 'desktop.ready',
      attachmentId: f.prepared.attachmentId
    });
  });
  it('keeps a closing attachment until its own settlement, not its close notice', async () => {
    const f = fixture();
    const attaching = f.client.attach(f.input);
    f.client.handle(f.prepared);
    await vi.waitFor(() => expect(f.createSocket).toHaveBeenCalledOnce());
    f.raw.open();
    f.raw.receive(JSON.stringify({ type: 'ATTACHED', attachmentId: f.prepared.attachmentId }));
    const handle = (await attaching)!;
    const result = vi.fn();
    const closed = handle.close().then(result);
    f.client.handle({
      type: 'desktop.relay.closed',
      attachmentId: f.prepared.attachmentId,
      code: 'DESKTOP_CANCELLED'
    });
    f.client.handle({
      type: 'desktop.relay.settled',
      attachmentId: 'other-attachment',
      code: 'DESKTOP_TRANSPORT_ERROR'
    });
    await Promise.resolve();
    expect(result).not.toHaveBeenCalled();
    f.client.handle({
      type: 'desktop.relay.settled',
      attachmentId: f.prepared.attachmentId,
      code: 'DESKTOP_TRANSPORT_ERROR'
    });
    await closed;
    expect(result).toHaveBeenCalledWith(true);
    f.client.close();
  });
  it('treats missing settlement as unknown and refuses another attachment', async () => {
    const f = fixture();
    const attaching = f.client.attach(f.input);
    f.client.handle(f.prepared);
    await vi.waitFor(() => expect(f.createSocket).toHaveBeenCalledOnce());
    f.raw.open();
    f.raw.receive(JSON.stringify({ type: 'ATTACHED', attachmentId: f.prepared.attachmentId }));
    const handle = (await attaching)!;
    vi.useFakeTimers();
    try {
      const settled = handle.close();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await settled).toBe(false);
      await expect(f.client.attach(f.input)).rejects.toMatchObject({
        code: 'DESKTOP_CONTROL_UNAVAILABLE'
      });
      f.client.handle({
        type: 'desktop.relay.settled',
        attachmentId: f.prepared.attachmentId,
        code: 'DESKTOP_TRANSPORT_ERROR'
      });
      await expect(f.client.attach(f.input)).rejects.toMatchObject({
        code: 'DESKTOP_CONTROL_UNAVAILABLE'
      });
    } finally {
      f.client.close();
      vi.useRealTimers();
    }
  });
  it('does not let a previous attachment settle its replacement', async () => {
    const f = fixture();
    const sockets: Socket[] = [];
    let request = 0;
    const client = createRemoteDesktopRelayClient({
      send: f.send,
      connectionId: () => 'connection-12345678',
      randomId: () => `request-${++request}`,
      createSocket: () => {
        const socket = new Socket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      }
    });
    const connect = async (index: number) => {
      const attachmentId = `attachment-${index}`;
      const pending = client.attach(f.input);
      client.handle({ ...f.prepared, requestId: `request-${index}`, attachmentId });
      await vi.waitFor(() => expect(sockets).toHaveLength(index));
      const socket = sockets[index - 1]!;
      socket.open();
      socket.receive(JSON.stringify({ type: 'ATTACHED', attachmentId }));
      return (await pending)!;
    };
    const first = await connect(1);
    const firstClosed = first.close();
    client.handle({
      type: 'desktop.relay.settled',
      attachmentId: 'attachment-1',
      code: 'DESKTOP_TRANSPORT_ERROR'
    });
    expect(await firstClosed).toBe(true);
    const second = await connect(2);
    const seen = vi.fn();
    const secondClosed = second.close().then(seen);
    client.handle({
      type: 'desktop.relay.settled',
      attachmentId: 'attachment-1',
      code: 'DESKTOP_TRANSPORT_ERROR'
    });
    await Promise.resolve();
    expect(seen).not.toHaveBeenCalled();
    client.handle({
      type: 'desktop.relay.settled',
      attachmentId: 'attachment-2',
      code: 'DESKTOP_TRANSPORT_ERROR'
    });
    await secondClosed;
    expect(seen).toHaveBeenCalledWith(true);
    client.close();
  });
  it('closes only the attachment when the Relay output queue overflows', async () => {
    const f = fixture();
    const attaching = f.client.attach(f.input);
    f.client.handle(f.prepared);
    await vi.waitFor(() => expect(f.createSocket).toHaveBeenCalledOnce());
    f.raw.open();
    f.raw.receive(JSON.stringify({ type: 'ATTACHED', attachmentId: f.prepared.attachmentId }));
    const handle = (await attaching)!;
    f.raw.bufferedAmount = 1024 * 1024;
    handle.channel.send(new Uint8Array(1024 * 1024 + 1));
    expect(f.onDisconnected).toHaveBeenCalledWith('DESKTOP_BACKPRESSURE');
    expect(f.raw.readyState).toBe(3);
    expect(f.send).toHaveBeenCalledWith({
      type: 'desktop.relay.cancel',
      attachmentId: f.prepared.attachmentId
    });
  });
  it('bounds pending Relay setup and closes all pending attempts', async () => {
    const f = fixture();
    let id = 0;
    const client = createRemoteDesktopRelayClient({
      send: f.send,
      connectionId: () => 'connection-12345678',
      randomId: () => `request-${++id}`
    });
    const attempts = Array.from({ length: 4 }, () => client.attach(f.input));
    const outcomes = Promise.all(
      attempts.map((attempt) => attempt.catch((error: unknown) => error))
    );
    await expect(client.attach(f.input)).rejects.toMatchObject({
      code: 'DESKTOP_CONTROL_UNAVAILABLE'
    });
    client.close();
    expect(await outcomes).toHaveLength(4);
    expect(f.send).toHaveBeenCalledTimes(4);
  });
});
