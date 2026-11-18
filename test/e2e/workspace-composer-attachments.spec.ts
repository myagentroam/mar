import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

// @test-covers packages/web-core/src/service/composer-attachment-service.ts
// @test-covers packages/web-core/src/service/workspace-session-pane-state.ts
// @test-covers packages/web-core/src/view/composer/ComposerAttachments.vue
let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/workspace-composer-attachments.html');
});
test.afterAll(async () => fixture?.close());

for (const position of ['main', 'aside'] as const) {
  test(`${position} attachments follow the question across session changes without crossing Workspace or Pane`, async ({
    page
  }) => {
    await page.setViewportSize({ width: position === 'main' ? 1280 : 390, height: 900 });
    await page.goto(`${fixture.url}workspace-composer-attachments.html`);
    const pane = page.getByRole('region', { name: position, exact: true });
    const other = page.getByRole('region', {
      name: position === 'main' ? 'aside' : 'main',
      exact: true
    });
    const uploads = page.getByLabel('Upload count');
    const question = pane.getByRole('textbox', { name: 'Question' });
    await question.fill('Unsent question');
    await other.getByRole('textbox', { name: 'Question' }).fill('Other question');
    const input = pane.getByLabel('Attachments', { exact: true });
    await input.setInputFiles({
      name: 'first.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('first')
    });
    const txtIcon = pane.locator('.composer-attachments .mar-file-icon use');
    await expect(txtIcon).toHaveAttribute('href', /#mar-file-txt$/u);
    await expect
      .poll(() => txtIcon.evaluate((node: SVGUseElement) => node.getBBox().width))
      .toBeGreaterThan(0);
    await other
      .getByLabel('Attachments', { exact: true })
      .setInputFiles({ name: 'other.txt', mimeType: 'text/plain', buffer: Buffer.from('other') });
    await expect(uploads).toHaveText('2');
    await pane.getByRole('button', { name: 'Session B' }).click();
    if (position === 'main') {
      await pane.getByRole('button', { name: 'New session' }).click();
      await expect(pane.getByText('first.txt', { exact: true })).toBeVisible();
      await pane.getByRole('button', { name: 'Session created' }).click();
    }
    await expect(question).toHaveValue('Unsent question');
    await expect(pane.getByText('first.txt', { exact: true })).toBeVisible();
    await expect(pane.getByText('other.txt', { exact: true })).toHaveCount(0);
    await expect(other.getByText('first.txt', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Switch workspace' }).click();
    await expect(question).toHaveValue('');
    await expect(page.locator('.composer-attachments')).toHaveCount(0);
    await page.getByRole('button', { name: 'Finish uploads' }).click();
    await page.getByRole('button', { name: 'Switch workspace' }).click();
    await expect(question).toHaveValue('Unsent question');
    await expect(pane.getByText('first.txt', { exact: true })).toBeVisible();
    await expect(pane.locator('.composer-attachments')).toContainText('Uploaded');
    await expect(other.getByText('other.txt', { exact: true })).toBeVisible();
    await expect(uploads).toHaveText('2');
    await pane.getByRole('button', { name: 'Capture attachment batch' }).click();
    await input.setInputFiles({
      name: 'next.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('next')
    });
    await expect(uploads).toHaveText('3');
    await pane.getByRole('button', { name: 'Session A' }).click();
    await pane.getByRole('button', { name: 'Accept attachment batch' }).click();
    await expect(pane.getByText('first.txt', { exact: true })).toHaveCount(0);
    await expect(pane.getByText('next.txt', { exact: true })).toBeVisible();
    await expect(other.getByText('other.txt', { exact: true })).toBeVisible();
    await expect(other.getByRole('textbox', { name: 'Question' })).toHaveValue('Other question');
    await expect(uploads).toHaveText('3');
    await page.reload();
    await expect(question).toHaveValue('Unsent question');
    await expect(page.locator('.composer-attachments')).toHaveCount(0);
    await expect(uploads).toHaveText('0');
  });
}
