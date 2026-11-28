import { createServer } from 'node:net';
import { dirname } from 'node:path';
import { cliText } from '@myagentroam-enterprise/server-implementation/cli-locale';
import type { QuickStartArguments } from './arguments.js';
import { createLocalApplication } from './application.js';
import {
  createQuickStartConfig,
  type QuickStartConfig,
  readQuickStartConfig,
  resolveQuickStartConfigPath,
  selectQuickStartComponents,
  writeQuickStartConfig
} from './config.js';
import { acquireQuickStartLock } from './lock.js';
import { prepareMysqlInstallation } from './mysql-installation.js';
import { initializeManagedMysql, startManagedMysql, waitForMysql } from './mysql-runtime.js';
import {
  managedSearchSupported,
  newSearchInstallation,
  prepareSearchInstallation
} from './search-installation.js';
import { startManagedSearch } from './search-runtime.js';
import { searchSetupFailureCode } from './search-errors.js';

/** Owns Quick Start's deployment lock and orchestration; component modules own their processes. */
export async function setupQuickStart(
  args: Extract<QuickStartArguments, { command: 'setup' | 'run' }>
): Promise<void> {
  if (!args.reinstallSearxng && process.env['MAR_DATABASE_URL'])
    throw new Error('QUICK_START_EXTERNAL_DATABASE_UNSUPPORTED');
  const path = resolveQuickStartConfigPath(args.config);
  const root = dirname(path);
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('QUICK_START_CANCELLED'));
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  let release: (() => Promise<void>) | undefined;
  let releaseLock = true;
  try {
    release = await acquireQuickStartLock(root);
    controller.signal.throwIfAborted();
    let config = await readQuickStartConfig(path);
    if (args.reinstallSearxng) {
      if (config === undefined) throw new Error('QUICK_START_SETUP_REQUIRED');
      if (config.search.mode !== 'managed')
        throw new Error('QUICK_START_SEARCH_REINSTALL_REQUIRES_MANAGED');
      await setupManagedSearch(root, path, config, controller.signal, true);
      return;
    }
    if (config === undefined) {
      const serverPort = await freePort();
      let mysqlPort = await freePort();
      while (mysqlPort === serverPort) mysqlPort = await freePort();
      config = createQuickStartConfig({
        serverPort,
        mysqlPort,
        node: args.node !== false,
        search: args.searxng !== false && managedSearchSupported() ? 'managed' : 'disabled'
      });
      if (args.searxng !== false && !managedSearchSupported())
        console.log(cliText('quickSearchDisabled'));
    } else config = selectQuickStartComponents(config, args);
    await writeQuickStartConfig(path, config);
    controller.signal.throwIfAborted();
    const installation = await prepareMysqlInstallation(
      root,
      config.mysql.installation,
      controller.signal
    );
    config = { ...config, mysql: { ...config.mysql, installation } };
    await writeQuickStartConfig(path, config);
    controller.signal.throwIfAborted();
    await initializeManagedMysql(root, config, controller.signal);
    controller.signal.throwIfAborted();
    const mysql = await startManagedMysql(root, config);
    try {
      const connection = await waitForMysql(
        mysql,
        'mar',
        [config.mysql.password],
        controller.signal
      );
      await connection.end();
      controller.signal.throwIfAborted();
      const { app } = await createLocalApplication(root, config);
      try {
        await app.ready();
        controller.signal.throwIfAborted();
      } finally {
        await app.shutdown();
      }
    } finally {
      await mysql.stop();
    }
    controller.signal.throwIfAborted();
    if (config.search.mode === 'managed')
      await setupManagedSearch(root, path, config, controller.signal);
    controller.signal.throwIfAborted();
    console.log(cliText('quickSetupComplete', { path: root }));
  } catch (error) {
    if (
      error instanceof Error &&
      [
        'QUICK_START_NODE_RECLAIM_FAILED',
        'QUICK_START_SEARCH_RECLAIM_FAILED',
        'QUICK_START_MYSQL_RECLAIM_FAILED'
      ].includes(error.message)
    )
      releaseLock = false;
    throw error;
  } finally {
    try {
      if (releaseLock) await release?.();
    } finally {
      process.off('SIGINT', cancel);
      process.off('SIGTERM', cancel);
    }
  }
}

async function setupManagedSearch(
  root: string,
  path: string,
  config: QuickStartConfig,
  signal: AbortSignal,
  reinstall = false
): Promise<void> {
  const previous = config.search.installation;
  let upgrading = false;
  try {
    let port = previous?.port;
    if (port === undefined) {
      port = await freePort();
      while (port === config.serverPort || port === config.mysql.port) port = await freePort();
    }
    const current = newSearchInstallation(port, reinstall);
    upgrading = previous !== undefined && previous.version !== current.version;
    const installation = reinstall || upgrading ? current : (previous ?? current);
    await prepareSearchInstallation(
      root,
      config.deploymentId,
      installation,
      signal,
      installation === previous ? undefined : previous
    );
    signal.throwIfAborted();
    const search = await startManagedSearch(root, installation, config.deploymentId);
    let ready = false;
    try {
      ready = await search.ready(signal);
      if (!ready) throw new Error('QUICK_START_SEARCH_NOT_READY');
    } finally {
      await search.stop({ requireGracefulExit: ready });
    }
    // The persisted selection is the activation point. A failed check or stop keeps the old one.
    if (installation !== previous) {
      await writeQuickStartConfig(
        path,
        { ...config, search: { mode: 'managed', installation } },
        signal
      );
      if (reinstall) console.log(cliText('quickManagedSearchReinstalled'));
      else if (upgrading) console.log(cliText('quickManagedSearchUpgraded'));
    }
  } catch (error) {
    if (
      error instanceof Error &&
      ['QUICK_START_NODE_RECLAIM_FAILED', 'QUICK_START_SEARCH_RECLAIM_FAILED'].includes(
        error.message
      )
    )
      throw error;
    signal.throwIfAborted();
    const code = searchSetupFailureCode(error);
    if (reinstall) throw new Error(code);
    console.error(
      cliText(upgrading ? 'quickManagedSearchUpgradeFailure' : 'quickManagedSearchFailure', {
        code
      })
    );
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('QUICK_START_PORT_UNAVAILABLE');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return address.port;
}
