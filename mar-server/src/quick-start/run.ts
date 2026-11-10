import { cliText } from '@myagentroam-enterprise/server-implementation/cli-locale';
import { dirname } from 'node:path';
import type { QuickStartArguments } from './arguments.js';
import { createLocalApplication } from './application.js';
import { readQuickStartConfig, resolveQuickStartConfigPath } from './config.js';
import { acquireQuickStartLock } from './lock.js';
import { startManagedMysql, waitForMysql } from './mysql-runtime.js';
import { startLocalNode } from './node-runtime.js';
import { probeSearchEndpoint } from './search-probe.js';
import { startManagedSearch } from './search-runtime.js';

/** The foreground run owns its application, MySQL child and deployment exclusion. */
export async function runQuickStart(
  args: Extract<QuickStartArguments, { command: 'setup' | 'run' }>
): Promise<void> {
  if (process.env['MAR_DATABASE_URL']) throw new Error('QUICK_START_EXTERNAL_DATABASE_UNSUPPORTED');
  const path = resolveQuickStartConfigPath(args.config);
  const root = dirname(path);
  const release = await acquireQuickStartLock(root);
  let releaseLock = true;
  let interrupted = false;
  const startupAbort = new AbortController();
  let signalReceived!: () => void;
  const signal = new Promise<void>((resolve) => {
    signalReceived = resolve;
  });
  const onSignal = () => {
    interrupted = true;
    startupAbort.abort();
    signalReceived();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    const config = await readQuickStartConfig(path);
    if (!config) throw new Error('QUICK_START_SETUP_REQUIRED');
    const mysql = await startManagedMysql(root, config);
    try {
      let connection: Awaited<ReturnType<typeof waitForMysql>>;
      try {
        connection = await waitForMysql(mysql, 'mar', [config.mysql.password], startupAbort.signal);
      } catch (error) {
        if (interrupted) return;
        throw error;
      }
      await connection.end();
      if (interrupted) return;
      let searchAvailable = false;
      if (interrupted) return;
      const { app, quickStartNode } = await createLocalApplication(
        root,
        config,
        () => searchAvailable
      );
      let localNode: Awaited<ReturnType<typeof startLocalNode>> | undefined;
      let localSearch: Awaited<ReturnType<typeof startManagedSearch>> | undefined;
      let stoppingSearch = false;
      const searchAbort = new AbortController();
      let stoppingNode = false;
      try {
        try {
          await app.listen({ host: '127.0.0.1', port: config.serverPort });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE')
            throw new Error('QUICK_START_SERVER_PORT_IN_USE');
          throw error;
        }
        if (interrupted) return;
        console.log(
          cliText('quickStarted', { url: `http://127.0.0.1:${config.serverPort}`, path: root })
        );
        if (config.search.mode === 'external') {
          void probeSearchEndpoint(config.search.url).then((available) => {
            if (stoppingSearch) return;
            searchAvailable = available;
            if (!available) console.error(cliText('quickSearchUnavailable'));
          });
        } else if (config.search.mode === 'managed') {
          try {
            if (!config.search.installation) throw new Error('QUICK_START_SEARCH_NOT_PREPARED');
            localSearch = await startManagedSearch(
              root,
              config.search.installation,
              config.deploymentId
            );
            void localSearch.exited.then(() => {
              searchAvailable = false;
              if (!stoppingSearch) console.error(cliText('quickManagedSearchUnavailable'));
            });
            void localSearch
              .ready(searchAbort.signal)
              .then((available) => {
                if (stoppingSearch) return;
                searchAvailable = available;
                if (available) console.log(cliText('quickManagedSearchReady'));
                else console.error(cliText('quickManagedSearchUnavailable'));
              })
              .catch(() => {
                if (!stoppingSearch) console.error(cliText('quickManagedSearchUnavailable'));
              });
          } catch {
            console.error(cliText('quickManagedSearchUnavailable'));
          }
        }
        if (config.node.enabled) {
          let mysqlExitedDuringNodeStartup = false;
          try {
            localNode = await startLocalNode(root, config, quickStartNode);
            void localNode.exited.then(() => {
              if (!stoppingNode) console.error(cliText('quickNodeSupervisorExited'));
            });
            const online = await Promise.race([
              localNode.online(signal),
              mysql.exited.then(() => {
                mysqlExitedDuringNodeStartup = true;
                return false;
              })
            ]);
            if (!mysqlExitedDuringNodeStartup) {
              if (online) console.log(cliText('quickNodeOnline'));
              else if (!interrupted) console.error(cliText('quickNodeUnavailable'));
            }
          } catch (error) {
            if (
              error instanceof Error &&
              'code' in error &&
              error.code === 'QUICK_START_NODE_BOOTSTRAP_RECOVERY_REQUIRED'
            )
              console.error(cliText('quickNodeBootstrapRecoveryRequired'));
            else if (
              error instanceof Error &&
              'code' in error &&
              error.code === 'QUICK_START_NODE_CONFIG_INVALID'
            )
              console.error(cliText('quickNodeInstallFailed', { code: error.code }));
            else console.error(cliText('quickNodeUnavailable'));
          }
          if (mysqlExitedDuringNodeStartup) throw new Error('QUICK_START_MYSQL_EXITED');
        }
        await Promise.race([
          signal,
          mysql.exited.then(() => {
            throw new Error('QUICK_START_MYSQL_EXITED');
          })
        ]);
      } finally {
        stoppingNode = true;
        stoppingSearch = true;
        searchAbort.abort();
        try {
          await localNode?.stop();
        } catch (error) {
          if (error instanceof Error && error.message === 'QUICK_START_NODE_RECLAIM_FAILED')
            releaseLock = false;
          throw error;
        } finally {
          try {
            await localSearch?.stop();
          } catch (error) {
            if (error instanceof Error && error.message === 'QUICK_START_SEARCH_RECLAIM_FAILED')
              releaseLock = false;
            throw error;
          } finally {
            await app.shutdown();
          }
        }
      }
    } finally {
      try {
        await mysql.stop();
      } catch (error) {
        if (error instanceof Error && error.message === 'QUICK_START_MYSQL_RECLAIM_FAILED')
          releaseLock = false;
        throw error;
      }
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (releaseLock) await release();
  }
}
