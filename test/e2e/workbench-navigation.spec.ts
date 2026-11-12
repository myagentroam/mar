import { devices, expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/workbench-navigation.html');
});
test.afterAll(async () => {
  await fixture?.close();
});

for (const theme of ['vscode-dark-2026', 'daylight']) {
  test(`Navigation hierarchy preserves selection, focus and actions in ${theme}`, async ({
    page
  }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${fixture.url}workbench-navigation.html?theme=${theme}`);
    const active = page.locator('[data-tab-id="workbench"]');
    const inactive = page.locator('[data-tab-id="protocol"]');
    const button = inactive.getByRole('tab');
    const close = inactive.locator('.tab-close');
    await expect(active.getByRole('tab')).toHaveAttribute('aria-selected', 'true');
    await expect(active.locator('.tab-close')).toHaveCSS('opacity', '1');
    await expect(close).toHaveCSS('opacity', '0');
    const initial = await inactive.boundingBox();
    await button.hover();
    await expect(close).toHaveCSS('opacity', '1');
    await expect(button).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await close.hover();
    await expect(close).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    expect(await inactive.boundingBox()).toEqual(initial);
    await button.click({ button: 'right' });
    await page.mouse.move(1100, 700);
    await expect(close).toHaveCSS('opacity', '1');
    await page.mouse.click(1100, 700);
    await button.click();
    const selectedColor = await inactive.evaluate(
      (element) => getComputedStyle(element).backgroundImage
    );
    await active.getByRole('tab').hover();
    expect(await inactive.evaluate((element) => getComputedStyle(element).backgroundImage)).toBe(
      selectedColor
    );
    await active.getByRole('tab').click();
    await page.mouse.move(1100, 700);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(button).toBeFocused();
    await expect(close).toHaveCSS('opacity', '1');
    await expect(button).toHaveCSS('outline-style', 'solid');
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await expect(close).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(close).toHaveCSS('outline-style', 'solid');
    await page.keyboard.press('Enter');
    await expect(inactive).toHaveCount(0);
    await expect(active.getByRole('tab')).toHaveAttribute('aria-selected', 'true');

    const sessionList = page.locator('.session-list');
    const groups = page.locator('.session-group-tabs');
    await expect(sessionList).toHaveCSS('border-top-width', '0px');
    await expect(groups).toHaveCSS('border-top-width', '0px');
    await expect(groups.locator('.group-options')).toHaveCSS('box-shadow', 'none');
    await groups.locator('[data-group="CHILD"]').click();
    await expect(groups.locator('[data-group="CHILD"]')).toHaveAttribute('aria-selected', 'true');
    await groups.locator('[data-group="MAIN"]').click();
    const otherSession = page.locator('[data-session-id="session-2"]');
    await otherSession.locator('.session-link').click();
    await expect(otherSession).toHaveClass(/selected/);
    await expect(page.locator('[data-session-id="session-1"] .session-activity')).toBeVisible();
    await expect(page.locator('[data-session-id="session-3"] .session-unread-label')).toBeVisible();
    await expect(page.locator('[data-tab-id="docs"] .workspace-tab-unread')).toBeVisible();
    await expect(page.locator('[data-tab-id="workbench"] .workspace-tab-running')).toBeVisible();
    await page.locator('.session-search input').fill('keyboard');
    await page.locator('.session-search input').press('Enter');
    await expect(page.locator('.session-row')).toHaveCount(1);
    await page.locator('.session-search input').fill('');
    await page.locator('.session-search input').press('Enter');
    await expect(page.locator('.session-row')).toHaveCount(5);
    await page.mouse.move(1100, 700);
    await page.screenshot({ path: testInfo.outputPath(`navigation-${theme}.png`) });
    expect(errors).toEqual([]);
  });
}

test('Custom translucent selection and hover are painted once across the whole tab', async ({
  page
}) => {
  await page.goto(`${fixture.url}workbench-navigation.html`);
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--mar-fill-selection', '#34567880');
    document.documentElement.style.setProperty('--mar-fill-row-hover', '#98765440');
  });
  const inactive = page.locator('[data-tab-id="protocol"]');
  const button = inactive.getByRole('tab');
  await button.hover();
  await expect(inactive).toHaveCSS(
    'background-image',
    'linear-gradient(rgba(152, 118, 84, 0.25), rgba(152, 118, 84, 0.25)), none'
  );
  await expect(button).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const close = inactive.locator('.tab-close');
  await close.hover();
  await expect(close).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await button.click();
  await expect(inactive).toHaveCSS(
    'background-image',
    'linear-gradient(rgba(52, 86, 120, 0.5), rgba(52, 86, 120, 0.5)), none'
  );
  await expect(button).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await close.hover();
  await expect(close).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
});

test('Touch navigation keeps close controls available and long titles bounded', async ({
  browser
}, testInfo) => {
  const context = await browser.newContext({ ...devices['Pixel 7'] });
  try {
    const page = await context.newPage();
    await page.goto(`${fixture.url}workbench-navigation.html?mobile&locale=zh-CN`);
    const close = page.locator('[data-tab-id="protocol"] .tab-close');
    await expect(close).toHaveCSS('opacity', '1');
    await close.tap();
    await expect(page.locator('[data-tab-id="protocol"]')).toHaveCount(0);
    await expect(page.locator('[data-tab-id="workbench"] .tab-close')).toHaveCSS('opacity', '1');
    const last = page.locator('.session-row').last();
    const bounds = await last.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await expect(last.locator('strong')).toHaveCSS('text-overflow', 'ellipsis');
    await page.screenshot({ path: testInfo.outputPath('navigation-mobile.png') });
  } finally {
    await context.close();
  }
});

for (const [width, theme] of [
  [1280, 'vscode-dark-2026'],
  [390, 'daylight']
] as const) {
  test(`Wide conversation content stays readable without widening the work surface at ${width}px`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${fixture.url}workbench-navigation.html?wide-content&theme=${theme}`);
    const markdown = page.locator('.agent-markdown');
    await expect(markdown.getByRole('heading', { name: 'Content layout review' })).toBeVisible();
    const code = markdown.locator('pre');
    const table = markdown.locator('table');
    for (const name of [
      'Unchanged',
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    ]) {
      const cell = table.getByRole('cell', { name, exact: true });
      const lines = await cell.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return new Set(
          [...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => rect.top)
        ).size;
      });
      expect(lines, `Keep the table value intact: ${name}`).toBe(1);
    }
    for (const content of [code, table]) {
      const bounds = (await content.boundingBox())!;
      const pane = (await page.locator('.reading-pane').boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(pane.x);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(pane.x + pane.width);
    }
    for (const content of [code, table]) {
      expect(await content.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
        true
      );
      await content.evaluate((element) => {
        element.scrollLeft = 200;
      });
      expect(await content.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
      await content.evaluate((element) => {
        element.scrollLeft = 0;
      });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width
    );
    await expect(markdown).toContainText('preserveReadingPosition: true');
    await page.screenshot({ path: testInfo.outputPath(`wide-content-${width}.png`) });
  });
}
