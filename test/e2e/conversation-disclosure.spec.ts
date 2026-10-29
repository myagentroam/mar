import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/conversation-style.html');
});
test.afterAll(async () => {
  await fixture?.close();
});

for (const [width, reducedMotion] of [
  [1280, 'no-preference'],
  [390, 'reduce']
] as const) {
  test(`collapsing a parent releases only its descendants' disclosure state (${width}px, ${reducedMotion})`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion });
    await page.goto(`${fixture.url}conversation-style.html?disclosure-reset=1`);
    const first = page.locator('[data-process-id="first"]');
    const second = page.locator('[data-process-id="second"]');
    for (const process of [first, second]) {
      await process.locator(':scope > .process-heading').click();
      await expect(process.locator('.conversation-record-group')).toHaveCount(4);
      for (const group of await process.locator('.conversation-record-group').all()) {
        await group.locator(':scope > summary').click();
        const child = group.locator(':scope > details');
        await expect(child).toHaveCount(1);
        await child.locator(':scope > summary').click();
        await expect(child).toHaveAttribute('open', '');
        await expect(child.locator('.tool-detail')).toHaveCount(1);
      }
      await process.locator('.reasoning-group > details > summary').click();
      await expect(process.locator('.reasoning-group .conversation-detail-body')).toHaveCount(1);
      await process.locator('.conversation-file-change-details > summary').click();
      await expect(process.locator('.conversation-file-change-list')).toHaveCount(1);
    }

    const groups = first.locator('.conversation-record-group');
    for (const group of await groups.all()) {
      await group.locator(':scope > summary').click();
      await expect(group.locator(':scope > details')).toHaveCount(0);
      await group.locator(':scope > summary').click();
      await expect(group.locator(':scope > details')).toHaveCount(1);
      await expect(group.locator(':scope > details[open]')).toHaveCount(0);
      await expect(group.locator('.tool-detail')).toHaveCount(0);
      await group.locator(':scope > details > summary').click();
      await expect(group.locator('.tool-detail')).toHaveCount(1);
    }

    await first.locator(':scope > .process-heading').click();
    await expect(first.locator('.process-content')).toHaveCount(0);
    await expect(second.locator('details[open]')).toHaveCount(10);
    await first.locator(':scope > .process-heading').click();
    await expect(first.locator('.conversation-record-group')).toHaveCount(4);
    await expect(first.locator('details[open]')).toHaveCount(0);
    await expect(first.locator('.tool-detail, .conversation-detail-body')).toHaveCount(0);
    await expect(first.locator('.conversation-file-change-list')).toHaveCount(0);
    for (const group of await first.locator('.conversation-record-group').all()) {
      await group.locator(':scope > summary').click();
      await expect(group.locator(':scope > details')).toHaveCount(1);
      await expect(group.locator(':scope > details[open]')).toHaveCount(0);
      await expect(group.locator('.tool-detail')).toHaveCount(0);
    }
    await expect(second.locator('details[open]')).toHaveCount(10);
  });
}

test('automatic process collapse also releases its reasoning disclosure state', async ({
  page
}) => {
  await page.goto(`${fixture.url}conversation-style.html?reasoning-preview=1`);
  const process = page.locator('[data-process-id="preview-process"]');
  await expect(process.locator(':scope > .process-heading')).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  await process.locator('.reasoning-group > details > summary').click();
  await expect(process.locator('.reasoning-group .conversation-detail-body')).toHaveCount(1);
  await page.getByTestId('finish-reasoning-process').click();
  await expect(process.locator('.process-content')).toHaveCount(0);
  await process.locator(':scope > .process-heading').click();
  await expect(process.locator('.reasoning-group > details')).toHaveCount(1);
  await expect(process.locator('details[open]')).toHaveCount(0);
  await expect(process.locator('.reasoning-group .conversation-detail-body')).toHaveCount(0);
});
