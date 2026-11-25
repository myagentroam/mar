import { expect, test } from '@playwright/test';
import { json, mockConsoleApi } from './support/web-console-api.js';

// @test-covers packages/web-core/src/view/schedule/ScheduledTasksPanel.vue
// @test-covers packages/web-core/src/view/schedule/ScheduledTaskCard.vue

test.use({ timezoneId: 'Asia/Shanghai' });

const cardFixtures = [
  ['Commit review', 'MyAgentRoam', 'Review the latest changes and record findings.', '09:30'],
  ['UAT session analysis', 'MyAgentRoam', 'Summarize findings from the UAT session.', '14:00'],
  ['Forge queue check', 'MyAgentRoam', 'Check the queue for items that need attention.', ''],
  ['Research briefing', 'lab', 'Prepare notes and follow up on open research questions.', ''],
  ['Lab coordination', 'lab', 'Coordinate active work and capture the next steps.', '10:00'],
  ['AI news watch', 'personal', 'Track new releases and product changes.', ''],
  ['Codex reset watch', 'personal', 'Watch for Codex reset signals.', '']
].map(([name, workspaceName, objectivePreview, time], index) => ({
  nodeId: 'node-1',
  nodeName: 'linux',
  workspaceId: `workspace-${workspaceName}`,
  workspaceName,
  id: `task-${index}`,
  name,
  objectivePreview,
  targetKind: 'existing',
  sessionId: `session-${index}`,
  sessionTitle: name,
  mine: true,
  ownerName: 'Alex',
  enabled: Boolean(time),
  nextRunAt: time ? Date.parse(`2026-11-26T${time}:00+08:00`) : null
}));

for (const theme of ['daylight', 'dark']) {
  test(`Scheduled cards fit the panel and reveal the ready create action in ${theme}`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width: 1400, height: 1020 });
    let release!: () => void;
    const initialRead = new Promise<void>((done) => (release = done));
    try {
      await page.addInitScript((value) => localStorage.setItem('mar.theme', value), theme);
      await mockConsoleApi(page, 'MANAGED', ['session.schedule'], []);
      await page.route('**/api/oauth/providers', (route) => json(route, { providers: [] }));
      await page.route(/\/api\/scheduled-tasks(?:\?.*)?$/, async (route) => {
        await initialRead;
        await json(route, {
          items: cardFixtures,
          nodes: [{ id: 'node-1', name: 'linux', connected: true, supported: true }],
          workspaces: [cardFixtures[0]!, cardFixtures[3]!, cardFixtures[5]!].map(
            ({ nodeId, nodeName, workspaceId, workspaceName }) => ({
              nodeId,
              nodeName,
              workspaceId,
              workspaceName
            })
          ),
          unavailableNodeIds: [],
          page: 1,
          pageSize: 20,
          total: cardFixtures.length,
          hasMore: false
        });
      });
      await page.goto('/console');
      await page.getByRole('button', { name: '进入控制台' }).click();
      await page.getByRole('button', { name: '定时任务', exact: true }).click();
      await expect(page.locator('html')).toHaveCSS(
        'color-scheme',
        theme === 'daylight' ? 'light' : 'dark'
      );
      const panel = page.getByRole('region', { name: '我的定时', exact: true });
      await expect(panel.getByRole('progressbar')).toBeVisible();
      const create = panel.getByRole('button', { name: '新建定时', includeHidden: true });
      await expect(create).toBeAttached();
      await expect(create).toBeHidden();
      const createSlot = await create.evaluate((button) => button.getBoundingClientRect().toJSON());
      release();
      await expect(create).toBeVisible();
      await expect(create).toBeEnabled();
      expect(await create.evaluate((button) => button.getBoundingClientRect().toJSON())).toEqual(
        createSlot
      );

      const grid = panel.getByRole('list', { name: '任务', exact: true });
      const cards = grid.getByRole('listitem');
      await expect(cards).toHaveCount(cardFixtures.length);
      await expect(cards.first().locator('time')).toHaveAttribute(
        'datetime',
        '2026-11-26T01:30:00.000Z'
      );
      await expect(cards.first().locator('time')).toContainText('09:30');
      const [titleSize, clockSize] = await cards
        .first()
        .getByRole('button', { name: cardFixtures[0]!.name, exact: true })
        .or(cards.first().getByText('09:30', { exact: true }))
        .evaluateAll((elements) =>
          elements.map((element) => parseFloat(getComputedStyle(element).fontSize))
        );
      expect(clockSize).toBeLessThanOrEqual(titleSize!);
      await expect(cards.nth(2)).toContainText('已暂停');
      await expect(cards.nth(2).locator('time')).toHaveCount(0);

      async function expectColumns(columns: number): Promise<void> {
        await expect
          .poll(() =>
            cards.evaluateAll((elements) => {
              const boxes = elements.map((element) => element.getBoundingClientRect());
              return boxes.filter((box) => box.top === boxes[0]!.top).length;
            })
          )
          .toBe(columns);
        const widths = await cards.evaluateAll((elements) =>
          elements.map((element) => element.getBoundingClientRect().width)
        );
        expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(1);
        expect(await grid.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(
          Math.ceil((await grid.boundingBox())!.width)
        );
      }

      await expectColumns(2);
      await page.screenshot({
        path: testInfo.outputPath('cards-desktop.png'),
        animations: 'disabled'
      });
      if (theme === 'dark') {
        await page.setViewportSize({ width: 2060, height: 960 });
        await expectColumns(3);
        expect((await grid.boundingBox())!.width).toBe(1560);
        await page.screenshot({
          path: testInfo.outputPath('cards-wide.png'),
          animations: 'disabled'
        });
        await page.setViewportSize({ width: 390, height: 844 });
        await expectColumns(1);
        const first = cards.first();
        const heading = (await first.getByRole('heading').boundingBox())!;
        const time = (await first.locator('time').boundingBox())!;
        expect(time.y).toBeGreaterThan(heading.y + heading.height);
        await expect(first.getByRole('button', { name: '编辑', exact: true })).toHaveCount(0);
        await expect(
          first.getByRole('button', { name: cardFixtures[0]!.name, exact: true })
        ).toHaveAttribute('aria-haspopup', 'dialog');
        await page.screenshot({
          path: testInfo.outputPath('cards-mobile.png'),
          animations: 'disabled'
        });
      }
    } finally {
      release();
    }
  });
}

