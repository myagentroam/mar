import { grantClipboardPermissions, clipboardPermissions } from './support/clipboard.js';
import { expect, test, type Locator } from '@playwright/test';
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

test('standalone tool detail loads its own shared presentation', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(`${fixture.url}isolated-tool-detail.html`);
  const detail = page.locator('.tool-detail.mar-conversation-detail-body');
  await expect(detail).toContainText('Inspection output');
  const [padding, rootSize] = await detail.evaluate((element) => [
    parseFloat(getComputedStyle(element).paddingTop),
    parseFloat(getComputedStyle(document.documentElement).fontSize)
  ]);
  expect(padding).toBeCloseTo(rootSize! * 0.625, 1);
  expect(requests.some((url) => url.includes('ConversationTimeline.vue'))).toBe(false);
});

async function expectUnclippedDetail(content: Locator) {
  await content.evaluate(async (element) => {
    const animations = new Set<Animation>();
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement)
      for (const animation of ancestor.getAnimations()) animations.add(animation);
    await Promise.all([...animations].map((animation) => animation.finished));
  });
  // Reveal the final geometry, not an ancestor temporarily clipped by its disclosure animation.
  await content.scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      content.evaluate((element) => {
        const bottom = element.getBoundingClientRect().bottom;
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          if (
            ['hidden', 'clip'].includes(getComputedStyle(parent).overflowY) &&
            parent.getBoundingClientRect().bottom < bottom - 1
          )
            return false;
        }
        return true;
      })
    )
    .toBe(true);
}

test('replaces only the current process task snapshot and keeps other processes after reopening', async ({
  page
}) => {
  await grantClipboardPermissions(page.context());
  await page.goto(`${fixture.url}conversation-tool-detail.html?timeline&task-snapshots`);
  const first = page.locator('[data-process-id="process"]');
  const second = page.locator('[data-process-id="other-process"]');
  for (const process of [first, second]) {
    const heading = process.locator('.process-heading');
    if ((await heading.getAttribute('aria-expanded')) === 'false') await heading.click();
  }
  await expect(first.locator('.task-list')).toHaveCount(1);
  await expect(first.locator('.task-list')).toContainText('Initial task snapshot');
  await expect(second.locator('.task-list')).toContainText('Separate process task');
  const copy = first.locator('.task-list .tool-detail-copy');
  await expect(copy).toHaveCount(1);
  await copy.click();
  await expect(copy).toHaveAttribute('aria-label', 'Copied');
  expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))).toMatchObject({
    id: 'tasks-initial',
    kind: 'todo_list',
    payload: { items: [{ text: 'Initial task snapshot', status: 'COMPLETED' }] }
  });
  await first.locator('.task-list > summary').click();
  await expect(copy).toHaveCount(0);
  await expect(first.getByText('Initial task snapshot', { exact: true })).toBeHidden();
  await page.getByTestId('append-task-snapshot').click();
  await expect(first.locator('.task-list')).toHaveCount(1);
  await expect(first.locator('.task-list')).toContainText('Latest task snapshot');
  await expect(first.getByText('Latest task snapshot', { exact: true })).toBeVisible();
  await expect(first).not.toContainText('Initial task snapshot');
  await expect(second.locator('.task-list')).toContainText('Separate process task');
  await expect(copy).toHaveAttribute('aria-label', 'Copy public record');
  await copy.click();
  expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))).toMatchObject({
    id: 'tasks-latest',
    payload: { items: [{ text: 'Latest task snapshot', status: 'COMPLETED' }] }
  });
  await first.locator('.process-heading').click();
  await expect(first.locator('.task-list')).toHaveCount(0);
  await first.locator('.process-heading').click();
  await expect(first.locator('.task-list')).toHaveCount(1);
  await expect(first.locator('.task-list')).toContainText('Latest task snapshot');
  await expect(first).not.toContainText('Initial task snapshot');
  await expect(copy).toHaveCount(1);
  await expect(copy).toHaveAttribute('aria-label', 'Copy public record');
});

for (const [width, theme, locale] of [
  [1280, 'daylight', 'en-US'],
  [390, 'dark', 'en-US'],
  [1280, 'dark', 'zh-CN'],
  [390, 'daylight', 'zh-CN']
] as const) {
  test(`task, file and Agent lists share compact rows at ${width}px in ${locale}`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(
      `${fixture.url}conversation-tool-detail.html?timeline&list-layout&theme=${theme}&locale=${locale}`
    );
    const process = page.locator('[data-process-id="process"]');
    await process.locator('.process-heading').click();
    await process.locator('.conversation-file-change-details > summary').click();
    const agentGroup = process.locator('.subagent-group');
    await agentGroup.locator('.conversation-record-group > summary').click();
    await agentGroup.locator('.conversation-tool-detail > summary').click();
    const tasks = process.locator('.task-list-items');
    const files = process.locator('.conversation-file-change-list');
    const agents = process.locator('.agent-detail .mar-conversation-detail-list');
    await expect(agents.locator('li')).toHaveCount(3);
    await expect(agents).toContainText('Review native tool details');
    await expect(agents.locator('a, button')).toHaveCount(0);
    await expect(tasks.locator('li')).toHaveCount(3);
    const taskDetail = process.locator('.task-list .conversation-content-detail');
    const fileDetail = process.locator(
      '.conversation-file-change-details .conversation-content-detail'
    );
    const [taskFrame, fileFrame] = await Promise.all([
      taskDetail.boundingBox(),
      fileDetail.boundingBox()
    ]);
    expect(taskFrame!.x).toBeCloseTo(fileFrame!.x, 0);
    expect(taskFrame!.width).toBeCloseTo(fileFrame!.width, 0);
    const copy = taskDetail.getByRole('button', {
      name: locale === 'en-US' ? 'Copy public record' : '复制公开记录',
      exact: true
    });
    await expect(copy).toHaveCount(1);
    await expect(copy).toBeVisible();
    const [detailBounds, copyBounds] = await Promise.all([
      taskDetail.boundingBox(),
      copy.boundingBox()
    ]);
    expect(copyBounds!.x + copyBounds!.width).toBeLessThanOrEqual(
      detailBounds!.x + detailBounds!.width
    );
    const copyInset = await page.evaluate(
      () => Number.parseFloat(getComputedStyle(document.documentElement).fontSize) * 0.5
    );
    expect(detailBounds!.x + detailBounds!.width - copyBounds!.x - copyBounds!.width).toBeCloseTo(
      copyInset,
      0
    );
    expect(copyBounds!.y - detailBounds!.y).toBeCloseTo(copyInset, 0);
    await expect(files.locator('li')).toHaveCount(6);
    await expect(tasks.locator('.task-list-status')).toHaveText(
      locale === 'en-US' ? ['To-do', 'In progress', 'Done'] : ['待办', '进行中', '已完成']
    );
    const runningStatus = agents.locator('li').first().locator('.mar-conversation-list-marker');
    const idleStatus = agents.locator('li').nth(1).locator('.mar-conversation-list-marker');
    const completedStatus = agents.locator('li').nth(2).locator('.mar-conversation-list-marker');
    const green = await tasks
      .locator('.task-list-status--done')
      .evaluate((element) => getComputedStyle(element).color);
    await expect(runningStatus).toHaveCSS('color', green);
    await expect(idleStatus).not.toHaveCSS('color', green);
    await expect(completedStatus).toHaveCSS(
      'color',
      await idleStatus.evaluate((element) => getComputedStyle(element).color)
    );
    await expect(files.locator('.conversation-file-change-status')).toHaveText(
      locale === 'en-US'
        ? ['Added', 'Modified', 'Deleted', 'Renamed', 'Copied', 'Type changed']
        : ['新增', '修改', '删除', '重命名', '复制', '类型变更']
    );
    await expect(tasks).toHaveCSS(
      'row-gap',
      await files.evaluate((element) => getComputedStyle(element).rowGap)
    );
    await expect(tasks).toHaveCSS('border-top-width', '0px');
    for (const row of await tasks.locator('li').all())
      await expect(row).toHaveCSS('border-bottom-width', '0px');
    for (const list of [tasks, files, agents]) {
      await expect(list).toHaveCSS('font-size', '12px');
      await expect(list).toHaveCSS('font-weight', '400');
      const markers = list.locator('.mar-conversation-list-marker');
      const sizes = await markers.evaluateAll((elements) =>
        elements.map((element) => ({
          width: element.getBoundingClientRect().width,
          clipped: element.scrollWidth > element.clientWidth + 1,
          weight: getComputedStyle(element).fontWeight
        }))
      );
      expect(sizes.every((size) => size.weight === '400')).toBe(true);
      expect(sizes.some((size) => size.clipped)).toBe(false);
      if (width >= 768)
        expect(sizes.every((size) => Math.abs(size.width - sizes[0]!.width) < 0.5)).toBe(true);
      const bounds = await list.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      await expect
        .poll(() => list.evaluate((element) => element.scrollWidth <= element.clientWidth + 1))
        .toBe(true);
    }
    await expect(process.locator('.tool-detail-copy')).toHaveCount(3);
    await process.screenshot({
      path: testInfo.outputPath(`task-file-lists-${width}-${locale}.png`)
    });
  });
}

