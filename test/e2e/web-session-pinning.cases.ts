import { expect, test } from '@playwright/test';
import { json, mockConsoleApi } from './support/web-console-api.js';

test('Pinned sessions support menu movement and dragging across multiple rows', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start', 'session.pin'], writes);
  let sessions = [
    session('one', '会话一', 0),
    session('two', '会话二', 1),
    session('three', '会话三', 2),
    session('plain', '普通会话', null)
  ];
  let pinMoveRequests = 0;
  await page.route(/\/api\/agent-sessions\?nodeId=node-1(?:&.*)?$/, (route) =>
    json(route, { sessions, nextCursor: null })
  );
  await page.route('**/api/agent-sessions/*/metadata', async (route) => {
    const id =
      route
        .request()
        .url()
        .match(/agent-sessions\/([^/]+)\/metadata/)?.[1] ?? '';
    const body = JSON.parse(route.request().postData() ?? '{}') as { pinned?: boolean };
    const target = sessions.find((entry) => entry.id === id);
    if (target !== undefined && body.pinned === true)
      sessions = [
        session(id, target.runnerTitle, 0),
        ...sessions
          .filter((entry) => entry.id !== id)
          .map((entry) =>
            entry.pinOrder === null ? entry : { ...entry, pinOrder: entry.pinOrder + 1 }
          )
      ];
    if (target !== undefined && body.pinned === false)
      sessions = [
        ...sessions.filter((entry) => entry.id !== id),
        session(id, target.runnerTitle, null)
      ];
    return json(route, { session: target });
  });
  await page.route('**/api/agent-sessions/*/pin-order', async (route) => {
    pinMoveRequests += 1;
    const id =
      route
        .request()
        .url()
        .match(/agent-sessions\/([^/]+)\/pin-order/)?.[1] ?? '';
    const body = JSON.parse(route.request().postData() ?? '{}') as { direction?: 'up' | 'down' };
    const pinned = sessions.filter((entry) => entry.pinOrder !== null);
    const index = pinned.findIndex((entry) => entry.id === id);
    const adjacent = body.direction === 'up' ? index - 1 : index + 1;
    if (index >= 0 && adjacent >= 0 && adjacent < pinned.length) {
      [pinned[index], pinned[adjacent]] = [pinned[adjacent]!, pinned[index]!];
      sessions = [
        ...pinned.map((entry, pinOrder) => ({ ...entry, pinOrder })),
        ...sessions.filter((entry) => entry.pinOrder === null)
      ];
    }
    return json(route, { moved: true });
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await expect(page.locator('.tree-node-row.selected')).toHaveCount(0);
  await expect(page.locator('.workspace-branches > li.selected')).toHaveCSS('border-radius', '6px');

  const rows = page.locator('.session-row');
  await expect(rows.filter({ hasText: '会话一' })).toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)'
  );
  await expect(rows.filter({ hasText: '会话一' }).getByLabel('已置顶')).toBeVisible();
  await expect(rows.filter({ hasText: '普通会话' }).getByLabel('已置顶')).toHaveCount(0);
  async function openPlainSessionActions() {
    const row = rows.filter({ hasText: '普通会话' });
    await row.hover();
    await row.getByRole('button', { name: /更多会话操作/ }).click();
  }
  await openPlainSessionActions();
  await page
    .locator('.el-dropdown__popper:visible')
    .getByRole('menuitem', { name: '置顶' })
    .evaluate((element: HTMLElement) => element.click());
  await expect(rows.filter({ hasText: '普通会话' })).toHaveClass(/pinned/);
  await expect(page.locator('.session-list .session-link strong').first()).toHaveText('普通会话');

  await openPlainSessionActions();
  await page
    .locator('.el-dropdown__popper:visible')
    .getByRole('menuitem', { name: '下移' })
    .evaluate((element: HTMLElement) => element.click());
  await expect(page.locator('.session-list .session-link strong').first()).toHaveText('会话一');

  const dragged = rows.filter({ hasText: '普通会话' });
  const target = rows.filter({ hasText: '会话三' });
  await expect(dragged.locator('..')).toHaveAttribute('draggable', 'true');
  await dragged.locator('..').dragTo(target.locator('..'));
  await expect(page.locator('.session-list .session-link strong').nth(3)).toHaveText('普通会话');
  expect(pinMoveRequests).toBe(3);

  await openPlainSessionActions();
  await page
    .locator('.el-dropdown__popper:visible')
    .getByRole('menuitem', { name: '取消置顶' })
    .evaluate((element: HTMLElement) => element.click());
  await expect(page.locator('.session-list .session-link strong').last()).toHaveText('普通会话');
});

