import { expect, test, type Locator } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

async function expectSquare(control: Locator, size: number): Promise<void> {
  await expect(control).toHaveCSS('width', `${size}px`);
  await expect(control).toHaveCSS('height', `${size}px`);
}

test('Desktop browser page actions use compact buttons and matching icons', async ({
  page
}, testInfo) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/browser-input.html');
  try {
    await page.setViewportSize({ width: 960, height: 700 });
    await page.goto(`${fixture.url}browser-input.html`);
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'vscode-dark-2026';
    });
    const actions = page.getByRole('group', { name: 'Remote page actions' });
    const copy = actions.getByRole('button', { name: 'Copy selected text' });
    const keyboard = actions.getByRole('button', { name: 'Page keyboard mode' });
    const paste = actions.getByRole('button', { name: 'Paste plain text' });
    const info = actions.getByRole('button', { name: 'Browser streaming performance' });
    const collapse = actions.getByRole('button', { name: 'Collapse page actions' });
    const expand = actions.getByRole('button', { name: 'Expand page actions' });
    await expect(actions.getByRole('button')).toHaveCount(5);
    for (const button of [keyboard, copy, paste, info, collapse]) {
      await expectSquare(button, 26);
      await expectSquare(button.locator('svg'), 14);
    }
    const rootFontSize = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).fontSize)
    );
    expect(
      await actions.evaluate((element) => parseFloat(getComputedStyle(element).padding))
    ).toBeCloseTo(rootFontSize * 0.1875, 2);
    const [keyboardBox, copyBox, pasteBox, infoBox, collapseBox] = await Promise.all(
      [keyboard, copy, paste, info, collapse].map((button) => button.boundingBox())
    );
    expect(copyBox!.x - keyboardBox!.x - keyboardBox!.width).toBeCloseTo(rootFontSize * 0.25, 1);
    expect(pasteBox!.x - copyBox!.x - copyBox!.width).toBeCloseTo(rootFontSize * 0.25, 1);
    expect(infoBox!.x - pasteBox!.x - pasteBox!.width).toBeCloseTo(rootFontSize * 0.25, 1);
    expect(collapseBox!.x - infoBox!.x - infoBox!.width).toBeCloseTo(rootFontSize * 0.25, 1);
    await actions.screenshot({ path: testInfo.outputPath('browser-page-actions-desktop.png') });

    await info.press('Enter');
    const panel = page.getByRole('region', { name: 'Browser streaming performance' });
    await expect(panel).toBeVisible();
    await collapse.press('Enter');
    await expect(panel).toBeHidden();
    await expect(actions.getByRole('button')).toHaveCount(1);
    await expectSquare(expand, 26);
    await expand.press('Enter');
    await expect(copy).toBeVisible();
  } finally {
    await fixture.close();
  }
});

test.describe('Browser page actions on a touch device', () => {
  test.use({ viewport: { width: 390, height: 700 }, hasTouch: true, isMobile: true });

  test('keep the existing button size on narrow and wide touch layouts', async ({ page }) => {
    const fixture = await startCustomThemeFixture('test/e2e/support/browser-input.html');
    try {
      await page.goto(`${fixture.url}browser-input.html`);
      const actions = page.getByRole('group', { name: 'Remote page actions' });
      const buttons = actions.getByRole('button');
      for (const width of [390, 960]) {
        await page.setViewportSize({ width, height: 700 });
        await expect(actions.getByRole('button', { name: 'Page keyboard mode' })).toBeVisible();
        await expect(buttons).toHaveCount(5);
        for (const button of await buttons.all()) await expectSquare(button, 36);
      }
    } finally {
      await fixture.close();
    }
  });
});

test('An unavailable browser shows the offline icon instead of page actions', async ({
  page
}, testInfo) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/browser-input.html');
  try {
    await page.goto(`${fixture.url}browser-input.html?offline`);
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'vscode-dark-2026';
    });
    const warning = page.getByRole('alert').filter({ hasText: 'Browser unavailable' });
    await expect(warning).toBeVisible();
    const icon = warning.locator('svg');
    await expect(icon).toHaveAttribute('aria-hidden', 'true');
    await expectSquare(icon, 32);
    await expect(page.getByRole('group', { name: 'Remote page actions' })).toBeHidden();
    await warning.screenshot({ path: testInfo.outputPath('browser-unavailable.png') });
  } finally {
    await fixture.close();
  }
});
