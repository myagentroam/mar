import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { authPlugins } from 'mysql2';
import mysql, { type Connection } from 'mysql2/promise';
import type { MysqlInstallation, QuickStartConfig } from './config.js';

interface RunningMysql {
  readonly socket: string;
  readonly exited: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  stop(): Promise<void>;
}

/** Owns only the MySQL child and private socket created for this deployment invocation. */
export async function startManagedMysql(
  root: string,
  config: QuickStartConfig,
  options: { readonly socketOnly?: boolean } = {}
): Promise<RunningMysql> {
  const installation = config.mysql.installation;
  if (!installation) throw new Error('QUICK_START_MYSQL_NOT_INSTALLED');
  if (
    !['linux', 'win32'].includes(process.platform) ||
    process.arch !== 'x64' ||
    installation.platform !== process.platform ||
    installation.arch !== process.arch
  )
    throw new Error('QUICK_START_MYSQL_PLATFORM_UNSUPPORTED');
  await assertDataOwnership(root, config.deploymentId);
  const socketDirectory = await mkdtemp(join(tmpdir(), 'mar-mysql-'));
  const pipeName = `mar-mysql-${randomBytes(16).toString('hex')}`;
  const socket =
    process.platform === 'win32' ? `\\\\.\\pipe\\${pipeName}` : join(socketDirectory, 'mysql.sock');
  const args = mysqlArguments(
    root,
    installation,
    process.platform === 'win32' ? pipeName : socket,
    join(socketDirectory, 'mysql.pid')
  );
  if (process.platform === 'win32') args.push('--no-monitor', '--enable-named-pipe');
  if (options.socketOnly) args.push('--skip-networking');
  else args.push('--bind-address=127.0.0.1', `--port=${config.mysql.port}`);
  let child: ChildProcess;
  try {
    child = spawn(
      resolve(
        root,
        installation.directory,
        process.platform === 'win32' ? 'bin/mysqld.exe' : 'bin/mysqld'
      ),
      args,
      {
        env: mysqlEnvironment(root, installation),
        stdio: 'ignore',
        windowsHide: true
      }
    );
  } catch (error) {
    await rm(socketDirectory, { recursive: true, force: true });
    throw error;
  }
  let hasExited = false;
  let signalFailure: () => void = () => undefined;
  const failedSignal = new Promise<'signal-error'>((done) => {
    signalFailure = () => done('signal-error');
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => {
      child.on('error', () => {
        if (child.pid === undefined) {
          hasExited = true;
          resolveExit({ code: null, signal: null });
        } else signalFailure();
      });
      child.once('exit', (code, signal) => {
        hasExited = true;
        resolveExit({ code, signal });
      });
    }
  );
  const forceStop = async (): Promise<never> => {
    try {
      if (!child.kill('SIGKILL') && !hasExited) throw new Error('QUICK_START_MYSQL_RECLAIM_FAILED');
    } catch {
      throw new Error('QUICK_START_MYSQL_RECLAIM_FAILED');
    }
    const result = await Promise.race([
      exited,
      failedSignal,
      delay(15_000, undefined, { ref: false }).then(() => undefined)
    ]);
    if (result === undefined || result === 'signal-error')
      throw new Error('QUICK_START_MYSQL_RECLAIM_FAILED');
    throw new Error('QUICK_START_MYSQL_FORCED_STOP');
  };
  let stopping: Promise<void> | undefined;
  return {
    socket,
    exited,
    stop: () =>
      (stopping ??= (async () => {
        try {
          if (child.exitCode === null && child.signalCode === null) {
            if (process.platform === 'win32') {
              let shutdown = false;
              for (const password of options.socketOnly
                ? [config.mysql.password, '']
                : [config.mysql.password]) {
                try {
                  const connection = await mysql.createConnection({
                    socketPath: socket,
                    user: 'root',
                    password,
                    ...managedPipeAuthentication(),
                    connectTimeout: 1500
                  });
                  try {
                    await connection.query('SHUTDOWN');
                  } catch {
                    /* MySQL may close the connection while shutting down. */
                  }
                  connection.destroy();
                  shutdown = true;
                  break;
                } catch {
                  /* Try the initial empty root password only during initialization. */
                }
              }
              if (!shutdown) {
                await forceStop();
              }
            } else {
              try {
                if (!child.kill('SIGTERM') && !hasExited) signalFailure();
              } catch {
                signalFailure();
              }
            }
          }
          const result = await Promise.race([
            exited,
            failedSignal,
            delay(15_000, undefined, { ref: false }).then(() => undefined)
          ]);
          if (result === 'signal-error') throw new Error('QUICK_START_MYSQL_RECLAIM_FAILED');
          if (result === undefined) {
            await forceStop();
          }
          if (result?.code !== 0) throw new Error('QUICK_START_MYSQL_STOP_FAILED');
        } finally {
          if (hasExited) await rm(socketDirectory, { recursive: true, force: true });
        }
      })())
  };
}

export async function initializeManagedMysql(
  root: string,
  config: QuickStartConfig,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted();
  const installation = config.mysql.installation;
  if (!installation) throw new Error('QUICK_START_MYSQL_NOT_INSTALLED');
  const data = resolve(root, 'mysql-data');
  const owner = resolve(root, 'mysql-data.owner');
  let fresh = false;
  try {
    await mkdir(data, { mode: 0o700 });
    try {
      await writeFile(owner, `${config.deploymentId}\n`, { flag: 'wx', mode: 0o600 });
      fresh = true;
    } catch (error) {
      await rmdir(data);
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    await assertDataOwnership(root, config.deploymentId);
  }
  if (fresh) {
    try {
      signal?.throwIfAborted();
      const binary = resolve(
        root,
        installation.directory,
        process.platform === 'win32' ? 'bin/mysqld.exe' : 'bin/mysqld'
      );
      const child = spawn(
        binary,
        [
          '--no-defaults',
          '--mysqlx=0',
          ...(process.platform === 'win32' ? ['--no-monitor'] : []),
          '--initialize-insecure',
          `--basedir=${resolve(root, installation.directory)}`,
          `--datadir=${data}`,
          `--log-error=${resolve(root, 'mysql-init.log')}`
        ],
        { env: mysqlEnvironment(root, installation), stdio: 'ignore', windowsHide: true }
      );
      let force: NodeJS.Timeout | undefined;
      let deadline: NodeJS.Timeout | undefined;
      let forced = false;
      let reclaimFailed = false;
      let finish: (value: number | null) => void = () => undefined;
      const failedReclaim = () => {
        reclaimFailed = true;
        finish(null);
      };
      const cancel = () => {
        if (process.platform === 'win32') forced = true;
        try {
          if (!child.kill('SIGTERM')) return failedReclaim();
        } catch {
          return failedReclaim();
        }
        force ??= setTimeout(() => {
          forced = true;
          try {
            if (!child.kill('SIGKILL')) return failedReclaim();
          } catch {
            return failedReclaim();
          }
          deadline = setTimeout(failedReclaim, 15_000).unref();
        }, 15_000).unref();
      };
      const code = await new Promise<number | null>((done) => {
        finish = done;
        child.on('error', () => {
          if (child.pid === undefined) done(null);
          else if (signal?.aborted) failedReclaim();
        });
        child.once('exit', (value) => done(value));
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
      }).finally(() => {
        signal?.removeEventListener('abort', cancel);
        if (force) clearTimeout(force);
        if (deadline) clearTimeout(deadline);
      });
      if (reclaimFailed) throw new Error('QUICK_START_MYSQL_RECLAIM_FAILED');
      if (forced) throw new Error('QUICK_START_MYSQL_FORCED_STOP');
      signal?.throwIfAborted();
      if (code !== 0) throw new Error('QUICK_START_MYSQL_INITIALIZATION_FAILED');
    } catch (error) {
      if (!(error instanceof Error && error.message === 'QUICK_START_MYSQL_RECLAIM_FAILED')) {
        await rm(data, { recursive: true, force: true });
        await unlink(owner);
      }
      throw error;
    }
  }
  signal?.throwIfAborted();
  const managedMysql = await startManagedMysql(root, config, { socketOnly: true });
  let connection: Connection | undefined;
  try {
    connection = await waitForMysql(managedMysql, 'root', [config.mysql.password, ''], signal);
    signal?.throwIfAborted();
    await connection.query(
      'CREATE DATABASE IF NOT EXISTS `mar` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci'
    );
    await connection.query("CREATE USER IF NOT EXISTS 'mar'@'localhost' IDENTIFIED BY ?", [
      config.mysql.password
    ]);
    await connection.query("ALTER USER 'mar'@'localhost' IDENTIFIED BY ?", [config.mysql.password]);
    await connection.query("GRANT ALL PRIVILEGES ON `mar`.* TO 'mar'@'localhost'");
    await connection.query("ALTER USER 'root'@'localhost' IDENTIFIED BY ?", [
      config.mysql.password
    ]);
  } finally {
    try {
      await connection?.end();
    } finally {
      await managedMysql.stop();
    }
  }
}

async function assertDataOwnership(root: string, deploymentId: string): Promise<void> {
  const data = await lstat(resolve(root, 'mysql-data')).catch(() => undefined);
  const identity = await readFile(resolve(root, 'mysql-data.owner'), 'utf8').catch(() => '');
  if (!data?.isDirectory() || identity !== `${deploymentId}\n`)
    throw new Error('QUICK_START_MYSQL_DATA_NOT_OWNED');
}

export async function waitForMysql(
  process: RunningMysql,
  user: string,
  passwords: readonly string[],
  signal?: AbortSignal
): Promise<Connection> {
  let hasExited = false;
  void process.exited.then(() => {
    hasExited = true;
  });
  for (let attempt = 0; attempt < 80 && !hasExited; attempt += 1) {
    signal?.throwIfAborted();
    for (const password of passwords) {
      try {
        return await mysql.createConnection({
          socketPath: process.socket,
          user,
          password,
          ...managedPipeAuthentication(),
          connectTimeout: 500
        });
      } catch {
        /* The owned server may still be starting. */
      }
    }
    await delay(250);
  }
  throw new Error('QUICK_START_MYSQL_NOT_READY');
}

/** Windows named pipes do not qualify as secure transport for MySQL full authentication. */
function managedPipeAuthentication() {
  return process.platform === 'win32'
    ? {
        authPlugins: {
          caching_sha2_password: authPlugins.caching_sha2_password({ overrideIsSecure: false })
        }
      }
    : {};
}

function mysqlArguments(
  root: string,
  installation: MysqlInstallation,
  socket: string,
  pidFile: string
): string[] {
  return [
    '--no-defaults',
    '--mysqlx=0',
    `--basedir=${resolve(root, installation.directory)}`,
    `--datadir=${resolve(root, 'mysql-data')}`,
    `--socket=${socket}`,
    `--pid-file=${pidFile}`,
    `--log-error=${resolve(root, 'mysql.log')}`
  ];
}

function mysqlEnvironment(root: string, installation: MysqlInstallation): NodeJS.ProcessEnv {
  return process.platform === 'win32'
    ? { ...process.env }
    : { ...process.env, LD_LIBRARY_PATH: resolve(root, installation.libraryDirectory) };
}
