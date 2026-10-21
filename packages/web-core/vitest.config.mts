import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
const runId = (process.env['MAR_TEST_RUN_ID'] ?? String(process.pid)).replace(
  /[^a-zA-Z0-9_-]/gu,
  '_'
);
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
    reporters: ['default', 'json'],
    outputFile: `test/runs/vitest-results-${runId}.json`
  }
});
