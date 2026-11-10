#!/usr/bin/env node

import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadNodeConfig, nodeConfigPath, nodeDatabasePath, nodeDataDirectory } from './config.js';
import { getNodeHealth } from './health.js';
import { browserCachePath, removeServiceDefinition, writeServiceDefinition } from './service.js';
import { superviseNode } from './supervisor.js';
import { SupervisorUpgradeHandoff } from './service/supervisor-upgrade-handoff.js';
import { configureNodeLog } from './rotating-log.js';
import { nodeLog } from './operational.js';
import {
  acquireNodeProcessLock,
  NodeProcessOwnerConflictError,
  NODE_OWNER_CONFLICT_EXIT_CODE
} from './node-process-lock.js';
import { safeErrorCode } from './util/safe-error.js';

const [command = 'status', ...args] = process.argv.slice(2);
const config = readOption(args, '--config') ?? nodeConfigPath();
const output = readOption(args, '--output') ?? defaultServicePath();

const browserPath = readOption(args, '--browser-cache');
if (browserPath !== undefined) process.env['PLAYWRIGHT_BROWSERS_PATH'] = browserPath;

if (command === 'run') {
  let earlyQuickStop = false;
  let quickStop: (() => void) | undefined;
  process.on('message', (message: unknown) => {
    if (
      typeof message !== 'object' ||
      message === null ||
      !('type' in message) ||
      message.type !== 'node-quick-start-stop'
    )
      return;
    earlyQuickStop = true;
    quickStop?.();
  });
  if (process.env['MAR_QUICK_START_OWNER'] === '1') {
    process.once('disconnect', () => {
      earlyQuickStop = true;
      quickStop?.();
    });
  }
  const nodeConfig = await loadNodeConfig(config);
  let releaseOwner: () => void;
  try {
    releaseOwner = await acquireNodeProcessLock(nodeDataDirectory(nodeConfig, config));
  } catch (error) {
    if (!(error instanceof NodeProcessOwnerConflictError)) throw error;
    console.error(`${error.code}: ${error.message}`);
    process.exit(NODE_OWNER_CONFLICT_EXIT_CODE);
  }
  const { NodeConnector } = await import('./connector.js');
  configureNodeLog(nodeDataDirectory(nodeConfig, config));
  let connector: InstanceType<typeof NodeConnector>;
  let shuttingDown = false;
  const shutdown = (handoff = true, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => {
      nodeLog('node.restart.diagnostic', { code: 'RESTART_HANDOFF_SHUTDOWN_TIMEOUT' });
      process.exit(1);
    }, 25_000);
    void connector.stop({ handoff }).then(
      () => {
        clearTimeout(deadline);
        releaseOwner();
        process.exit(exitCode);
      },
      (error: unknown) => {
        clearTimeout(deadline);
        try {
          nodeLog('node.restart.diagnostic', {
            code: 'RESTART_HANDOFF_SHUTDOWN_FAILED',
            errorCode: safeErrorCode(error, 'NODE_SHUTDOWN_FAILED')
          });
        } finally {
          process.exit(1);
        }
      }
    );
  };
  const supervisorHandoff = new SupervisorUpgradeHandoff();
  const supportsProgress =
    process.env['MAR_QUICK_START_OWNER'] !== '1' && (await supervisorHandoff.handshake());
  if (!supportsProgress) supervisorHandoff.close();
  connector = new NodeConnector({
    configPath: config,
    config: nodeConfig,
    upgradeReady: () => shutdown(false, 75),
    ...(supportsProgress ? { supervisorUpgradeHandoff: supervisorHandoff } : {})
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => shutdown());
  }
  quickStop = () => shutdown();
  try {
    if (earlyQuickStop) shutdown();
    else await connector.start();
  } catch (error) {
    nodeLog('node.start.failed', { code: safeErrorCode(error, 'NODE_START_FAILED') });
    shutdown(false, 1);
  }
} else if (command === 'supervise') {
  if (process.argv[1] === undefined) throw new Error('NODE_ENTRYPOINT_UNAVAILABLE');
  configureNodeLog(nodeDataDirectory(await loadNodeConfig(config), config));
  await superviseNode(config, process.argv[1]);
} else if (command === 'install') {
  await writeCurrentServiceDefinition(output, config);
  process.stdout.write(`${output}\n`);
} else if (command === 'upgrade') {
  await writeCurrentServiceDefinition(output, config);
  process.stdout.write(`${output}\n`);
} else if (command === 'uninstall') {
  await removeServiceDefinition(output);
} else if (command === 'status') {
  process.stdout.write(`${JSON.stringify(getNodeHealth())}\n`);
} else {
  throw new Error('NODE_COMMAND_INVALID');
}

function readOption(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function defaultServicePath(): string {
  if (process.platform === 'win32') return resolve('data/myagentroam-node-service.json');
  if (process.platform === 'darwin')
    return resolve(homedir(), 'Library', 'LaunchAgents', 'com.myagentroam.node.plist');
  return resolve('data/myagentroam-node.service');
}

async function writeCurrentServiceDefinition(output: string, configPath: string): Promise<void> {
  const nodeConfig = await loadNodeConfig(configPath);
  const cachePath = browserCachePath(nodeDataDirectory(nodeConfig, configPath));
  const browser = spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, '../scripts/install-web-browser.mjs')],
    { stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cachePath } }
  );
  if (browser.error || browser.signal || browser.status !== 0)
    throw new Error('NODE_WEB_BROWSER_INSTALL_FAILED');
  await writeServiceDefinition(
    output,
    process.execPath,
    configPath,
    process.platform,
    process.argv[1],
    [dirname(nodeDatabasePath(nodeConfig, configPath)), ...nodeConfig.allowedRoots],
    cachePath
  );
}
