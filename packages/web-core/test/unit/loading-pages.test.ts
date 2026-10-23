import { readFileSync } from 'node:fs';
import { createSSRApp, h, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ElementPlus, { ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus';
import { describe, expect, it } from 'vitest';
import LoadingPanel from '../../src/view/common/LoadingPanel.vue';
import BusyIndicator from '../../src/view/common/BusyIndicator.vue';
import ManagementPagination from '../../src/view/settings/ManagementPagination.vue';

async function render(
  component: Component,
  props: Record<string, unknown>,
  content?: string
): Promise<string> {
  const app = createSSRApp({
    render: () => h(component, props, content ? () => h('input', { value: content }) : undefined)
  });
  app.use(ElementPlus);
  app.provide(ID_INJECTION_KEY, { prefix: 700, current: 0 });
  app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
  return renderToString(app);
}

describe('shared loading presentation', () => {
  it.each(['page', 'region'] as const)(
    'preserves content, caller attributes and busy semantics for %s',
    async (variant) => {
      for (const loading of [true, false]) {
        const html = await render(
          LoadingPanel,
          { variant, loading, 'aria-label': 'Retained content' },
          'Draft value'
        );
        expect(html).toContain('value="Draft value"');
        expect(html).toContain('aria-label="Retained content"');
        expect(html).toContain(`aria-busy="${loading}"`);
        expect(html.includes('element-loading-custom-class="mar-page-loading"')).toBe(
          variant === 'page'
        );
      }
    }
  );

  it('keeps the shared ring decorative rather than creating an interactive or duplicate status', async () => {
    const html = await render(BusyIndicator, {});
    expect(html).toContain('class="busy-indicator"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toMatch(/\b(?:tabindex|role)=/u);
  });

  it('uses one inline ring for automatic management append and leaves the action label intact', async () => {
    const html = await render(ManagementPagination, {
      total: 60,
      page: 1,
      mobile: true,
      mobileVisibleCount: 20,
      loading: true,
      loadingMore: true
    });
    expect(html.match(/class="busy-indicator"/gu)).toHaveLength(1);
    expect(html).toContain('role="status"');
    expect(html).toContain('disabled');
    expect(html).not.toMatch(/\bis-loading\b/u);
  });

  it('does not apply incremental feedback to desktop or cursor pagination', async () => {
    for (const props of [{ mobile: false }, { mobile: true, cursor: { hasNext: true } }]) {
      const html = await render(ManagementPagination, {
        total: 60,
        page: 1,
        mobileVisibleCount: 20,
        loading: true,
        ...props
      });
      expect(html).not.toContain('busy-indicator');
      expect(html).toContain('el-pagination');
    }
  });

  it('disables pagination without an append ring while the loaded directory is refreshing', async () => {
    const html = await render(ManagementPagination, {
      total: 60,
      page: 1,
      mobile: true,
      mobileVisibleCount: 20,
      loading: true,
      loadingMore: false
    });
    expect(html).toContain('disabled');
    expect(html).not.toContain('busy-indicator');
    expect(html).not.toMatch(/\bis-loading\b/u);
  });

  it('does not expose fabricated percentages for indeterminate install progress', () => {
    for (const name of ['McpCenterPanel', 'SkillCenterPage']) {
      const source = readFileSync(
        new URL(`../../src/view/skill/${name}.vue`, import.meta.url),
        'utf8'
      );
      expect(source).toContain('role="progressbar"');
      expect(source).not.toContain('aria-valuenow');
      expect(source).not.toContain('<el-progress');
    }
  });
});
