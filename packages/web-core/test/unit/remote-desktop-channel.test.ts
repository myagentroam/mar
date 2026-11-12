import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteDesktopChannel } from '../../src/service/remote-desktop-channel.js';

class Peer extends EventTarget {
  readyState = 'open';
  binaryType = 'arraybuffer';
  bufferedAmount = 0;
  sent: number[][] = [];
  closes = 0;
  send(bytes: Uint8Array) {
    this.sent.push([...bytes]);
  }
  close() {
    this.closes++;
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
  receive(data: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

function setup(preRead: (ArrayBuffer | ArrayBufferView<ArrayBuffer>)[] = []) {
  const peer = new Peer();
  const onFailure = vi.fn();
  const channel = new RemoteDesktopChannel(peer as unknown as RTCDataChannel, {
    preRead,
    maxMessageBytes: 4,
    maxQueuedBytes: 8,
    highWaterBytes: 8,
    onFailure
  });
  return { peer, channel, onFailure };
}

describe('Remote Desktop noVNC channel handoff', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('delivers bounded preread once after handler installation and preserves order', async () => {
    const prior = Uint8Array.of(99, 1, 2, 88);
    const { peer, channel } = setup([prior.subarray(1, 3)]);
    prior.fill(9);
    peer.receive(Uint8Array.of(3).buffer);
    const received: number[][] = [];
    channel.onmessage = (event) => received.push([...new Uint8Array(event.data)]);
    expect(received).toEqual([]);
    await Promise.resolve();
    expect(received).toEqual([[1, 2], [3]]);
    await Promise.resolve();
    expect(received).toHaveLength(2);
    channel.close();
  });

  it('snapshots only a reused view range before deferred chunked sending', () => {
    const { peer, channel } = setup();
    peer.bufferedAmount = 8;
    const source = Uint8Array.of(99, 2, 3, 4, 5, 6, 88);
    channel.send(source.subarray(1, 6));
    source.fill(0);
    expect(peer.sent).toEqual([]);
    peer.bufferedAmount = 0;
    vi.advanceTimersByTime(20);
    expect(peer.sent).toEqual([[2, 3, 4, 5], [6]]);
    channel.close();
  });

  it('closes only this channel on queue overflow and does not drain stale data', async () => {
    const { peer, channel, onFailure } = setup();
    const closed = vi.fn();
    channel.onclose = closed;
    peer.bufferedAmount = 8;
    channel.send(new Uint8Array(8));
    channel.send(new Uint8Array(1));
    expect(onFailure).toHaveBeenCalledExactlyOnceWith('DESKTOP_BACKPRESSURE');
    expect(peer.closes).toBe(1);
    peer.bufferedAmount = 0;
    vi.advanceTimersByTime(100);
    channel.close();
    await Promise.resolve();
    expect(peer.sent).toEqual([]);
    expect(peer.closes).toBe(1);
    expect(closed).toHaveBeenCalledOnce();
  });

  it('rejects nonbinary data and cannot deliver preread after close', async () => {
    const { peer, channel, onFailure } = setup([Uint8Array.of(1).buffer]);
    const received = vi.fn();
    channel.onmessage = received;
    peer.receive('not RFB bytes');
    await Promise.resolve();
    expect(onFailure).toHaveBeenCalledExactlyOnceWith('DESKTOP_TRANSPORT_ERROR');
    expect(received).not.toHaveBeenCalled();
    expect(peer.closes).toBe(1);
  });

  it('reports unexpected peer closure without closing the already-closed endpoint again', async () => {
    const { peer, channel, onFailure } = setup();
    const closed = vi.fn();
    channel.onclose = closed;
    peer.close();
    await Promise.resolve();
    expect(onFailure).toHaveBeenCalledExactlyOnceWith('DESKTOP_TRANSPORT_ERROR');
    expect(closed).toHaveBeenCalledWith(expect.objectContaining({ wasClean: false }));
    channel.close();
    expect(peer.closes).toBe(1);
  });

  it('converts a bounded decoder receive overflow into a closed attachment', async () => {
    const { peer, channel, onFailure } = setup();
    channel.onmessage = () => {
      throw Object.assign(new Error('decoder queue full'), { code: 'DESKTOP_BACKPRESSURE' });
    };
    peer.receive(Uint8Array.of(1).buffer);
    await Promise.resolve();
    expect(onFailure).toHaveBeenCalledExactlyOnceWith('DESKTOP_BACKPRESSURE');
    expect(peer.closes).toBe(1);
    expect(channel.readyState).toBe('closed');
  });
});
