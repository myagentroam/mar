import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

// @test-covers packages/mar-ui/components/tabs/MarTabs.vue
// @test-covers packages/web-core/src/view/settings/MarAgentModelManagementPage.vue
// @test-covers packages/web-core/src/view/skill/SkillCenterPage.vue
// @test-covers packages/web-core/src/view/skill/McpCenterPanel.vue
// @test-covers packages/web-core/src/view/skill/SkillSourceManagementPage.vue
// @test-covers packages/web-core/src/view/skill/McpSourceManagementPage.vue

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

test('Tapping a partially visible management tab reveals its full label', async ({
  browser
}, testInfo) => {
  const page = await browser.newPage({ viewport: { width: 320, height: 820 }, hasTouch: true });
  try {
    await page.goto(
      `${fixture.url}visual-alignment.html?list-hierarchy=mcp-sources&scope-columns&theme=daylight`
    );
    const list = page.getByRole('tablist');
    const tab = list.getByRole('tab', { name: 'Catalog MCP Servers' });
    await expect(tab).toBeVisible();
    const clip = (await list.boundingBox())!;
    const target = (await tab.boundingBox())!;
    const right = clip.x + clip.width;
    expect(target.x).toBeLessThan(right);
    expect(target.x + target.width).toBeGreaterThan(right + 10);

    // Locator.tap() would scroll the tab into view before dispatching the tap.
    await page.touchscreen.tap((target.x + right) / 2, target.y + target.height / 2);
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(tab).toBeInViewport({ ratio: 0.95 });
    await list.screenshot({ path: testInfo.outputPath('catalog-tab-revealed.png') });
  } finally {
    await page.close();
  }
});

for (const [width, theme] of [
  [1280, 'vscode-dark-2026'],
  [320, 'daylight']
] as const) {
  for (const view of ['models', 'skills', 'sources', 'mcp-sources'] as const) {
    test(`${view} uses standard management tabs at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 820 });
      await page.goto(
        `${fixture.url}visual-alignment.html?list-hierarchy=${view}&scope-columns&theme=${theme}`
      );
      const list = page.getByRole('tablist').first();
      const tabs = list.getByRole('tab');
      await expect(tabs).toHaveCount(view === 'models' ? 4 : 2);
      const first = tabs.first();
      const last = tabs.last();
      await expect(first).toHaveAttribute('aria-selected', 'true');
      const { selected, inactive } = await list.evaluate((list) => {
        const probe = document.createElement('span');
        list.append(probe);
        probe.style.color = 'var(--mar-fill-selection)';
        const selected = getComputedStyle(probe).color;
        probe.style.color = 'var(--mar-bg-tab-inactive)';
        const inactive = getComputedStyle(probe).color;
        probe.remove();
        return { selected, inactive };
      });
      const expectTabStrip = async () => {
        const bounds = await list.getByRole('tab').evaluateAll((tabs) =>
          tabs.map((tab) => {
            const { left, right, bottom } = tab.getBoundingClientRect();
            return { left, right, bottom };
          })
        );
        for (let index = 1; index < bounds.length; index += 1) {
          expect(bounds[index]!.left - bounds[index - 1]!.right).toBeCloseTo(-1, 0);
          expect(bounds[index]!.bottom).toBeCloseTo(bounds[0]!.bottom, 0);
        }
        for (const tab of await list.getByRole('tab').all()) {
          await expect(tab).toHaveCSS('border-top-style', 'solid');
          await expect(tab).toHaveCSS('border-top-left-radius', '6px');
          await expect(tab).toHaveCSS('border-bottom-left-radius', '0px');
        }
      };
      await expectTabStrip();
      await expect(first).toHaveCSS('background-color', selected);
      await expect(last).toHaveCSS('background-color', inactive);
      await list.screenshot({ path: testInfo.outputPath(`${view}-tablist.png`) });

      await first.press('End');
      await expect(last).toBeFocused();
      await expect(last).toHaveAttribute('aria-selected', 'true');
      await expect(last).toHaveCSS('background-color', selected);
      await expect(last).toHaveCSS('outline-style', 'solid');
      await expect(last).toBeInViewport({ ratio: 0.95 });
      const panel = page.locator(`[id="${await last.getAttribute('aria-controls')}"]`);

      if (view === 'skills') {
        const mcp = page.locator('.mcp-panel');
        await expect(mcp).toBeVisible();
        const mcpTabs = mcp.getByRole('tablist').getByRole('tab');
        await expect(mcpTabs).toHaveCount(2);
        await mcpTabs.last().click();
        await expect(mcpTabs.last()).toHaveAttribute('aria-selected', 'true');
        await expect(mcpTabs.last()).toHaveCSS('border-top-style', 'solid');
        await expect(mcp.getByPlaceholder('Search MCP servers')).toBeVisible();
      } else {
        await expect(panel).toBeVisible();
      }

      await last.press('Home');
      await expect(first).toBeFocused();
      await expect(first).toHaveAttribute('aria-selected', 'true');
      await expect(panel).toBeHidden();
      if (view === 'skills') await expect(page.locator('.skill-content')).toBeVisible();
    });
  }
}
