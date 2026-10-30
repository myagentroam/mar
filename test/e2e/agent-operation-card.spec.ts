import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/agent-operation.html');
});
test.afterAll(async () => {
  await fixture?.close();
});

for (const theme of ['light', 'dark']) {
  for (const width of [390, 1280]) {
    test(`Agent cards share the four-Runner surface and mapped navigation (${theme}, ${width})`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${fixture.url}agent-operation.html?theme=${theme}`);
      const process = page.locator('.process-heading').first();
      if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
      const groups = page.locator('.subagent-group');
      await expect(groups).toHaveCount(6);
      for (const group of await groups.all())
        await group.locator('.conversation-record-group > summary').click();
      await expect(groups.first()).toContainText('Agent operations');
      await expect(groups.first()).toContainText('Review the implementation');
      const controls = groups.first().locator('.conversation-tool-detail');
      await expect(controls).toHaveCount(2);
      await controls.nth(1).locator(':scope > summary').click();
      await expect(controls.nth(1)).toContainText('Tool: agent_send');
      await expect(controls.nth(1)).toContainText('AGENT_UNAVAILABLE');
      await groups
        .first()
        .getByRole('button', { name: 'Open session · Review the implementation' })
        .click();
      await expect(page.getByTestId('opened')).toHaveText('peer');
      for (const index of [1, 2, 3]) {
        await expect(groups.nth(index).getByRole('button', { name: /Open session/ })).toHaveCount(
          0
        );
      }
      const wait = groups.nth(4);
      await expect(wait.getByRole('button', { name: /Open session/ })).toHaveCount(2);
      await wait.getByRole('button', { name: 'Open session · Check the final result' }).click();
      await expect(page.getByTestId('opened')).toHaveText('other');
      await wait.locator('.conversation-tool-detail > summary').click();
      await expect(wait).toContainText('Timeout. Both targets are still running.');
      await expect(wait.locator('.conversation-detail-text')).toBeVisible();
      await expect(groups.nth(5)).toContainText('List');
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`agent-cards-${theme}-${width}.png`),
        fullPage: true,
        animations: 'disabled'
      });
    });
  }
}
