import { expect, test, type Page } from '@playwright/test';
import type { BrowserDownloadInfo } from '../../packages/protocol/src/index.js';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

async function update(
  page: Page,
  detail: {
    revision: number;
    id?: string;
    status?: 'connecting' | 'ready';
    items?: BrowserDownloadInfo[];
  }
): Promise<void> {
  await page.evaluate((detail) => {
    document.dispatchEvent(new CustomEvent('fixture-download-update', { detail }));
  }, detail);
}

test('Browser signals download activity at the toolbar without interrupting page input', async ({
  page
}) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/browser-downloads.html');
  try {
    await page.setViewportSize({ width: 390, height: 700 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.clock.install();
    await page.goto(`${fixture.url}browser-downloads.html`);
    const button = page.getByRole('button', { name: 'Downloads', exact: true });
    const commands = page.getByRole('button', { name: 'Browser commands' });
    const hint = page.getByRole('status').filter({ hasText: 'Download list updated' });
    const dialog = page.getByRole('dialog', { name: 'Downloads' });
    const address = page.getByRole('textbox', { name: 'Address', exact: true });

    await expect(button).toBeVisible();
    const buttonRect = (await button.boundingBox())!;
    const menuRect = (await commands.boundingBox())!;
    expect(buttonRect.x + buttonRect.width).toBeLessThan(menuRect.x);
    expect(buttonRect.y).toBe(menuRect.y);
    await commands.click();
    await expect(page.getByRole('menuitem', { name: 'Downloads' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await address.focus();
    await expect(hint).toHaveCount(0);

    await update(page, { revision: 6 });
    await expect(hint).toBeVisible();
    await expect(hint.getByText('Download list updated')).toHaveCSS('animation-name', 'none');
    const hintRect = (await hint.boundingBox())!;
    expect(hintRect.x).toBeGreaterThanOrEqual(0);
    expect(hintRect.x + hintRect.width).toBeLessThanOrEqual(390);
    expect(hintRect.y).toBeGreaterThan(buttonRect.y + buttonRect.height);
    await expect(address).toBeFocused();
    await expect(dialog).toHaveCount(0);

    await page.clock.runFor(2600);
    await expect(hint).toHaveCount(0);
    await update(page, { revision: 10, status: 'connecting' });
    await expect(button).toBeDisabled();
    await update(page, { revision: 11, status: 'ready' });
    await expect(button).toBeEnabled();
    await expect(hint).toHaveCount(0);
    await update(page, { revision: 12, id: 'browser-b' });
    await expect(hint).toHaveCount(0);

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await update(page, { revision: 13 });
    await expect(hint.getByText('Download list updated')).toHaveCSS(
      'animation-name',
      /download-arrive/u
    );
    await button.click();
    await expect(dialog).toBeVisible();
    await expect(hint).toHaveCount(0);
    await update(page, { revision: 14 });
    await expect(hint).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(button).toBeFocused();
  } finally {
    await fixture.close();
  }
});

test('Browser shows indeterminate progress only while each Node download is active', async ({
  page
}) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/browser-downloads.html');
  try {
    await page.goto(`${fixture.url}browser-downloads.html`);
    const button = page.getByRole('button', { name: 'Downloads', exact: true });
    await expect(button).toBeVisible();
    const pending = { id: 'pending', name: 'slow.bin', state: 'downloading' } as const;
    const completing = { id: 'completing', name: 'finish.bin', state: 'downloading' } as const;
    await update(page, { revision: 6, items: [pending, completing] });
    await button.click();
    const dialog = page.getByRole('dialog', { name: 'Downloads' });
    const row = dialog.getByRole('listitem').filter({ hasText: pending.name });
    const bar = row.getByRole('progressbar', { name: /Downloading.*slow\.bin/u });
    await expect(bar).toBeVisible();
    expect(await bar.getAttribute('value')).toBeNull();
    expect(await bar.getAttribute('aria-valuenow')).toBeNull();
    await expect(dialog.getByRole('progressbar')).toHaveCount(2);

    await update(page, {
      revision: 7,
      items: [pending, { ...completing, state: 'ready', size: 1234 }]
    });
    const ready = dialog.getByRole('listitem').filter({ hasText: completing.name });
    await expect(ready.getByRole('link', { name: 'Save to device' })).toHaveAttribute(
      'href',
      '/fixture-download/completing'
    );
    await expect(ready.getByRole('progressbar')).toHaveCount(0);
    await row.getByRole('button', { name: 'Cancel' }).click();
    await expect(row.getByText('Canceled')).toBeVisible();
    await expect(dialog.getByRole('progressbar')).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});
