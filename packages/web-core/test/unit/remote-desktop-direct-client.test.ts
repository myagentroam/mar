import { describe, expect, it, vi } from 'vitest';
import { createRemoteDesktopDirectClient } from '../../src/service/remote-desktop-direct-client.js';

class Channel extends EventTarget {
  readyState: RTCDataChannelState = 'open';
  binaryType: BinaryType = 'arraybuffer';
  bufferedAmount = 0;
  readonly sent: unknown[] = [];
  send(value: unknown) {
    this.sent.push(value);
  }
  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
  receive(data: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

function fixture() {
  const raw = new Channel();
  const transport = {
    transportSessionId: 'transport-12345678',
    nodeGeneration: 'generation-12345678',
    maxMessageBytes: 16_384,
    waitChannel: vi.fn(async () => raw as unknown as RTCDataChannel),
    release: vi.fn()
  };
  const send = vi.fn((_message: unknown) => true);
  const disconnected = vi.fn();
  const client = createRemoteDesktopDirectClient({
    send,
    acquire: () => transport,
    randomId: () => 'request-12345678'
  });
  const signal = new AbortController();
  const input = {
    nodeId: 'node',
    nodeGeneration: 'generation-12345678',
    desktopGeneration: 'desktop-12345678',
    topologyRevision: 3,
    mode: 'CONTROL' as const,
    signal: signal.signal,
    onDisconnected: disconnected
  };
  const prepared = {
    type: 'desktop.direct.prepared' as const,
    requestId: 'request-12345678',
    attachmentId: 'attachment-12345678',
    grant: 'g'.repeat(32),
    openExpiresAt: Date.now() + 15_000,
    expiresAt: Date.now() + 30_000
  };
  return { raw, transport, send, disconnected, client, signal, input, prepared };
}

describe('remote desktop Direct authorization and handoff', () => {
  it('hands ATTACHED to noVNC without dropping the next frame, and ready is explicit and once', async () => {
    const f = fixture();
    const attaching = f.client.attach(f.input);
    f.client.handle(f.prepared);
    await vi.waitFor(() => expect(f.raw.sent).toHaveLength(1));
    expect(JSON.parse(f.raw.sent[0] as string)).toEqual({
      type: 'OPEN',
      attachmentId: f.prepared.attachmentId,
      grant: f.prepared.grant
    });
    f.raw.dispatchEvent(new Event('open'));
    expect(f.raw.sent).toHaveLength(1);
    f.raw.receive(JSON.stringify({ type: 'ATTACHED', attachmentId: f.prepared.attachmentId }));
    f.raw.receive(new Uint8Array([7, 8]).buffer);
    const handle = (await attaching)!;
    const received: number[][] = [];
    handle.channel.onmessage = (event) => received.push([...new Uint8Array(event.data)]);
    await vi.waitFor(() => expect(received).toEqual([[7, 8]]));
    expect(f.send).not.toHaveBeenCalledWith({
      type: 'desktop.ready',
      attachmentId: f.prepared.attachmentId
    });
    handle.ready();
    handle.ready();
    expect(
      f.send.mock.calls.filter(
        ([message]) => (message as { type: string }).type === 'desktop.ready'
      )
    ).toHaveLength(1);
    handle.close();
    handle.close();
    handle.ready();
    expect(
      f.send.mock.calls.filter(
        ([message]) => (message as { type: string }).type === 'desktop.ready'
      )
    ).toHaveLength(1);
    expect(f.transport.release).toHaveBeenCalledOnce();
    expect(f.send).toHaveBeenCalledWith({
      type: 'desktop.direct.cancel',
      attachmentId: f.prepared.attachmentId
    });
    f.client.close();
  });

  it('does not activate after an immediate closed event or a late grant after cancellation', async () => {
    const f = fixture();
    const attaching = f.client.attach(f.input);
    f.client.handle(f.prepared);
    f.client.handle({
      type: 'desktop.direct.closed',
      attachmentId: f.prepared.attachmentId,
      code: 'DESKTOP_LOCKED'
    });
    await expect(attaching).rejects.toMatchObject({ code: 'DESKTOP_CONTROL_UNAVAILABLE' });
    expect(f.transport.waitChannel).not.toHaveBeenCalled();
    expect(f.disconnected).toHaveBeenCalledWith('DESKTOP_LOCKED');
    expect(f.transport.release).toHaveBeenCalledOnce();

    const other = fixture();
    const cancelled = other.client.attach(other.input);
    other.signal.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'DESKTOP_CONTROL_UNAVAILABLE' });
    other.client.handle(other.prepared);
    expect(other.send).toHaveBeenCalledWith({
      type: 'desktop.direct.cancel',
      attachmentId: other.prepared.attachmentId
    });
    expect(other.transport.release).toHaveBeenCalledOnce();
  });

  it('rejects a mismatched ATTACHED and releases only its own channel', async () => {
    const f = fixture();
    const attaching = f.client.attach(f.input);
    f.client.handle(f.prepared);
    await vi.waitFor(() => expect(f.raw.sent).toHaveLength(1));
    f.raw.receive(JSON.stringify({ type: 'ATTACHED', attachmentId: 'different-12345678' }));
    await expect(attaching).rejects.toMatchObject({ code: 'DESKTOP_TRANSPORT_ERROR' });
    expect(f.raw.readyState).toBe('closed');
    expect(f.transport.release).toHaveBeenCalledOnce();
  });

  it('releases the borrowed transport when the page control sender throws', async () => {
    const f = fixture();
    f.send.mockImplementation(() => {
      throw new Error('private detail');
    });
    await expect(f.client.attach(f.input)).rejects.toMatchObject({
      code: 'DESKTOP_CONTROL_UNAVAILABLE'
    });
    expect(f.transport.release).toHaveBeenCalledOnce();
  });
});
