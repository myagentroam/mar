import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadNodeConfig, nodeDatabasePath } from './config.js';
import { nodeLog, platformCliInvocation } from './operational.js';
import { nodeUpgradeRequestPath } from './service/node-upgrade-coordinator.js';
import { safeErrorCode } from './util/safe-error.js';
import { NODE_OWNER_CONFLICT_EXIT_CODE } from './node-process-lock.js';
import { runSupervisedNodeChild } from './service/supervised-node-child.js';
import { NodeUpgradeReporter } from './service/node-upgrade-reporter.js';
import { terminateProcessTree } from './process-tree.js';

const UPGRADE_EXIT_CODE = 75;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export async function superviseNode(
  configPath: string,
  bootstrapEntrypoint: string
): Promise<void> {
  const config = await loadNodeConfig(configPath);
  const dataDirectory = dirname(nodeDatabasePath(config, configPath));
  const activePath = resolve(dataDirectory, 'node-active-entrypoint');
  let entrypoint = await readActiveEntrypoint(activePath, bootstrapEntrypoint);
  let reporter: NodeUpgradeReporter | undefined;
  let awaitingOnline: string | undefined;
  for (;;) {
    const requestPath = nodeUpgradeRequestPath(nodeDatabasePath(config, configPath));
    let reportingIdentity: { serverUrl: string; nodeId: string } | undefined;
    const childResult = await runSupervisedNodeChild(
      entrypoint,
      configPath,
      async (handoff) => {
        const currentConfig = await loadNodeConfig(configPath);
        if (
          currentConfig.nodeId === undefined ||
          !STABLE_VERSION.test(handoff.targetVersion) ||
          !/^[0-9a-f-]{36}$/u.test(handoff.attemptId) ||
          !/^[A-Za-z0-9_-]{43}$/u.test(handoff.credential)
        )
          return false;
        const request = JSON.parse(await readFile(requestPath, 'utf8')) as Record<string, unknown>;
        const matches =
          request['schemaVersion'] === 1 &&
          request['attemptId'] === handoff.attemptId &&
          request['targetVersion'] === handoff.targetVersion;
        if (matches)
          reportingIdentity = { serverUrl: currentConfig.serverUrl, nodeId: currentConfig.nodeId };
        return matches;
      },
      (handoff) => {
        if (reportingIdentity === undefined) throw new Error('NODE_UPGRADE_HANDOFF_UNAVAILABLE');
        const next = new NodeUpgradeReporter(
          reportingIdentity.serverUrl,
          reportingIdentity.nodeId,
          handoff.credential
        );
        reporter?.stop();
        reporter = next;
        next.update({ attemptId: handoff.attemptId, step: 'CLOSING_NODE' });
      },
      awaitingOnline
    );
    if (childResult.signalled) {
      reporter?.stop();
      process.exitCode = childResult.code ?? 1;
      return;
    }
    if (childResult.reclaimFailed) {
      if (childResult.handoff !== undefined)
        await reporter?.finish({
          attemptId: childResult.handoff.attemptId,
          step: 'CLOSING_NODE',
          result: 'FAILED',
          failure: {
            code: 'NODE_UPGRADE_RECLAIM_FAILED',
            message: 'The old Node process could not be stopped.',
            step: 'CLOSING_NODE',
            kind: 'INSTALL'
          }
        });
      process.exitCode = 1;
      return;
    }
    if (childResult.forced)
      nodeLog('node.supervisor.upgrade-old-node-reclaimed', {
        code: 'NODE_UPGRADE_EXIT_TIMEOUT_RECLAIMED'
      });
    const code = childResult.code;
    if (
      childResult.handoff === undefined &&
      awaitingOnline !== undefined &&
      reporter !== undefined
    ) {
      await reporter.finish({
        attemptId: awaitingOnline,
        step: 'WAITING_FOR_ONLINE',
        result: 'FAILED',
        operationEnded: true,
        failure: {
          code: 'NODE_UPGRADE_START_FAILED',
          message: 'The upgraded Node process exited before reporting online.',
          step: 'WAITING_FOR_ONLINE',
          kind: 'START'
        }
      });
      reporter = undefined;
    }
    if (code === NODE_OWNER_CONFLICT_EXIT_CODE && childResult.handoff === undefined) {
      process.exitCode = code;
      return;
    }
    if (code !== UPGRADE_EXIT_CODE && childResult.handoff === undefined) {
      if (code === 0) return;
      nodeLog('node.supervisor.child-exited', { code });
      await delay(1_000);
      continue;
    }
    let stopping = false;
    let switched = false;
    let installReclaimFailed = false;
    let failureStage = 'VALIDATE_REQUEST';
    let failureExitCode: number | null | undefined;
    try {
      const request = JSON.parse(await readFile(requestPath, 'utf8')) as Record<string, unknown>;
      const targetVersion = request['targetVersion'];
      if (
        request['schemaVersion'] !== 1 ||
        typeof targetVersion !== 'string' ||
        !STABLE_VERSION.test(targetVersion)
      )
        throw new Error('NODE_UPGRADE_REQUEST_INVALID');
      const prefix = resolve(dataDirectory, 'node-versions', targetVersion);
      const installDeadline = Date.now() + 15 * 60_000;
      if (childResult.handoff !== undefined)
        reporter?.update({ attemptId: childResult.handoff.attemptId, step: 'INSTALLING' });
      failureStage = 'PREPARE_INSTALL_DIRECTORY';
      await rm(prefix, { recursive: true, force: true });
      await mkdir(prefix, { recursive: true, mode: 0o700 });
      const invocation = platformCliInvocation('npm', [
        'install',
        '--prefix',
        prefix,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        `@myagentroam/node@${targetVersion}`
      ]);
      failureStage = 'NPM_INSTALL';
      const installResult = await runProcess(
        invocation.command,
        invocation.args,
        false,
        installDeadline
      );
      failureExitCode = installResult.code;
      if (installResult.reclaimFailed) {
        installReclaimFailed = true;
        stopping = true;
        throw new Error('NODE_UPGRADE_INSTALL_RECLAIM_FAILED');
      }
      if (installResult.signalled) {
        stopping = true;
        throw new Error('NODE_UPGRADE_INSTALL_INTERRUPTED');
      }
      if (installResult.timedOut) throw new Error('NODE_UPGRADE_INSTALL_TIMEOUT');
      if (installResult.code !== 0) throw new Error('NODE_UPGRADE_INSTALL_FAILED');
      const rebuild = platformCliInvocation('npm', ['rebuild', '--prefix', prefix, 'node-pty']);
      failureStage = 'NATIVE_REBUILD';
      failureExitCode = undefined;
      const rebuildResult = await runProcess(rebuild.command, rebuild.args, false, installDeadline);
      failureExitCode = rebuildResult.code;
      if (rebuildResult.reclaimFailed) {
        installReclaimFailed = true;
        stopping = true;
        throw new Error('NODE_UPGRADE_INSTALL_RECLAIM_FAILED');
      }
      if (rebuildResult.signalled) {
        stopping = true;
        throw new Error('NODE_UPGRADE_INSTALL_INTERRUPTED');
      }
      if (rebuildResult.timedOut) throw new Error('NODE_UPGRADE_INSTALL_TIMEOUT');
      if (rebuildResult.code !== 0) throw new Error('NODE_UPGRADE_NATIVE_REBUILD_FAILED');
      failureStage = 'BROWSER_INSTALL';
      failureExitCode = undefined;
      const browserInstall = await runProcess(
        process.execPath,
        [
          resolve(
            prefix,
            'node_modules',
            '@myagentroam',
            'node',
            'scripts',
            'install-web-browser.mjs'
          )
        ],
        true,
        installDeadline
      );
      failureExitCode = browserInstall.code;
      if (browserInstall.reclaimFailed) {
        installReclaimFailed = true;
        stopping = true;
        throw new Error('NODE_UPGRADE_INSTALL_RECLAIM_FAILED');
      }
      if (browserInstall.signalled) {
        stopping = true;
        throw new Error('NODE_UPGRADE_INSTALL_INTERRUPTED');
      }
      if (browserInstall.timedOut) throw new Error('NODE_UPGRADE_INSTALL_TIMEOUT');
      if (browserInstall.code !== 0) throw new Error('NODE_UPGRADE_BROWSER_INSTALL_FAILED');
      failureStage = 'ENTRYPOINT_SWITCH';
      failureExitCode = undefined;
      const nextEntrypoint = resolve(
        prefix,
        'node_modules',
        '@myagentroam',
        'node',
        'dist',
        'main.js'
      );
      await access(nextEntrypoint);
      await writeAtomic(activePath, `${nextEntrypoint}\n`);
      entrypoint = nextEntrypoint;
      switched = true;
      if (childResult.handoff !== undefined) {
        awaitingOnline = childResult.handoff.attemptId;
        reporter?.update({
          attemptId: childResult.handoff.attemptId,
          step: 'WAITING_FOR_ONLINE',
          result: 'INSTALLED'
        });
      }
      await writeResult(dataDirectory, {
        state: 'SUCCEEDED',
        targetVersion,
        updatedAt: Date.now()
      });
    } catch (error) {
      if (switched) {
        nodeLog('node.supervisor.upgrade-result-write-failed', {
          code: 'NODE_UPGRADE_RESULT_WRITE_FAILED'
        });
      } else {
        if (childResult.handoff !== undefined)
          await reporter?.finish({
            attemptId: childResult.handoff.attemptId,
            step: 'INSTALLING',
            result: 'FAILED',
            ...(installReclaimFailed ? {} : { operationEnded: true }),
            failure: {
              code: safeErrorCode(error, 'NODE_UPGRADE_INSTALL_FAILED'),
              message: 'The Node upgrade could not be installed.',
              step: 'INSTALLING',
              kind: 'INSTALL',
              details: `Stage: ${failureStage}${failureExitCode == null ? '' : `; exit code: ${failureExitCode}`}`
            }
          });
        reporter = undefined;
        try {
          await writeResult(dataDirectory, {
            state: 'FAILED',
            errorCode: safeErrorCode(error, 'NODE_UPGRADE_INSTALL_FAILED'),
            updatedAt: Date.now()
          });
        } catch {
          nodeLog('node.supervisor.upgrade-result-write-failed', {
            code: 'NODE_UPGRADE_RESULT_WRITE_FAILED'
          });
        }
      }
    }
    try {
      await rm(requestPath, { force: true });
    } catch {
      nodeLog('node.supervisor.upgrade-request-cleanup-failed', {
        code: 'NODE_UPGRADE_REQUEST_CLEANUP_FAILED'
      });
    }
    if (stopping) return;
  }
}

