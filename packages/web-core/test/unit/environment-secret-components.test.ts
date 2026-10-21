import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ElementPlus, { ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus';
import SecretPage from '../../src/view/settings/SecretManagementPage.vue';
import { i18n } from '../../src/service/LocalePreferenceService.js';
import { commonMessages } from '../../src/i18n/messages.js';

afterEach(() => vi.unstubAllGlobals());

describe('Public environment secret management', () => {
  it('binds Workspace details to their own scope and management permission', () => {
    const source = readFileSync(
      new URL('../../src/view/settings/NodeDetailsDialogs.vue', import.meta.url),
      'utf8'
    );
    const permission = source.indexOf('workspaceSecretManageable === true');
    const section = source.slice(permission - 120, permission + 600);
    expect(section).toContain('workspaceSecretManageable === true');
    expect(section).toContain(':scopes="[\'WORKSPACE\']"');
    expect(section).toContain(':workspace-id="workspace.id"');
    expect(section).toContain(':key="`${workspaceNodeId}:${workspace.id}`"');
    expect(section).not.toContain('workspaceNodeSecretManageable');
    expect(section).not.toContain(':scopes="[\'NODE\']"');
  });
  it('owns the interaction without importing enterprise policy or persisting secret values', () => {
    const source = readFileSync(
      new URL('../../src/view/settings/EnvironmentSecretManager.vue', import.meta.url),
      'utf8'
    );
    expect(source).not.toMatch(
      /@\/|ORGANIZATION|ENTERPRISE|organizationId|localStorage|sessionStorage/u
    );
    expect(source).toContain('ElMessage.error');
    expect(source).not.toContain('<el-alert v-if="error"');
    expect(source).toContain('name="create-fields"');
    expect(source).toContain(':model="{ ...formContext, name, value }"');
    expect(source).toContain('await formRef.value?.validate()');
    expect(source).toContain(
      'replaceManagementUrlValues(urlNamespace, { keyword: keyword.value })'
    );
  });

  it.each(['en-US', 'zh-CN'] as const)(
    'has complete independent messages and read-only rendering in %s',
    async (locale) => {
      for (const file of [
        'view/settings/EnvironmentSecretManager.vue',
        'view/settings/SecretManagementPage.vue',
        'service/EnvironmentSecretService.ts'
      ]) {
        const source = readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8');
        for (const match of source.matchAll(/translate\(\s*['"]([^'"]+)['"]/gu)) {
          let value: unknown = commonMessages[locale];
          for (const key of match[1]!.split('.')) value = (value as Record<string, unknown>)?.[key];
          expect(value, match[1]).toBeTypeOf('string');
        }
      }
      vi.stubGlobal('window', { location: { search: '' }, matchMedia: () => ({ matches: false }) });
      i18n.global.locale.value = locale;
      const request = vi.fn(async <T>() => ({ secrets: [] }) as T);
      const app = createSSRApp({
        render: () => h(SecretPage, { request, writable: false })
      });
      app.use(i18n).use(ElementPlus);
      app.provide(ID_INJECTION_KEY, { prefix: 921, current: 0 });
      app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
      const html = await renderToString(app);
      expect(html).toContain(
        commonMessages[locale].generated.environmentSecretManager.environmentSecrets
      );
      expect(html).not.toContain(
        commonMessages[locale].generated.environmentSecretManager.addSecret
      );
      expect(request).not.toHaveBeenCalled();
    }
  );
});
