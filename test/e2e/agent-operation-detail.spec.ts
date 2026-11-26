import { grantClipboardPermissions } from './support/clipboard.js';
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

test('shows historical whiteboard receipts and errors inside Agent collaboration', async ({
  page,
  context
}) => {
  await grantClipboardPermissions(context);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(
    `${fixture.url}conversation-tool-detail.html?timeline&unified&agent-cards&whiteboard-cards&theme=dark`
  );
  const process = page.locator('.process-heading').first();
  if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
  const group = page.locator('.subagent-group > details');
  await expect(group).toHaveCount(1);
  await expect(group.locator('.whiteboard-detail')).toHaveCount(0);
  await group.locator(':scope > summary').click();
  await expect(group.getByText('start Native review')).toBeVisible();
  const rows = group.locator('.conversation-tool-detail');
  const update = rows.filter({ has: page.getByText('Update whiteboard', { exact: true }) });
  await expect(update.locator(':scope > summary')).not.toContainText('board-owner');
  await update.locator(':scope > summary').press('Enter');
  const facts = update.locator('.whiteboard-detail');
  await expect(facts).toHaveText('Board owner: board-owner');
  await expect(update.locator('.tool-detail')).not.toContainText(
    /Board revision|Requested operations|Input:|Output:|"changed"/
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect
    .poll(() =>
      facts.evaluate((element) => {
        const text = document.createRange();
        text.selectNodeContents(element);
        return new Set(Array.from(text.getClientRects(), (rect) => rect.top)).size;
      })
    )
    .toBe(1);
  await page.setViewportSize({ width: 320, height: 900 });
  await expect
    .poll(() => facts.evaluate((element) => element.scrollWidth <= element.clientWidth))
    .toBe(true);
  await expect(update.getByRole('link')).toHaveCount(0);
  await update.locator('.tool-detail-copy').click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('"operationCount": 1');
  const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(copied.payload).toMatchObject({
    inputSummary: '{"action":"update"}',
    outputSummary: '{"changed":false}',
    toolPresentation: { kind: 'EXTENSION', name: 'whiteboard', data: { boardRevision: 0 } }
  });
  const join = rows.filter({ has: page.getByText('Join whiteboard', { exact: true }) });
  await expect(join.locator(':scope > summary')).toContainText('Failed');
  await join.locator(':scope > summary').click();
  await expect(join.locator('.whiteboard-detail')).toHaveText('Board owner: unknown-owner');
  await expect(join.getByText('Board is not active.')).toBeVisible();
  const read = rows.filter({ has: page.getByText('Read whiteboard', { exact: true }) });
  await expect(read.locator(':scope > summary')).toContainText('Running');
  await read.locator(':scope > summary').click();
  await expect(read.locator('.whiteboard-detail')).toHaveText('Board owner: board-owner');
  await expect(read.locator('.tool-detail')).not.toContainText('Running');
  const leave = rows.filter({ has: page.getByText('Leave whiteboard', { exact: true }) });
  await expect(leave.locator(':scope > summary')).toContainText('Cancelled');
  await group.locator(':scope > summary').click();
  await expect(group.locator('.whiteboard-detail')).toHaveCount(0);
});

test('renders only meaningful whiteboard results on a narrow Chinese viewport', async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(
    `${fixture.url}conversation-tool-detail.html?timeline&unified&whiteboard-results&locale=zh-CN`
  );
  const process = page.locator('.process-heading').first();
  if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
  const group = page.locator('.subagent-group > details');
  await group.locator(':scope > summary').click();
  const summaries = group
    .locator('.conversation-tool-detail > summary')
    .filter({ hasText: '白板' });
  await expect(summaries).toHaveCount(6);
  for (const summary of await summaries.all()) await summary.click();
  await expect(group.locator('.whiteboard-detail')).toHaveText([
    '白板所有者: shared-board · 3 条记录',
    '白板所有者: empty-board · 白板为空',
    '白板所有者: 交付评审',
    '白板所有者: shared-board',
    '没有额外关注的白板',
    '白板所有者: 交付评审 · 已取消关注'
  ]);
  await expect(group.locator('.whiteboard-entry-changes li')).toHaveText([
    '保留兼容接口',
    '新增回归覆盖'
  ]);
  await expect(group.getByText('移除了 1 条记录', { exact: true })).toBeVisible();
  await expect(group.getByText('此处省略了部分更新内容。', { exact: true })).toBeVisible();
  await expect(group).not.toContainText(/已变更|无变化|关注未变化/);
  await expect(group.getByText('fixture receipt')).toHaveCount(0);
  await expect(group.getByText('[Truncated]', { exact: true })).toBeVisible();
  const successfulLeave = group.locator('.conversation-tool-detail').filter({
    has: page.getByText('白板所有者: 交付评审 · 已取消关注', { exact: true })
  });
  await expect(successfulLeave.locator('.tool-detail-copy')).toBeVisible();
  await group.screenshot({ path: testInfo.outputPath('whiteboard-summary-mobile.png') });
});

for (const [width, theme, locale, goalLabel] of [
  [1280, 'daylight', 'en-US', 'Goal'],
  [390, 'dark', 'zh-CN', '目标']
] as const) {
  test(`Goal-only Agent send at ${width}px ${locale}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(
      `${fixture.url}conversation-tool-detail.html?timeline&unified&agent-cards&agent-goal&theme=${theme}&locale=${locale}`
    );
    const process = page.locator('.process-heading').first();
    if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
    const group = page.locator('.subagent-group');
    await group.locator('.conversation-record-group > summary').click();
    const send = group.locator('.conversation-tool-detail').filter({
      has: page.locator('summary').filter({ hasText: /^send Review the boundary/ })
    });
    await send.locator(':scope > summary').click();
    await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
    await expect(send.locator('.agent-detail-goal')).toHaveText(goalLabel);
    await expect(send.locator('.agent-detail-text')).toBeInViewport({ ratio: 1 });
    expect(await send.locator('.agent-detail-text').textContent()).toBe(
      'Review the Goal.\n继续验证'
    );
    await expect(send.locator('.agent-detail-meta')).not.toContainText(/queue|steer/);
    await expect(send.locator('.agent-detail')).not.toContainText('Hidden public input');
    expect(
      await send
        .locator('.agent-detail')
        .evaluate((element) => element.scrollWidth <= element.clientWidth)
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`agent-goal-${width}.png`), fullPage: true });
  });
}

for (const [width, theme] of [
  [1280, 'daylight'],
  [390, 'dark']
] as const) {
  test(`Agent operation cards at ${width}px ${theme}`, async ({ page, context }, testInfo) => {
    await grantClipboardPermissions(context);
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
    await expect(group.locator('.agent-detail-goal')).toHaveCount(0);
    const start = rows
      .filter({ has: page.locator('summary').filter({ hasText: /^start\b/ }) })
      .last();
    const send = rows
      .filter({ has: page.locator('summary').filter({ hasText: /^send\b/ }) })
      .last();
    const stop = rows.filter({ has: page.locator('summary').filter({ hasText: /^stop\b/ }) });
    const wait = rows.filter({ has: page.locator('summary').filter({ hasText: /^wait\b/ }) });
    await expect(wait.locator('.agent-detail > .agent-detail-meta')).toHaveText(
      'completion · any · 5 min'
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
    await expect(title).toHaveText(
      `Review the boundary · completion · ${zero ? '0 sec' : '5 min'}`
    );
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