test('copies loaded file-change records without flattening their public fields', async ({
  page
}) => {
  await grantClipboardPermissions(page.context());
  await page.goto(`${fixture.url}conversation-tool-detail.html?timeline&list-layout`);
  const process = page.locator('[data-process-id="process"]');
  await process.locator('.process-heading').click();
  const files = process.locator('.conversation-file-change-details');
  await files.locator('> summary').click();
  await files.getByRole('button', { name: 'Copy public record', exact: true }).click();
  expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))).toMatchObject([
    { id: 'list-files', kind: 'file_change', payload: { changes: expect.any(Array) } }
  ]);
  const records = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(records[0].payload.changes).toHaveLength(6);
});

for (const [width, theme] of [
  [1280, 'dark'],
  [390, 'daylight']
] as const) {
  test(`unified list design at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(
      `${fixture.url}conversation-tool-detail.html?timeline&list-layout&list-design&theme=${theme}`
    );
    const process = page.locator('[data-process-id="process"]');
    await process.locator('.process-heading').click();
    await process.locator('.conversation-file-change-details > summary').click();
    const agents = process.locator('.subagent-group');
    await agents.locator('.conversation-record-group > summary').click();
    await agents.locator('.conversation-tool-detail > summary').click();
    await expect(process.locator('.mar-conversation-detail-list')).toHaveCount(3);
    await expect(process.locator('.tool-detail-copy')).toHaveCount(3);
    await process.screenshot({ path: testInfo.outputPath(`unified-lists-${width}-${theme}.png`) });
  });
}

for (const [width, theme] of [
  [1280, 'daylight'],
  [390, 'dark']
] as const) {
  test(`detail edges use container padding without losing section gaps at ${width}px ${theme}`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(
      `${fixture.url}conversation-tool-detail.html?timeline&unified&spacing-probe&theme=${theme}`
    );
    const probe = page.getByTestId('spacing-probe');
    const tools = probe.locator('.tool-content');
    await expect(probe.locator('.generic-detail')).toHaveCount(3);
    await expect(probe.locator('.execution-detail')).toHaveCount(3);
    await expect(probe.locator('.skill-detail')).toHaveCount(2);
    await expect(probe.locator('.web-detail')).toHaveCount(2);
    await expect(probe.locator('.compact-detail')).toHaveCount(2);
    await expect(probe.getByTestId('spacing-execution-error')).toContainText('EXEC_FAILED');
    await expect(probe.getByTestId('spacing-skill-error')).toContainText('SKILL_FAILED');
    for (const root of await tools.all()) {
      const edges = await root.evaluate((element) => ({
        name: element.parentElement?.closest('[data-testid]')?.getAttribute('data-testid'),
        top: parseFloat(getComputedStyle(element.firstElementChild!).marginTop),
        bottom: parseFloat(getComputedStyle(element.lastElementChild!).marginBottom)
      }));
      expect.soft(edges.top, `${edges.name} first content margin`).toBe(0);
      expect.soft(edges.bottom, `${edges.name} last content margin`).toBe(0);
    }
    const sectionGap = await probe
      .getByTestId('spacing-generic-sections')
      .locator('.tool-content-section')
      .last()
      .evaluate((element) => parseFloat(getComputedStyle(element).marginTop));
    expect(sectionGap).toBeGreaterThan(0);
    const process = page.locator('.process-heading').first();
    if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
    const closed = page.locator('.conversation-timeline details:not([open]) > summary');
    for (let i = 0; i < 40 && (await closed.count()); i++) await closed.first().click();
    await expect(closed).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
    const contents = page.locator('.conversation-content-detail');
    await expect(page.locator('.conversation-file-change-list')).toHaveCount(2);
    await expect(contents).toHaveCount(5);
    for (const root of await contents.all()) {
      const edges = await root.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const content = Array.from(element.children).filter(
          (child) => getComputedStyle(child).position !== 'absolute'
        );
        const first = content[0]!;
        const last = content.at(-1)!;
        const style = getComputedStyle(element);
        return {
          name: element.textContent,
          top: first.getBoundingClientRect().top - bounds.top,
          bottom: bounds.bottom - last.getBoundingClientRect().bottom,
          paddingTop: parseFloat(style.paddingTop),
          paddingBottom: parseFloat(style.paddingBottom)
        };
      });
      expect
        .soft(Math.abs(edges.top - edges.paddingTop), `${edges.name} top padding`)
        .toBeLessThan(1);
      expect
        .soft(Math.abs(edges.bottom - edges.paddingBottom), `${edges.name} bottom padding`)
        .toBeLessThan(1);
    }
    const plans = page.locator('.plan-step-list');
    await expect(plans).toHaveCount(2);
    const followingSteps = plans.filter({ hasText: 'Following step' });
    expect(
      await followingSteps.evaluate((element) => parseFloat(getComputedStyle(element).marginTop))
    ).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    await page.screenshot({
      path: testInfo.outputPath(`detail-edges-${width}.png`),
      fullPage: true
    });
  });
}

test('updates a conditional fallback slot and does not schedule copy feedback after unmount', async ({
  page
}) => {
  await page.goto(`${fixture.url}conversation-tool-detail.html?lifecycle-probe&locale=en-US`);
  const probe = page.getByTestId('lifecycle-probe');
  const detail = probe.getByTestId('lifecycle-detail').locator('.tool-detail');
  await expect(detail).not.toHaveClass(/mar-conversation-detail-body/);
  await probe.getByTestId('toggle-slot').click();
  await expect(detail).toHaveClass(/mar-conversation-detail-body/);
  await expect(probe.getByTestId('lifecycle-slot')).toHaveText('Slot content');
  await probe.getByTestId('toggle-slot').click();
  await expect(detail).not.toHaveClass(/mar-conversation-detail-body/);
  await expect(probe.getByTestId('lifecycle-slot')).toHaveCount(0);

  await detail.getByRole('button', { name: 'Copy public record' }).click();
  await expect(probe.getByTestId('copy-pending')).toHaveText('true');
  await probe.getByTestId('unmount-detail').click();
  await expect(detail).toHaveCount(0);
  await page.evaluate(() => {
    const original = window.setTimeout;
    const feedback = Object.assign(window, { feedbackTimers: 0 });
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === 500) feedback.feedbackTimers++;
      return original(handler, timeout, ...args);
    }) as typeof window.setTimeout;
  });
  await probe.getByTestId('resolve-copy').click();
  await expect(probe.getByTestId('copy-completed')).toHaveText('true');
  expect(
    await page.evaluate(() => (window as Window & { feedbackTimers?: number }).feedbackTimers)
  ).toBe(0);
});

test('updates fixed labels in the mounted detail without changing raw text or expansion', async ({
  page
}) => {
  await page.goto(`${fixture.url}conversation-tool-detail.html?lifecycle-probe&locale=en-US`);
  const detail = page.getByTestId('locale-detail').locator('.tool-detail');
  const input = '  input stays\n  unchanged\n';
  const output = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
  expect(
    await detail.locator('pre').evaluateAll((nodes) => nodes.map((node) => node.textContent))
  ).toEqual([input, output]);
  await expect(detail).toContainText('Input:');
  await expect(detail).toContainText('Output:');
  await detail.getByRole('button', { name: 'Show more' }).click();
  await expect(detail.getByRole('button', { name: 'Show less' })).toBeVisible();
  await detail.evaluate((element) => {
    (window as Window & { originalDetail?: Element }).originalDetail = element;
  });
  await page.getByTestId('switch-locale').click();
  expect(
    await detail.evaluate(
      (element) => element === (window as Window & { originalDetail?: Element }).originalDetail
    )
  ).toBe(true);
  await expect(detail).toContainText('输入:');
  await expect(detail).toContainText('输出:');
  expect(
    await detail.locator('pre').evaluateAll((nodes) => nodes.map((node) => node.textContent))
  ).toEqual([input, output]);
  await expect(detail.getByRole('button', { name: '收起' })).toBeVisible();
});

async function expectGenericDetail(detail: Locator) {
  await expect(detail.locator('pre')).toHaveText(['Preserved input', 'Partial inspection output']);
  for (const text of [
    'Details: Inspect fixture',
    'Input:',
    'Output:',
    '[Truncated]',
    'Progress: Stopped at the last file',
    'Error: INSPECTION_FAILED'
  ])
    await expect(detail).toContainText(text);
}

for (const { width, theme, locale } of [
  { width: 1280, theme: 'daylight', locale: 'en-US' },
  { width: 390, theme: 'dark', locale: 'zh-CN' }
]) {
  test(`compact and generic tool details remain readable at ${width}px`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await grantClipboardPermissions(page.context());
    await page.goto(
      `${fixture.url}conversation-tool-detail.html?timeline&unified&compact-tools&theme=${theme}&locale=${locale}`
    );
    const process = page.locator('.process-heading').first();
    if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
    for (const group of await page
      .locator('details.conversation-record-group:not([data-tool-presentation]) > summary')
      .all())
      if (!(await group.locator('..').evaluate((element) => (element as HTMLDetailsElement).open)))
        await group.click();
    const sleep = page.locator('[data-tool-presentation="SLEEP"]');
    await sleep.locator('> summary').click();
    const sleepBody = sleep.locator('.compact-detail');
    await expect(sleepBody).toContainText('sleep');
    await expect(sleepBody).toContainText('800');
    await expect(sleepBody).not.toContainText('raw input for copying');
    await sleepBody.scrollIntoViewIfNeeded();
    await expectUnclippedDetail(sleepBody);
    const sleepBounds = await sleep.locator('.mar-conversation-detail-body').boundingBox();
    for (const [name, expected] of [
      ['tool_search', 'tools <query>'],
      ['view_image', '/fixture/example.png'],
      ['smart_compact', locale === 'en-US' ? 'Compaction request accepted' : '已接受压缩请求']
    ] as const) {
      const row = page
        .locator('details.conversation-tool-detail')
        .filter({ hasText: name })
        .first();
      await row.locator('> summary').click();
      const body = row.locator('.compact-detail');
      const bounds = await row.locator('.mar-conversation-detail-body').boundingBox();
      expect(Math.abs(bounds!.x - sleepBounds!.x)).toBeLessThan(1);
      await expect(body).toContainText(expected);
      await expect(body).not.toContainText('raw input for copying');
      const meta = body.locator('.tool-detail-meta').first();
      await expect(meta).toHaveCSS('font-weight', '400');
      await expect(meta).toHaveCSS('font-size', '12px');
      const visibleDetail = name === 'tool_search' ? row.locator('.detail-preview-window') : body;
      await visibleDetail.scrollIntoViewIfNeeded();
      await expectUnclippedDetail(visibleDetail);
      if (name === 'view_image') {
        await expect(body.locator('img')).toHaveCount(0);
        await expect(body).toContainText(locale === 'en-US' ? 'Source size' : '原始尺寸');
        await expect(body).toContainText('1600 × 1200');
      }
      if (name === 'tool_search') {
        const more = row.getByRole('button', { name: /Show more|展开更多/ });
        await expect(more).toBeVisible();
        await row.getByRole('button', { name: /Copy public record|复制公开记录/ }).click();
        const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
        expect(copied.payload.inputSummary).toBe('raw input for copying');
        expect(copied.payload.toolPresentation.tools).toHaveLength(20);
        await more.click();
        await expect(row.getByRole('button', { name: /Show less|收起/ })).toBeVisible();
        await row.locator('> summary').click();
        await expect(row.locator('.compact-detail')).toHaveCount(0);
        await row.locator('> summary').click();
        await expect(row.getByRole('button', { name: /Show more|展开更多/ })).toBeVisible();
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    const compact = page
      .locator('details.conversation-tool-detail')
      .filter({ hasText: 'smart_compact' })
      .first()
      .locator('.compact-detail');
    await compact.scrollIntoViewIfNeeded();
    await expectUnclippedDetail(compact);
    await page.screenshot({
      path: testInfo.outputPath(`compact-details-${width}-${theme}.png`),
      fullPage: true
    });
    await process.click();
    await expect(page.locator('.compact-detail')).toHaveCount(0);
    await page.goto(`${fixture.url}conversation-tool-detail.html?theme=${theme}&locale=${locale}`);
    const generic = page.getByTestId('generic');
    await generic.locator('> summary').click();
    await expect(generic.locator('.generic-detail')).toContainText('Partial inspection output');
    await expect(generic.locator('.generic-detail')).toContainText('INSPECTION_FAILED');
    await generic.scrollIntoViewIfNeeded();
    await expectUnclippedDetail(generic.locator('.generic-detail'));
    await page.screenshot({
      path: testInfo.outputPath(`generic-details-${width}-${theme}.png`),
      fullPage: true
    });
  });
}

for (const variant of [
  { width: 1280, theme: 'daylight', locale: 'en-US', more: 'Show more', less: 'Show less' },
  { width: 390, theme: 'dark', locale: 'zh-CN', more: '展开更多', less: '收起' }
]) {
  test(`previews the complete detail area by height at ${variant.width}px`, async ({
    page
  }, testInfo) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.setViewportSize({ width: variant.width, height: 900 });
    await grantClipboardPermissions(page.context());
    await page.goto(
      `${fixture.url}conversation-tool-detail.html?timeline=1&unified=1&updates=1&read-association=1&preview=1&theme=${variant.theme}&locale=${variant.locale}`
    );
    const process = page.locator('.process-heading').first();
    if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
    const read = page.locator('[data-tool-presentation="READ"]');
    await read.locator('> summary').click();
    const file = read.locator('.conversation-tool-detail');
    await file.locator('> summary').click();
    const preview = file.locator('.detail-preview-window');
    const more = file.getByRole('button', { name: variant.more, exact: true });
    await expect(more).toBeVisible();
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(file.locator('pre')).toContainText('Returned line 40');
    await expect(file.locator('pre')).not.toContainText('[Truncated]');
    const heights = await preview.evaluate((element) => ({
      visible: element.getBoundingClientRect().height,
      full: element.firstElementChild!.getBoundingClientRect().height,
      limit: parseFloat(getComputedStyle(element).lineHeight) * 12
    }));
    expect(heights.visible).toBeLessThanOrEqual(heights.limit + 1);
    expect(heights.full).toBeGreaterThan(heights.visible);
    await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
    await page.screenshot({
      path: testInfo.outputPath(`detail-preview-${variant.width}.png`),
      fullPage: true
    });
    await file.getByRole('button', { name: /Copy public record|复制公开记录/ }).click();
    const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
    expect(copied.payload.output.blocks[0].text).toContain('Returned line 40');
    await more.focus();
    await page.keyboard.press('Enter');
    const less = file.getByRole('button', { name: variant.less, exact: true });
    await expect(less).toHaveAttribute('aria-expanded', 'true');
    await expect(preview).toHaveCSS('max-height', 'none');
    await less.click();
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await more.click();
    await file.locator('> summary').click();
    await expect(file.locator('.detail-preview')).toHaveCount(0);
    await file.locator('> summary').click();
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await page.getByTestId('stream-details').click();
    await expect(file.locator('pre')).toContainText('live output');
    await expect(more).toHaveCount(0);
    await page.getByTestId('finish-details').click();
    await expect(file.locator('pre')).toContainText('[Truncated]');
    await expect(more).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    expect(pageErrors).toEqual([]);
  });
}

test('uses area height for wrapped single-line execution output and keeps copy outside', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`${fixture.url}conversation-tool-detail.html`);
  const exec = page.getByTestId('exec');
  await exec.locator('summary').click();
  await expect(exec.getByRole('button', { name: 'Show more', exact: true })).toHaveCount(0);
  await page.getByTestId('finish').click();
  const more = exec.getByRole('button', { name: 'Show more', exact: true });
  await expect(more).toBeVisible();
  await expect(exec.getByRole('button', { name: 'Copy public record' })).toBeVisible();
  expect(
    await exec
      .locator('.detail-preview-window')
      .evaluate((element) => element.scrollHeight > element.clientHeight)
  ).toBe(true);
  await more.click();
  await expect(exec.locator('.detail-preview-window')).toHaveCSS('max-height', 'none');
  await expect(exec.locator('.tool-output-text')).toContainText('TAIL');
  await expect(exec.locator('.execution-detail')).toHaveText(/TAIL\s+\[Truncated\]\s+Exit 0$/, {
    useInnerText: true
  });
  await expect(exec.getByRole('button', { name: 'Show less', exact: true })).toBeVisible();
});

test('remeasures on resize and reveals a keyboard-focused link below the preview', async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.url}conversation-tool-detail.html?preview-probe=1`);
  const probe = page.getByTestId('preview-probe');
  const more = probe.getByRole('button', { name: 'Show more', exact: true });
  const less = probe.getByRole('button', { name: 'Show less', exact: true });
  await expect(more).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(more).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(more).toHaveCount(0);
  await page.getByTestId('stretch-preview').click();
  await expect(more).toBeVisible();
  const link = page.getByTestId('preview-link');
  await link.focus();
  await expect(less).toHaveAttribute('aria-expanded', 'true');
  await expect(link).toBeFocused();
  await expect(link).toBeInViewport();
});

