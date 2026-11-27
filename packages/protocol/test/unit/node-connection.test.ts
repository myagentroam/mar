import { describe, expect, it, vi } from 'vitest';
import { NodeConnection, type NodeConnectionPath } from '../../src/node-connection.js';

type Stream = { close(): void };
type Path = NodeConnectionPath<string, Stream>;

function path() {
  return {
    closed: false,
    close: vi.fn(),
    openStream: vi.fn<Path['openStream']>(async () => ({ close: vi.fn() }))
  };
}

describe('NodeConnection', () => {
  it('opens only the winning path when Direct becomes ready before a cold Relay', async () => {
    const relayReady = Promise.withResolvers<Path>();
    const direct = path();
    const relay = path();
    const connectRelay = vi.fn(() => relayReady.promise);
    const connection = new NodeConnection({ direct: async () => direct, relay: connectRelay });

    await connection.openStream('terminal');
    expect(connectRelay).toHaveBeenCalledOnce();
    relayReady.resolve(relay);
    await relayReady.promise;
    expect(direct.openStream).toHaveBeenCalledOnce();
    expect(relay.openStream).not.toHaveBeenCalled();
    connection.close();
  });

  it('settles failure of both cold paths without sending OPEN or poisoning the next request', async () => {
    const relay = path();
    const connectDirect = vi.fn(async () => {
      throw new Error('DIRECT_UNAVAILABLE');
    });
    const connectRelay = vi.fn(async () => relay).mockRejectedValueOnce(new Error('RELAY_OFFLINE'));
    const connection = new NodeConnection({ direct: connectDirect, relay: connectRelay });

    await expect(connection.openStream('failed')).rejects.toBeInstanceOf(AggregateError);
    expect(relay.openStream).not.toHaveBeenCalled();
    await connection.openStream('next');
    expect(relay.openStream).toHaveBeenCalledExactlyOnceWith('next', expect.any(AbortSignal));
    connection.close();
  });

  it('uses warm relay without waiting for ICE and shares one cold attempt across streams', async () => {
    const directReady = Promise.withResolvers<Path>();
    const direct = path();
    const relay = path();
    const connectDirect = vi.fn(() => directReady.promise);
    const connectRelay = vi.fn(async () => relay);
    const connection = new NodeConnection({ direct: connectDirect, relay: connectRelay });

    await Promise.all([connection.openStream('terminal'), connection.openStream('upload')]);
    await connection.openStream('download');
    expect(connectDirect).toHaveBeenCalledTimes(1);
    expect(connectRelay).toHaveBeenCalledTimes(1);
    expect(relay.openStream.mock.calls.map(([request]) => request)).toEqual([
      'terminal',
      'upload',
      'download'
    ]);

    directReady.resolve(direct);
    await directReady.promise;
    await connection.openStream('computer');
    expect(direct.openStream).toHaveBeenCalledWith('computer', expect.any(AbortSignal));
    expect(relay.openStream).toHaveBeenCalledTimes(3);
    connection.close();
    expect(relay.close).toHaveBeenCalledOnce();
    expect(direct.close).toHaveBeenCalledOnce();
  });

  it('releases a path that closes as it is handed over and admits a later replacement', async () => {
    const obsolete = path();
    obsolete.closed = true;
    const replacement = path();
    const connect = vi.fn(async () => replacement).mockResolvedValueOnce(obsolete);
    const connection = new NodeConnection({ direct: connect });

    await expect(connection.openStream('first')).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: 'NODE_PATH_CLOSED' })]
    });
    expect(obsolete.openStream).not.toHaveBeenCalled();
    expect(obsolete.close).toHaveBeenCalledOnce();

    await connection.openStream('replacement');
    expect(replacement.openStream).toHaveBeenCalledExactlyOnceWith(
      'replacement',
      expect.any(AbortSignal)
    );
    connection.close();
    expect(replacement.close).toHaveBeenCalledOnce();
  });

  it('tries the other path only when the selected adapter confirms nothing was dispatched', async () => {
    const direct = path();
    const relay = path();
    const connection = new NodeConnection({ direct: async () => direct, relay: async () => relay });
    direct.openStream.mockResolvedValueOnce(undefined);
    await connection.openStream('copy');
    expect(relay.openStream).toHaveBeenCalledOnce();
    const rejected = new Error('RESOURCE_DENIED');
    direct.openStream.mockRejectedValueOnce(rejected);
    await expect(connection.openStream('denied')).rejects.toBe(rejected);
    expect(relay.openStream).toHaveBeenCalledOnce();
    connection.close();
  });

  it('cancels only the waiting caller without restarting shared preparation', async () => {
    const ready = Promise.withResolvers<Path>();
    const relay = path();
    const connect = vi.fn(() => ready.promise);
    const connection = new NodeConnection({ relay: connect });
    const abort = new AbortController();
    const cancelled = connection.openStream('cancelled', { signal: abort.signal });
    const surviving = connection.openStream('surviving');
    abort.abort();
    await expect(cancelled).rejects.toBe(abort.signal.reason);
    ready.resolve(relay);
    await surviving;
    expect(connect).toHaveBeenCalledOnce();
    expect(relay.openStream.mock.calls.map(([request]) => request)).toEqual(['surviving']);
    connection.close();
  });

  it('reuses a ready path without rebuilding the other until the connection is cold', async () => {
    const direct = path();
    const relay = path();
    const replacement = Promise.withResolvers<Path>();
    const connectDirect = vi.fn(() => replacement.promise).mockResolvedValueOnce(direct);
    const reconnectRelay = vi.fn(async () => relay);
    const connection = new NodeConnection({ direct: connectDirect, relay: reconnectRelay });
    const originalStream = await connection.openStream('terminal');
    direct.closed = true;
    await connection.openStream('copy');
    await connection.openStream('computer');
    expect(relay.openStream).toHaveBeenCalledTimes(2);
    expect(connectDirect).toHaveBeenCalledOnce();
    expect(reconnectRelay).toHaveBeenCalledOnce();
    expect(direct.close).toHaveBeenCalledOnce();
    expect(originalStream.close).not.toHaveBeenCalled();

    relay.closed = true;
    const cancelled = connection.openStream('new');
    const cancellation = expect(cancelled).rejects.toThrow('NODE_CONNECTION_CLOSED');
    await Promise.resolve();
    expect(connectDirect).toHaveBeenCalledTimes(2);
    expect(reconnectRelay).toHaveBeenCalledTimes(2);

    connection.close();
    const late = path();
    replacement.resolve(late);
    await cancellation;
    await replacement.promise;
    expect(late.close).toHaveBeenCalledOnce();
  });

  it('closes a stream returned after cancellation without trying the other path', async () => {
    const direct = path();
    const relay = path();
    const started = Promise.withResolvers<void>();
    const result = Promise.withResolvers<Stream>();
    direct.openStream.mockImplementationOnce(() => {
      started.resolve();
      return result.promise;
    });
    const connection = new NodeConnection({ direct: async () => direct, relay: async () => relay });
    const abort = new AbortController();
    const opening = connection.openStream('terminal', { signal: abort.signal });
    await started.promise;
    abort.abort();
    const cancelled = expect(opening).rejects.toBe(abort.signal.reason);
    const stream = { close: vi.fn() };
    result.resolve(stream);
    await cancelled;
    expect(stream.close).toHaveBeenCalledOnce();
    expect(relay.openStream).not.toHaveBeenCalled();
    connection.close();
  });
});
