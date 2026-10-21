import { defineConfig } from 'vitest/config';

const testRunId = (process.env['MAR_TEST_RUN_ID'] ?? String(process.pid)).replace(
  /[^a-zA-Z0-9_-]/gu,
  '_'
);

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'ee/*/test/unit/**/*.test.ts'],
    environment: 'node',
    reporters: ['default', 'json'],
    outputFile: `test/runs/vitest-results-${testRunId}.json`
  }
});
