import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const packageRoot = process.env['MAR_E2E_PRODUCTION_PACKAGE']?.trim();
const implementationUrl =
  packageRoot === undefined
    ? new URL('../../../ee/server/src/app.ts', import.meta.url).href
    : pathToFileURL(
        resolve(
          packageRoot,
          'node_modules/@myagentroam-enterprise/server-implementation/dist/app.js'
        )
      ).href;
const { createServerApp } = (await import(
  implementationUrl
)) as typeof import('../../../ee/server/src/app.js');
const productUuidPath = process.env['MAR_LICENSE_HOST_PATH'];
const productUuid =
  productUuidPath === undefined ? undefined : readFileSync(productUuidPath, 'utf8').trim();
const app = (
  await createServerApp({
    ...(process.env['MAR_WEB_ROOT'] === undefined ? {} : { webRoot: process.env['MAR_WEB_ROOT'] }),
    ...(process.env['MAR_DATA_DIR'] === undefined
      ? {}
      : { dataDirectory: process.env['MAR_DATA_DIR'] }),
    ...(process.env['MAR_DATABASE_URL'] === undefined
      ? {}
      : { databaseUrl: process.env['MAR_DATABASE_URL'] }),
    ...(process.env['MAR_PUBLIC_ORIGIN'] === undefined
      ? {}
      : { publicOrigin: process.env['MAR_PUBLIC_ORIGIN'] }),
    ...(productUuid === undefined ? {} : { productUuid }),
    secureCookies: process.env['MAR_SECURE_COOKIES'] !== 'false',
    logger: true
  })
).app;
const host = process.env['MAR_SERVER_HOST'] ?? '127.0.0.1';
const port = Number(process.env['MAR_SERVER_PORT']);
let shutdown: Promise<void> | undefined;
const stop = () => (shutdown ??= app.shutdown());
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void stop().finally(() => process.exit(0));
  });
}
try {
  await app.listen({ host, port });
} catch (error) {
  await stop();
  throw error;
}
