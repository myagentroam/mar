import { expect, test, type Locator } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

async function sidebarGeometry(sidebar: Locator) {
  return sidebar.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      left: rect.left,
      top: rect.top,
      bottom: innerHeight - rect.bottom,
      width: rect.width,
      radius: style.borderTopLeftRadius,
      background: style.backgroundColor,
      border: style.borderRightColor
    };
  });
}

for (const theme of ['daylight', 'vscode-dark-2026']) {
  test(`Hosted history shares the desktop resource sidebar shell in ${theme}`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(
      `${fixture.url}workbench-mobile-drawer.html?tree-reveal&theme=${theme}&locale=en-US`
    );
    const tree = page.locator('.workspace-tree');
    await expect(tree).toBeVisible();
    const geometry = await sidebarGeometry(tree);
    expect(geometry.top).toBeGreaterThan(0);
    expect(geometry.bottom).toBeCloseTo(geometry.top, 1);
    expect(parseFloat(geometry.radius)).toBeGreaterThan(0);
    const buttons = page.locator('.activity-rail nav > button');
    for (const button of await buttons.all()) {
      const bounds = (await button.boundingBox())!;
      const rail = (await page.locator('.activity-rail').boundingBox())!;
      expect(bounds.width).toBeCloseTo(bounds.height, 1);
      expect(bounds.x - rail.x).toBeCloseTo(rail.x + rail.width - bounds.x - bounds.width, 1);
      expect(bounds.x).toBeGreaterThan(rail.x);
    }
    await page.screenshot({
      path: testInfo.outputPath(`resource-sidebar-${theme}.png`),
      clip: { x: 0, y: 0, width: Math.ceil(geometry.left + geometry.width), height: 900 }
    });
    await page.getByRole('button', { name: 'Toggle resource sidebar', exact: true }).click();
    await expect(tree).toBeHidden();
    await page.getByRole('button', { name: 'Toggle resource sidebar', exact: true }).click();
    await expect(tree).toBeVisible();
    await expect.poll(() => sidebarGeometry(tree)).toEqual(geometry);

    await page.route('**/api/**', (route) =>
      route.fulfill({ json: { items: [], nextCursor: null } })
    );
    await page.goto(`${fixture.url}hosted-entry.html?workspace-page&theme=${theme}`);
    const history = page.locator('.hosted-conversation-history');
    await expect(history).toBeVisible();
    expect(await sidebarGeometry(history)).toEqual(geometry);
    const header = (await history.locator('.history-header').boundingBox())!;
    expect(header.y).toBeCloseTo(geometry.top, 1);
    await history.screenshot({ path: testInfo.outputPath(`hosted-history-${theme}.png`) });

    await page.goto(
      `${fixture.url}hosted-entry.html?workspace-page&sidebar-collapsed&theme=${theme}`
    );
    await expect(history).toBeHidden();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${fixture.url}hosted-entry.html?workspace-page&history-open&theme=${theme}`);
    await expect(history).toBeVisible();
    const mobile = await sidebarGeometry(history);
    expect(mobile.left).toBe(0);
    expect(mobile.bottom).toBe(0);
    expect(mobile.width).toBeLessThan(390);
    expect(mobile.radius).toBe('0px');
    await page.screenshot({ path: testInfo.outputPath(`hosted-history-mobile-${theme}.png`) });
  });

  for (const placement of ['header', 'body']) {
    test(`Inactive Workspace Tabs blend into the ${placement} strip in ${theme}`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(
        `${fixture.url}workspace-tabs.html?layout=boundary&placement=${placement}&theme=${theme}&locale=en-US`
      );
      const tabs = page.locator('.workspace-tab');
      const pinned = tabs.nth(1);
      const inactive = tabs.nth(2);
      const active = tabs.first();
      await expect(pinned).toHaveClass(/sticky-pinned/);
      await page.mouse.move(1200, 800);
      for (const tab of [pinned, inactive]) {
        await expect(tab).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(tab).toHaveCSS('background-image', 'none');
      }
      await expect(active).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await inactive.hover();
      await expect(inactive).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await inactive.locator('[role="tab"]').focus();
      await expect(inactive.locator('[role="tab"]')).toBeFocused();
      await inactive.locator('[role="tab"]').press('Enter');
      await expect(inactive.locator('[role="tab"]')).toHaveAttribute('aria-selected', 'true');
      await page.mouse.move(1200, 800);
      await expect(active).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      const strip = page.locator('.workspace-tabs');
      await strip.evaluate((element) => {
        element.scrollLeft = 120;
      });
      await expect.poll(() => strip.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
      const pinBounds = (await pinned.boundingBox())!;
      const tabBounds = (await inactive.boundingBox())!;
      const overlap = Math.min(pinBounds.x + pinBounds.width - 1, tabBounds.x + 12);
      expect(
        await page.evaluate(
          ({ x, y }) =>
            document
              .elementFromPoint(x, y)
              ?.closest('.workspace-tab')
              ?.classList.contains('sticky-pinned'),
          { x: overlap, y: pinBounds.y + pinBounds.height / 2 }
        )
      ).toBe(true);
      await page.locator('.workspace-tab-strip').screenshot({
        path: testInfo.outputPath(`workspace-tabs-${placement}-${theme}.png`)
      });
    });
  }
}
