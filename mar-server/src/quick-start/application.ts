import { createQuickStartServerApp } from '@myagentroam-enterprise/server-implementation';
import { resolve } from 'node:path';
import type { QuickStartConfig } from './config.js';

/** Creates the existing product with only the local deployment's paths and database. */
export async function createLocalApplication(
  root: string,
  config: QuickStartConfig,
  searchBackendAvailable: () => boolean = () => false
) {
  const databaseUrl = new URL('mysql://127.0.0.1/mar');
  databaseUrl.port = String(config.mysql.port);
  databaseUrl.username = 'mar';
  databaseUrl.password = config.mysql.password;
  return createQuickStartServerApp({
    databaseUrl: databaseUrl.toString(),
    dataDirectory: resolve(root, 'server-data'),
    webRoot: resolve(import.meta.dirname, '../../web'),
    publicOrigin: `http://127.0.0.1:${config.serverPort}`,
    secureCookies: false,
    searchBackendAvailable,
    ...(config.search.mode === 'external'
      ? { webSearchEndpoint: config.search.url }
      : config.search.mode === 'managed' && config.search.installation
        ? { webSearchEndpoint: `http://127.0.0.1:${config.search.installation.port}` }
        : {})
  });
}
