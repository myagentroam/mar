import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ElementPlus, { ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus';
import { commonMessages } from '../../src/i18n/messages.js';
import { i18n } from '../../src/service/LocalePreferenceService.js';
import WorkbenchPage from '../../src/view/workbench/WorkbenchPage.vue';

// Keep page composition real; unrelated child domains do not participate in slot routing.
vi.mock('../../src/view/workbench/WorkbenchNavigation.vue', () => ({
  default: { render: () => null }
}));
vi.mock('../../src/view/workspace/QuickOpenDialog.vue', () => ({
  default: { render: () => null }
}));
vi.mock('../../src/view/conversation/ImagePreviewDialogs.vue', () => ({
  default: { render: () => null }
}));
vi.mock('../../src/view/workbench/WorkbenchSurface.vue', () => ({
  default: { render: () => h('p', 'Default work surface') }
}));
vi.mock('../../src/view/settings/NodeDetailsDialogs.vue', () => ({
  default: { render: () => h('p', 'Default resource details') }
}));

describe('public Workbench page controller', () => {
  it('delegates file protocols and native history transactions to domain owners', () => {
    const source = readFileSync(
      new URL('../../src/service/WorkbenchPageController.ts', import.meta.url),
      'utf8'
    );
    expect(source).not.toContain('/files/direct-metadata');
    expect(source).not.toContain('/git/file-metadata');
    expect(source).not.toContain('createWorkspaceDirectObjectUrlSink(');
    expect(source).not.toContain('createWorkspaceDirectDownloadStream(');
    expect(source).not.toContain('turnId: turn.turnId ?? turn.id');
  });
  it('owns the root page without OAuth or enterprise resource implementations', () => {
    const source = readFileSync(
      new URL('../../src/view/workbench/WorkbenchPage.vue', import.meta.url),
      'utf8'
    );
    expect(source).not.toMatch(/@\/|oauth|OAuth|EnterpriseLoginExtension|__MAR_WEB_/u);
  });
  it.each([
    [false, true],
    [true, true],
    [true, false]
  ])(
    'renders page extensions or public defaults (authenticated=%s, hostSlots=%s)',
    async (authenticated, hostSlots) => {
      const page = {
        adminLoaded: true,
        admin: { authenticated },
        locked: false,
        loading: false,
        panelWidths: {},
        workspaceTreeService: {},
        nodes: [],
        sessions: [],
        workspaceTabs: []
      };
      const app = createSSRApp({
        render: () =>
          h(
            WorkbenchPage,
            // Supply the state consumed by this page; child domain fixtures are isolated above.
            { page },
            hostSlots
              ? {
                  'identity-extension': () => h('p', 'Host identity entry'),
                  surface: () => h('p', 'Host work surface'),
                  'resource-details': () => h('p', 'Host resource details')
                }
              : {}
          )
      });
      app.use(i18n).use(ElementPlus);
      app.provide(ID_INJECTION_KEY, { prefix: 1024, current: 0 });
      app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
      const html = await renderToString(app);
      expect(html.includes('Host identity entry')).toBe(!authenticated && hostSlots);
      expect(html.includes('Host work surface')).toBe(authenticated && hostSlots);
      expect(html.includes('Host resource details')).toBe(authenticated && hostSlots);
      expect(html.includes('Default work surface')).toBe(authenticated && !hostSlots);
      expect(html.includes('Default resource details')).toBe(authenticated && !hostSlots);
    }
  );
  it('owns the work surface with slots for identity, registration and management notices', () => {
    const source = readFileSync(
      new URL('../../src/view/workbench/WorkbenchSurface.vue', import.meta.url),
      'utf8'
    );
    expect(source).not.toMatch(/@\/|ENTERPRISE_FROZEN|ownerOrganizationId|node-ownership/u);
    expect(source).toContain('name="workspace-registration"');
    expect(source).toContain('name="settings"');
    expect(source).toContain('name="management-notice"');
  });
  it.each(['en-US', 'zh-CN'] as const)('owns every fixed controller message in %s', (locale) => {
    const source =
      readFileSync(
        new URL('../../src/service/WorkbenchPageController.ts', import.meta.url),
        'utf8'
      ) +
      readFileSync(
        new URL('../../src/view/workbench/WorkbenchSurface.vue', import.meta.url),
        'utf8'
      ) +
      readFileSync(new URL('../../src/view/workbench/WorkbenchPage.vue', import.meta.url), 'utf8');
    const matches = [...source.matchAll(/(?:translate|\bt)\(\s*['"]([^'"]+)['"]/gu)];
    expect(matches.length).toBeGreaterThan(0);
    for (const match of matches) {
      let value: unknown = commonMessages[locale];
      for (const part of match[1]!.split('.')) {
        value =
          typeof value === 'object' && value !== null
            ? (value as Record<string, unknown>)[part]
            : undefined;
      }
      expect(value, match[1]).toBeTypeOf('string');
    }
  });
  it('owns composition without enterprise modules, ownership policy or build constants', () => {
    const source = readFileSync(
      new URL('../../src/service/WorkbenchPageController.ts', import.meta.url),
      'utf8'
    );
    expect(source).not.toMatch(/@\/|__MAR_WEB_|ownerOrganizationId|ownerType|ORGANIZATION/u);
    expect(source).toContain('createWorkbenchPageStateService');
    expect(source).toContain('options.navigation');
    expect(source).toContain('options.management');
    expect(source).toContain('options.webVersion');
    expect(source).toContain('options.webBuildHash');
  });
  it('delegates notification clicks to the notification service', () => {
    const source = readFileSync(
      new URL('../../src/service/WorkbenchPageController.ts', import.meta.url),
      'utf8'
    );
    expect(source).toContain(
      'openWorkbenchNotification: workbenchNotificationService.openNotification'
    );
  });
  it('refreshes Node status after any restored socket without restarting an unresumed Watch twice', () => {
    const source = readFileSync(
      new URL('../../src/service/WorkbenchPageController.ts', import.meta.url),
      'utf8'
    );
    expect(source).toMatch(/onConnectionRestored: \(\) => \{\s*void refreshNodes\(\);/u);
    expect(source).toMatch(
      /onConnectionRestored: \(\) => \{\s*void refreshNodes\(\);\s*void workbenchNotificationService\.recover\(\)\.catch/u
    );
    expect(source).not.toMatch(/onReconnect: \(\) => \{\s*void refreshNodes\(\);/u);
    expect(source).toContain('onNodeConnected: (nodeId) => handleNodeConnected(nodeId, false)');
    expect(source).toContain('if (!restartWatch) return;');
    expect(source).toMatch(
      /if \(!resumed && activeWorkspaceId\.value !== undefined\)\s*void watchCoordinator\.current\?\.startWorkspace\(activeWorkspaceId\.value\)/u
    );
  });
  it('serializes reusable standalone file intents and exposes a recoverable failure state', () => {
    const source = readFileSync(
      new URL('../../src/service/WorkbenchPageController.ts', import.meta.url),
      'utf8'
    );
    expect(source).toContain(
      'pendingStandaloneFileIntent.value !== undefined &&\n        pendingStandaloneFileIntent.value !== intent'
    );
    expect(source).toContain('void Promise.resolve().then(openPendingStandaloneFileIntent);');
    expect(source).toContain('standaloneFileError.value = true;');
    expect(source).toContain('if (nodeManifestLoading.value) return;');
    expect(source).toContain('filesReady,\n      nodeManifestLoading,\n      workspaceInspector');
    expect(source).toContain(
      'if (consumedStandaloneFileIntent && pendingStandaloneFileIntent.value === undefined)'
    );
  });
});
