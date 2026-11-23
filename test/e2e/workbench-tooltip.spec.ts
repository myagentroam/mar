import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

test('New session shows the same shortcut hint on hover and keyboard focus', async ({ page }) => {
  await page.goto(`${fixture.url}workbench-style.html?list-state=main&locale=en-US`);
  const sidebar = page.getByRole('region', { name: 'Session fixture' });
  const create = sidebar.getByRole('button', { name: 'New session', exact: true });
  const tooltip = page.getByRole('tooltip');
  const hint = 'New session (Alt+N / Ctrl+N)';
  await create.hover();
  await expect(tooltip).toHaveText(hint);
  await page.mouse.move(0, 0);
  await expect(tooltip).toHaveCount(0);

  await sidebar.locator('.session-search-button').press('Tab');
  await expect(create).toBeFocused();
  await expect(tooltip).toHaveText(hint);
  await create.press('Escape');
  await expect(tooltip).toHaveCount(0);
  await expect(create).toBeFocused();
});

test('Only the active workspace close button advertises the close shortcut', async ({ page }) => {
  await page.goto(`${fixture.url}workbench-style.html?locale=en-US`);
  const strip = page.getByRole('region', { name: 'Workspace tab fixture' });
  const tab = (selected: boolean) => strip.getByRole('tab', { selected }).first();
  const close = (selected: boolean) =>
    tab(selected)
      .locator('..')
      .getByRole('button', { name: /^Close / });
  await tab(false).hover();
  await close(false).hover();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toHaveText((await close(false).getAttribute('aria-label'))!);
  await close(true).hover();
  await expect(tooltip).toHaveText(
    `${await close(true).getAttribute('aria-label')} (Alt+W / Ctrl+W)`
  );
});

test.describe('Touch workspace actions', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('The first tap opens workspace actions instead of a tooltip', async ({ page }) => {
    await page.goto(`${fixture.url}workbench-style.html?list-state=main&locale=en-US`);
    const sidebar = page.getByRole('region', { name: 'Session fixture' });
    await sidebar.getByRole('button', { name: 'More workspace actions' }).tap();
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.getByRole('tooltip')).toHaveCount(0);
  });
});

test('The advertised Mac model shortcut opens the menu without inserting the Option character', async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
  });
  await page.goto(`${fixture.url}workbench-style.html?composer=1&locale=en-US`);
  const model = page.locator('.composer-model-effort-select [role=combobox]');
  await model.hover();
  await expect(page.getByRole('tooltip')).toContainText('Option+M');
  const composer = page.locator('.composer textarea');
  await composer.fill('kept draft');
  await composer.dispatchEvent('keydown', {
    key: 'µ',
    code: 'KeyM',
    altKey: true,
    bubbles: true,
    cancelable: true
  });
  await expect(model).toBeFocused();
  await expect(model).toHaveAttribute('aria-expanded', 'true');
  await expect(composer).toHaveValue('kept draft');
});
