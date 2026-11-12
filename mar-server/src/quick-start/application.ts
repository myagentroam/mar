import { createQuickStartServerApp } from '@myagentroam-enterprise/server-implementation';
import { resolve } from 'node:path';
import { resolveQuickStartNetwork, type QuickStartConfig } from './config.js';
import { readQuickStartLocalNodeId } from './node-runtime.js';

/** Builds the production Quick Start Server options from its owned deployment and Node data. */
export function createLocalApplicationOptions(
  root: string,
  config: QuickStartConfig,
  searchBackendAvailable: () => boolean = () => false,
  environment: NodeJS.ProcessEnv = process.env
): Parameters<typeof createQuickStartServerApp>[0] {
  const databaseUrl = new URL('mysql://127.0.0.1/mar');
  databaseUrl.port = String(config.mysql.port);
  databaseUrl.username = 'mar';
  databaseUrl.password = config.mysql.password;
  const network = resolveQuickStartNetwork(config, environment);
  return {
    databaseUrl: databaseUrl.toString(),
    dataDirectory: resolve(root, 'server-data'),
    webRoot: resolve(import.meta.dirname, '../../web'),
    publicOrigin: network.publicOrigin,
    quickStartLocalServerUrl: network.localServerUrl,
    readQuickStartLocalNodeId: () => readQuickStartLocalNodeId(root),
    searchBackendAvailable,
    ...(config.search.mode === 'external'
      ? { webSearchEndpoint: config.search.url }
      : config.search.mode === 'managed' && config.search.installation
        ? { webSearchEndpoint: `http://127.0.0.1:${config.search.installation.port}` }
        : {})
  };
}

/** Creates the existing product with only the local deployment's paths and database. */
export async function createLocalApplication(
  root: string,
  config: QuickStartConfig,
  searchBackendAvailable: () => boolean = () => false
) {
  return createQuickStartServerApp(
    createLocalApplicationOptions(root, config, searchBackendAvailable)
  );
}
