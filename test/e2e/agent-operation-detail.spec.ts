import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/conversation-tool-detail.html', {
    protocolSource: true
  });
});
test.afterAll(async () => {
  await fixture?.close();
});

for (const [width, theme] of [
  [1280, 'daylight'],
  [390, 'dark']
] as const) {
  test(`Agent operation cards at ${width}px ${theme}`, async ({ page, context }, testInfo) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(
      `${fixture.url}conversation-tool-detail.html?timeline=1&unified=1&agent-cards=1&theme=${theme}`
    );
    const apiRequests: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url());
    });
    const process = page.locator('.process-heading').first();
    if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
    const group = page.locator('.subagent-group');
    await group.locator('.conversation-record-group > summary').click();
    await expect(group.locator('.agent-detail')).toHaveCount(0);
    expect(apiRequests).toEqual([]);
    const rows = group.locator('.conversation-tool-detail');
    const native = rows.filter({ has: page.locator('summary').filter({ hasText: 'spawn_agent' }) });
    await native.locator(':scope > summary').click();
    await expect(native.locator('.agent-detail-text')).toHaveText('Inspect the native change.');
    for (const action of ['start', 'send', 'wait', 'list', 'view', 'stop']) {
      const row = rows
        .filter({ has: page.locator('summary').filter({ hasText: `agent_${action}` }) })
        .last();
      await row.locator(':scope > summary').click();
      await expect(row.locator('.agent-detail')).toHaveCount(1);
    }
    const start = rows.filter({ has: page.locator('summary').filter({ hasText: 'agent_start' }) });
    const send = rows
      .filter({ has: page.locator('summary').filter({ hasText: 'agent_send' }) })
      .last();
    const stop = rows.filter({ has: page.locator('summary').filter({ hasText: 'agent_stop' }) });
    await expect(start.locator('.agent-detail-text')).toHaveText(
      'Initial task\nwith a second line.'
    );
    await expect(send.locator('.agent-detail')).toContainText('queue');
    const list = rows.filter({ has: page.locator('summary').filter({ hasText: 'agent_list' }) });
    await expect(list.locator('.agent-detail')).toContainText('Ready');
    await expect(list.locator('.agent-detail')).not.toContainText('IDLE');
    await expect(stop.locator('.agent-detail-text')).toHaveText('{"status":"accepted"}\n');
    await expect(group.locator('.agent-detail').filter({ hasText: 'Truncated' })).toHaveCount(0);
    const styles = await start.locator('.agent-detail').evaluate((element) => {
      const title = getComputedStyle(element.querySelector('.agent-detail-meta')!);
      const body = getComputedStyle(element.querySelector('.agent-detail-text')!);
      return {
        titleWeight: title.fontWeight,
        bodyWeight: body.fontWeight,
        titleColor: title.color,
        bodyColor: body.color,
        titleSize: parseFloat(title.fontSize),
        bodySize: parseFloat(body.fontSize)
      };
    });
    expect(styles.titleWeight).toBe('400');
    expect(styles.bodyWeight).toBe('400');
    expect(styles.titleColor).not.toBe(styles.bodyColor);
    expect(styles.titleSize).toBeLessThanOrEqual(styles.bodySize);
    expect(styles.bodySize).toBe(12);
    await start.locator('.tool-detail-copy').click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain('Hidden public input');
    expect(
      JSON.parse(await page.evaluate(() => navigator.clipboard.readText())).payload
    ).toHaveProperty('inputTruncated', true);
    await page.screenshot({
      path: testInfo.outputPath(`agent-cards-${theme}-${width}.png`),
      fullPage: true
    });
    await group.locator('.conversation-record-group > summary').click();
    await expect(group.locator('.agent-detail')).toHaveCount(0);
    await group.locator('.conversation-record-group > summary').click();
    await expect(group.locator('.agent-detail')).toHaveCount(0);
    expect(apiRequests).toEqual([]);
  });
}

test('wraps a long unbroken target title without overflowing on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(
    `${fixture.url}conversation-tool-detail.html?timeline=1&unified=1&agent-cards=1&long-title=1&locale=zh-CN`
  );
  const process = page.locator('.process-heading').first();
  if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
  const group = page.locator('.subagent-group');
  await group.locator('.conversation-record-group > summary').click();
  const list = group
    .locator('.conversation-tool-detail')
    .filter({ has: page.locator('summary').filter({ hasText: 'agent_list' }) });
  await list.locator(':scope > summary').click();
  await expect(list.locator('.agent-detail')).toContainText('可继续');
  await expect(list.locator('.agent-detail')).not.toContainText('IDLE');
  const start = group
    .locator('.conversation-tool-detail')
    .filter({ has: page.locator('summary').filter({ hasText: 'agent_start' }) });
  await start.locator(':scope > summary').click();
  const title = start.locator('.agent-detail-meta > span').first();
  const geometry = await title.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height,
    lineHeight: parseFloat(getComputedStyle(element).lineHeight),
    scrollWidth: element.scrollWidth
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(Math.ceil(geometry.width));
  expect(geometry.height).toBeGreaterThan(geometry.lineHeight * 2);
});

for (const truncation of ['HEAD', 'SOURCE'] as const) {
  test(`places the STOP ${truncation} truncation marker without rewriting the result`, async ({
    page
  }) => {
    await page.goto(
      `${fixture.url}conversation-tool-detail.html?timeline=1&unified=1&agent-cards=1&stop-truncation=${truncation}`
    );
    const process = page.locator('.process-heading').first();
    if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
    const group = page.locator('.subagent-group');
    await group.locator('.conversation-record-group > summary').click();
    const stop = group
      .locator('.conversation-tool-detail')
      .filter({ has: page.locator('summary').filter({ hasText: 'agent_stop' }) });
    await stop.locator(':scope > summary').click();
    const content = stop.locator('.agent-detail');
    await expect(content.locator('.agent-detail-text')).toHaveText('{"status":"accepted"}\n');
    const text = await content.innerText();
    expect(text.match(/Truncated/g)).toHaveLength(1);
    const marker = text.indexOf('Truncated');
    const result = text.indexOf('{"status":"accepted"}');
    expect(marker).toBeGreaterThanOrEqual(0);
    expect(truncation === 'HEAD' ? marker < result : marker > result).toBe(true);
  });
}