test('mounts independent details only while open and releases them with the process', async ({
  page
}) => {
  await page.goto(`${fixture.url}conversation-tool-detail.html?timeline=1&unified=1&web-layout`);
  const process = page.locator('.process-heading').first();
  if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
  const search = page.locator('[data-tool-presentation="WEB_SEARCH"]');
  const fetch = page.locator('[data-tool-presentation="WEB_FETCH"]');
  await expect(search.locator('.tool-detail, .conversation-tool-sources a')).toHaveCount(0);
  await expect(fetch.locator('.tool-detail')).toHaveCount(0);
  await search.locator('> summary').click();
  await expect(search).toHaveJSProperty('open', true);
  await fetch.locator('> summary').click();
  await expect(fetch).toHaveJSProperty('open', true);
  await expect(search.locator('.conversation-tool-sources a')).toHaveCount(7);
  await expect(search.locator('.conversation-tool-sources a').first()).toHaveAttribute(
    'href',
    'https://example.com/docs'
  );
  await expect(search.locator('.conversation-tool-sources a').first()).toHaveAttribute(
    'rel',
    'noopener noreferrer'
  );
  await expect(search.locator('.conversation-tool-source-host').first()).toHaveText(
    'https://example.com/docs'
  );
  await expect(search.locator('.conversation-tool-sources')).toContainText(
    'A plain-text search summary.'
  );
  await expect(search.locator('.conversation-tool-sources')).toContainText('<plain summary>');
  await expect(search.locator('.conversation-tool-sources plain')).toHaveCount(0);
  expect(await search.locator('.conversation-tool-sources').innerHTML()).toContain(
    '&lt;plain summary&gt;'
  );
  await expect(search.locator('.web-query')).toHaveText('Documentation and release notes');
  await expect(search.locator('.tool-detail')).not.toContainText('Input:');
  await expect(search.locator('.web-output')).toHaveCount(0);
  await expect(search.locator('.tool-detail')).not.toContainText(
    'Redundant source output is preserved in the copied public record.'
  );
  await expect(fetch.locator('.web-page-url a')).toHaveAttribute(
    'href',
    'https://example.com/docs'
  );
  await expect(fetch.locator('.web-page-url a')).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(fetch.locator('.web-output')).toContainText('Returned page paragraph 1.');
  await expect(fetch.locator('.tool-detail')).not.toContainText('Input:');
  await search.locator('> summary').click();
  await expect(search.locator('.tool-detail, .conversation-tool-sources a')).toHaveCount(0);
  await process.click();
  await expect(
    page.locator('[data-tool-presentation="WEB_FETCH"] .mar-conversation-detail-text')
  ).toHaveCount(0);
  await process.click();
  await expect(
    page.locator('[data-tool-presentation="WEB_FETCH"] .mar-conversation-detail-text')
  ).toHaveCount(0);
});

