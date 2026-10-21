import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { commonMessages } from '../../src/i18n/messages.js';

describe('public Workbench page controller', () => {
  it('owns the root page without OAuth or enterprise resource implementations', () => {
    const source = readFileSync(
      new URL('../../src/view/workbench/WorkbenchPage.vue', import.meta.url),
      'utf8'
    );
    expect(source).not.toMatch(/@\/|oauth|OAuth|EnterpriseLoginExtension|__MAR_WEB_/u);
    expect(source).toContain('name="identity-extension"');
    expect(source).toContain('name="surface"');
    expect(source).toContain('name="resource-details"');
  });
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
    for (const match of source.matchAll(/(?:translate|\bt)\(\s*['"]([^'"]+)['"]/gu)) {
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
    expect(source).toContain('if (!resumed && selectedWorkspaceId.value !== undefined)');
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
