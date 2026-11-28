import { fork } from 'node:child_process';
import { once } from 'node:events';
import { MarctlError } from './errors.mjs';

/** Owns only startup. Once acknowledged, the child owns the lease without the parent. */
export async function startBackgroundTcpForward({ nodeId, forward, env, signal, translate }) {
  signal.throwIfAborted();
  const child = fork(
    new URL('./tcp-forward-worker.mjs', import.meta.url),
    [nodeId, JSON.stringify(forward)],
    {
      env,
      execArgv: [],
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    }
  );
  const disconnected = new AbortController();
  child.once('disconnect', () => disconnected.abort());
  let started = false;
  let code;
  try {
    const [reply] = await once(child, 'message', {
      signal: AbortSignal.any([signal, disconnected.signal])
    });
    signal.throwIfAborted();
    if (reply?.ready === true) {
      started = true;
      return child.pid;
    }
    code = reply?.code;
  } catch (error) {
    if (signal.aborted) throw error;
  } finally {
    if (!started) child.kill('SIGTERM');
    child.unref();
  }
  throw new MarctlError(translate('errors.tcpForwardFailed'), {
    code: code ?? 'TCP_FORWARD_BACKGROUND_FAILED'
  });
}
