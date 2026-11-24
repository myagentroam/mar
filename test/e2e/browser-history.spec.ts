import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

test('Browser history selects only the current page and clears selection on filter or page change', async ({
  page
}, testInfo) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/browser-history.html');
  try {
    await page.setViewportSize({ width: 390, height: 720 });
    await page.clock.install();
    await page.goto(`${fixture.url}browser-history.html`);
    const history = page.getByRole('dialog', { name: 'Browsing history', exact: true });
    const selectAll = history.getByRole('button', { name: 'Select all on this page' });
    const clearSelection = history.getByRole('button', { name: 'Cancel', exact: true });
    const deleteSelected = history.getByRole('button', { name: 'Delete selected' });
    const checked = history.getByRole('checkbox', { checked: true });
    const search = history.getByRole('textbox', { name: 'Search titles and URLs' });

    await history.getByRole('checkbox', { name: 'Select First page 1', exact: true }).check();
    await selectAll.focus();
    await page.keyboard.press('Enter');
    await expect(checked).toHaveCount(30);
    await expect(selectAll).toBeDisabled();
    await expect(history.getByText('Selected: 30')).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(clearSelection).toBeFocused();
    await history.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(checked).toHaveCount(0);
    await expect(deleteSelected).toHaveCount(0);

    await selectAll.click();
    await expect(checked).toHaveCount(2);
    await clearSelection.click();
    await expect(checked).toHaveCount(0);
    await selectAll.click();
    await expect(checked).toHaveCount(2);
    await history.getByRole('checkbox', { name: 'Select Second page 1', exact: true }).uncheck();
    await expect(selectAll).toBeEnabled();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    await search.fill('first page');
    await expect(history.getByRole('checkbox')).toHaveCount(2);
    await expect(selectAll).toBeDisabled({ timeout: 1500 });
    await expect(deleteSelected).toBeDisabled({ timeout: 1500 });
    await page.clock.runFor(250);
    await page.clock.resume();
    await expect(history.getByRole('checkbox')).toHaveCount(30);
    await expect(checked).toHaveCount(0);
    await selectAll.click();
    await deleteSelected.click();
    const confirm = page.getByRole('dialog', { name: 'Delete browsing history' });
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(checked).toHaveCount(30);
    await expect(search).toHaveValue('first page');
    await history.screenshot({ path: testInfo.outputPath('browser-history-select-all.png') });

    await deleteSelected.click();
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(history.getByText('No matching browsing history.')).toBeVisible();
    await expect(selectAll).toHaveCount(0);
    await search.clear();
    await expect(history.getByRole('checkbox')).toHaveCount(2);
    await expect(history.getByRole('checkbox', { name: 'Select Second page 1' })).toBeVisible();
    await expect(checked).toHaveCount(0);

    await history.getByRole('button', { name: 'Filter by date' }).click();
    const from = history.getByRole('textbox', { name: 'From', exact: true });
    const through = history.getByRole('textbox', { name: 'Through', exact: true });
    await from.fill('2026-01-01');
    await search.focus();
    await selectAll.click();
    await through.fill('2025-12-30');
    await search.focus();
    await expect(history.getByRole('alert')).toHaveText('Enter a valid date range.');
    await expect(deleteSelected).toBeDisabled();
  } finally {
    await fixture.close();
  }
});
