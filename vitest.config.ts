import { defineConfig } from 'vitest/config';
import webCoreConfig from './packages/web-core/vitest.config.mts';

const testRunId = (process.env['MAR_TEST_RUN_ID'] ?? String(process.pid)).replace(
  /[^a-zA-Z0-9_-]/gu,
  '_'
);

const { test: webCoreTest, ...webCoreViteConfig } = webCoreConfig;

export default defineConfig({
  ...webCoreViteConfig,
  test: {
    ...webCoreTest,
    include: ['test/unit/**/*.test.ts', 'ee/*/test/unit/**/*.test.ts'],
    environment: 'node',
    reporters: ['default', 'json'],
    outputFile: `test/runs/vitest-results-${testRunId}.json`
  }
});
