import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import type { Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
const runId = (process.env['MAR_TEST_RUN_ID'] ?? String(process.pid)).replace(
  /[^a-zA-Z0-9_-]/gu,
  '_'
);
const vuePlugin = vue();
const vueTransform = vuePlugin.transform;
const componentFixtureQuery = /[?&]unit-render(?:&|$)/u;
const marUiComponentEntry =
  /^@myagentroam\/mar-ui\/(alert|busy-indicator|button|cascader|checkbox|check-tag|date-picker|descriptions|divider|dropdown|empty|form|icons|input-number|link|loading-panel|pagination|progress|radio|region-status|result|scrollbar|segmented|select|switch|table|tabs|tag|time-picker|time-select)$/u;
const selectBusinessFixtures =
  /\/(EnterpriseUserManagementPage|EnvironmentSecretManager|MarAgentCompactSettings|MarAgentModelManagementPage|RemoteDesktopPage|SettingsContent|UsageStatisticsSettings)\.vue\?/u;
// Opt in only the component fixtures that drive the real template and lifecycle.
// Existing SSR and setup-only fixtures keep their original compilation mode.
const componentFixtures: Plugin = {
  name: 'component-fixture-templates',
  enforce: 'pre',
  async resolveId(source, importer) {
    if (importer && componentFixtureQuery.test(importer)) {
      const stubs = {
        '@myagentroam/mar-ui/dialog': 'mar-dialog-stub.ts',
        '@myagentroam/mar-ui/loading': 'mar-loading-stub.ts'
      } as const;
      const stub =
        source === './index.js' &&
        /\/mar-ui\/components\/loading\/MarLoadingPanel\.vue\?/u.test(importer)
          ? 'mar-loading-stub.ts'
          : stubs[source as keyof typeof stubs];
      if (stub) return fileURLToPath(new URL('./test/unit/support/' + stub, import.meta.url));
    }
    if (
      importer &&
      componentFixtureQuery.test(importer) &&
      source === '@myagentroam/mar-ui/input'
    ) {
      return fileURLToPath(new URL('./test/unit/support/mar-input-stub.ts', import.meta.url));
    }
    if (
      importer &&
      componentFixtureQuery.test(importer) &&
      selectBusinessFixtures.test(importer) &&
      source === '@myagentroam/mar-ui/select'
    ) {
      return fileURLToPath(new URL('./test/unit/support/mar-select-stub.ts', import.meta.url));
    }
    if (importer && componentFixtureQuery.test(importer) && marUiComponentEntry.test(source)) {
      const entry = await this.resolve(source, importer, { skipSelf: true });
      return entry && { ...entry, id: `${entry.id}?unit-render` };
    }
    if (
      !importer ||
      !componentFixtureQuery.test(importer) ||
      !/\.vue(?:\?|$)/u.test(source) ||
      componentFixtureQuery.test(source) ||
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
        componentFixtureQuery.test(id) ? { ...options, ssr: false } : options
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
