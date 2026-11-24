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
    activeCount?: number | null;
    startedCount?: number | null;
    listDelay?: number;
    failList?: boolean;
    failDelete?: boolean;
  }
): Promise<void> {
  await page.evaluate((detail) => {
    document.dispatchEvent(new CustomEvent('fixture-download-update', { detail }));
  }, detail);
}

test('Browser confirms a Workspace destination and distinguishes conflicts from unknown outcomes', async ({
  page
}) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/browser-downloads.html');
  try {
    await page.goto(`${fixture.url}browser-downloads.html?workspaceSave`);
    await update(page, {
      revision: 5,
      items: [{ id: 'ready', name: 'report.bin', state: 'ready', size: 3 }]
    });
    await page.getByRole('button', { name: 'Downloads', exact: true }).click();
    const list = page.getByRole('dialog', { name: 'Downloads' });
    const save = list.getByRole('button', { name: 'Save to Workspace' });
    const prompt = page.getByRole('dialog', { name: 'Save to Workspace' });
    const path = prompt.getByRole('textbox');
    const confirm = prompt.getByRole('button', { name: 'Save to Workspace' });
    await save.click();
    await expect(path).toHaveValue('report.bin');
    await prompt.getByRole('button', { name: 'Cancel' }).click();
    await expect(prompt).toHaveCount(0);
    await expect(save).toBeFocused();
    for (const text of [
      'Saved to Workspace: reports/result.bin',
      'A file already exists at this path. Choose a different name.'
    ]) {
      await save.click();
      await path.fill('reports/result.bin');
      await confirm.click();
      await expect(list.getByText(text, { exact: true })).toBeVisible();
    }
    await save.click();
    await path.fill('reports/slow.bin');
    await confirm.click();
    await expect(list.getByRole('alert')).toHaveText(
      'Could not confirm the save. Check whether reports/slow.bin is complete before retrying.'
    );
    await expect(list.getByRole('link', { name: 'Save to device' })).toBeVisible();
  } finally {
    await fixture.close();
  }
});

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
    const badge = page.locator('.node-browser-download-badge');
    const dialog = page.getByRole('dialog', { name: 'Downloads' });
    const address = page.getByRole('combobox', { name: 'Address', exact: true });

    await expect(button).toBeVisible();
    const buttonRect = (await button.boundingBox())!;
    const menuRect = (await commands.boundingBox())!;
    expect(buttonRect.x + buttonRect.width).toBeLessThan(menuRect.x);
    expect(buttonRect.y).toBe(menuRect.y);
    await commands.click();
    await expect(page.getByRole('menuitem', { name: 'Downloads' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await address.focus();
    await expect(badge).toHaveCount(0);

    const started = page.getByText('Download started', { exact: true });
    await update(page, { revision: 5, activeCount: 0, startedCount: 3 });
    await expect(started).toHaveCount(0);
    await update(page, { revision: 6, activeCount: 2, startedCount: 5 });
    await expect(started).toHaveCount(1);
    await expect(badge).toHaveText('2');
    await expect(button).toHaveAccessibleDescription('2 active downloads');
    const badgeRect = (await badge.boundingBox())!;
    expect(badgeRect.x).toBeGreaterThan(buttonRect.x);
    expect(badgeRect.y).toBeLessThan(buttonRect.y);
    expect(badgeRect.x + badgeRect.width).toBeLessThanOrEqual(390);
    await expect(address).toBeFocused();
    await expect(dialog).toHaveCount(0);

    await page.clock.runFor(2600);
    await expect(started).toHaveCount(0);
    await expect(badge).toHaveText('2');
    await update(page, { revision: 10, status: 'connecting', activeCount: 2, startedCount: null });
    await expect(button).toBeDisabled();
    await expect(badge).toHaveCount(0);
    await update(page, { revision: 11, status: 'ready', activeCount: 1, startedCount: 7 });
    await expect(button).toBeEnabled();
    await expect(button).toHaveAccessibleDescription('1 active download');
    await update(page, { revision: 12, id: 'browser-b', activeCount: 0, startedCount: 8 });
    await expect(badge).toHaveCount(0);
    await expect(started).toHaveCount(0);
    await button.click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(button).toBeFocused();
    await update(page, { revision: 13, startedCount: 9, activeCount: 0 });
    await expect(started).toHaveCount(1);
    await expect(badge).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});

test('Browser shows received bytes, a determinate bar when size is known, and completion', async ({
  page
}, testInfo) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/browser-downloads.html');
  try {
    await page.goto(`${fixture.url}browser-downloads.html`);
    const button = page.getByRole('button', { name: 'Downloads', exact: true });
    await expect(button).toBeVisible();
    const pending = { id: 'pending', name: 'slow.bin', state: 'downloading' } as const;
    const completing = { id: 'completing', name: 'finish.bin', state: 'downloading' } as const;
    await update(page, { revision: 6, items: [pending, completing], listDelay: 250 });
    await button.click();
    const dialog = page.getByRole('dialog', { name: 'Downloads' });
    const row = dialog.getByRole('listitem').filter({ hasText: pending.name });
    const bar = row.getByRole('progressbar', { name: /Downloading.*slow\.bin/u });
    await expect(bar).toBeVisible();
    expect(await bar.getAttribute('value')).toBeNull();
    expect(await bar.getAttribute('aria-valuenow')).toBeNull();
    await expect(dialog.getByRole('progressbar')).toHaveCount(2);
    const statusBox = (await row.getByText('Downloading…', { exact: true }).boundingBox())!;
    const progressBox = (await bar.boundingBox())!;
    const cancelBox = (await row.getByRole('button', { name: 'Cancel' }).boundingBox())!;
    expect(progressBox.y).toBeGreaterThanOrEqual(statusBox.y + statusBox.height);
    expect(progressBox.x + progressBox.width).toBeLessThan(cancelBox.x);

    // Revisions arriving during the list request must not starve it by aborting.
    await update(page, { revision: 7, items: [{ ...pending, receivedBytes: 512 }, completing] });
    await update(page, { revision: 8, items: [{ ...pending, receivedBytes: 1024 }, completing] });
    await expect(row.getByText('1 KB downloaded', { exact: true })).toBeVisible();
    expect(await bar.getAttribute('value')).toBeNull();
    await update(page, {
      revision: 9,
      items: [{ ...pending, receivedBytes: 1024, totalBytes: 4096 }, completing]
    });
    await expect(bar).toHaveAttribute('value', '25');
    await expect(bar).toHaveAttribute('aria-valuetext', '1 KB of 4 KB downloaded');
    await dialog.screenshot({ path: testInfo.outputPath('browser-download-progress.png') });

    await update(page, {
      revision: 10,
      items: [pending, { ...completing, state: 'ready', size: 1234 }]
    });
    const ready = dialog.getByRole('listitem').filter({ hasText: completing.name });
    const save = ready.getByRole('link', { name: 'Save to device' });
    await expect(save).toHaveAttribute('href', '/fixture-download/completing');
    await expect(save).toHaveAttribute('download', '');
    await expect(save).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
    await expect(save.locator('svg')).toHaveCount(0);
    await expect(ready.getByRole('progressbar')).toHaveCount(0);
    await expect(ready.getByText('1.21 KB')).toBeVisible();
    await expect(ready.getByText('Ready to save')).toHaveCount(0);
    await row.getByRole('button', { name: 'Cancel' }).click();
    await expect(row.getByText('Canceled')).toBeVisible();
    await expect(dialog.getByRole('progressbar')).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});

test('Browser loads paused download progress once the attachment subscription is confirmed', async ({
  page
}) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/browser-downloads.html');
  try {
    await page.goto(`${fixture.url}browser-downloads.html?negotiateProgress`);
    await update(page, {
      revision: 4,
      items: [
        {
          id: 'paused',
          name: 'paused.bin',
          state: 'downloading',
          receivedBytes: 1024,
          totalBytes: 4096
        }
      ]
    });
    await page.getByRole('button', { name: 'Downloads', exact: true }).click();
    const bar = page.getByRole('dialog', { name: 'Downloads' }).getByRole('progressbar');
    await expect(bar).toBeVisible();
    expect(await bar.getAttribute('value')).toBeNull();

    // Subscription starts projecting the counter but does not change the download revision.
    await update(page, { revision: 4, startedCount: 1 });
    await expect(bar).toHaveAttribute('value', '25');
    await expect(page.getByText('Download started', { exact: true })).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});

test('Browser confirms removing completed files, supports retry and removes ended records', async ({
  page
}) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/browser-downloads.html');
  try {
    await page.goto(`${fixture.url}browser-downloads.html`);
    const items = [
      { id: 'ready', name: 'archive.zip', state: 'ready', size: 0 },
      { id: 'fail', name: 'connection-lost.zip', state: 'failed' },
      { id: 'cancel', name: 'canceled.zip', state: 'canceled' }
    ] satisfies BrowserDownloadInfo[];
    await expect(page.getByRole('button', { name: 'Downloads', exact: true })).toBeEnabled();
    await update(page, { revision: 6, items, activeCount: null });
    await page.getByRole('button', { name: 'Downloads', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Downloads', exact: true });
    const ready = dialog.getByRole('listitem').filter({ hasText: 'archive.zip' });
    await expect(ready.getByText('0 B')).toBeVisible();
    await expect(ready.getByRole('button', { name: 'Delete download' })).toHaveCount(0);
    await update(page, { revision: 7, failDelete: true });
    const deletion = ready.getByRole('button', { name: 'Delete download' });
    await deletion.click();
    const confirm = page.getByRole('dialog', { name: 'Delete download' });
    await expect(confirm.getByText(/copy you saved to your device will be kept/u)).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(ready).toBeVisible();
    await deletion.click();
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(ready.getByRole('alert')).toHaveText('Could not delete this download.');
    await expect(ready.getByRole('link', { name: 'Save to device' })).toBeVisible();
    await update(page, { revision: 8, failDelete: false });
    await deletion.click();
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(ready).toHaveCount(0);
    for (const [file, label] of [
      ['connection-lost.zip', 'Failed'],
      ['canceled.zip', 'Canceled']
    ]) {
      const row = dialog.getByRole('listitem').filter({ hasText: file });
      await expect(row.getByText(label!, { exact: true })).toBeVisible();
      await expect(row.getByRole('link')).toHaveCount(0);
      await row.getByRole('button', { name: 'Delete download' }).click();
      await expect(row).toHaveCount(0);
    }
    await expect(dialog.getByText('No downloads')).toBeVisible();
  } finally {
    await fixture.close();
  }
});

test('Browser offers download list retry only while connected', async ({ page }) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/browser-downloads.html');
  try {
    await page.goto(`${fixture.url}browser-downloads.html`);
    const button = page.getByRole('button', { name: 'Downloads', exact: true });
    await expect(button).toBeEnabled();
    await update(page, { revision: 6, failList: true });
    await button.click();
    const dialog = page.getByRole('dialog', { name: 'Downloads', exact: true });
    const retry = dialog.getByRole('button', { name: /^(Reconnect|Retry)$/u });
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(retry).toBeEnabled();
    await expect(retry).toHaveText('Retry');

    await update(page, { revision: 6, status: 'connecting' });
    await expect(dialog.getByRole('status')).toBeVisible();
    await expect(retry).toHaveCount(0);

    await update(page, { revision: 6, status: 'ready' });
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(retry).toBeEnabled();
    await update(page, { revision: 6, failList: false });
    await retry.click();
    await expect(dialog.getByText('No downloads')).toBeVisible();
    await expect(retry).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});

test('Browser download states fit dark desktop and light narrow dialogs', async ({
  page
}, testInfo) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/browser-downloads.html');
  try {
    await page.setViewportSize({ width: 960, height: 680 });
    await page.goto(`${fixture.url}browser-downloads.html?locale=zh-CN`);
    await page.evaluate(() => (document.documentElement.dataset.theme = 'vscode-dark-2026'));
    const downloads = page.getByRole('button', { name: '下载', exact: true });
    await expect(downloads).toBeEnabled();
    const items = [
      { id: 'pending-a', name: 'workspace-backup.zip', state: 'downloading' },
      { id: 'pending-b', name: 'reference-assets.tar.gz', state: 'downloading' },
      { id: 'ready', name: 'release-notes.pdf', state: 'ready', size: 482_345 },
      { id: 'failed', name: 'interrupted-recording.mp4', state: 'failed' },
      { id: 'canceled', name: 'old-export.zip', state: 'canceled' }
    ] satisfies BrowserDownloadInfo[];
    await update(page, { revision: 6, items });
    await expect(downloads).toHaveAccessibleDescription('2 个下载进行中');
    await page
      .locator('.node-browser-toolbar')
      .screenshot({ path: testInfo.outputPath('01-badge.png') });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await downloads.click();
    const dialog = page.getByRole('dialog', { name: '下载', exact: true });
    const panel = dialog.locator('.mar-ui-dialog');
    await expect(dialog.getByRole('listitem')).toHaveCount(items.length);
    const segment = panel.locator('.mar-ui-progress__segment').first();
    await expect(segment).toBeVisible();
    await expect(segment).toHaveCSS('animation-name', 'none');
    await panel.screenshot({
      path: testInfo.outputPath('02-download-states.png'),
      animations: 'disabled'
    });
    await dialog
      .getByRole('listitem')
      .filter({ hasText: items[2]!.name })
      .getByRole('button', { name: '删除下载' })
      .click();
    const confirm = page.getByRole('dialog', { name: '删除下载' });
    await expect(confirm).toBeVisible();
    await confirm.locator('.mar-ui-dialog').screenshot({
      path: testInfo.outputPath('03-delete-confirmation.png'),
      animations: 'disabled'
    });
    await confirm.getByRole('button', { name: '取消', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 740 });
    await page.evaluate(() => (document.documentElement.dataset.theme = 'daylight'));
    const box = (await panel.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(16);
    expect(box.x + box.width).toBeLessThanOrEqual(374);
    expect(await panel.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(box.width);
    await panel.screenshot({
      path: testInfo.outputPath('04-mobile-download-states.png'),
      animations: 'disabled'
    });
    await update(page, { revision: 7, items: [] });
    await expect(dialog.getByRole('listitem')).toHaveCount(0);
    await panel.screenshot({ path: testInfo.outputPath('05-empty.png'), animations: 'disabled' });
  } finally {
    await fixture.close();
  }
});
