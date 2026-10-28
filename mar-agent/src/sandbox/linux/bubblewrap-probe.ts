import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { BubblewrapSandboxExecutor } from './bubblewrap-sandbox-executor.js';
import { snapshotSandboxProfile } from './bubblewrap-policy.js';
import {
  LINUX_BUBBLEWRAP_SANDBOX_POLICY_VERSION,
  type BubblewrapSandboxExecutorOptions
} from './profile.js';
import { policyInvalid, unavailable, withCleanupDiagnostics } from './sandbox-error.js';
import { terminateSandboxChild } from './sandbox-process.js';

const DEFAULT_BUBBLEWRAP_PATH = '/usr/bin/bwrap';

export async function probeBubblewrapSandbox(
  options: {
    readonly bubblewrapPath?: string;
    readonly profile?: BubblewrapSandboxExecutorOptions['profile'];
    readonly cwd?: string;
  } = {}
): Promise<{ readonly version: string; readonly policyVersion: number }> {
  if (process.platform !== 'linux') throw unavailable();
  let bubblewrapPath: string;
  let cwd: string;
  let profile: BubblewrapSandboxExecutorOptions['profile'];
  try {
    bubblewrapPath = options.bubblewrapPath ?? DEFAULT_BUBBLEWRAP_PATH;
    cwd = options.cwd ?? '/';
    profile = snapshotSandboxProfile(
      options.profile ?? {
        policyVersion: LINUX_BUBBLEWRAP_SANDBOX_POLICY_VERSION
      }
    );
  } catch {
    throw policyInvalid();
  }
  const versionOutput = await probeVersion(bubblewrapPath);
  const version = /^bubblewrap\s+([0-9]+(?:\.[0-9]+){1,3})\s*$/u.exec(versionOutput)?.[1];
  if (version === undefined) throw unavailable();
  const executor = new BubblewrapSandboxExecutor({
    bubblewrapPath,
    profile
  });
  const child = await executor.spawn({
    command: '/bin/true',
    cwd,
    shell: false,
    environment: {},
    detached: true,
    owner: { sessionId: 'sandbox-probe', executionId: 'sandbox-probe' }
  });
  const result = await waitForProbe(child);
  if (result !== 0) throw unavailable();
  return { version, policyVersion: LINUX_BUBBLEWRAP_SANDBOX_POLICY_VERSION };
}

async function probeVersion(path: string): Promise<string> {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(path, ['--version'], {
      cwd: '/',
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      windowsHide: true,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }
    });
  } catch {
    throw unavailable();
  }
  const chunks: Buffer[] = [];
  let length = 0;
  const onData = (chunk: Buffer) => {
    length += chunk.length;
    if (length <= 4_096) chunks.push(chunk);
  };
  child.stdout.on('data', onData);
  try {
    const result = await waitForProbe(child);
    if (result !== 0 || length > 4_096) throw unavailable();
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    child.stdout.off('data', onData);
  }
}

export async function waitForProbe(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  child.stdout.resume();
  child.stderr.resume();
  child.stdin.end();
  return await new Promise((resolve, reject) => {
    let failed = false;
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const cleanupFailures: ('terminate' | 'exit_timeout')[] = [];
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (deadline !== undefined) clearTimeout(deadline);
      child.off('error', onError);
      child.off('close', onClose);
      if (failed) reject(withCleanupDiagnostics(unavailable(), cleanupFailures));
      else resolve(code);
    };
    const stop = () => {
      if (failed || settled) return;
      failed = true;
      deadline = setTimeout(() => {
        cleanupFailures.push('exit_timeout');
        for (const release of [
          () => child.stdin.destroy(),
          () => child.stdout.destroy(),
          () => child.stderr.destroy(),
          () => child.unref()
        ]) {
          try {
            release();
          } catch {
            cleanupFailures.push('terminate');
          }
        }
        child.on('error', () => {});
        finish(null);
      }, 1_000);
      try {
        if (!terminateSandboxChild(child, true)) cleanupFailures.push('terminate');
      } catch {
        cleanupFailures.push('terminate');
      }
    };
    const timer = setTimeout(() => {
      stop();
    }, 5_000);
    timer.unref();
    const onError = () => stop();
    const onClose = (code: number | null) => {
      if (!failed) {
        try {
          if (!terminateSandboxChild(child, true)) {
            failed = true;
            cleanupFailures.push('terminate');
          }
        } catch {
          failed = true;
          cleanupFailures.push('terminate');
        }
      }
      finish(code);
    };
    child.on('error', onError);
    child.once('close', onClose);
  });
}