async function runProcess(
  command: string,
  args: readonly string[],
  inherit: boolean,
  deadlineAt: number
): Promise<{
  readonly code: number | null;
  readonly signalled: boolean;
  readonly timedOut: boolean;
  readonly reclaimFailed: boolean;
}> {
  return new Promise((resolveProcess) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: inherit ? 'inherit' : 'ignore',
      env: process.env,
      detached: process.platform !== 'win32'
    });
    let settled = false;
    let signalled = false;
    let timedOut = false;
    let reclaimed = false;
    let exited: { code: number | null } | undefined;
    let reapDeadline: NodeJS.Timeout | undefined;
    const deadline = setTimeout(
      () => {
        timedOut = true;
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
      },
      Math.max(0, deadlineAt - Date.now())
    );
    const forward = (signal: NodeJS.Signals): void => {
      if (signalled) return;
      signalled = true;
      child.kill(signal);
    };
    const onSigint = (): void => forward('SIGINT');
    const onSigterm = (): void => forward('SIGTERM');
    const finish = (code: number | null, reclaimFailed = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (reapDeadline !== undefined) clearTimeout(reapDeadline);
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      if (reclaimFailed) child.unref();
      resolveProcess({ code, signalled, timedOut, reclaimFailed });
    };
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    child.on('error', () => {
      if (child.pid === undefined) finish(null);
    });
    child.once('exit', (code) => {
      exited = { code };
      if (!timedOut || reclaimed) finish(code);
    });
  });
}

async function readActiveEntrypoint(path: string, fallback: string): Promise<string> {
  try {
    const value = (await readFile(path, 'utf8')).trim();
    await access(value);
    return value;
  } catch {
    return fallback;
  }
}

async function writeResult(directory: string, result: Record<string, unknown>): Promise<void> {
  await writeAtomic(resolve(directory, 'upgrade-result.json'), `${JSON.stringify(result)}\n`);
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, path);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
