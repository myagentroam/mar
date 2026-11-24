import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/agent-operation.html');
});
test.afterAll(async () => {
  await fixture?.close();
});

for (const [theme, width] of [
  ['light', 1280],
  ['dark', 390]
] as const) {
  test(`keeps incoming messages inside each Agent collaboration group (${theme}, ${width})`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${fixture.url}agent-operation.html?theme=${theme}&collaboration`);
    const processes = page.locator('.conversation-process.is-group');
    await expect(processes).toHaveCount(2);
    for (const process of await processes.all()) {
      const heading = process.locator('.process-heading');
      if ((await heading.getAttribute('aria-expanded')) === 'false') await heading.click();
    }
    const groups = processes.locator('.subagent-group > details');
    await expect(groups).toHaveCount(2);
    const first = groups.first();
    const last = groups.last();
    const firstSummary = first.locator(':scope > summary');
    const lastSummary = last.locator(':scope > summary');
    await expect(firstSummary).toHaveText(/Agent collaboration\s*8 records/);
    await expect(lastSummary).toHaveText(/Agent collaboration\s*1 record/);
    await expect(page.getByText('Review complete.')).toBeVisible();
    await expect(page.getByText('Thanks for the review.')).toBeVisible();
    await expect(
      page.locator('.user_message').filter({ hasText: 'Thanks for the review.' })
    ).toContainText('Alice');
    await expect(processes.first().locator('.subagent-group')).toHaveCount(1);
    await expect(processes.last().locator('.subagent-group')).toHaveCount(1);
    expect(
      await first.evaluate(
        (group) => group.closest('.conversation-turn')?.nextElementSibling?.textContent
      )
    ).toContain('Review complete.');
    await expect(page.locator('.agent-collaboration-message')).toHaveCount(0);
    await page.locator('.conversation-timeline').screenshot({
      path: testInfo.outputPath(`collaboration-collapsed-${width}.png`),
      animations: 'disabled'
    });
    await firstSummary.focus();
    await page.keyboard.press('Enter');
    const records = first.locator(
      ':scope > :is(.conversation-tool-detail, .agent-collaboration-message)'
    );
    await expect(records.nth(1)).toContainText('send');
    await expect(records.nth(2)).toContainText('The review is ready.');
    await expect(records.nth(3)).toContainText('Inspect persistence');
    await expect(records.nth(2)).toContainText('Review session');
    const source = records.nth(2).locator('.conversation-item-heading > strong');
    const metaSize = await source.evaluate((element) =>
      getComputedStyle(element).getPropertyValue('--mar-font-size-meta').trim()
    );
    await expect(source).toHaveCSS('font-size', metaSize);
    await expect(source).toHaveCSS('font-weight', '400');
    await expect(records.nth(2).locator('time')).toBeVisible();
    await first.screenshot({
      path: testInfo.outputPath(`collaboration-expanded-${width}.png`),
      animations: 'disabled'
    });
    await records.nth(2).getByRole('button', { name: /Copy/ }).click();
    await expect(page.getByTestId('copied-record')).toHaveText('The review is ready.');
    await expect(last).not.toHaveAttribute('open');
    await page.getByRole('button', { name: 'Add update' }).click();
    await expect(lastSummary).toHaveText(/Agent collaboration\s*2 records/);
    await expect(last).not.toHaveAttribute('open');
    await lastSummary.click();
    await expect(last.locator('.agent-collaboration-message')).toHaveText([
      /Build session.*The isolated build passed\./s,
      /Test session.*Browser checks passed\./s
    ]);
    await expect(first).toHaveAttribute('open', '');
    await lastSummary.click();
    await expect(last.locator('.agent-collaboration-message')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
  });
}

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
      await expect(groups.first()).toContainText('Agent collaboration');
      await expect(groups.first()).toContainText('Review the implementation');
      const controls = groups.first().locator('.conversation-tool-detail');
      await expect(controls).toHaveCount(7);
      await expect(controls.nth(0).locator(':scope > summary')).toContainText(
        'start Review the implementation'
      );
      await expect(controls.nth(1).locator(':scope > summary')).toContainText('send');
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
        'wait Review the implementation, Check the final result'
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
      await expect(wait.locator('.mar-conversation-detail-text')).toContainText('END');
      await expect(wait).toContainText('Timeout. Both targets are still running.');
      await expect(wait.locator('.mar-conversation-detail-text')).toBeVisible();
      await expect(controls.nth(6).locator(':scope > summary')).toContainText('list profile');
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
