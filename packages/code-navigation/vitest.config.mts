import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const runId = (process.env['MAR_TEST_RUN_ID'] ?? String(process.pid)).replace(
  /[^a-zA-Z0-9_-]/gu,
  '_'
);

export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
    reporters: ['default', 'json'],
    outputFile:
      process.env['MAR_TEST_OUTPUT_FILE'] ??
      resolve(import.meta.dirname, `test/runs/vitest-results-${runId}.json`)
  }
});
