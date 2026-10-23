import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

test('Application bootstrap remains until the selected asynchronous page resolves', async ({
  page
}) => {
  await page.goto(`${fixture.url}app-shell.html`);
  await expect(page.locator('#mar-bootstrap')).toBeVisible();
  await expect(page.getByTestId('workbench')).toHaveCount(0);
  await page.locator('#resolve-page').click();
  await expect(page.getByTestId('workbench')).toBeVisible();
  await expect(page.locator('#mar-bootstrap')).toHaveCount(0);
  await page.goto(`${fixture.url}app-shell.html?standaloneFile=1&markdownPreview=1`);
  await expect(page.getByTestId('preview')).toBeVisible();
  await expect(page.getByTestId('workbench')).toHaveCount(0);
  await expect(page.locator('#mar-bootstrap')).toHaveCount(0);
});

test('Application context menus preserve editing, media and touch defaults', async ({ page }) => {
  await page.goto(`${fixture.url}app-shell.html`);
  await page.locator('#resolve-page').click();
  await expect(page.getByTestId('workbench')).toBeVisible();
  for (const id of [
    'ordinary',
    'noneditable',
    'input',
    'textarea',
    'select',
    'editable',
    'image',
    'video',
    'audio'
  ]) {
    const prevented = await page.locator(`#${id}`).evaluate((target) => {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(prevented, id).toBe(id === 'ordinary' || id === 'noneditable');
  }
  expect(
    await page.locator('#ordinary').evaluate((target) => {
      const event = new PointerEvent('contextmenu', {
        pointerType: 'touch',
        bubbles: true,
        cancelable: true
      });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    })
  ).toBe(false);
});