test('Scheduled sessions show a clock and save versioned settings through a dialog', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start', 'session.pin'], writes);
  await page.route(/\/api\/agent-sessions\?nodeId=node-1(?:&.*)?$/, (route) =>
    json(route, {
      sessions: [
        {
          ...session('scheduled', '定时会话', 0),
          schedule: { enabled: true, nextRunAt: Date.parse('2026-10-01T09:00:00Z') },
          runtime: {
            level: 'MANAGED',
            capabilities: ['history.read', 'turn.start', 'session.pin', 'session.schedule']
          }
        }
      ],
      nextCursor: null
    })
  );
  const task = {
    id: 'task-1',
    objective: 'Inspect status',
    cron: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    enabled: true,
    ownerUserId: 7,
    notifyOnTerminal: false,
    revision: 2,
    nextRunAt: Date.parse('2026-10-01T09:00:00Z')
  };
  let displayedTask: typeof task | null = task;
  const historyPages: number[] = [];
  let historyTotal = 25;
  let failHistoryPage = false;
  let holdHistoryPage = false;
  let releaseHistoryPage: (() => Promise<void>) | undefined;
  await page.route('**/api/agent-sessions/scheduled/schedule*', (route) => {
    const requestedPage = Number(
      new URL(route.request().url()).searchParams.get('occurrencePage') ?? 1
    );
    if (route.request().method() === 'GET') {
      historyPages.push(requestedPage);
      if (holdHistoryPage) {
        holdHistoryPage = false;
        releaseHistoryPage = () =>
          json(route, { code: 'INTERNAL_ERROR', message: 'History unavailable' }, 500);
        return;
      }
      if (failHistoryPage) {
        failHistoryPage = false;
        return json(route, { code: 'INTERNAL_ERROR', message: 'History unavailable' }, 500);
      }
    }
    if (route.request().method() === 'PUT') {
      writes.push({
        url: route.request().url(),
        csrf: route.request().headers()['x-csrf-token'],
        body: route.request().postData() ?? ''
      });
      const body = JSON.parse(route.request().postData() ?? '{}') as {
        cron?: string;
        notifyOnTerminal?: boolean;
      };
      displayedTask = {
        ...task,
        ...displayedTask,
        ...(body.cron === undefined ? {} : { cron: body.cron }),
        ...(body.notifyOnTerminal === undefined ? {} : { notifyOnTerminal: body.notifyOnTerminal }),
        ownerUserId: 1,
        revision: (displayedTask?.revision ?? task.revision) + 1
      };
    }
    const occurrencePage = Math.min(requestedPage, Math.max(1, Math.ceil(historyTotal / 10)));
    return json(route, {
      task: displayedTask,
      currentUserName: '李四',
      notifyUserName: displayedTask?.ownerUserId === 7 ? '张三' : '李四',
      nodeTimezone: 'Asia/Shanghai',
      occurrencePage,
      occurrenceTotal: historyTotal,
      occurrences: Array.from(
        { length: Math.max(0, Math.min(10, historyTotal - (occurrencePage - 1) * 10)) },
        (_, index) => ({
          id: `${occurrencePage}-${index}`,
          due_at: Date.parse('2026-10-01T09:00:00Z') - ((occurrencePage - 1) * 10 + index) * 60_000,
          status: 'SUCCEEDED',
          code: null
        })
      ),
      proposals: [],
      canResolveProposals: true
    });
  });
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  const row = page.locator('.session-row').filter({ hasText: '定时会话' });
  await expect(row.getByLabel('已启用')).toBeVisible();
  await expect(row.getByLabel('已置顶')).toHaveCount(0);
  await row.hover();
  await row.getByRole('button', { name: /更多会话操作/ }).click();
  await expect(
    page.locator('.el-dropdown__popper:visible').getByRole('menuitem', { name: '取消置顶' })
  ).toHaveAttribute('aria-disabled', 'true');
  await page
    .locator('.el-dropdown__popper:visible')
    .getByRole('menuitem', { name: '定时任务' })
    .click();
  const dialog = page.getByRole('dialog', { name: '定时任务' });
  await expect(dialog.locator('textarea')).toHaveValue('Inspect status');
  const history = dialog.locator('.schedule-history');
  const pager = history.locator('.el-pagination');
  await expect(history.locator('p')).toHaveCount(10);
  await dialog.locator('textarea').fill('Unsaved draft');
  await pager.locator('.btn-next').click();
  await expect(pager.locator('.number.is-active')).toHaveText('2');
  await expect(history.locator('p')).toHaveCount(10);
  await expect(dialog.locator('textarea')).toHaveValue('Unsaved draft');
  await pager.locator('.btn-next').click();
  await expect(pager.locator('.number.is-active')).toHaveText('3');
  await expect(history.locator('p')).toHaveCount(5);
  await expect(pager.locator('.btn-next')).toBeDisabled();
  failHistoryPage = true;
  await pager.locator('.btn-prev').click();
  await expect(page.getByText('无法加载定时任务。', { exact: true })).toBeVisible();
  await expect(pager.locator('.number.is-active')).toHaveText('3');
  await expect(history.locator('p')).toHaveCount(5);
  historyTotal = 12;
  await pager.locator('.btn-prev').click();
  await expect(pager.locator('.number.is-active')).toHaveText('2');
  await expect(history.locator('p')).toHaveCount(2);
  await pager.locator('.btn-prev').click();
  await expect(pager.locator('.number.is-active')).toHaveText('1');
  expect(historyPages.slice(0, 6)).toEqual([1, 2, 3, 2, 2, 1]);
  await dialog.locator('textarea').fill('Inspect status');
  await expect(dialog.getByText('按节点时区执行：Asia/Shanghai')).toBeVisible();
  await expect(dialog.getByText('任务提示词', { exact: true })).toBeVisible();
  await expect(dialog.getByText('重复', { exact: true })).toBeVisible();
  await expect(dialog.getByText('时间', { exact: true })).toBeVisible();
  await expect(dialog.getByText('状态', { exact: true })).toBeVisible();
  await expect(dialog.getByText('通知人', { exact: true })).toBeVisible();
  await expect(dialog.getByText('张三', { exact: true })).toBeVisible();
  const contentLeft = await dialog
    .locator('.el-form-item__content')
    .first()
    .evaluate((content) => content.getBoundingClientRect().left);
  for (const content of await dialog.locator('.el-form-item__content').all())
    expect(
      Math.abs(
        (await content.evaluate((element) => element.getBoundingClientRect().left)) - contentLeft
      )
    ).toBeLessThan(2);
  for (const text of ['重复', '状态', '通知人', '运行终态通知']) {
    const alignment = await dialog.getByText(text, { exact: true }).evaluate((label) => {
      const range = document.createRange();
      range.selectNodeContents(label);
      const labelText = range.getBoundingClientRect();
      const labelBounds = label.getBoundingClientRect();
      const fieldBounds = label.nextElementSibling?.firstElementChild?.getBoundingClientRect();
      return {
        left: labelText.left - labelBounds.left,
        vertical:
          (labelText.top + labelText.bottom) / 2 -
          ((fieldBounds?.top ?? 0) + (fieldBounds?.bottom ?? 0)) / 2
      };
    });
    expect(Math.abs(alignment.left), `${text} label left edge`).toBeLessThan(2);
    expect(Math.abs(alignment.vertical), `${text} row vertical alignment`).toBeLessThan(3);
  }
  await expect(dialog.getByRole('switch', { name: '运行终态通知' })).toHaveAttribute(
    'aria-checked',
    'false'
  );
  await expect(dialog.locator('.el-date-editor')).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: '时区' })).toHaveCount(0);
  await dialog.locator('textarea').fill('Review project');
  await dialog.getByRole('switch', { name: '运行终态通知' }).locator('..').click();
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect
    .poll(() =>
      writes.find(
        (entry) =>
          entry.url.includes('/scheduled/schedule') &&
          JSON.parse(entry.body).objective === 'Review project'
      )
    )
    .toBeTruthy();
  const saved = writes.find(
    (entry) =>
      entry.url.includes('/scheduled/schedule') &&
      JSON.parse(entry.body).objective === 'Review project'
  );
  expect(JSON.parse(saved!.body)).toMatchObject({
    expectedRevision: 2,
    enabled: true,
    notifyOnTerminal: true,
    cron: '0 9 * * *'
  });
  expect(JSON.parse(saved!.body)).not.toHaveProperty('timezone');
  await expect(dialog.getByText('李四', { exact: true })).toBeVisible();
  await dialog.locator('.el-radio-button').filter({ hasText: 'Cron' }).click();
  await dialog.getByRole('textbox', { name: 'Cron 表达式' }).fill('60 * * * *');
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog.getByText('请输入有效的五字段 Cron 表达式。')).toBeVisible();
  expect(
    writes.some(
      (entry) =>
        entry.url.includes('/scheduled/schedule') && JSON.parse(entry.body).cron === '60 * * * *'
    )
  ).toBe(false);
  await dialog.getByRole('textbox', { name: 'Cron 表达式' }).fill('*/15 9-17 * * 1-5');
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect
    .poll(() =>
      writes.find(
        (entry) =>
          entry.url.includes('/scheduled/schedule') &&
          JSON.parse(entry.body).cron === '*/15 9-17 * * 1-5'
      )
    )
    .toBeTruthy();
  expect(
    JSON.parse(
      writes.find(
        (entry) =>
          entry.url.includes('/scheduled/schedule') &&
          JSON.parse(entry.body).cron === '*/15 9-17 * * 1-5'
      )!.body
    )
  ).toMatchObject({ cron: '*/15 9-17 * * 1-5', expectedRevision: 3 });
  await expect(dialog.getByRole('textbox', { name: 'Cron 表达式' })).toHaveValue(
    '*/15 9-17 * * 1-5'
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog.getByText('任务提示词', { exact: true })).toBeVisible();
  await expect(dialog.locator('.el-form-item__label').first()).toHaveCSS('width', /3\d\dpx/);
  expect(await pager.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByText('无法加载定时任务。', { exact: true })).toHaveCount(0);
  holdHistoryPage = true;
  await pager.locator('.btn-next').click();
  await expect.poll(() => releaseHistoryPage !== undefined).toBe(true);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await releaseHistoryPage!();
  displayedTask = null;
  historyTotal = 0;
  await row.hover();
  await row.getByRole('button', { name: /更多会话操作/ }).click();
  await page
    .locator('.el-dropdown__popper:visible')
    .getByRole('menuitem', { name: '定时任务' })
    .click();
  await expect(dialog.getByText('李四', { exact: true })).toBeVisible();
  await expect(history).toHaveCount(0);
  await expect(page.getByText('无法加载定时任务。', { exact: true })).toHaveCount(0);
  expect(historyPages.at(-1)).toBe(1);
  await expect(dialog.getByText('当前用户', { exact: true })).toHaveCount(0);
});

function session(id: string, runnerTitle: string, pinOrder: number | null) {
  return {
    id,
    workspaceId: 'workspace-1',
    runner: 'codex' as const,
    runnerTitle,
    pinOrder,
    pinnedAt: pinOrder === null ? null : 1,
    lastActivityAt: 100,
    externalDiscovered: true,
    activity: 'IDLE' as const,
    control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] },
    runtime: { level: 'MANAGED', capabilities: ['history.read', 'turn.start', 'session.pin'] }
  };
}
