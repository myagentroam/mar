import { createServerApp } from '@myagentroam-enterprise/server-implementation';
import { readLicenseHostUuid } from '@myagentroam-enterprise/server-implementation/license-host';
import { resolve } from 'node:path';
const app = (
  await createServerApp({
    webRoot: resolve(process.env['MAR_WEB_ROOT'] ?? resolve(import.meta.dirname, '../web')),
    productUuid: readLicenseHostUuid(),
    logger: true
  })
).app;
const port = Number(process.env['MAR_SERVER_PORT'] ?? 5090);
const host = process.env['MAR_SERVER_HOST'] ?? '127.0.0.1';

let shutdown: Promise<void> | undefined;
const stop = () => (shutdown ??= app.shutdown());
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void stop().then(
      () => process.exit(0),
      () => {
        console.error(`SERVER_SHUTDOWN_FAILED: Server shutdown failed after ${signal}.`);
        process.exit(1);
      }
    );
  });
}
try {
  await app.listen({ host, port });
} catch (error) {
  try {
    await stop();
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], 'Server startup and cleanup failed', {
      cause: error
    });
  }
  throw error;
}
