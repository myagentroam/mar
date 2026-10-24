import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import { integrationTestFiles, smokeTitlesForPlatform } from './scripts/test-e2e-policy.mjs';
import { resolvePlaywrightTestDatabase } from './test/e2e/support/playwright-test-database.js';
import { initializePlaywrightTestLicense } from './test/e2e/support/playwright-test-license.js';

const mode = process.env.MAR_E2E_MODE ?? 'full';
const listing = process.env.MAR_E2E_LIST === '1';
const smoke = mode === 'smoke';
const integration = mode === 'integration';
const fixtures = mode === 'fixtures';
const testRunId = (process.env.MAR_TEST_RUN_ID ?? String(process.pid)).replace(
  /[^a-zA-Z0-9_-]/gu,
  '_'
);
process.env.MAR_TEST_RUN_ID = testRunId;
const testLicense = listing || fixtures ? undefined : initializePlaywrightTestLicense(testRunId);
if (testLicense) {
  process.env.MAR_TEST_LICENSE_KEY_PATH = testLicense.keyPath;
  process.env.MAR_TEST_LICENSE_PUBLIC_KEY = testLicense.publicKey;
}
const testDatabase =
  listing || integration || fixtures ? undefined : resolvePlaywrightTestDatabase(testRunId);
const productionPackageRoot = process.env.MAR_E2E_PRODUCTION_PACKAGE?.trim();
const portOffset = [...testRunId].reduce(
  (value, character) => (value * 31 + character.charCodeAt(0)) % 800,
  0
);
const webPort = process.env.MAR_E2E_WEB_PORT ?? String(5600 + portOffset * 2);
const serverPort =
  productionPackageRoot === undefined
    ? (process.env.MAR_E2E_SERVER_PORT ?? String(Number(webPort) + 1))
    : webPort;
if (productionPackageRoot !== undefined) process.env.MAR_E2E_SERVER_PORT = serverPort;
const origin = `http://127.0.0.1:${webPort}`;
const licenseHostPath = `test/runs/playwright-license-host-${testRunId}.txt`;
const serverCommand = 'node --import tsx test/e2e/support/playwright-server.ts';

export default defineConfig({
  testDir: './test/e2e',
  forbidOnly: smoke,
  ...(smoke ? { workers: 1, retries: 0, timeout: 90_000 } : {}),
  ...(smoke ? { grep: new RegExp(smokeTitlesForPlatform().join('|')) } : {}),
  outputDir: `./test/runs/playwright-${testRunId}`,
  reporter: [
    ['line'],
    ['json', { outputFile: `./test/runs/playwright-results-${testRunId}.json` }]
  ],
  use: { ...(!fixtures ? { baseURL: `http://127.0.0.1:${webPort}` } : {}), locale: 'zh-CN' },
  projects: smoke
    ? [
        {
          name: 'chromium',
          testMatch: '**/release-smoke.spec.ts',
          use: { browserName: 'chromium' }
        }
      ]
    : [
        {
          name: 'integration',
          testMatch: integrationTestFiles.map((file) => `**/${file}`),
          use: { browserName: 'chromium' }
        },
        ...(!integration
          ? ['chromium', 'firefox'].map((browserName) => ({
              name: browserName,
              testIgnore: [
                ...integrationTestFiles.map((file) => `**/${file}`),
                '**/release-smoke.spec.ts'
              ],
              use: { browserName: browserName as 'chromium' | 'firefox' }
            }))
          : [])
      ],
  webServer:
    listing || integration || fixtures
      ? []
      : productionPackageRoot !== undefined
        ? [
            {
              command: serverCommand,
              env: {
                MAR_TEST_RUN_ID: testRunId,
                MAR_LICENSE_HOST_PATH: licenseHostPath,
                MAR_LICENSE_PUBLIC_KEY: testLicense!.publicKey,
                MAR_DATABASE_URL: testDatabase!.databaseUrl,
                MAR_SECURE_COOKIES: 'false',
                MAR_DATA_DIR: `test/runs/playwright-server-${testRunId}`,
                MAR_PUBLIC_ORIGIN: origin,
                MAR_SERVER_HOST: '127.0.0.1',
                MAR_SERVER_PORT: serverPort,
                MAR_WEB_ROOT: resolve(productionPackageRoot!, 'web')
              },
              url: `http://127.0.0.1:${serverPort}/health`,
              reuseExistingServer: false
            }
          ]
        : [
            {
              command: serverCommand,
              env: {
                MAR_TEST_RUN_ID: testRunId,
                MAR_LICENSE_HOST_PATH: licenseHostPath,
                MAR_LICENSE_PUBLIC_KEY: testLicense!.publicKey,
                MAR_DATABASE_URL: testDatabase!.databaseUrl,
                MAR_SECURE_COOKIES: 'false',
                MAR_DATA_DIR: `test/runs/playwright-server-${testRunId}`,
                MAR_PUBLIC_ORIGIN: origin,
                MAR_SERVER_PORT: serverPort
              },
              url: `http://127.0.0.1:${serverPort}/health`,
              reuseExistingServer: false
            },
            {
              command: `pnpm --filter @myagentroam/web-console ${smoke ? 'exec vite preview' : 'dev'} --host 127.0.0.1 --port ${webPort} --strictPort`,
              env: {
                MAR_TEST_RUN_ID: testRunId,
                MAR_DEV_WEB_EXTERNAL_ORIGIN: origin,
                MAR_WEB_CONSOLE_SERVER_URL: `http://127.0.0.1:${serverPort}`
              },
              url: `http://127.0.0.1:${webPort}`,
              reuseExistingServer: false
            }
          ]
});
