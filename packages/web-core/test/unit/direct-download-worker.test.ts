import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { directDownloadServiceWorkerPlugin } from '../../scripts/direct-download-service-worker.js';

function fixture(size = 0) {
  let source = '';
  (directDownloadServiceWorkerPlugin().generateBundle as (...args: unknown[]) => void).call({
    emitFile: (asset: { source: string }) => {
      source = asset.source;
    }
  });
  const listeners = new Map<string, (event: unknown) => void>();
  const port = {
    postMessage: vi.fn(),
    close: vi.fn(),
    onmessage: (_event: { data: unknown }) => {}
  };
  runInNewContext(source, {
    self: {
      location: { origin: 'https://download.test' },
      addEventListener: (type: string, listener: (event: unknown) => void) =>
        listeners.set(type, listener)
    },
    URL,
    Response,
    ReadableStream,
    Uint8Array,
    ArrayBuffer,
    setTimeout,
    clearTimeout
  });
  listeners.get('message')!({
    data: { type: 'direct-download.create', id: 'file', fileName: 'empty.bin', size },
    ports: [port]
  });
  const send = (data: unknown) => port.onmessage({ data });
  const fetch = () => {
    let response: Response | undefined;
    listeners.get('fetch')!({
      request: new Request('https://download.test/__mar_direct_download__/file'),
      respondWith: (value: Response) => {
        response = value;
      }
    });
    return response!;
  };
  return { port, send, fetch };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('direct download Service Worker stream lifecycle', () => {
  it('retains close received before fetch and releases the empty stream and registration', async () => {
    const worker = fixture();
    worker.send({ type: 'close' });
    const response = worker.fetch();
    const reader = response.body!.getReader();
    try {
      await expect(Promise.race([reader.read(), Promise.resolve('still-open')])).resolves.toEqual({
        done: true,
        value: undefined
      });
      expect(worker.port.postMessage).toHaveBeenCalledWith({ type: 'finished' });
      expect(worker.port.postMessage).not.toHaveBeenCalledWith({ type: 'pull' });
      expect(worker.port.close).toHaveBeenCalledOnce();
      expect(worker.fetch().status).toBe(410);
    } finally {
      await reader.cancel();
    }
  });

  it('closes a normal empty download after fetch without a body chunk', async () => {
    const worker = fixture();
    const response = worker.fetch();
    expect(worker.port.postMessage).toHaveBeenCalledWith({ type: 'pull' });
    worker.send({ type: 'close' });
    expect((await response.arrayBuffer()).byteLength).toBe(0);
    expect(response.headers.get('content-length')).toBe('0');
    expect(worker.port.close).toHaveBeenCalledOnce();
  });

  it('keeps nonempty chunks ordered and bounded by pull credit', async () => {
    const worker = fixture(3);
    const reader = worker.fetch().body!.getReader();
    worker.send({ type: 'chunk', bytes: new Uint8Array([1, 2, 3]).buffer });
    expect(await reader.read()).toEqual({ done: false, value: new Uint8Array([1, 2, 3]) });
    worker.send({ type: 'close' });
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(worker.port.close).toHaveBeenCalledOnce();
  });

  it('allows abort to discard a pending early close before fetch', () => {
    const worker = fixture();
    worker.send({ type: 'close' });
    worker.send({ type: 'abort' });
    expect(worker.fetch().status).toBe(410);
    expect(worker.port.close).toHaveBeenCalledOnce();
    expect(worker.port.postMessage).not.toHaveBeenCalledWith({ type: 'finished' });
  });

  it('rejects a nonempty chunk sent without remaining pull credit', async () => {
    const worker = fixture(6);
    const response = worker.fetch();
    worker.send({ type: 'chunk', bytes: new Uint8Array([1, 2, 3]).buffer });
    worker.send({ type: 'chunk', bytes: new Uint8Array([4, 5, 6]).buffer });
    await expect(response.arrayBuffer()).rejects.toThrow('Unexpected direct download chunk');
    expect(worker.port.close).toHaveBeenCalledOnce();
  });

  it('propagates browser cancellation and closes the active port once', async () => {
    const worker = fixture(3);
    await worker.fetch().body!.cancel();
    expect(worker.port.postMessage).toHaveBeenCalledWith({
      type: 'cancel',
      reason: 'DIRECT_DOWNLOAD_CANCELLED'
    });
    worker.send({ type: 'close' });
    expect(worker.port.close).toHaveBeenCalledOnce();
  });

  it('expires an unfetched early close and cleans up its registration', () => {
    vi.useFakeTimers();
    const worker = fixture();
    worker.send({ type: 'close' });
    vi.advanceTimersByTime(60_000);
    expect(worker.fetch().status).toBe(410);
    expect(worker.port.postMessage).toHaveBeenCalledWith({
      type: 'cancel',
      reason: 'DIRECT_DOWNLOAD_NOT_STARTED'
    });
    expect(worker.port.close).toHaveBeenCalledOnce();
  });
});
