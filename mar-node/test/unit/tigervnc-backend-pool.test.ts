import { describe, expect, it, vi } from 'vitest';
import { TigerVncBackendPool } from '../../src/remote-desktop/tigervnc-backend-pool.js';
import type { TigerVncManagedProcess } from '../../src/remote-desktop/tigervnc-managed-process.js';

function fixture() {
  const stop = vi.fn(async () => {});
  const backend = { stop } as unknown as TigerVncManagedProcess;
  let failure = () => {};
  const start = vi.fn(async (_signal: AbortSignal, onFailure: () => void) => {
    failure = onFailure;
    return backend;
  });
  const onFailure = vi.fn();
  const pool = new TigerVncBackendPool(start, onFailure);
  return { backend, stop, start, pool, onFailure, fail: () => failure() };
}

describe('Remote-only TigerVNC backend ownership', () => {
  it('shares concurrent references and stops only after the last release', async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    const [a, b] = await Promise.all([f.pool.acquire(signal), f.pool.acquire(signal)]);
    expect(a.backend).toBe(b.backend);
    expect(f.start).toHaveBeenCalledOnce();
    await a.release();
    await a.release();
    expect(f.stop).not.toHaveBeenCalled();
    await b.release();
    expect(f.stop).toHaveBeenCalledOnce();
    const c = await f.pool.acquire(signal);
    expect(f.start).toHaveBeenCalledTimes(2);
    await c.release();
  });

  it('retains the last reference after a failed stop and refuses new acquisitions', async () => {
    const f = fixture();
    f.stop.mockRejectedValueOnce(new Error('private system detail'));
    const signal = new AbortController().signal;
    const ref = await f.pool.acquire(signal);
    await expect(ref.release()).rejects.toThrow();
    await expect(f.pool.acquire(signal)).rejects.toMatchObject({ code: 'DESKTOP_BACKEND_CLOSED' });
    await ref.release();
    expect(f.stop).toHaveBeenCalledTimes(2);
  });

  it('fences failure synchronously and does not restart until all references retire', async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    const ref = await f.pool.acquire(signal);
    expect(f.pool.isAvailable()).toBe(true);
    f.fail();
    f.fail();
    expect(f.pool.isAvailable()).toBe(false);
    expect(f.onFailure).toHaveBeenCalledOnce();
    await expect(f.pool.acquire(signal)).rejects.toMatchObject({ code: 'DESKTOP_BACKEND_CLOSED' });
    await ref.release();
    expect(f.pool.isAvailable()).toBe(true);
    const next = await f.pool.acquire(signal);
    expect(f.start).toHaveBeenCalledTimes(2);
    await next.release();
  });

  it('does not dispose live references and refuses new ones after disposal', async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    const ref = await f.pool.acquire(signal);
    await expect(f.pool.dispose()).rejects.toMatchObject({
      code: 'DESKTOP_NATIVE_ATTACHMENTS_ACTIVE'
    });
    await expect(f.pool.acquire(signal)).rejects.toMatchObject({ code: 'DESKTOP_BACKEND_CLOSED' });
    await ref.release();
    await f.pool.dispose();
    expect(f.stop).toHaveBeenCalledOnce();
  });

  it('stops a newly started backend if its initiating request was cancelled', async () => {
    const f = fixture();
    const controller = new AbortController();
    f.start.mockImplementationOnce(async () => {
      controller.abort();
      return f.backend;
    });
    await expect(f.pool.acquire(controller.signal)).rejects.toMatchObject({
      code: 'DESKTOP_SETUP_CANCELLED'
    });
    expect(f.stop).toHaveBeenCalledOnce();
  });
});
