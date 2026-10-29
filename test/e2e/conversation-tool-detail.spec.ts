import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/conversation-tool-detail.html');
});
test.afterAll(async () => {
  await fixture?.close();
});

for (const width of [1280, 390]) {
  test(`execution details, copy and terminal replacement at ${width}px`, async ({
    browser
  }, testInfo) => {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      permissions: ['clipboard-read', 'clipboard-write']
    });
    try {
      const page = await context.newPage();
      await page.goto(`${fixture.url}conversation-tool-detail.html`);
      const exec = page.getByTestId('exec');
      await exec.locator('summary').click();
      await expect(exec).toContainText('visible stdout');
      await expect(exec).toContainText('visible stderr');
      await expect(exec).not.toContainText('combined should not replace streams');
      await exec.getByRole('button', { name: 'Copy public record' }).click();
      await expect(page.getByTestId('copied')).toContainText('exec-a');
      const copied = JSON.parse((await page.getByTestId('copied').textContent()) ?? '{}');
      expect(copied.id).toBe('exec-a');
      expect(copied.payload.command).toBe('printf test');
      await expect(exec.getByRole('status')).toHaveText('Copied');
      await page.getByTestId('empty').locator('summary').click();
      await expect(page.getByTestId('empty')).toContainText('No output');
      await page.getByTestId('wait').locator('summary').click();
      await expect(page.getByTestId('wait')).toContainText('Wait failed');
      await page.getByTestId('declined').locator('summary').click();
      await expect(page.getByTestId('declined')).toContainText('Declined');
      await expect(page.getByTestId('declined')).not.toContainText(
        'toolPresentation.detail.DECLINED'
      );
      await page.getByTestId('finish').click();
      await expect(exec).toContainText('TAIL');
      await expect(exec).toContainText('Output or details may be truncated');
      await expect(exec).not.toContainText('visible stdout');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      );
      await page.screenshot({
        path: testInfo.outputPath(`execution-${width}.png`),
        fullPage: true
      });
      await page.getByTestId('fail-copy').click();
      await exec.getByRole('button', { name: 'Copy public record' }).click();
      await expect(page.getByTestId('copy-error')).toHaveText('true');
    } finally {
      await context.close();
    }
  });
}
