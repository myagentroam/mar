import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { PooledDesktopAttachment } from '../../src/remote-desktop/pooled-desktop-attachment.js';
import { TigerVncBackendPool } from '../../src/remote-desktop/tigervnc-backend-pool.js';
import type { RemoteDesktopAttachment } from '../../src/remote-desktop/remote-desktop-attachment.js';
import type { TigerVncManagedProcess } from '../../src/remote-desktop/tigervnc-managed-process.js';

function fixture() {
  const stop = vi.fn(async () => {});
  const backend = { stop } as unknown as TigerVncManagedProcess;
  const start = vi.fn(async () => backend);
  const pool = new TigerVncBackendPool(start, vi.fn());
  const frontend = new PassThrough();
  const open = vi.fn(async (_signal: AbortSignal) => {});
  const close = vi.fn(async (_signal: AbortSignal) => {});
  const attachment = { open, close } as unknown as RemoteDesktopAttachment;
  const create = vi.fn(() => attachment);
  return {
    pool,
    frontend,
    start,
    stop,
    open,
    close,
    create,
    wrapper: new PooledDesktopAttachment(pool, frontend, create)
  };
}

describe('pooled Remote attachment', () => {
  it('starts lazily and stops the backend only after native cleanup', async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    expect(f.start).not.toHaveBeenCalled();
    await f.wrapper.open(signal);
    expect(f.start).toHaveBeenCalledOnce();
    f.close.mockImplementationOnce(async () => {
      expect(f.stop).not.toHaveBeenCalled();
    });
    await f.wrapper.close(signal);
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.stop).toHaveBeenCalledOnce();
  });

  it('keeps the backend reference when cleanup fails, and retries the same owner', async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    await f.wrapper.open(signal);
    f.close.mockRejectedValueOnce(new Error('receipt missing'));
    await expect(f.wrapper.close(signal)).rejects.toThrow('receipt missing');
    expect(f.stop).not.toHaveBeenCalled();
    await f.wrapper.close(signal);
    expect(f.close).toHaveBeenCalledTimes(2);
    expect(f.stop).toHaveBeenCalledOnce();
  });

  it('fences the frontend while backend startup is pending and stops a late backend', async () => {
    const f = fixture();
    let finish!: (backend: TigerVncManagedProcess) => void;
    f.start.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const signal = new AbortController().signal;
    const opening = f.wrapper.open(signal);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
    const closing = f.wrapper.close(signal);
    expect(f.frontend.destroyed).toBe(true);
    finish({ stop: f.stop } as unknown as TigerVncManagedProcess);
    await expect(opening).rejects.toMatchObject({ code: 'DESKTOP_SETUP_CANCELLED' });
    await closing;
    expect(f.create).not.toHaveBeenCalled();
    expect(f.stop).toHaveBeenCalledOnce();
  });
});