test('read file details separate their path and range from the associated raw file text', async ({
  page
}) => {
  await page.goto(
    `${fixture.url}conversation-tool-detail.html?timeline=1&unified=1&read-association=1`
  );
  const process = page.locator('.process-heading').first();
  if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
  const read = page.locator('[data-tool-presentation="READ"]');
  await read.locator('> summary').click();
  await read.locator('.conversation-tool-detail > summary').click();
  const detail = read.locator('.mar-conversation-detail-text');
  await expect(read.locator('.conversation-tool-detail > summary')).toContainText('3–4');
  await expect(read.locator('.tool-detail-heading')).toHaveText('/fixture/example.ts · 3–4');
  await expect(detail).toHaveText('  first file\r\nsecond line\r\n', { useInnerText: false });
  await expect(detail).not.toContainText('3–4');
  await expect(detail).not.toContainText('/fixture/example.ts');
  await expect(detail).not.toContainText('1: export const result');
});

for (const [width, theme, locale] of [
  [1280, 'daylight', 'en-US'],
  [390, 'dark', 'zh-CN']
] as const) {
  test(`renders the revised Read, Skill and execution layouts at ${width}px`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await grantClipboardPermissions(page.context());
    await page.goto(
      `${fixture.url}conversation-tool-detail.html?timeline&unified&read-association&detail-layout&theme=${theme}&locale=${locale}`
    );
    const process = page.locator('.process-heading').first();
    if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
    const read = page.locator('[data-tool-presentation="READ"]');
    await read.locator('> summary').click();
    await read.locator('.conversation-tool-detail > summary').click();
    await expect(read.locator('.tool-detail-heading')).toHaveText('/fixture/example.ts · 3–4');
    const skill = page.locator('[data-tool-presentation="SKILL"]');
    await skill.locator('> summary').click();
    await expect(skill.locator('.tool-detail-heading')).toHaveText('mar-web-spec');
    const readBounds = await read.locator('.mar-conversation-detail-body').boundingBox();
    const skillBounds = await skill.locator('.mar-conversation-detail-body').boundingBox();
    expect(Math.abs(skillBounds!.x - readBounds!.x)).toBeLessThan(1);
    const description = skill.locator('.mar-conversation-detail-text');
    await expect(description).toHaveText(
      'Design <plain> interfaces.\nKeep the original description and its line breaks.'
    );
    await expect(skill.locator('plain')).toHaveCount(0);
    await expect(skill).not.toContainText('Complete skill output');
    await expect(skill).not.toContainText('original skill request');
    await expect(skill).not.toContainText('Output:');
    await skill.getByRole('button', { name: /Copy public record|复制公开记录/ }).click();
    await expect(skill.getByRole('button', { name: /Copied|已复制/ })).toBeVisible();
    const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
    expect(copied.payload.output.blocks[0].text).toBe(
      'Complete skill output is copied, not displayed.'
    );
    await page.locator('.command-group > details > summary').click();
    const shell = page
      .locator('.conversation-command-detail')
      .filter({ has: page.locator('.conversation-command-preview', { hasText: 'printf test' }) });
    await shell.locator('> summary').click();
    await expect(shell.locator('.tool-detail-heading')).toHaveText('exec');
    await expect(shell.locator('.tool-source-text')).toHaveText(
      locale === 'en-US' ? 'Command: printf test' : '命令: printf test'
    );
    await expect(shell.locator('.execution-output').nth(0)).toContainText(
      locale === 'en-US' ? 'Output:' : '输出:'
    );
    await expect(shell.locator('.execution-output').nth(1)).toContainText('stderr:');
    const code = page.locator('.conversation-command-detail').filter({
      has: page.locator('.conversation-command-preview', {
        hasText: 'const result = await tools.read'
      })
    });
    await code.locator('> summary').click();
    await expect(code.locator('.tool-detail-heading')).toHaveText('code_exec');
    await expect(code.locator('.tool-source-text')).toContainText(
      locale === 'en-US' ? 'Code: const result' : '代码: const result'
    );
    await expect(code.locator('.tool-output-text')).toHaveText('Observed the requested file.');
    await expect(code.locator('.tool-exit')).toHaveCount(0);
    for (const body of [read, skill, shell, code]) {
      const heading = body.locator('.tool-detail-heading');
      await expect(heading).toHaveCSS('font-size', '12px');
      await expect(heading).toHaveCSS('font-weight', '400');
      for (const content of await body.locator('.mar-conversation-detail-text').all()) {
        await expect(content).toHaveCSS('font-size', '12px');
        await expect(content).toHaveCSS('font-weight', '400');
      }
      expect(await heading.evaluate((element) => getComputedStyle(element).color)).not.toBe(
        await body
          .locator('.mar-conversation-detail-text')
          .first()
          .evaluate((element) => getComputedStyle(element).color)
      );
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    await page.setViewportSize({ width, height: 1600 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await expectUnclippedDetail(code.locator('.execution-detail'));
    await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
    await page.screenshot({
      path: testInfo.outputPath(`revised-details-${width}-${theme}.png`),
      fullPage: true
    });
  });
}

for (const width of [1280, 390]) {
  test(`wait rows use explicit commands, code or resource IDs at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await grantClipboardPermissions(page.context());
    await page.goto(
      `${fixture.url}conversation-tool-detail.html?timeline&unified&wait-titles&locale=${width === 390 ? 'zh-CN' : 'en-US'}&theme=${width === 390 ? 'dark' : 'daylight'}`
    );
    const process = page.locator('.process-heading').first();
    if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
    await page.locator('.command-group > details > summary').click();
    const source = `pnpm test --filter fixture ${'long-argument-'.repeat(24)}`;
    const code = `await tools.exec({ command: "${source}" });\nawait tools.agent_wait({ agentId: "peer" });`;
    for (const [targetId, toolName, title] of [
      ['p_known', 'exec_wait', `wait ${source}`],
      ['c_known', 'code_exec_wait', `wait ${code}`],
      ['p_unknown', 'exec_wait', 'wait p_unknown'],
      ['c_unknown', 'code_exec_wait', 'wait c_unknown']
    ] as const) {
      const row = page.locator('.conversation-command-detail').filter({
        has: page.locator('.conversation-command-preview', { hasText: title })
      });
      const matchingRow = row;
      const preview = matchingRow.locator('.conversation-command-preview');
      await expect(preview).toHaveText(title.replaceAll('\n', ' '));
      if (targetId === 'p_known' || targetId === 'c_known') {
        expect(await preview.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
          true
        );
      }
      await expect(matchingRow.locator('.tool-detail')).toHaveCount(0);
      await matchingRow.locator('> summary').click();
      await expect(matchingRow.locator('.tool-detail-heading')).toContainText(`${toolName} · Poll`);
      if (targetId === 'p_unknown' || targetId === 'c_unknown')
        await expect(matchingRow.locator('.tool-detail-heading')).toContainText(targetId);
      if (targetId === 'c_known') {
        await expect(matchingRow.locator('.execution-detail')).toContainText(
          width === 390 ? '代码:' : 'Code:'
        );
        await expect(matchingRow.locator('.execution-detail')).toContainText(code);
        await expect(matchingRow.locator('.tool-detail-heading')).not.toContainText(targetId);
      }
      await matchingRow.getByRole('button', { name: /Copy public record|复制公开记录/ }).click();
      await expect(matchingRow.getByRole('button', { name: /Copied|已复制/ })).toBeVisible();
      const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
      expect(copied.payload.toolPresentation.execution.toolName).toBe(toolName);
      expect(copied.payload.toolPresentation.execution.targetId).toBe(targetId);
      if (targetId === 'c_known')
        expect(copied.payload.toolPresentation.execution.source.text).toBe(code);
      await matchingRow.locator('> summary').click();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
  });

  test(`Read keeps the range visible beside a long path at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const path = `/fixture/${'long-directory/'.repeat(24)}README.md`;
    await page.goto(
      `${fixture.url}conversation-tool-detail.html?timeline&unified&read-association&read-path=${encodeURIComponent(path)}`
    );
    const process = page.locator('.process-heading').first();
    if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
    const read = page.locator('[data-tool-presentation="READ"]');
    await read.locator('> summary').click();
    const heading = read.locator('.conversation-tool-detail > summary');
    const range = heading.locator('.conversation-read-range');
    await expect(range).toHaveText('· 3–4');
    const geometry = await range.evaluate((element) => {
      const range = element.getBoundingClientRect();
      const preview = element.parentElement!.getBoundingClientRect();
      return { left: range.left, right: range.right, start: preview.left, end: preview.right };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(geometry.start);
    expect(geometry.right).toBeLessThanOrEqual(geometry.end + 1);
    const pathBox = heading.locator('.conversation-read-path');
    await expect(pathBox).toHaveText(path);
    expect((await pathBox.boundingBox())!.width).toBeGreaterThan(32);
    expect(await pathBox.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
      true
    );
    const height = (await heading.boundingBox())!.height;
    await heading.click();
    await expect(read.locator('.mar-conversation-detail-text')).toHaveText(
      '  first file\r\nsecond line\r\n'
    );
    expect((await heading.boundingBox())!.height).toBe(height);
    await heading.click();
    await expect(read.locator('.mar-conversation-detail-text')).toHaveCount(0);
  });
}

for (const truncation of ['HEAD', 'SOURCE']) {
  test(`places the ${truncation} notice beside associated READ content`, async ({ page }) => {
    await page.goto(
      `${fixture.url}conversation-tool-detail.html?timeline&unified&read-association&read-truncation=${truncation}`
    );
    const process = page.locator('.process-heading').first();
    if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
    const read = page.locator('[data-tool-presentation="READ"]');
    await read.locator('> summary').click();
    await expect(read).toHaveJSProperty('open', true);
    await read.locator('.conversation-tool-detail > summary').click();
    const detail = read.locator('.mar-conversation-detail-text');
    await expect(detail).toContainText('[Truncated]');
    const text = await detail.textContent();
    expect(text?.match(/\[Truncated\]/gu)).toHaveLength(1);
    if (truncation === 'HEAD') expect(text).toMatch(/^\[Truncated\][\s\S]+second line\s*$/u);
    else expect(text).toMatch(/^ {2}first file[\s\S]+\[Truncated\]$/u);
  });
}

test('READ replaces body and association together, then falls back when a snapshot has none', async ({
  page
}) => {
  await page.goto(
    `${fixture.url}conversation-tool-detail.html?timeline&unified&updates&read-association`
  );
  const process = page.locator('.process-heading').first();
  if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
  const read = page.locator('[data-tool-presentation="READ"]');
  await read.locator('> summary').click();
  await read.locator('.conversation-tool-detail > summary').click();
  const detail = read.locator('.mar-conversation-detail-text');
  await expect(detail).toContainText('first file');
  await page.getByTestId('stream-details').click();
  await expect.poll(() => detail.textContent()).toContain('  live output\n\n  next line\n');
  await expect(detail).not.toContainText('first file');
  await page.getByTestId('finish-details').click();
  await expect.poll(() => detail.textContent()).toContain('  authoritative tail\n');
  await expect(detail).not.toContainText('live output');
  await page.getByTestId('clear-read-association').click();
  await expect(detail).toContainText('unassociated replacement');
  await expect(detail).not.toContainText('authoritative tail');
});

for (const [width, theme] of [
  [1280, 'daylight'],
  [390, 'dark']
] as const) {
  test(`web details keep source hierarchy, safe links and shared preview at ${width}px in ${theme}`, async ({
    browser
  }, testInfo) => {
    const context = await browser.newContext({
      viewport: { width, height: 1100 },
      reducedMotion: 'reduce',
      permissions: clipboardPermissions(browser)
    });
    try {
      const page = await context.newPage();
      await page.goto(
        `${fixture.url}conversation-tool-detail.html?timeline&unified&web-layout&theme=${theme}`
      );
      const process = page.locator('.process-heading').first();
      if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
      const search = page.locator('[data-tool-presentation="WEB_SEARCH"]');
      const fetch = page.locator('[data-tool-presentation="WEB_FETCH"]');
      await search.locator('> summary').click();
      await fetch.locator('> summary').click();
      await expect(search.locator('.web-query')).toHaveText('Documentation and release notes');
      await expect(search.locator('.web-output')).toHaveCount(0);
      await expect(search.locator('.tool-detail')).not.toContainText('copy-only input');
      await expect(search.locator('.detail-preview-toggle')).toBeVisible();
      await expect(search.locator('.detail-preview-toggle')).toHaveAttribute(
        'aria-expanded',
        'false'
      );
      await expect(fetch.locator('.web-page-origin')).toContainText(
        'From: https://example.com/old'
      );
      await expect(fetch.locator('.web-page-url a')).toHaveAttribute(
        'href',
        'https://example.com/docs'
      );
      await expect(fetch.locator('.web-output')).toContainText('Returned page paragraph 1.');
      await page.screenshot({
        path: testInfo.outputPath(`web-details-${width}-${theme}.png`),
        fullPage: true
      });
      await search.locator('.detail-preview-toggle').click();
      await expect(search.locator('.conversation-tool-sources li')).toHaveCount(8);
      await expect(search.locator('a[href^="javascript:"]')).toHaveCount(0);
      await expect(search.locator('.conversation-tool-sources script')).toHaveCount(0);
      await expect(search.locator('.conversation-tool-sources')).toContainText('<unsafe title>');
      await expect(search.locator('.conversation-tool-sources')).toContainText(
        '<script>plain text only</script>'
      );
      await expect(search.locator('.conversation-tool-sources a').first()).toHaveAttribute(
        'rel',
        'noopener noreferrer'
      );
      await expect(search.locator('.conversation-tool-source-host').first()).toHaveCSS(
        'font-size',
        '12px'
      );
      await expect(search.locator('.web-detail')).toHaveCSS('font-weight', '400');
      await fetch.locator('.detail-preview-toggle').click();
      await expect(fetch.locator('.web-output')).toContainText('Returned page paragraph 30.');
      await expect(fetch.locator('.web-detail')).toContainText('[Truncated]');
      await search.locator('.tool-detail-copy').click();
      await expect(page.getByTestId('copied')).toContainText('copy-only input');
      const copied = JSON.parse((await page.getByTestId('copied').textContent())!);
      expect(copied.payload.inputSummary).toContain('copy-only input');
      expect(copied.payload.outputSummary).toContain('Redundant source output');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      );
      await search.locator('> summary').click();
      await expect(search.locator('.web-detail')).toHaveCount(0);
      await search.locator('> summary').click();
      await expect(search.locator('.detail-preview-toggle')).toHaveAttribute(
        'aria-expanded',
        'false'
      );
    } finally {
      await context.close();
    }
  });
}

for (const width of [1280, 390]) {
  test(`detail-only native web tools keep their ordinary group at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${fixture.url}conversation-tool-detail.html?timeline&unified&external-web`);
    const process = page.locator('.process-heading').first();
    if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
    const groups = page.locator('details.conversation-record-group:not([data-tool-presentation])');
    for (const group of await groups.all()) await group.locator('> summary').click();
    for (const [name, text] of [
      ['WebSearch', 'Native documentation query'],
      ['WebFetch', 'https://example.com/native-page']
    ] as const) {
      const row = groups.locator('details.conversation-tool-detail').filter({ hasText: name });
      await expect(row).toHaveCount(1);
      await expect(row.locator('.web-detail')).toHaveCount(0);
      await row.locator('> summary').click();
      await expect(row.locator('.web-detail')).toContainText(text);
      if (name === 'WebSearch') {
        await expect(row.locator('.web-output')).toHaveCount(0);
        await expect(row.locator('.web-detail')).not.toContainText('Native public output');
      } else await expect(row.locator('.web-detail')).toContainText('Native public output');
      await expect(row.locator('.web-detail')).not.toContainText('copy-only native input');
      await expect(row.locator('.conversation-tool-sources')).toHaveCount(0);
      await row.locator('> summary').click();
      await expect(row.locator('.web-detail')).toHaveCount(0);
    }
    await expect(page.locator('[data-tool-presentation="WEB_SEARCH"]')).toHaveCount(1);
    await expect(page.locator('[data-tool-presentation="WEB_FETCH"]')).toHaveCount(1);
  });
}

