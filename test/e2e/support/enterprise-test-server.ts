import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerApp } from '../../../ee/server/src/app.js';
import {
  createPlaywrightTestDatabase,
  dropPlaywrightTestDatabase,
  resolvePlaywrightTestDatabase
} from './playwright-test-database.js';
import {
  PLAYWRIGHT_LICENSE_PRODUCT_UUID,
  getPlaywrightTestLicensePublicKey
} from './playwright-test-license.js';

export interface EnterpriseTestServer {
  readonly baseURL: string;
  readonly databaseUrl: string;
  close(): Promise<void>;
}

export async function createEnterpriseTestServer(label: string): Promise<EnterpriseTestServer> {
  const runId = process.env['MAR_TEST_RUN_ID'];
  if (runId === undefined || runId.length === 0) throw new Error('MAR_TEST_RUN_ID_REQUIRED');
  const target = resolvePlaywrightTestDatabase(`${runId}-${label}-${randomUUID()}`);
  const dataDirectory = await mkdtemp(join(tmpdir(), `my-agent-roam-${label}-`));
  await createPlaywrightTestDatabase(target);

  const previousPublicKey = process.env['MAR_LICENSE_PUBLIC_KEY'];
  process.env['MAR_LICENSE_PUBLIC_KEY'] = getPlaywrightTestLicensePublicKey();
  const app = (
    await createServerApp({
      databaseUrl: target.databaseUrl,
      dataDirectory,
      secureCookies: false,
      logger: false,
      productUuid: PLAYWRIGHT_LICENSE_PRODUCT_UUID
    })
  ).app;
  if (previousPublicKey === undefined) delete process.env['MAR_LICENSE_PUBLIC_KEY'];
  else process.env['MAR_LICENSE_PUBLIC_KEY'] = previousPublicKey;

  try {
    const baseURL = await app.listen({ host: '127.0.0.1', port: 0 });
    let closePromise: Promise<void> | undefined;
    return {
      baseURL,
      databaseUrl: target.databaseUrl,
      close() {
        closePromise ??= (async () => {
          try {
            await app.shutdown();
          } finally {
            try {
              await rm(dataDirectory, { recursive: true, force: true });
            } finally {
              await dropPlaywrightTestDatabase(target);
            }
          }
        })();
        return closePromise;
      }
    };
  } catch (error) {
    try {
      await app.shutdown();
    } finally {
      try {
        await rm(dataDirectory, { recursive: true, force: true });
      } finally {
        await dropPlaywrightTestDatabase(target);
      }
    }
    throw error;
  }
}
