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
    test(`Agent cards show real operations without session shortcuts (${theme}, ${width})`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${fixture.url}agent-operation.html?theme=${theme}`);
      const process = page.locator('.process-heading').first();
      if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
      const groups = page.locator('.subagent-group');
      await expect(groups).toHaveCount(1);
      await expect(
        groups.first().locator('.conversation-record-group > summary')
      ).not.toContainText('Review the implementation');
      await groups.first().locator('.conversation-record-group > summary').click();
      await expect(groups.locator('.conversation-tool-detail')).toHaveCount(7);
      await expect(groups.first()).toContainText('Agent operations');
      await expect(groups.first()).toContainText('Review the implementation');
      const controls = groups.first().locator('.conversation-tool-detail');
      await expect(controls).toHaveCount(7);
      await expect(controls.nth(0).locator(':scope > summary')).toContainText(
        'agent_start Review the implementation'
      );
      await expect(controls.nth(1).locator(':scope > summary')).toContainText('agent_send');
      await expect(controls.nth(1).locator(':scope > summary')).not.toContainText('peer');
      await expect(controls.nth(1).locator('.conversation-record-meta')).toHaveText('Failed');
      await controls.nth(1).locator(':scope > summary').click();
      await expect(controls.nth(1)).toContainText('Tool: agent_send');
      await expect(controls.nth(1)).toContainText('AGENT_UNAVAILABLE');
      await expect(page.getByRole('button', { name: /Open session/ })).toHaveCount(0);
      await expect(controls.nth(1)).toContainText('Agent ID: peer');
      await controls.nth(1).getByRole('button', { name: /Copy/ }).click();
      await expect(page.getByTestId('copied-record')).toContainText('"id": "mar-send"');
      const wait = controls.nth(5);
      await expect(wait.locator(':scope > summary')).toContainText(
        'agent_wait Review the implementation, Check the final result'
      );
      const preview = wait.locator(':scope > summary .conversation-tool-preview');
      expect(
        await preview.evaluate((node) => {
          const style = getComputedStyle(node);
          return (
            style.whiteSpace === 'nowrap' &&
            style.textOverflow === 'ellipsis' &&
            node.scrollWidth > node.clientWidth
          );
        })
      ).toBe(true);
      await wait.locator(':scope > summary').click();
      await expect(wait).toContainText('Tool: agent_wait');
      await expect(wait).toContainText('Agent ID: peer');
      await expect(wait).toContainText('Agent ID: other');
      await expect(wait).toContainText('Task: Review the implementation');
      await expect(wait).toContainText('Task: Check the final result');
      await expect(wait.locator('.conversation-detail-text')).toContainText('END');
      await expect(wait).toContainText('Timeout. Both targets are still running.');
      await expect(wait.locator('.conversation-detail-text')).toBeVisible();
      await expect(controls.nth(6).locator(':scope > summary')).toContainText('agent_list');
      await expect(controls.nth(6).locator(':scope > summary')).not.toContainText('profile');
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
