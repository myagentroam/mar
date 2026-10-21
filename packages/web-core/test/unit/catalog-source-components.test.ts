import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ElementPlus, { ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus';
import SkillPage from '../../src/view/skill/SkillSourceManagementPage.vue';
import McpPage from '../../src/view/skill/McpSourceManagementPage.vue';
import { i18n } from '../../src/service/LocalePreferenceService.js';
import { commonMessages } from '../../src/i18n/messages.js';

afterEach(() => vi.unstubAllGlobals());

describe('Public source discovery and catalog management', () => {
  it('keeps organization policy outside both complete source pages', () => {
    for (const name of ['SkillSourceManagementPage', 'McpSourceManagementPage']) {
      const source = readFileSync(
        new URL(`../../src/view/skill/${name}.vue`, import.meta.url),
        'utf8'
      );
      expect(source).not.toMatch(
        /@\/|ORGANIZATION|ENTERPRISE|organizationId|\/api\/organizations/u
      );
      expect(source).toContain('name="source-ownership"');
      expect(source).toContain('name="catalog-ownership"');
      expect(source).toContain('prop="description"');
      expect(source).toContain('confirmSourceStatusChange');
      expect(source).toContain('class="source-search-bar"');
    }
  });
  it.each(['en-US', 'zh-CN'] as const)(
    'renders both public entry points with complete messages in %s',
    async (locale) => {
      vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
      i18n.global.locale.value = locale;
      for (const [name, component] of [
        ['SkillSourceManagementPage', SkillPage],
        ['McpSourceManagementPage', McpPage]
      ] as const) {
        const source = readFileSync(
          new URL(`../../src/view/skill/${name}.vue`, import.meta.url),
          'utf8'
        );
        for (const match of source.matchAll(/translate\(\s*['"]([^'"]+)['"]/gu)) {
          let value: unknown = commonMessages[locale];
          for (const key of match[1]!.split('.')) value = (value as Record<string, unknown>)?.[key];
          expect(value, `${name}: ${match[1]}`).toBeTypeOf('string');
        }
        const request = vi.fn(async <T>() => ({}) as T);
        const app = createSSRApp({ render: () => h(component, { request, writable: false }) });
        app.use(i18n).use(ElementPlus);
        app.provide(ID_INJECTION_KEY, { prefix: 923, current: 0 });
        app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
        const html = await renderToString(app);
        expect(html).toContain('management-page');
        expect(html).not.toMatch(/organization|enterprise|组织|企业/iu);
        expect(request).not.toHaveBeenCalled();
      }
    }
  );
});
