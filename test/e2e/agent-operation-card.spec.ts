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
    const visitor = page.locator('.user_message').filter({ hasText: 'Thanks for the review.' });
    await expect(visitor).toContainText('Alice');
    const ownMessage = page
      .locator('.user_message')
      .filter({ hasText: 'Review the implementation.' });
    await expect(ownMessage.getByRole('button', { name: /Create a session branch/ })).toBeVisible();
    await expect(ownMessage.getByRole('button', { name: /Permanently delete/ })).toBeVisible();
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
    await expect(records.nth(3)).toContainText('Inspect persistence');
    const message = records.nth(2);
    const messageSummary = message.locator(':scope > summary');
    const messageBody = message.locator(':scope > .mar-conversation-detail-body');
    const fullMessage =
      'The review is ready.\nThe implementation and browser checks passed. Please review the final conversation layout, including how long messages wrap on smaller screens.';
    await expect(messageSummary.locator('.collaboration-action')).toHaveText('message');
    await expect(messageSummary.locator('.collaboration-source')).toHaveText('child session');
    await expect(messageSummary).not.toContainText('Review session');
    const preview = messageSummary.locator('.collaboration-text');
    await expect(preview).toHaveText(fullMessage);
    await expect(preview).toHaveCSS('text-overflow', 'ellipsis');
    await expect(preview).toHaveCSS('white-space', 'nowrap');
    await expect.poll(() => preview.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await expect(messageSummary.locator('time')).toHaveCount(0);
    await expect(message).not.toHaveAttribute('open');
    await expect(messageBody).toHaveCount(0);
    await first.screenshot({
      path: testInfo.outputPath(`collaboration-expanded-${width}.png`),
      animations: 'disabled'
    });
    await messageSummary.press('Enter');
    await expect(messageBody).toBeVisible();
    const sourceHeading = messageBody.locator('.conversation-item-heading > strong');
    await expect(sourceHeading).toHaveText('From child session Review session');
    const metaSize = await sourceHeading.evaluate((element) =>
      getComputedStyle(element).getPropertyValue('--mar-font-size-meta').trim()
    );
    await expect(sourceHeading).toHaveCSS('font-size', metaSize);
    await expect(sourceHeading).toHaveCSS('font-weight', '400');
    const bodyText = messageBody.locator('.conversation-message');
    await expect(bodyText).toHaveText(fullMessage);
    await expect(bodyText).toHaveCSS('font-size', '12px');
    await expect(bodyText).toHaveCSS('white-space', 'pre-wrap');
    await expect(messageBody.locator('.conversation-message-actions time')).toBeVisible();
    await expect(messageBody.getByRole('button')).toHaveCount(1);
    await first.screenshot({
      path: testInfo.outputPath(`collaboration-message-expanded-${width}.png`),
      animations: 'disabled'
    });
    await messageBody.getByRole('button', { name: 'Copy message', exact: true }).click();
    await expect.poll(() => page.getByTestId('copied-record').textContent()).toBe(fullMessage);
    await expect(last).not.toHaveAttribute('open');
    await page.getByRole('button', { name: 'Add update' }).click();
    await expect(lastSummary).toHaveText(/Agent collaboration\s*2 records/);
    await expect(last).not.toHaveAttribute('open');
    await lastSummary.click();
    await expect(last.locator('.collaboration-source')).toHaveText([
      'another session',
      'parent session'
    ]);
    const messages = last.locator('.agent-collaboration-message');
    const otherMessage = messages.first();
    await otherMessage.locator('summary').click();
    await expect(otherMessage.locator('.conversation-item-heading > strong')).toHaveText(
      'From another session Build session'
    );
    const recent = messages.last();
    const recentSummary = recent.locator('summary');
    await expect(recentSummary).not.toContainText('Test session');
    await recentSummary.click();
    await expect(recent.locator('.conversation-message')).toHaveText('Browser checks passed.');
    const recentSource = recent.locator('.conversation-item-heading > strong');
    await expect(recentSource).toHaveText(
      `From parent session Test session ${'BrowserChecks'.repeat(10)}`
    );
    await expect
      .poll(() =>
        recentSource.evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return range.getClientRects().length > 1;
        })
      )
      .toBe(true);
    const heading = recent.locator('.conversation-item-heading');
    await expect.poll(() => heading.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(recent.locator('time')).toHaveCount(0);
    await expect(first).toHaveAttribute('open', '');
    await expect(message).toHaveAttribute('open', '');
    await lastSummary.click();
    await expect(last.locator('.agent-collaboration-message')).toHaveCount(0);
    await firstSummary.click();
    await expect(message).toHaveCount(0);
    await firstSummary.click();
    await expect(messageSummary).toBeVisible();
    await expect(message).not.toHaveAttribute('open');
    await expect(messageBody).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
  });
}

test('distinguishes the Chinese source label from the full collaboration heading', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`${fixture.url}agent-operation.html?theme=dark&collaboration&locale=zh-CN`);
  const process = page.locator('.conversation-process.is-group').first();
  const processHeading = process.locator('.process-heading');
  await expect(processHeading).toBeVisible();
  if ((await processHeading.getAttribute('aria-expanded')) === 'false')
    await processHeading.click();
  const group = process.locator('.subagent-group > details');
  await group.locator(':scope > summary').click();
  const message = group.locator('.agent-collaboration-message');
  const summary = message.locator(':scope > summary');
  await expect(summary.locator('.collaboration-source')).toHaveText('子会话');
  await expect(summary).not.toContainText('Review session');
  await summary.click();
  await expect(message.locator('.conversation-item-heading > strong')).toHaveText(
    '来自子会话 Review session'
  );
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
