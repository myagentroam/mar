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
    const body = JSON.parse(route.request().postData() ?? '{}') as {
      direction?: 'up' | 'down';
      targetSessionId?: string;
      position?: 'before' | 'after';
    };
    const pinned = sessions.filter((entry) => entry.pinOrder !== null);
    const index = pinned.findIndex((entry) => entry.id === id);
    const adjacent =
      body.targetSessionId === undefined
        ? body.direction === 'up'
          ? index - 1
          : index + 1
        : pinned.findIndex((entry) => entry.id === body.targetSessionId);
    if (index >= 0 && adjacent >= 0 && adjacent < pinned.length) {
      const [moved] = pinned.splice(index, 1);
      const targetIndex =
        body.targetSessionId === undefined
          ? adjacent
          : pinned.findIndex((entry) => entry.id === body.targetSessionId) +
            (body.position === 'after' ? 1 : 0);
      pinned.splice(targetIndex, 0, moved!);
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
    .getByRole('menu')
    .getByRole('menuitem', { name: '置顶' })
    .evaluate((element: HTMLElement) => element.click());
  await expect(rows.filter({ hasText: '普通会话' })).toHaveClass(/pinned/);
  await expect(page.locator('.session-list .session-link strong').first()).toHaveText('普通会话');

  await openPlainSessionActions();
  await page
    .getByRole('menu')
    .getByRole('menuitem', { name: '下移' })
    .evaluate((element: HTMLElement) => element.click());
  await expect(page.locator('.session-list .session-link strong').first()).toHaveText('会话一');

  const dragged = rows.filter({ hasText: '普通会话' });
  const target = rows.filter({ hasText: '会话三' });
  await expect(dragged.locator('..')).toHaveAttribute('draggable', 'true');
  await dragged.locator('..').dragTo(target.locator('..'), {
    targetPosition: { x: 30, y: (await target.locator('..').boundingBox())!.height - 3 }
  });
  await expect(page.locator('.session-list .session-link strong').nth(3)).toHaveText('普通会话');
  expect(pinMoveRequests).toBe(2);

  await openPlainSessionActions();
  await page
    .getByRole('menu')
    .getByRole('menuitem', { name: '取消置顶' })
    .evaluate((element: HTMLElement) => element.click());
  await expect(page.locator('.session-list .session-link strong').last()).toHaveText('普通会话');
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

test('Scheduled tasks select a node, save multiple time combinations, and open execution records', async ({
  page
}, info) => {
  await mockConsoleApi(
    page,
    'MANAGED',
    ['history.read', 'turn.start', 'session.pin', 'session.schedule'],
    []
  );
  const nodes = [
    { id: 'node-1', name: 'Node A', connected: true, supported: true },
    { id: 'node-2', name: 'Node B', connected: true, supported: true }
  ];
  const scope = { nodeId: 'node-2', workspaceId: 'workspace-1' };
  const targetSession = {
    ...session('scheduled', '定时会话', 0),
    externalSessionId: 'mock-native:scheduled'
  };
  const groups = [
    { days: { kind: 'anyDay' }, times: { kind: 'times', times: ['10:00', '20:00'] } }
  ];
  const task = {
    id: 'task',
    name: '检查构建',
    objective: 'Inspect status',
    groups,
    enabled: true,
    notifyOnTerminal: false,
    graceMinutes: 60,
    timezone: 'Asia/Shanghai',
    revision: 2,
    sessionId: targetSession.externalSessionId,
    newSession: null,
    nextRunAt: Date.parse('2027-01-01T02:00:00Z')
  };
  const otherTask = { ...task, id: 'other-task', name: '复盘失败' };
  const listRequests: URL[] = [];
  const writes: { url: URL; body: Record<string, unknown>; csrf: string | undefined }[] = [];
  const makeCard = (row: typeof task, nodeId: string, mine: boolean) => ({
    ...row,
    nodeId,
    workspaceId: 'workspace-1',
    mine,
    objectivePreview: row.objective,
    nodeName: nodeId === 'node-2' ? 'Node B' : 'Node A',
    workspaceName: 'project',
    sessionTitle: '定时会话',
    targetKind: 'existing',
    ownerName: mine ? '李四' : '张三'
  });
  await page.route(/\/api\/workspaces\?nodeId=node-2$/, (route) =>
    json(route, {
      workspaces: [
        { id: 'workspace-1', path: '/work/project', displayName: 'project', kind: 'DIRECTORY' }
      ]
    })
  );
  await page.route(/\/api\/agent-sessions\?nodeId=node-2(?:&.*)?$/, (route) =>
    json(route, { sessions: [targetSession], nextCursor: null })
  );
  await page.route(/\/api\/scheduled-tasks(?:\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'POST') {
      writes.push({
        url,
        body: route.request().postDataJSON(),
        csrf: route.request().headers()['x-csrf-token']
      });
      return json(route, { task });
    }
    listRequests.push(url);
    return json(route, {
      nodes,
      items: [
        makeCard(task, 'node-2', true),
        makeCard(otherTask, 'node-2', true),
        ...(url.searchParams.get('mine') === 'false'
          ? [makeCard({ ...task, name: '另一节点的相同任务 ID' }, 'node-1', false)]
          : [])
      ],
      unavailableNodeIds: [],
      nextCursor: null
    });
  });
  await page.route('**/api/scheduled-tasks/preview', (route) =>
    json(route, { timezone: 'Asia/Shanghai', times: [{ dueAt: task.nextRunAt }] })
  );
  await page.route(/\/api\/scheduled-tasks\/task(?:\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'PUT')
      writes.push({
        url,
        body: route.request().postDataJSON(),
        csrf: route.request().headers()['x-csrf-token']
      });
    else expect(url.searchParams.get('nodeId')).toBe('node-2');
    return json(route, { task, mine: true, proposals: [] });
  });
  const record = {
    ...scope,
    occurrenceId: 'record',
    taskId: 'task',
    name: task.name,
    dueAt: task.nextRunAt,
    state: 'SUCCEEDED',
    startedAt: task.nextRunAt + 1000,
    endedAt: task.nextRunAt + 4000,
    reason: null,
    run: null
  };
  let failPage = true;
  const historyQueries: URL[] = [];
  await page.route(/\/api\/scheduled-occurrences\?.*$/, (route) => {
    const url = new URL(route.request().url());
    historyQueries.push(url);
    if (url.searchParams.has('cursor') && failPage) {
      failPage = false;
      return json(route, { code: 'INTERNAL_ERROR', message: 'History unavailable' }, 500);
    }
    return json(route, {
      items: url.searchParams.has('cursor')
        ? [{ ...record, occurrenceId: 'older', name: '较早记录' }]
        : [record],
      nextCursor: url.searchParams.has('cursor') ? null : 'next',
      unavailableNodeIds: []
    });
  });
  await page.route(/\/api\/scheduled-occurrences\/record\?.*$/, (route) => {
    expect(new URL(route.request().url()).searchParams.get('nodeId')).toBe('node-2');
    return json(route, { ...record, snapshot: { objective: 'Historical prompt', revision: 1 } });
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '定时任务', exact: true }).click();
  const panel = page.getByRole('region', { name: '定时任务', exact: true });
  const scheduleMenu = page.getByRole('navigation', { name: '定时任务', exact: true });
  const header = page.locator('.workbench-header');
  const toggle = header.locator('.workbench-tree-toggle');
  await expect(panel.locator('.card')).toHaveCount(2);
  expect(listRequests.at(-1)?.searchParams.get('mine')).toBe('true');
  expect([...listRequests.at(-1)!.searchParams.keys()]).toEqual(['mine']);
  await expect(panel.getByRole('heading', { name: '定时任务', level: 2 })).toBeVisible();
  await expect(panel.getByRole('heading', { name: '检查构建', level: 3 })).toBeVisible();
  await expect(panel.getByRole('heading', { name: '接下来', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '关闭', exact: true })).toHaveCount(0);
  await expect(panel.getByText('下次执行', { exact: true })).toHaveCount(2);
  await expect(header.getByRole('heading', { name: '我的定时' })).toBeVisible();
  await expect(scheduleMenu.getByRole('button', { name: '我的定时' })).toHaveAttribute(
    'aria-current',
    'page'
  );
  await expect(page.locator('.workspace-tree-resize')).toHaveCount(0);
  await toggle.click();
  await expect(scheduleMenu).toBeHidden();
  await expect(header.getByRole('heading', { name: '我的定时' })).toBeVisible();
  await toggle.click();
  await scheduleMenu.getByRole('button', { name: '全部定时', exact: true }).click();
  await expect(header.getByRole('heading', { name: '全部定时' })).toBeVisible();
  await expect(panel.getByRole('tablist')).toHaveCount(0);
  await expect(panel.locator('.card')).toHaveCount(3);
  expect(listRequests.at(-1)?.searchParams.get('mine')).toBe('false');
  await page.locator('html').evaluate((element) => element.setAttribute('data-theme', 'daylight'));
  const titleBox = (await panel
    .getByRole('heading', { name: '定时任务', exact: true })
    .boundingBox())!;
  const refreshBox = (await panel
    .getByRole('button', { name: '刷新', exact: true })
    .boundingBox())!;
  expect(Math.abs(titleBox.x - refreshBox.x)).toBeLessThan(1);
  expect(refreshBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height);
  await page.screenshot({ path: info.outputPath('scheduled-tasks-desktop.png') });

  await panel.getByRole('button', { name: '新建定时', exact: true }).click();
  const editor = page.getByRole('dialog');
  const select = async (name: string, option: string) => {
    await editor.getByRole('combobox', { name, exact: true }).click();
    await page.getByRole('option', { name: option, exact: true }).click();
  };
  await expect(editor.getByRole('combobox', { name: '工作区', exact: true })).toBeDisabled();
  await editor.getByRole('combobox', { name: '执行节点', exact: true }).click();
  await expect(page.getByRole('option', { name: 'Node B', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('option', { name: 'Node B', exact: true })).toBeHidden();
  await expect(editor).toBeVisible();
  await select('执行节点', 'Node B');
  await select('工作区', 'project');
  await select('运行目标', '已有会话');
  await select('运行会话', '定时会话');
  await editor.getByRole('textbox', { name: '任务名称' }).fill('第三项任务');
  await editor.getByRole('textbox', { name: '任务提示词' }).fill('Review the build');
  const enabled = editor.getByRole('switch', { name: '已启用', exact: true });
  const notification = editor.getByRole('switch', { name: '任务通知', exact: true });
  await expect(notification).not.toBeChecked();
  const notificationHint = '任务以创建者身份执行。开启后，任务结束时通知创建者。';
  await expect(notification).toHaveAccessibleDescription(notificationHint);
  await editor.getByText(notificationHint).scrollIntoViewIfNeeded();
  const enabledBox = (await enabled.boundingBox())!;
  const notificationBox = (await notification.boundingBox())!;
  expect(Math.abs(enabledBox.y - notificationBox.y)).toBeLessThan(1);
  expect(notificationBox.x).toBeGreaterThan(enabledBox.x);
  await page.screenshot({ path: info.outputPath('scheduled-settings-desktop.png') });
  const desktopViewport = page.viewportSize()!;
  await page.setViewportSize({ width: 390, height: 844 });
  await editor.getByText(notificationHint).scrollIntoViewIfNeeded();
  await expect(notification).toBeInViewport();
  const mobileEnabledBox = (await enabled.boundingBox())!;
  const mobileNotificationBox = (await notification.boundingBox())!;
  expect(Math.abs(mobileEnabledBox.x - mobileNotificationBox.x)).toBeLessThan(1);
  expect(mobileNotificationBox.y).toBeGreaterThan(mobileEnabledBox.y);
  await page.screenshot({ path: info.outputPath('scheduled-settings-mobile.png') });
  await page.setViewportSize(desktopViewport);
  await editor.getByRole('tab', { name: '时间组合', exact: true }).click();
  await editor.getByRole('textbox', { name: '指定时刻' }).fill('10:00,');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor.getByText('检查这组的日期和时刻。')).toBeVisible();
  expect(writes).toHaveLength(0);
  await editor.getByRole('textbox', { name: '指定时刻' }).fill('10:00, 20:00');
  await editor.getByRole('button', { name: '添加时间组合' }).click();
  const second = editor.locator('fieldset').nth(1);
  await second.getByRole('combobox', { name: '日期规则' }).click();
  await page.getByRole('option', { name: '指定日期', exact: true }).click();
  await second.getByRole('textbox', { name: '指定日期' }).fill('2028-02-29');
  await second.getByRole('textbox', { name: '指定时刻' }).fill('14:30');
  await expect(editor.getByText('按节点时区执行：Asia/Shanghai')).toBeVisible();
  await expect(editor.getByText('Cron', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('scheduled-editor-desktop.png') });
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(writes[0]?.csrf).toBeTruthy();
  expect(writes[0]?.body).toMatchObject({
    ...scope,
    name: '第三项任务',
    objective: 'Review the build',
    target: { kind: 'existing', sessionId: targetSession.externalSessionId },
    groups: [
      ...groups,
      { days: { kind: 'dates', dates: ['2028-02-29'] }, times: { kind: 'times', times: ['14:30'] } }
    ]
  });
  expect(writes[0]?.body).not.toHaveProperty('timezone');

  const card = panel.locator('.card').filter({ hasText: '检查构建' });
  await card.getByRole('button', { name: '检查构建', exact: true }).click();
  await editor.getByRole('textbox', { name: '任务提示词' }).fill('New prompt');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(writes[1]?.url.pathname).toBe('/api/scheduled-tasks/task');
  expect(writes[1]?.body).toMatchObject({
    ...scope,
    expectedRevision: 2,
    patch: { objective: 'New prompt', groups }
  });
  await card.getByRole('button', { name: '执行记录', exact: true }).click();
  await expect(panel.locator('.history li')).toHaveCount(1);
  expect(historyQueries.at(-1)?.searchParams.get('taskId')).toBe('task');
  await panel.getByRole('button', { name: '加载更多' }).click();
  await expect(panel.getByRole('alert')).toBeVisible();
  await expect(panel.locator('.history li')).toHaveCount(1);
  await panel.getByRole('button', { name: '加载更多' }).click();
  await expect(panel.locator('.history li')).toHaveCount(2);
  await panel.getByRole('button', { name: '检查构建', exact: true }).click();
  await expect(editor.getByText('Historical prompt')).toBeVisible();
  await expect(editor.getByRole('button', { name: '打开运行所在会话' })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('aside.workspace-tree')).toBeHidden();
  await page
    .locator('html')
    .evaluate((element) => element.setAttribute('data-theme', 'vscode-dark-2026'));
  await expect(editor.getByText('触发时的提示词')).toBeVisible();
  await expect(editor).toBeInViewport();
  await page.screenshot({ path: info.outputPath('scheduled-history-mobile.png') });
  await editor.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(editor).not.toBeVisible();
  const clock = page.getByRole('button', { name: '定时任务', exact: true });
  await expect(toggle).toBeHidden();
  await expect(header.getByRole('heading', { name: '执行记录' })).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await clock.click();
  await expect(clock).toHaveAttribute('aria-expanded', 'true');
  await expect(scheduleMenu).toBeInViewport();
  await expect(scheduleMenu.getByRole('button', { name: '执行记录' })).toHaveAttribute(
    'aria-current',
    'page'
  );
  await page.screenshot({
    path: info.outputPath('scheduled-menu-mobile.png'),
    animations: 'disabled'
  });
  await scheduleMenu.getByRole('button', { name: '执行记录' }).click();
  await expect(clock).toHaveAttribute('aria-expanded', 'false');
  await expect(scheduleMenu).toBeHidden();
  await expect.poll(() => historyQueries.at(-1)?.searchParams.has('taskId')).toBe(false);
  await clock.click();
  await scheduleMenu.getByRole('button', { name: '我的定时' }).click();
  await expect(header.getByRole('heading', { name: '我的定时' })).toBeVisible();
  await expect(scheduleMenu).toBeHidden();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await expect(panel).toBeHidden();
});