test('renders image, search and compact details within the ordinary tool group', async ({
  page
}) => {
  await page.goto(`${fixture.url}conversation-tool-detail.html?timeline&unified&specialized`);
  const process = page.locator('.process-heading').first();
  if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
  const groups = page.locator('details.conversation-record-group:not([data-tool-presentation])');
  for (const group of await groups.all()) await group.locator('> summary').click();
  for (const [name, expected] of [
    ['view_image', '/fixture/image.png'],
    ['tool_search', 'mcp__example'],
    ['smart_compact', 'Compaction request accepted']
  ] as const) {
    const row = page.locator('details.conversation-tool-detail').filter({ hasText: name }).first();
    await row.locator(':scope > summary').click();
    await expect(row.locator('.tool-detail')).toContainText(expected);
    await expect(row.locator('.tool-detail')).toHaveClass(/mar-conversation-detail-body/);
  }
});

for (const [width, theme] of [
  [1280, 'daylight'],
  [390, 'dark']
] as const) {
  test(`captures specialized details at ${width}px in ${theme}`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      reducedMotion: 'reduce'
    });
    try {
      const page = await context.newPage();
      await page.goto(
        `${fixture.url}conversation-tool-detail.html?timeline&unified&specialized&read-association&long&theme=${theme}`
      );
      const process = page.locator('.process-heading').first();
      if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
      const read = page.locator('[data-tool-presentation="READ"]');
      await read.locator('> summary').click();
      await read.locator('.conversation-tool-detail > summary').click();
      await page.locator('[data-tool-presentation="WEB_SEARCH"] > summary').click();
      for (const group of await page
        .locator('details.conversation-record-group:not([data-tool-presentation])')
        .all())
        await group.locator('> summary').click();
      for (const name of ['view_image', 'tool_search', 'smart_compact']) {
        const detail = page
          .locator('details.conversation-tool-detail')
          .filter({ hasText: name })
          .first();
        await detail.locator('> summary').click();
        await expect(detail.locator('.tool-detail')).toBeVisible();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      );
      await page.screenshot({
        path: testInfo.outputPath(`specialized-${theme}-${width}.png`),
        fullPage: true
      });
    } finally {
      await context.close();
    }
  });
}

