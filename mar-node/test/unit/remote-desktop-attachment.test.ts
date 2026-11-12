import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteDesktopError } from '../../src/remote-desktop/desktop-error.js';
import { RemoteDesktopAttachment } from '../../src/remote-desktop/remote-desktop-attachment.js';
import {
  TigerVncRfbSession,
  TigerVncSetupCleanupError,
  type TigerVncRfbSessionOptions
} from '../../src/remote-desktop/tigervnc-rfb-session.js';
import type { StandardRfbAttachment } from '../../src/remote-desktop/standard-rfb-attachment.js';

afterEach(() => vi.restoreAllMocks());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

function fixture(mode: 'VIEW' | 'CONTROL') {
  const cleanup = vi.fn(async (_signal: AbortSignal) => {});
  const fence = vi.fn();
  const session = { close: cleanup, fence } as unknown as TigerVncRfbSession;
  const open = vi.spyOn(TigerVncRfbSession, 'open').mockResolvedValue(session);
  const failed = vi.fn();
  const options = {
    attachmentId: 'remote-1',
    mode,
    frontend: new PassThrough(),
    backend: {} as TigerVncRfbSessionOptions['backend'],
    maxPixels: 1_000_000,
    isCurrentTopology: () => true,
    onAttached: vi.fn(),
    onFailure: failed
  };
  return {
    attachment: new RemoteDesktopAttachment(options),
    options,
    cleanup,
    fence,
    open,
    failed
  };
}

describe('Remote Desktop attachment control lifecycle', () => {
  it('allows independent VIEW and CONTROL attachments', async () => {
    const f = fixture('VIEW');
    await f.attachment.open(AbortSignal.timeout(5_000));
    const control = new RemoteDesktopAttachment({ ...f.options, mode: 'CONTROL' });
    await control.open(AbortSignal.timeout(5_000));
    await f.attachment.close(AbortSignal.timeout(5_000));
    expect(f.open.mock.calls[1]![0].isControlOwner()).toBe(true);
    await control.close(AbortSignal.timeout(5_000));
  });

  it('fences this attachment while its native cleanup finishes', async () => {
    const f = fixture('CONTROL');
    const receipt = deferred();
    f.cleanup.mockReturnValue(receipt.promise);
    await f.attachment.open(AbortSignal.timeout(5_000));
    const controlOptions = f.open.mock.calls[0]![0];
    expect(controlOptions.isControlOwner()).toBe(true);
    const closing = f.attachment.close(AbortSignal.timeout(5_000));
    expect(f.fence).toHaveBeenCalledOnce();
    expect(f.cleanup).not.toHaveBeenCalled();
    expect(controlOptions.isControlOwner()).toBe(false);
    receipt.resolve();
    await closing;
  });

  it('keeps cleanup retryable after native failure', async () => {
    const f = fixture('CONTROL');
    f.cleanup.mockRejectedValueOnce(new RemoteDesktopError('DESKTOP_NATIVE_CLEANUP_TIMEOUT'));
    await f.attachment.open(AbortSignal.timeout(5_000));
    await expect(f.attachment.close(AbortSignal.timeout(5_000))).rejects.toMatchObject({
      code: 'DESKTOP_NATIVE_CLEANUP_TIMEOUT'
    });
    await f.attachment.close(AbortSignal.timeout(5_000));
    expect(f.cleanup).toHaveBeenCalledTimes(2);
  });

  it('retains failed setup cleanup until its original owner confirms a retry', async () => {
    const f = fixture('CONTROL');
    const receipt = deferred();
    const native = { close: vi.fn(() => receipt.promise) } as unknown as StandardRfbAttachment;
    f.open.mockRejectedValueOnce(
      new TigerVncSetupCleanupError('DESKTOP_NATIVE_CLEANUP_TIMEOUT', native)
    );
    await expect(f.attachment.open(AbortSignal.timeout(5_000))).rejects.toMatchObject({
      code: 'DESKTOP_NATIVE_CLEANUP_TIMEOUT'
    });
    const closing = f.attachment.close(AbortSignal.timeout(5_000));
    receipt.resolve();
    await closing;
    expect(native.close).toHaveBeenCalledOnce();
  });

  it('fences the attachment before reporting a transport failure', async () => {
    const f = fixture('CONTROL');
    const receipt = deferred();
    f.cleanup.mockReturnValue(receipt.promise);
    await f.attachment.open(AbortSignal.timeout(5_000));
    const bridgeOptions = f.open.mock.calls[0]![0];
    f.failed.mockImplementation(() => expect(bridgeOptions.isControlOwner()).toBe(false));
    bridgeOptions.onFailure('DESKTOP_TRANSPORT_ERROR');
    expect(f.failed).toHaveBeenCalledOnce();
    receipt.resolve();
    await f.attachment.close(AbortSignal.timeout(5_000));
  });

  it('cannot start an attachment after close was requested', async () => {
    const f = fixture('CONTROL');
    const closing = f.attachment.close(AbortSignal.timeout(5_000));
    await expect(f.attachment.open(AbortSignal.timeout(5_000))).rejects.toMatchObject({
      code: 'DESKTOP_RFB_CLOSED'
    });
    await closing;
    expect(f.open).not.toHaveBeenCalled();
  });

  it('cancels in-flight setup', async () => {
    const f = fixture('CONTROL');
    f.open.mockImplementation(
      (_options, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new RemoteDesktopError('DESKTOP_SETUP_CANCELLED')),
            { once: true }
          );
        })
    );
    const opening = f.attachment.open(AbortSignal.timeout(5_000));
    const rejected = expect(opening).rejects.toMatchObject({ code: 'DESKTOP_SETUP_CANCELLED' });
    const closing = f.attachment.close(AbortSignal.timeout(5_000));
    await rejected;
    await closing;
  });

  it('waits for a late setup-cleanup retry before releasing a cancelled attachment', async () => {
    const f = fixture('CONTROL');
    const receipt = deferred();
    const native = { close: vi.fn(() => receipt.promise) } as unknown as StandardRfbAttachment;
    f.open.mockImplementation(
      (_options, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new TigerVncSetupCleanupError('DESKTOP_NATIVE_CLEANUP_TIMEOUT', native)),
            { once: true }
          );
        })
    );
    const opening = f.attachment.open(AbortSignal.timeout(5_000));
    const rejected = expect(opening).rejects.toMatchObject({
      code: 'DESKTOP_NATIVE_CLEANUP_TIMEOUT'
    });
    const closing = f.attachment.close(AbortSignal.timeout(5_000));
    await rejected;
    receipt.resolve();
    await closing;
    expect(native.close).toHaveBeenCalledOnce();
  });
});