test('Mobile scheduled task navigation switches pages before opening their menus', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockConsoleApi(page, 'MANAGED', ['session.schedule'], []);
  await page.route('**/api/hosted-conversations?limit=20', (route) =>
    json(route, { items: [], nextCursor: null })
  );
  await page.route('**/api/conversation-templates', (route) => json(route, { templates: [] }));
  await page.route(/\/api\/scheduled-tasks(?:\?.*)?$/, (route) =>
    json(route, {
      items: [],
      nodes: [],
      unavailableNodeIds: [],
      page: 1,
      pageSize: 20,
      total: 0,
      hasMore: false
    })
  );
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();

  const work = page.getByRole('button', { name: '工作', exact: true });
  const chat = page.getByRole('button', { name: '对话', exact: true });
  const schedules = page.getByRole('button', { name: '定时任务', exact: true });
  const scheduleMenu = page.getByRole('navigation', { name: '定时任务', exact: true });
  const schedulePage = page.getByRole('region', { name: '我的定时', exact: true });

  async function switchTo(destination: typeof work): Promise<void> {
    await destination.click();
    await expect(destination).toHaveAttribute('aria-current', 'page');
    await expect(destination).toHaveAttribute('aria-expanded', 'false');
    await expect(scheduleMenu).toBeHidden();
    if (destination === schedules) await expect(schedulePage).toBeInViewport();
    else await expect(schedulePage).toBeHidden();
  }

  await expect(work).toHaveAttribute('aria-current', 'page');
  await switchTo(schedules);
  await switchTo(work); // Work is still the underlying view.

  await switchTo(schedules);
  await schedules.click();
  await expect(schedules).toHaveAttribute('aria-expanded', 'true');
  await expect(scheduleMenu.getByRole('button', { name: '全部定时' })).toBeVisible();
  await switchTo(chat);
  await chat.click();
  await expect(chat).toHaveAttribute('aria-expanded', 'true');

  await switchTo(schedules); // Leaving Chat also dismisses its open history.
  await switchTo(chat); // Chat is now the underlying view.
  await switchTo(schedules);
  await switchTo(work);
});
