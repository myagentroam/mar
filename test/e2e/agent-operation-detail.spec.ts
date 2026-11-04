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
    const native = rows.filter({
      has: page.locator('summary').filter({ hasText: 'start Native review' })
    });
    await native.locator(':scope > summary').click();
    await expect(native.locator('.agent-detail-text')).toHaveText('Inspect the native change.');
    for (const action of ['start', 'send', 'wait', 'list', 'view', 'stop']) {
      const row = rows
        .filter({
          has: page.locator('summary').filter({ hasText: new RegExp(`^${action}(?: |$)`) })
        })
        .last();
      await row.locator(':scope > summary').click();
      await expect(row.locator('.agent-detail')).toHaveCount(1);
    }
    const start = rows
      .filter({ has: page.locator('summary').filter({ hasText: /^start\b/ }) })
      .last();
    const send = rows
      .filter({ has: page.locator('summary').filter({ hasText: /^send\b/ }) })
      .last();
    const stop = rows.filter({ has: page.locator('summary').filter({ hasText: /^stop\b/ }) });
    const wait = rows.filter({ has: page.locator('summary').filter({ hasText: /^wait\b/ }) });
    await expect(wait.locator('.agent-detail > .agent-detail-meta')).toHaveText(
      'completion · any · 300000ms'
    );
    await expect(wait.locator('.agent-detail-entry')).toHaveCount(2);
    await expect(start.locator('.agent-detail-text')).toHaveText(
      'Initial task\nwith a second line.'
    );
    await expect(send.locator('.agent-detail')).toContainText('queue');
    const list = rows.filter({ has: page.locator('summary').filter({ hasText: /^list\b/ }) });
    await expect(list.locator(':scope > summary')).toContainText('list tree');
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

for (const [width, zero] of [
  [1280, false],
  [390, true]
] as const) {
  test(`shows the single active wait condition and duration at ${width}px`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(
      `${fixture.url}conversation-tool-detail.html?timeline&unified&agent-cards&agent-wait-single&${zero ? 'wait-zero&' : ''}theme=${width === 390 ? 'dark' : 'daylight'}`
    );
    const process = page.locator('.process-heading').first();
    if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
    const group = page.locator('.subagent-group');
    await group.locator('.conversation-record-group > summary').click();
    const row = group
      .locator('.conversation-tool-detail')
      .filter({ has: page.locator('summary').filter({ hasText: /^wait\b/ }) });
    await expect(row.locator('> summary')).toContainText('wait Review the boundary');
    await expect(row.locator('> summary')).not.toContainText('agent_wait');
    await row.locator('> summary').click();
    const title = row.locator('.agent-detail-meta > span').first();
    await expect(title).toHaveText(`Review the boundary · completion · ${zero ? 0 : 300000}ms`);
    await expect(title).toBeInViewport({ ratio: 1 });
    await expect(title).toHaveCSS('font-size', '12px');
    await expect(title).toHaveCSS('font-weight', '400');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    await page.screenshot({ path: testInfo.outputPath(`agent-wait-${width}.png`), fullPage: true });
    await row.locator('> summary').click();
    await expect(row.locator('.agent-detail')).toHaveCount(0);
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
    .filter({ has: page.locator('summary').filter({ hasText: /^list\b/ }) });
  await list.locator(':scope > summary').click();
  await expect(list.locator('.agent-detail')).toContainText('可继续');
  await expect(list.locator('.agent-detail')).not.toContainText('IDLE');
  const start = group
    .locator('.conversation-tool-detail')
    .filter({ has: page.locator('summary').filter({ hasText: /^start\b/ }) })
    .last();
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
      .filter({ has: page.locator('summary').filter({ hasText: /^stop\b/ }) });
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

for (const [width, scope] of [
  [1280, 'tree'],
  [390, 'active']
] as const) {
  test(`shows LIST ${scope} with empty results at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(
      `${fixture.url}conversation-tool-detail.html?timeline&unified&agent-cards&empty-list&list-scope=${scope}`
    );
    const process = page.locator('.process-heading').first();
    if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
    const group = page.locator('.subagent-group');
    await group.locator('.conversation-record-group > summary').click();
    const list = group.locator('.conversation-tool-detail').filter({
      has: page.locator('summary').filter({ hasText: `list ${scope}` })
    });
    await expect(list.locator(':scope > summary')).toContainText(`list ${scope}`);
    await list.locator(':scope > summary').click();
    await expect(list.locator('.agent-detail')).toHaveText('No sessions');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
  });
}