test('specialized tool details replace live output with the authoritative result', async ({
  page
}) => {
  await grantClipboardPermissions(page.context());
  await page.goto(
    `${fixture.url}conversation-tool-detail.html?timeline=1&unified=1&updates=1&read-association=1`
  );
  const process = page.locator('.process-heading').first();
  if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
  const read = page.locator('[data-tool-presentation="READ"]');
  await read.locator(':scope > summary').click();
  await expect(read).toHaveJSProperty('open', true);
  await read.locator('.conversation-tool-detail > summary').click();
  await expect(read.locator('.mar-conversation-detail-text')).toHaveText(
    '  first file\r\nsecond line\r\n',
    { useInnerText: false }
  );
  for (const kind of ['WEB_SEARCH', 'WEB_FETCH'])
    await page.locator(`[data-tool-presentation="${kind}"] > summary`).click();
  const child = page.locator('.subagent-group');
  await child.locator('.conversation-record-group > summary').click();
  await child.locator('.conversation-tool-detail > summary').click();
  const bodies = [
    read.locator('.mar-conversation-detail-text'),
    child.locator('.mar-conversation-detail-text')
  ];
  const webRegions = ['WEB_SEARCH', 'WEB_FETCH'].map((kind) => ({
    kind,
    region: page.locator(`[data-tool-presentation="${kind}"] .web-detail`)
  }));
  await page.getByTestId('stream-details').click();
  for (const [index, body] of bodies.entries()) {
    await expect
      .poll(() => body.textContent(), { message: `live detail ${index}` })
      .toContain(
        index === 0 ? '  live output\n\n  next line\n' : ':\n  live output\n\n  next line\n'
      );
    await expect(body).not.toContainText('Truncated');
  }
  for (const { kind, region } of webRegions) {
    if (kind === 'WEB_SEARCH') {
      await expect(region.locator('.web-output')).toHaveCount(0);
      await expect(region).not.toContainText('live output');
    } else
      await expect
        .poll(() => region.locator('.web-output .mar-conversation-detail-text').textContent())
        .toBe('  live output\n\n  next line\n');
    await expect(region).not.toContainText('[Truncated]');
  }
  await page.getByTestId('finish-details').click();
  for (const [index, body] of bodies.entries()) {
    if (index === 0) {
      await expect.poll(() => body.textContent()).toContain('  authoritative tail\n');
      const readText = (await body.textContent()) ?? '';
      expect(readText.indexOf('[Truncated]')).toBeGreaterThan(
        readText.indexOf('authoritative tail')
      );
    } else {
      await expect
        .poll(() => body.textContent())
        .toContain(':\n  authoritative tail\n\n[Truncated]');
    }
    await expect(body).not.toContainText('live output');
    await expect(body).not.toContainText('export const result');
    await expect(body).not.toContainText('The requested page content.');
    await expect(body).not.toContainText('Message delivered.');
  }
  for (const { kind, region } of webRegions) {
    if (kind === 'WEB_SEARCH') {
      await expect(region.locator('.web-output')).toHaveCount(0);
      await expect(region).not.toContainText('authoritative tail');
      await expect(region).toContainText('[Truncated]');
    } else {
      await expect
        .poll(() => region.locator('.web-output .mar-conversation-detail-text').textContent())
        .toBe('  authoritative tail\n');
      const text = await region.textContent();
      expect(text!.indexOf('[Truncated]')).toBeGreaterThan(text!.indexOf('authoritative tail'));
    }
    await expect(region).not.toContainText('live output');
    await expect(region).not.toContainText('Relevant documentation found.');
    await expect(region).not.toContainText('The requested page content.');
  }
  await expect(page.locator('.conversation-tool-sources a')).toHaveAttribute(
    'href',
    'https://example.com/docs'
  );
  await page.locator('[data-tool-presentation="WEB_SEARCH"] .tool-detail-copy').click();
  await expect(page.getByTestId('copied')).toContainText('authoritative tail');
  const copied = JSON.parse((await page.getByTestId('copied').textContent())!);
  expect(copied.payload.output).toMatchObject({
    blocks: [{ channel: 'TEXT', text: '  authoritative tail\n' }],
    truncation: 'SOURCE'
  });
});

