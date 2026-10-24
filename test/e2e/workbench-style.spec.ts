import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';
let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

for (const theme of ['daylight', 'vscode-dark-2026']) {
  for (const width of [1280, 390]) {
    test(`Workbench controls preserve selection, spacing and scrolling in ${theme} at ${width}px`, async ({
      page
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.route('**/api/terminals*', (route) =>
        route.fulfill({
          json:
            route.request().method() === 'POST'
              ? {
                  terminal: {
                    id: 'terminal-1',
                    nodeId: 'node',
                    workspaceId: 'workspace',
                    profileId: 'bash',
                    state: 'RUNNING',
                    latestSequence: 0
                  }
                }
              : { terminals: [] }
        })
      );
      await page.goto(`${fixture.url}workbench-style.html?theme=${theme}`);
      const offline = page.locator('.workspace-offline-placeholder');
      await expect(offline).toBeVisible();
      const message = page.locator('.workspace-offline-message');
      expect((await message.boundingBox())!.width).toBeLessThanOrEqual(380);
      const outer = (await offline.boundingBox())!;
      const inner = (await message.boundingBox())!;
      expect(Math.abs(inner.y + inner.height / 2 - outer.y - outer.height / 2)).toBeLessThan(2);
      const tabs = page.getByRole('region', { name: 'Workspace tab fixture' }).getByRole('tab');
      await tabs.nth(1).click();
      await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
      const activeTab = page
        .getByRole('region', { name: 'Workspace tab fixture' })
        .locator('.workspace-tab.active');
      await expect(activeTab).toHaveCSS('border-radius', '6px');
      await expect(activeTab).toHaveCSS('box-shadow', 'none');
      const selected = await activeTab.evaluate(
        (element) => getComputedStyle(element).backgroundColor
      );
      expect(selected).not.toBe('rgba(0, 0, 0, 0)');
      await page.locator('.workspace-group-toggle').click();
      const plain = page.getByRole('button', { name: 'plain', exact: true });
      const grouped = page.getByRole('button', { name: 'grouped', exact: true });
      const indent = (await grouped.boundingBox())!.x - (await plain.boundingBox())!.x;
      expect(indent).toBeCloseTo(16, 0);
      const sessions = page.locator('.session-list');
      await expect(sessions.locator('.session-activity')).toHaveCount(1);
      await expect(sessions.locator('.session-row.selected')).toHaveCSS('border-radius', '6px');
      await expect(sessions.locator('.session-row.selected')).toHaveCSS('box-shadow', 'none');
      const search = page.locator('.session-search-button');
      await search.click();
      await expect(page.getByLabel('Session action')).toHaveText('refresh');
      await page.getByLabel('Set fixture search').fill('review');
      await search.click();
      await expect(page.getByLabel('Session action')).toHaveText('search:review');
      await expect(search).toHaveAccessibleName(/search/iu);
      const picker = page.getByRole('region', { name: 'Workspace picker fixture' });
      await expect(picker.locator('.workspace-picker-toolbar-actions button')).toHaveCount(3);
      for (const button of await picker.locator('.workspace-picker-toolbar-actions button').all()) {
        const bounds = (await button.boundingBox())!;
        expect(bounds.width).toBeGreaterThanOrEqual(28);
        expect(bounds.height).toBeGreaterThanOrEqual(28);
        await expect(button.locator('svg')).toHaveCount(1);
      }
      const strip = page.locator('.inspector-tabs');
      await expect(strip.getByRole('tab')).toHaveCount(4);
      expect(await strip.evaluate((element) => element.scrollWidth >= element.clientWidth)).toBe(
        true
      );
      expect((await strip.boundingBox())!.height).toBeGreaterThan(24);
      await expect(strip).toHaveCSS('overflow-x', 'auto');
      const terminal = page.getByRole('region', { name: 'Terminal fixture' });
      await terminal.getByRole('button', { name: 'Expand terminal', exact: true }).click();
      await terminal.locator('.terminal-tab-add').click();
      await expect(terminal.getByRole('tab', { name: 'Terminal 1', exact: true })).toHaveAttribute(
        'aria-selected',
        'true'
      );
      await expect(terminal.locator('.terminal-tab.active')).toHaveCSS('border-radius', '6px');
      await expect(terminal.locator('.terminal-tab.active')).toHaveCSS('box-shadow', 'none');
      const background = await page.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--mar-terminal-background)';
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });
      await expect(terminal.locator('.admin-terminal-body')).toHaveCSS(
        'background-color',
        background
      );
      await expect(terminal.locator('.xterm-host')).toHaveCSS('background-color', background);
    });
  }
}
