import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

test('Aside uses shared tabs for tool, session and stable Terminal surfaces', async ({ page }) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/workbench-aside.html');
  try {
    await page.goto(`${fixture.url}workbench-aside.html`);
    const tabs = page.getByRole('tablist', { name: 'Workbench Aside' });
    await expect(tabs.locator('.tab-strip-separator')).toHaveCount(1);
    for (const tab of await tabs.getByRole('tab').all()) {
      expect(
        await tab.evaluate((el) => {
          const panel = document.getElementById(el.getAttribute('aria-controls') ?? '');
          return Boolean(
            el.id &&
            panel?.getAttribute('role') === 'tabpanel' &&
            panel.getAttribute('aria-labelledby') === el.id
          );
        })
      ).toBe(true);
    }
    await expect(tabs.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#tool')).toHaveText('Tool files');
    await page.getByLabel('Inspector draft').fill('unsaved edit');
    const childIds = await tabs.getByRole('tab', { name: 'Child' }).evaluate((el) => ({
      id: el.id,
      controls: el.getAttribute('aria-controls')
    }));
    await tabs.getByRole('tab', { name: 'Child' }).click();
    await expect(page.locator('#session')).toHaveText('Session child');
    await tabs.getByRole('tab', { name: 'Terminal' }).click();
    await expect(page.locator('#terminal')).toBeVisible();
    await expect(page.locator('#terminal')).toHaveAttribute('data-mounts', '1');
    await tabs.getByRole('tab', { name: 'Search' }).click();
    await expect(page.getByLabel('Inspector draft')).toHaveValue('unsaved edit');
    await expect(page.locator('#tool')).toHaveAttribute('data-mounts', '1');
    await expect(page.locator('#terminal')).toBeHidden();
    expect(
      await tabs.getByRole('tab', { name: 'Child' }).evaluate((el) => ({
        id: el.id,
        controls: el.getAttribute('aria-controls')
      }))
    ).toEqual(childIds);
    await tabs.getByRole('tab', { name: 'Terminal' }).click();
    await expect(page.locator('#terminal')).toHaveAttribute('data-mounts', '1');
    await tabs.getByRole('button', { name: 'Close Child' }).click();
    await expect(tabs.getByRole('tab', { name: 'Child' })).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});

test('Shared TabStrip skips disabled tabs and exposes close intent independently', async ({
  page
}) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/workbench-aside.html');
  try {
    await page.goto(`${fixture.url}workbench-aside.html`);
    const tabs = page.getByRole('tablist', { name: 'Generic tabs' });
    await tabs.getByRole('tab', { name: 'One' }).focus();
    await page.keyboard.press('Alt+ArrowRight');
    await expect(tabs.getByRole('tab', { name: 'One' })).toBeFocused();
    await expect(page.locator('#activations')).toHaveText('0');
    await page.keyboard.press('ArrowRight');
    await expect(tabs.getByRole('tab', { name: 'Last' })).toBeFocused();
    await expect(tabs.getByRole('tab', { name: 'One' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#activations')).toHaveText('0');
    await page.keyboard.press('Enter');
    await expect(tabs.getByRole('tab', { name: 'Last' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#activations')).toHaveText('1');
    await page.keyboard.press('Home');
    await expect(tabs.getByRole('tab', { name: 'One' })).toBeFocused();
    await expect(tabs.getByRole('tab', { name: 'Last' })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Space');
    await expect(tabs.getByRole('tab', { name: 'One' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#activations')).toHaveText('2');
    await tabs.getByRole('button', { name: 'Close Last' }).click();
    await expect(page.locator('#closed')).toHaveText('c');
    await expect(tabs.getByRole('tab', { name: 'One' })).toHaveAttribute('aria-selected', 'true');
  } finally {
    await fixture.close();
  }
});

test('restores an overflowed active tab and returns focus after closing it', async ({ page }) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/workbench-aside.html');
  try {
    await page.goto(`${fixture.url}workbench-aside.html?active-child`);
    const tabs = page.getByRole('tablist', { name: 'Workbench Aside' });
    const child = tabs.getByRole('tab', { name: 'Child' });
    await expect(child).toHaveAttribute('aria-selected', 'true');
    expect(await tabs.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await expect.poll(() => tabs.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    await expect
      .poll(() =>
        child.evaluate((el) => {
          const bounds = el.getBoundingClientRect();
          const parent = el.closest('[role=tablist]')!.getBoundingClientRect();
          return bounds.left >= parent.left && bounds.right <= parent.right;
        })
      )
      .toBe(true);
    const close = tabs.getByRole('button', { name: 'Close Child' });
    await close.focus();
    await page.keyboard.press('Enter');
    await expect(child).toHaveCount(0);
    await expect(tabs.getByRole('tab', { name: 'Files' })).toBeFocused();
  } finally {
    await fixture.close();
  }
});
