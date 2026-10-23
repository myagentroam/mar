import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import type { Plugin } from 'vite';
const runId = (process.env['MAR_TEST_RUN_ID'] ?? String(process.pid)).replace(
  /[^a-zA-Z0-9_-]/gu,
  '_'
);
const vuePlugin = vue();
const vueTransform = vuePlugin.transform;
// Opt in only the component fixtures that drive the real template and lifecycle.
// Existing SSR and setup-only fixtures keep their original compilation mode.
const componentFixtures: Plugin = {
  name: 'component-fixture-templates',
  enforce: 'pre',
  async resolveId(source, importer) {
    if (
      !importer?.includes('unit-render') ||
      !/\.vue(?:\?|$)/u.test(source) ||
      source.includes('unit-render') ||
      source.includes('type=style')
    )
      return null;
    return this.resolve(`${source}${source.includes('?') ? '&' : '?'}unit-render`, importer, {
      skipSelf: true
    });
  }
};
if (typeof vueTransform === 'object') {
  vuePlugin.transform = {
    ...vueTransform,
    handler(code, id, options) {
      return vueTransform.handler.call(
        this,
        code,
        id,
        id.includes('unit-render') ? { ...options, ssr: false } : options
      );
    }
  };
}
export default defineConfig({
  plugins: [componentFixtures, vuePlugin],
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
    reporters: ['default', 'json'],
    outputFile: `test/runs/vitest-results-${runId}.json`
  }
});
