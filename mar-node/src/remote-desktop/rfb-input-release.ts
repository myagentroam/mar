import type { Writable } from 'node:stream';
import { RemoteDesktopError } from './desktop-error.js';
import type { RfbClientGate, RfbInputSnapshot } from './rfb-client-gate.js';

/** Sends this attachment's held inputs up before closing an unmodified RFB backend.
 * A successful write is not native cleanup confirmation; the caller must obtain it separately.
 */
export async function submitRfbInputRelease(
  gate: RfbClientGate,
  target: Writable,
  signal: AbortSignal
): Promise<void> {
  const snapshot = await abortable(gate.fence(), signal);
  const bytes = releaseFrames(snapshot);
  if (!bytes.length) return;
  if (signal.aborted || target.destroyed || !target.writable)
    throw new RemoteDesktopError('DESKTOP_NATIVE_CLEANUP_FAILED');

  await new Promise<void>((resolve, reject) => {
    const onError = () => finish(new RemoteDesktopError('DESKTOP_NATIVE_CLEANUP_FAILED'));
    const onClose = () => finish(new RemoteDesktopError('DESKTOP_NATIVE_CLEANUP_FAILED'));
    const onAbort = () => finish(new RemoteDesktopError('DESKTOP_NATIVE_CLEANUP_TIMEOUT'));
    let finished = false;
    const finish = (error?: Error | null) => {
      if (finished) return;
      finished = true;
      target.off('error', onError);
      target.off('close', onClose);
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    target.once('error', onError);
    target.once('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      target.write(bytes, (error) =>
        finish(error ? new RemoteDesktopError('DESKTOP_NATIVE_CLEANUP_FAILED') : undefined)
      );
    } catch {
      finish(new RemoteDesktopError('DESKTOP_NATIVE_CLEANUP_FAILED'));
    }
  });
}

function releaseFrames(snapshot: RfbInputSnapshot): Buffer {
  // Release ordinary keys before modifiers so the backend interprets their
  // key-up events under the same modifiers as their key-down events.
  const modifier = (key: number) => key === 0xff7e || (key >= 0xffe1 && key <= 0xffee);
  const keys = [
    ...snapshot.keys.filter((key) => !modifier(key)),
    ...snapshot.keys.filter(modifier)
  ];
  const frames = keys.map((key) => {
    const frame = Buffer.alloc(8);
    frame[0] = 4;
    frame.writeUInt32BE(key, 4);
    return frame;
  });
  if (snapshot.buttons & 7) {
    const frame = Buffer.alloc(6);
    frame[0] = 5;
    frame.writeUInt16BE(snapshot.x, 2);
    frame.writeUInt16BE(snapshot.y, 4);
    frames.push(frame);
  }
  return Buffer.concat(frames);
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => {});
    throw new RemoteDesktopError('DESKTOP_NATIVE_CLEANUP_TIMEOUT');
  }
  return await new Promise<T>((resolve, reject) => {
    const abort = () =>
      finish(() => reject(new RemoteDesktopError('DESKTOP_NATIVE_CLEANUP_TIMEOUT')));
    const finish = (done: () => void) => {
      signal.removeEventListener('abort', abort);
      done();
    };
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error))
    );
  });
}