test('places the HEAD marker before authoritative output without repeating it at the end', async ({
  page
}) => {
  await page.goto(`${fixture.url}conversation-tool-detail.html?head`);
  const exec = page.getByTestId('exec');
  await exec.locator('summary').click();
  await page.getByTestId('finish').click();
  const pre = exec.locator('.tool-output-text');
  await expect(pre).toHaveText(/^\[Truncated\]\nx+TAIL$/);
  await expect(exec.locator('.tool-exit')).toHaveText('Exit 0');
  await expect(pre).not.toContainText('TAIL\n[Truncated]');
  await expect(pre).not.toContainText('visible stdout');
});

for (const width of [1280, 390]) {
  test(`execution details, copy and terminal replacement at ${width}px`, async ({
    browser
  }, testInfo) => {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      permissions: clipboardPermissions(browser)
    });
    try {
      const page = await context.newPage();
      await page.goto(
        `${fixture.url}conversation-tool-detail.html?theme=${width === 390 ? 'dark' : 'daylight'}`
      );
      const exec = page.getByTestId('exec');
      await exec.locator('summary').click();
      await expect(exec.locator('.tool-detail-heading')).toHaveText('exec');
      await expect(exec.locator('.tool-source-text')).toHaveText('Command: printf test');
      await expect(exec.locator('.execution-detail')).toContainText('Working directory: /fixture');
      const cwd = exec.locator('.tool-cwd-value');
      await expect(cwd).toHaveText('/fixture');
      await expect(cwd).toHaveCSS(
        'color',
        await exec
          .locator('.tool-source-text')
          .evaluate((element) => getComputedStyle(element).color)
      );
      expect(await cwd.evaluate((element) => getComputedStyle(element).color)).not.toBe(
        await cwd.locator('..').evaluate((element) => getComputedStyle(element).color)
      );
      await expect(exec).toContainText('visible stdout');
      await expect(exec).toContainText('visible stderr');
      await expect(exec).not.toContainText('combined should not replace streams');
      const copyButton = exec.getByRole('button', { name: 'Copy public record' });
      await expect(copyButton).toHaveText('');
      await expect(exec).not.toContainText('may be truncated');
      for (const pre of await exec.locator('pre').all()) {
        await expect(pre).toHaveCSS('border-top-width', '0px');
        await expect(pre).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(pre).toHaveCSS('max-height', 'none');
      }
      const detailBox = await exec.locator('.tool-detail').boundingBox();
      const copyBox = await copyButton.boundingBox();
      expect(
        Math.abs(copyBox!.x + copyBox!.width + 8 - detailBox!.x - detailBox!.width)
      ).toBeLessThan(2);
      expect(copyBox!.y - detailBox!.y).toBeLessThan(12);

      await exec.getByRole('button', { name: 'Copy public record' }).click();
      await expect(page.getByTestId('copied')).toContainText('exec-a');
      const copied = JSON.parse((await page.getByTestId('copied').textContent()) ?? '{}');
      expect(copied.id).toBe('exec-a');
      expect(copied.payload.command).toBe('printf test');
      await expect(exec.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
      await page.getByTestId('empty').locator('summary').click();
      await expect(page.getByTestId('empty').locator('.execution-output')).toHaveCount(0);
      await expect(page.getByTestId('empty')).not.toContainText('No output');
      await expect(page.getByTestId('empty')).not.toContainText('stderr');
      await page.getByTestId('generic').locator('summary').click();
      await expectGenericDetail(page.getByTestId('generic').locator('.generic-detail'));
      await page.getByTestId('wait').locator('summary').click();
      await expect(page.getByTestId('wait')).toContainText('Wait failed');
      await expect(page.getByTestId('wait').locator('.tool-detail-heading')).toHaveText(
        'exec_wait · Poll'
      );
      await expect(page.getByTestId('wait').locator('.tool-source-text')).toHaveText(
        'Command: pnpm test --filter fixture'
      );
      await page.getByTestId('declined').locator('summary').click();
      await expect(page.getByTestId('declined')).toContainText('Declined');
      await expect(page.getByTestId('declined')).not.toContainText(
        'toolPresentation.detail.DECLINED'
      );
      await page.getByTestId('finish').click();
      await expect(exec).toContainText('TAIL');
      await expect(exec).toContainText('[Truncated]');
      await expect(exec.locator('.execution-detail')).toHaveText(/\[Truncated\]\s+Exit 0$/, {
        useInnerText: true
      });
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

for (const width of [1280, 390]) {
  for (const theme of ['daylight', 'dark']) {
    test(`tool details blend into the timeline at ${width}px in ${theme}`, async ({
      browser
    }, testInfo) => {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      try {
        const page = await context.newPage();
        const reasoningQuery = theme === 'dark' ? '&reasoning-pair' : '';
        await page.goto(
          `${fixture.url}conversation-tool-detail.html?timeline=1&long=1&unified=1&theme=${theme}${reasoningQuery}`
        );
        const process = page.locator('.process-heading').first();
        if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
        const group = page.locator('.conversation-record-group').filter({ hasText: 'Command' });
        await group.locator(':scope > summary').click();
        const command = page.locator('.conversation-command-detail');
        await command.locator(':scope > summary').click();
        const detail = command.locator('.tool-detail');
        await expect(detail).toContainText('visible stdout');
        await expect(detail).toContainText('visible stderr');
        await expect(detail.locator('.tool-source-text')).toHaveCount(1);
        await expect(detail.locator('.execution-output')).toHaveCount(2);
        await expect(detail.locator('strong, dl, dt, dd')).toHaveCount(0);
        await expect(detail.locator('.tool-source-text')).toContainText(
          'Code: observe.result(await tools.exec('
        );
        await expect(detail.locator('.execution-output > .tool-detail-meta')).toHaveText([
          'Output:',
          'stderr:'
        ]);
        await expect(detail.locator('.tool-output-text')).toHaveText([
          'visible stdout',
          'visible stderr'
        ]);
        await expect(detail).not.toContainText('Working directory:');
        await expect(detail).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        const expand = detail.getByRole('button', { name: 'Show more', exact: true });
        if (await expand.isVisible()) await expand.click();
        const textBounds = await detail.locator('.tool-source-text').boundingBox();
        const titleBounds = await command.locator('.conversation-command-preview').boundingBox();
        expect(Math.abs(textBounds!.x - titleBounds!.x)).toBeLessThan(3);
        await expect(detail.locator('.tool-source-text')).toHaveCSS('font-weight', '400');

        await expectUnclippedDetail(detail.locator('.execution-detail'));

        const button = detail.getByRole('button', { name: 'Copy public record' });
        await expect(button).toHaveText('');
        const bounds = await detail.boundingBox();
        const copyBounds = await button.boundingBox();
        expect(
          Math.abs(copyBounds!.x + copyBounds!.width + 8 - bounds!.x - bounds!.width)
        ).toBeLessThan(2);
        for (const pre of await detail.locator('pre').all()) {
          await expect(pre).toHaveCSS('border-top-width', '0px');
          await expect(pre).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
          await expect(pre).toHaveCSS('overflow-y', 'visible');
          await expect(pre).toHaveCSS('overflow-x', 'visible');
          await expect(pre).toHaveCSS('max-height', 'none');
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true
        );
        const reasoning = page.locator('.reasoning-group');
        await reasoning.locator('summary').click();
        const thinking = reasoning.locator('.mar-conversation-detail-text');
        await expect(thinking).toContainText('Keep the changes focused.');
        if (reasoningQuery) await expect(thinking).toContainText('Check the shared reading start.');
        const thinkingBounds = await thinking.boundingBox();
        expect(Math.abs(thinkingBounds!.x - textBounds!.x)).toBeLessThan(1);
        const thinkingStyle = await thinking.evaluate((element) => ({
          fontSize: getComputedStyle(element).fontSize,
          lineHeight: getComputedStyle(element).lineHeight,
          color: getComputedStyle(element).color,
          expectedColor: getComputedStyle(element.closest('.conversation-item')!).color,
          background: getComputedStyle(element.closest('.mar-conversation-detail-body')!)
            .backgroundColor
        }));
        expect(thinkingStyle.fontSize).toBe('12px');
        expect(thinkingStyle.color).toBe(thinkingStyle.expectedColor);
        const read = page.locator('[data-tool-presentation="READ"]');
        await read.locator(':scope > summary').click();
        await read.locator('.conversation-tool-detail > summary').click();
        for (const kind of ['WEB_SEARCH', 'WEB_FETCH'])
          await page.locator(`[data-tool-presentation="${kind}"] > summary`).click();
        await expect(
          page.locator('.conversation-tool-sources .mar-conversation-detail-text')
        ).toHaveCSS('font-size', thinkingStyle.fontSize);
        await expect(page.locator('.conversation-tool-sources a')).toHaveCSS(
          'font-size',
          thinkingStyle.fontSize
        );
        const subagent = page.locator('.subagent-group');
        await subagent.locator('.conversation-record-group > summary').click();
        await subagent.locator('.conversation-tool-detail > summary').click();
        const generic = page.locator('.tool-group:not(:has([data-tool-presentation="READ"]))');
        await generic.locator('.conversation-record-group > summary').click();
        await generic.locator('.conversation-tool-detail > summary').click();
        await expectGenericDetail(generic.locator('.generic-detail'));
        const surfaces = page.locator('.mar-conversation-detail-body');
        const search = page.locator('[data-tool-presentation="WEB_SEARCH"]');
        await expect(search.locator('.web-detail')).toBeVisible();
        await expect(search.locator('.web-output')).toHaveCount(0);
        await expect(search.locator('.mar-conversation-detail-body')).toHaveCount(1);
        await expect(surfaces).toHaveCount(7);
        for (const surface of await surfaces.all()) {
          const spacing = await surface.evaluate((element) => {
            const text = element.querySelector('.mar-conversation-detail-text')!;
            const heading = element.parentElement!.querySelector(':scope > summary')!;
            const title = heading.querySelector(
              ':scope > strong, :scope > span:not(.mar-disclosure-icon):not(.conversation-record-icon)'
            )!;
            return {
              hasTypeIcon: !!heading.querySelector(':scope > .conversation-record-icon'),
              left: element.getBoundingClientRect().left,
              textLeft: text.getBoundingClientRect().left,
              inset: text.getBoundingClientRect().left - element.getBoundingClientRect().left,
              expectedInset: parseFloat(getComputedStyle(document.documentElement).fontSize) * 0.75,
              titleOffset: text.getBoundingClientRect().left - title.getBoundingClientRect().left
            };
          });
          expect(Math.abs(spacing.left - bounds!.x)).toBeLessThan(1);
          expect(Math.abs(spacing.textLeft - textBounds!.x)).toBeLessThan(1);
          expect(Math.abs(spacing.inset - spacing.expectedInset)).toBeLessThan(1);
          if (!spacing.hasTypeIcon) expect(Math.abs(spacing.titleOffset)).toBeLessThan(3);
          await expect(surface).toHaveCSS('background-color', thinkingStyle.background);
          const radius = await surface.evaluate((element) =>
            getComputedStyle(element).getPropertyValue('--mar-radius-surface').trim()
          );
          await expect(surface).toHaveCSS('border-radius', radius);
          const contents = surface.locator('.mar-conversation-detail-text');
          expect(await contents.count()).toBeGreaterThan(0);
          for (const content of await contents.all()) {
            await expect(content).toHaveCSS('font-size', thinkingStyle.fontSize);
            await expect(content).toHaveCSS('line-height', thinkingStyle.lineHeight);
          }
          await expect(surface).toHaveCSS('overflow-y', 'visible');
        }
        await expect(page.locator('.conversation-tool-sources a')).toHaveAttribute(
          'href',
          'https://example.com/docs'
        );
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true
        );
        await page.setViewportSize({ width, height: 1600 });
        await page.evaluate(() => window.scrollTo(0, 0));
        await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
        await page.screenshot({
          path: testInfo.outputPath(`timeline-${theme}-${width}.png`),
          fullPage: true
        });
      } finally {
        await context.close();
      }
    });
  }
}
