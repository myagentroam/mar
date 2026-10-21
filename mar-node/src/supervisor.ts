import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadNodeConfig, nodeDatabasePath } from './config.js';
import { nodeLog, platformCliInvocation } from './operational.js';
import { nodeUpgradeRequestPath } from './service/node-upgrade-coordinator.js';
import { safeErrorCode } from './util/safe-error.js';
import { NODE_OWNER_CONFLICT_EXIT_CODE } from './node-process-lock.js';

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
  for (;;) {
    const childResult = await runProcess(
      process.execPath,
      [entrypoint, 'run', '--config', configPath],
      true,
      { ...process.env, MAR_NODE_SUPERVISED: '1' }
    );
    if (childResult.signalled) {
      process.exitCode = childResult.code ?? 1;
      return;
    }
    const code = childResult.code;
    if (code === NODE_OWNER_CONFLICT_EXIT_CODE) {
      process.exitCode = code;
      return;
    }
    if (code !== UPGRADE_EXIT_CODE) {
      if (code === 0) return;
      nodeLog('node.supervisor.child-exited', { code });
      await delay(1_000);
      continue;
    }
    const requestPath = nodeUpgradeRequestPath(nodeDatabasePath(config, configPath));
    let stopping = false;
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
      const installResult = await runProcess(invocation.command, invocation.args, false);
      if (installResult.signalled) {
        stopping = true;
        throw new Error('NODE_UPGRADE_INSTALL_INTERRUPTED');
      }
      if (installResult.code !== 0) throw new Error('NODE_UPGRADE_INSTALL_FAILED');
      const rebuild = platformCliInvocation('npm', ['rebuild', '--prefix', prefix, 'node-pty']);
      const rebuildResult = await runProcess(rebuild.command, rebuild.args, false);
      if (rebuildResult.signalled) {
        stopping = true;
        throw new Error('NODE_UPGRADE_INSTALL_INTERRUPTED');
      }
      if (rebuildResult.code !== 0) throw new Error('NODE_UPGRADE_NATIVE_REBUILD_FAILED');
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
        true
      );
      if (browserInstall.signalled) {
        stopping = true;
        throw new Error('NODE_UPGRADE_INSTALL_INTERRUPTED');
      }
      if (browserInstall.code !== 0) throw new Error('NODE_UPGRADE_BROWSER_INSTALL_FAILED');
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
      await writeResult(dataDirectory, {
        state: 'SUCCEEDED',
        targetVersion,
        updatedAt: Date.now()
      });
      await rm(requestPath, { force: true });
      entrypoint = nextEntrypoint;
    } catch (error) {
      await writeResult(dataDirectory, {
        state: 'FAILED',
        errorCode: safeErrorCode(error, 'NODE_UPGRADE_INSTALL_FAILED'),
        updatedAt: Date.now()
      });
      await rm(requestPath, { force: true });
    }
    if (stopping) return;
  }
}

async function runProcess(
  command: string,
  args: readonly string[],
  inherit: boolean,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ readonly code: number | null; readonly signalled: boolean }> {
  return new Promise((resolveProcess) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: inherit ? 'inherit' : 'ignore',
      env
    });
    let settled = false;
    let signalled = false;
    const forward = (signal: NodeJS.Signals): void => {
      if (signalled) return;
      signalled = true;
      child.kill(signal);
    };
    const onSigint = (): void => forward('SIGINT');
    const onSigterm = (): void => forward('SIGTERM');
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      resolveProcess({ code, signalled });
    };
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    child.once('error', () => finish(null));
    child.once('close', finish);
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
