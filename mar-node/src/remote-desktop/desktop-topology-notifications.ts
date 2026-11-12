import { spawn } from 'node:child_process';
import { RemoteDesktopError } from './desktop-error.js';

/** Owns one native display-notification process; it reports invalidation, never a cached layout. */
export async function startDesktopTopologyNotifications(
  options: {
    readonly binary: string;
    readonly args: readonly string[];
    readonly invalidate: () => void;
    readonly unavailable: () => void;
  },
  signal: AbortSignal
): Promise<{ isAvailable(): boolean; stop(): Promise<void> }> {
  if (signal.aborted) throw new RemoteDesktopError('DESKTOP_SETUP_CANCELLED');
  const child = spawn(options.binary, [...options.args], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  let available = false;
  let stopping = false;
  let exited = false;
  let buffer = '';
  let resolveReady!: () => void;
  let rejectReady!: (error: RemoteDesktopError) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const closed = new Promise<void>((resolve) => {
    child.once('close', () => {
      exited = true;
      if (!stopping) fail();
      resolve();
    });
  });
  function fail(): void {
    available = false;
    rejectReady(new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE'));
    if (!stopping) {
      stopping = true;
      options.unavailable();
      if (!exited) child.kill();
    }
  }
  const abort = () => fail();
  const timer = setTimeout(abort, 5_000);
  signal.addEventListener('abort', abort, { once: true });
  child.once('error', fail);
  child.stdout.on('data', (chunk: Buffer) => {
    if (stopping) return;
    buffer += chunk.toString('utf8');
    if (buffer.length > 4_096) return fail();
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trimEnd();
      buffer = buffer.slice(newline + 1);
      if (line === 'ready' && !available) {
        available = true;
        resolveReady();
      } else if (line === 'invalidated') options.invalidate();
      else return fail();
    }
  });
  const stop = () => {
    available = false;
    if (!stopping) {
      stopping = true;
      if (!exited) child.kill();
    }
    return closed;
  };
  try {
    await ready;
    return { isAvailable: () => available, stop };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}
