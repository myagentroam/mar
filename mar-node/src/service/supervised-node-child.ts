import { spawn, type ChildProcess } from 'node:child_process';
import { terminateProcessTree } from '../process-tree.js';

export interface SupervisorHandoff {
  readonly attemptId: string;
  readonly targetVersion: string;
  readonly credential: string;
}

export interface SupervisedChildResult {
  readonly code: number | null;
  readonly signalled: boolean;
  readonly handoff?: SupervisorHandoff;
  readonly forced?: boolean;
  readonly reclaimFailed?: boolean;
}

/** Wait for the child process itself, not inherited output handles held by descendants. */
export function runSupervisedNodeChild(
  entrypoint: string,
  configPath: string,
  accept: (handoff: SupervisorHandoff) => Promise<boolean>,
  accepted: (handoff: SupervisorHandoff) => void,
  upgradeAttemptId?: string,
  stopSignal?: AbortSignal
): Promise<SupervisedChildResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entrypoint, 'run', '--config', configPath], {
      windowsHide: true,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: {
        ...process.env,
        MAR_NODE_SUPERVISED: process.env['MAR_QUICK_START_OWNER'] === '1' ? '0' : '1',
        ...(upgradeAttemptId === undefined ? {} : { MAR_NODE_UPGRADE_ATTEMPT_ID: upgradeAttemptId })
      },
      detached: process.platform !== 'win32'
    });
    if (
      process.env['MAR_QUICK_START_OWNER'] === '1' &&
      child.pid !== undefined &&
      process.connected
    )
      process.send?.({ type: 'node-quick-start-child', pid: child.pid }, () => {});
    let done = false;
    let signalled = false;
    let channelId: string | undefined;
    let accepting = false;
    let handoff: SupervisorHandoff | undefined;
    let forced = false;
    let reclaiming = false;
    let reclaimed = false;
    let exited: { code: number | null } | undefined;
    let deadline: NodeJS.Timeout | undefined;
    let reapDeadline: NodeJS.Timeout | undefined;
    const finish = (code: number | null, reclaimFailed = false): void => {
      if (done) return;
      done = true;
      if (deadline !== undefined) clearTimeout(deadline);
      if (reapDeadline !== undefined) clearTimeout(reapDeadline);
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      stopSignal?.removeEventListener('abort', onQuickStop);
      if (child.connected) child.disconnect();
      if (reclaimFailed) child.unref();
      resolve({
        code,
        signalled,
        ...(handoff === undefined ? {} : { handoff }),
        ...(forced ? { forced: true } : {}),
        ...(reclaimFailed ? { reclaimFailed: true } : {})
      });
    };
    const forward = (signal: NodeJS.Signals): void => {
      if (signalled) return;
      signalled = true;
      child.kill(signal);
    };
    const onSigint = (): void => forward('SIGINT');
    const onSigterm = (): void => forward('SIGTERM');
    const onQuickStop = (): void => {
      if (done || signalled) return;
      signalled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      send(child, { type: 'node-quick-start-stop' });
      deadline = setTimeout(() => {
        forced = true;
        reclaiming = true;
        reapDeadline = setTimeout(() => finish(null, true), 10_000);
        void terminateProcessTree(child)
          .then(() => {
            reclaimed = true;
            if (exited !== undefined) finish(exited.code);
          })
          .catch(() => finish(null, true));
        if (process.platform !== 'win32' && child.pid !== undefined) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }
      }, 30_000);
    };
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    stopSignal?.addEventListener('abort', onQuickStop, { once: true });
    if (stopSignal?.aborted) onQuickStop();
    child.on('error', () => {
      if (child.pid === undefined) finish(null);
    });
    child.once('exit', (code) => {
      if (
        process.env['MAR_QUICK_START_OWNER'] === '1' &&
        child.pid !== undefined &&
        process.connected
      )
        process.send?.({ type: 'node-quick-start-child-exited', pid: child.pid }, () => {});
      exited = { code };
      if (!reclaiming || reclaimed) finish(code);
    });
    child.on('message', (message: unknown) => {
      if (done || typeof message !== 'object' || message === null) return;
      const value = message as Record<string, unknown>;
      if (signalled) {
        if (stopSignal?.aborted && value['type'] === 'node-upgrade-hello')
          send(child, { type: 'node-quick-start-stop' });
        return;
      }
      if (
        value['type'] === 'node-upgrade-hello' &&
        channelId === undefined &&
        typeof value['channelId'] === 'string'
      ) {
        channelId = value['channelId'];
        send(child, { type: 'node-upgrade-ready', channelId });
        return;
      }
      if (
        value['type'] !== 'node-upgrade-handoff' ||
        value['channelId'] !== channelId ||
        channelId === undefined ||
        accepting ||
        handoff !== undefined ||
        typeof value['id'] !== 'string' ||
        typeof value['attemptId'] !== 'string' ||
        typeof value['targetVersion'] !== 'string' ||
        typeof value['credential'] !== 'string'
      )
        return;
      const id = value['id'];
      const request = {
        attemptId: value['attemptId'],
        targetVersion: value['targetVersion'],
        credential: value['credential']
      };
      accepting = true;
      void accept(request)
        .then((ok) => {
          if (done || signalled) return;
          if (!ok) {
            accepting = false;
            send(child, { type: 'node-upgrade-ack', channelId, id, accepted: false });
            return;
          }
          accepted(request);
          handoff = request;
          deadline = setTimeout(() => {
            if (done || signalled) return;
            forced = true;
            reclaiming = true;
            reapDeadline = setTimeout(() => finish(null, true), 10_000);
            void terminateProcessTree(child)
              .then(() => {
                reclaimed = true;
                if (exited !== undefined) finish(exited.code);
              })
              .catch(() => finish(null, true));
            if (process.platform !== 'win32' && child.pid !== undefined) {
              try {
                process.kill(-child.pid, 'SIGKILL');
              } catch {
                try {
                  child.kill('SIGKILL');
                } catch {
                  /* Wait for exit or timeout. */
                }
              }
            }
          }, 25_000);
          send(child, { type: 'node-upgrade-ack', channelId, id, accepted: true });
        })
        .catch(() => {
          accepting = false;
          if (!done && !signalled)
            send(child, { type: 'node-upgrade-ack', channelId, id, accepted: false });
        });
    });
  });
}

function send(child: ChildProcess, message: Record<string, string | boolean | undefined>): void {
  if (!child.connected) return;
  try {
    child.send(message, () => undefined);
  } catch {
    /* An absent ACK leaves the child blocked. */
  }
}
