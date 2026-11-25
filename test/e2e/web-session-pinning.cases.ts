import { expect, test, type Locator } from '@playwright/test';
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

test('Scheduled tasks show scope-specific page titles and summaries', async ({ page }, info) => {
  await mockConsoleApi(page, 'MANAGED', ['session.schedule'], []);
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
  const clock = page.getByRole('button', { name: '定时任务', exact: true });
  const menu = page.getByRole('navigation', { name: '定时任务', exact: true });
  await clock.click();

  const mine = page.getByRole('region', { name: '我的定时', exact: true });
  const mineSummary = mine.getByText('查看和管理你拥有的定时任务。', { exact: true });
  await expect(mine.getByRole('heading', { name: '我的定时', level: 2 })).toBeVisible();
  await expect(mineSummary).toBeVisible();

  await menu.getByRole('button', { name: '全部定时', exact: true }).click();
  await expect(mine).toHaveCount(0);
  const all = page.getByRole('region', { name: '全部定时', exact: true });
  const title = all.getByRole('heading', { name: '全部定时', level: 2 });
  const summary = all.getByText('查看你有权访问的所有定时任务。', { exact: true });
  await expect(title).toBeVisible();
  await expect(summary).toBeVisible();
  const workspaceLabel = all.getByText('工作区', { exact: true });
  const workspaceFilter = all.getByRole('combobox', { name: '工作区', exact: true });
  const refresh = all.getByRole('button', { name: '刷新', exact: true });
  await expect(workspaceFilter).toBeVisible();
  await expect(refresh).toBeVisible();
  // Measure in one frame while the Workbench sidebar can still be animating.
  const [titleBox, summaryBox, labelBox, filterBox, refreshBox] = await title
    .or(summary)
    .or(workspaceLabel)
    .or(workspaceFilter)
    .or(refresh)
    .evaluateAll((elements) =>
      elements.map((element) => {
        const { x, top, bottom, right } = element.getBoundingClientRect();
        return { x, top, bottom, right };
      })
    );
  expect(Math.abs(titleBox!.x - summaryBox!.x)).toBeLessThan(1);
  expect(Math.abs(titleBox!.x - labelBox!.x)).toBeLessThan(1);
  expect(summaryBox!.top).toBeGreaterThanOrEqual(titleBox!.bottom);
  expect(filterBox!.top).toBeGreaterThanOrEqual(summaryBox!.bottom);
  expect(refreshBox!.x).toBeGreaterThanOrEqual(filterBox!.right);
  expect(
    Math.abs(refreshBox!.top + refreshBox!.bottom - filterBox!.top - filterBox!.bottom)
  ).toBeLessThan(2);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(summary).toBeInViewport();
  await clock.click();
  await menu.getByRole('button', { name: '我的定时', exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(mineSummary).toBeInViewport();
  await page.screenshot({ path: info.outputPath('schedule-heading-mobile.png') });
});

test('Scheduled tasks select a node, save multiple run times, and open execution records', async ({
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
  const workspaces = nodes.map((node) => ({
    ...scope,
    nodeId: node.id,
    nodeName: node.name,
    workspaceName: 'project'
  }));
  const targetSession = {
    ...session('scheduled', '定时会话', 0),
    externalSessionId: 'mock-native:scheduled'
  };
  const daily = [
    { kind: 'daily', time: '10:00' },
    { kind: 'daily', time: '20:00' }
  ];
  const weekly = { kind: 'weekly', time: '18:30', weekdays: [1, 5] };
  const monthly = { kind: 'monthly', time: '09:00', monthDays: [15, 31] };
  const once = { kind: 'once', time: '14:30', date: '2028-03-01' };
  const triggers = [...daily, monthly];
  const promptPreview =
    '检查最近一次构建的结果，汇总失败的步骤、相关日志和下一步建议。若没有失败，请记录这次构建的状态和可复查的运行编号。'.repeat(
      3
    );
  const task = {
    id: 'task',
    name: '检查构建',
    objective: promptPreview,
    triggers,
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
  const newSession = {
    runner: 'mar-agent',
    model: { kind: 'fixed', modelId: 'retired-model' },
    effort: 'high'
  };
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
  let readerSessionPage: (typeof targetSession)[] = [targetSession];
  await page.route(/\/api\/agent-sessions\?nodeId=node-2(?:&.*)?$/, (route) =>
    json(route, { sessions: readerSessionPage, nextCursor: null })
  );
  await page.route(/\/api\/runner-profiles\?nodeId=node-2(?:&.*)?$/, (route) =>
    json(route, {
      profiles: ['opencode', 'mar-agent', 'codex', 'claude-code'].map((runner) => ({
        runner,
        models: [
          ...(runner === 'mar-agent'
            ? [
                {
                  id: 'dual',
                  label: 'Dual-purpose model',
                  supportedEfforts: [],
                  subagentModel: true
                }
              ]
            : []),
          {
            id: 'model',
            label: 'Test model',
            supportedEfforts: ['medium', 'high'],
            defaultEffort: 'high'
          },
          {
            id: 'another',
            label: 'Another model',
            supportedEfforts: ['medium', 'high'],
            defaultEffort: 'medium'
          }
        ],
        accessOptions: [],
        commands: [],
        capabilities: []
      }))
    })
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
    const filtered = url.searchParams.get('nodeId');
    const items = [
      makeCard(task, 'node-2', true),
      {
        ...makeCard(otherTask, 'node-2', true),
        enabled: false,
        nextRunAt: null,
        targetKind: 'newSession',
        sessionTitle: null,
        sessionId: null,
        objectivePreview: '整理失败报告并汇总待跟进项。'
      },
      ...(url.searchParams.get('mine') === 'false'
        ? [
            {
              ...makeCard({ ...task, name: '另一节点的相同任务 ID' }, 'node-1', false),
              sessionId: 'session-1',
              sessionTitle: '既有会话'
            }
          ]
        : [])
    ].filter(
      (item) =>
        !filtered ||
        (item.nodeId === filtered && item.workspaceId === url.searchParams.get('workspaceId'))
    );
    return json(route, {
      nodes: filtered ? nodes.filter((item) => item.id === filtered) : nodes,
      ...(!filtered ? { workspaces } : {}),
      items,
      unavailableNodeIds: ['node-offline'],
      page: 1,
      pageSize: 20,
      total: items.length,
      hasMore: false
    });
  });
  const previews: Record<string, unknown>[] = [];
  await page.route('**/api/scheduled-tasks/preview', (route) => {
    const body = route.request().postDataJSON();
    previews.push(body);
    return json(route, {
      timezone: 'Asia/Shanghai',
      times: body.triggers ? [{ dueAt: task.nextRunAt }] : [],
      ...(body.suggestTime ? { suggestedDate: '2028-02-29' } : {})
    });
  });
  await page.route(/\/api\/scheduled-tasks\/task(?:\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('nodeId') === 'node-1')
      return json(route, {
        task: { ...task, name: '另一节点的相同任务 ID', sessionId: 'session-1' },
        mine: false,
        proposals: []
      });
    if (route.request().method() === 'PUT')
      writes.push({
        url,
        body: route.request().postDataJSON(),
        csrf: route.request().headers()['x-csrf-token']
      });
    else expect(url.searchParams.get('nodeId')).toBe('node-2');
    return json(route, {
      task,
      mine: true,
      proposals: [{ id: 'proposal', baseRevision: task.revision, name: '建议名称' }]
    });
  });
  await page.route(/\/api\/scheduled-tasks\/other-task\?.*$/, (route) =>
    json(route, { task: { ...otherTask, sessionId: null, newSession }, mine: true, proposals: [] })
  );
  const record = {
    ...scope,
    nodeName: 'Node B',
    workspaceName: 'project',
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
  let failTaskPage = true;
  let failMobilePage = true;
  const historyQueries: URL[] = [];
  await page.route(/\/api\/scheduled-occurrences\?.*$/, (route) => {
    const url = new URL(route.request().url());
    historyQueries.push(url);
    const scoped = url.searchParams.has('taskId');
    const requestedPage = Number(url.searchParams.get('page'));
    const filtered = url.searchParams.get('nodeId');
    if (
      requestedPage === 2 &&
      ((scoped && failTaskPage) || (!scoped && filtered === 'node-2' && failMobilePage))
    ) {
      if (scoped) failTaskPage = false;
      else failMobilePage = false;
      return json(route, { error: 'INTERNAL_ERROR' }, 500);
    }
    const another = {
      ...record,
      nodeId: 'node-1',
      nodeName: 'Node A',
      workspaceName: 'project',
      occurrenceId: 'other-record',
      name: '另一个任务的记录',
      state: 'FAILED'
    };
    const pageSize = scoped ? 1 : 20;
    const older = Array.from({ length: scoped ? 2 : 25 }, (_, index) => ({
      ...record,
      occurrenceId: `older-${index}`,
      name: `旧记录 ${index + 1}`,
      dueAt: record.dueAt - (index + 1) * 3600_000
    }));
    const all = scoped
      ? [record, ...older]
      : [
          ...(!filtered || filtered === 'node-2' ? [record] : []),
          ...(!filtered || filtered === 'node-1' ? [another] : []),
          ...(!filtered || filtered === 'node-2' ? older : [])
        ];
    const responsePage = Math.min(requestedPage, Math.max(1, Math.ceil(all.length / pageSize)));
    return json(route, {
      items: all.slice((responsePage - 1) * pageSize, responsePage * pageSize),
      page: responsePage,
      pageSize,
      total: all.length,
      hasMore: responsePage * pageSize < all.length,
      unavailableNodeIds: [],
      ...(!scoped && !filtered ? { workspaces } : {})
    });
  });
  await page.route(/\/api\/scheduled-occurrences\/record\?.*$/, (route) => {
    expect(new URL(route.request().url()).searchParams.get('nodeId')).toBe('node-2');
    return json(route, { ...record, snapshot: { objective: 'Historical prompt', revision: 1 } });
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '定时任务', exact: true }).click();
  const panel = page.getByRole('region', { name: /^(我的定时|全部定时)$/ });
  const scheduleMenu = page.getByRole('navigation', { name: '定时任务', exact: true });
  const header = page.locator('.workbench-header');
  const toggle = header.locator('.workbench-tree-toggle');
  const filterWorkspace = async (surface: Locator, option: string) => {
    await surface.getByRole('combobox', { name: '工作区', exact: true }).click();
    await page.getByRole('option', { name: option, exact: true }).click();
  };
  const clearWorkspace = async (surface: Locator) => {
    await surface.getByRole('button', { name: '清空', exact: true }).click();
    await expect(surface.getByRole('combobox', { name: '工作区', exact: true })).toHaveAttribute(
      'placeholder',
      '全部工作区'
    );
  };
  await expect(panel.locator('.card')).toHaveCount(2);
  expect(listRequests.at(-1)?.searchParams.get('mine')).toBe('true');
  expect([...listRequests.at(-1)!.searchParams]).toEqual([
    ['mine', 'true'],
    ['page', '1']
  ]);
  await expect(panel.getByRole('heading', { name: '我的定时', level: 2 })).toBeVisible();
  await expect(panel.getByRole('heading', { name: /检查构建/, level: 3 })).toBeVisible();
  await expect(panel.getByRole('heading', { name: '接下来', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '关闭', exact: true })).toHaveCount(0);
  await expect(panel.getByText('下次执行', { exact: true })).toHaveCount(2);
  await filterWorkspace(panel, 'project · Node A');
  await expect(panel.getByText('暂无可显示的定时任务。')).toBeVisible();
  expect([...listRequests.at(-1)!.searchParams]).toEqual([
    ['nodeId', 'node-1'],
    ['workspaceId', 'workspace-1'],
    ['mine', 'true'],
    ['page', '1']
  ]);
  await clearWorkspace(panel);
  await expect(panel.locator('.card')).toHaveCount(2);
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
  await expect(panel.getByText(/节点不可用/)).toHaveCount(0);
  await filterWorkspace(panel, 'project · Node A');
  await expect(panel.locator('.card')).toHaveCount(1);
  expect([...listRequests.at(-1)!.searchParams]).toEqual([
    ['nodeId', 'node-1'],
    ['workspaceId', 'workspace-1'],
    ['mine', 'false'],
    ['page', '1']
  ]);
  await clearWorkspace(panel);
  await expect(panel.locator('.card')).toHaveCount(3);
  await page.locator('html').evaluate((element) => element.setAttribute('data-theme', 'daylight'));
  await page.screenshot({ path: info.outputPath('scheduled-tasks-desktop.png') });
  await page
    .locator('html')
    .evaluate((element) => element.setAttribute('data-theme', 'vscode-dark-2026'));
  await page.screenshot({ path: info.outputPath('scheduled-tasks-dark-desktop.png') });
  const hoverCard = panel.locator('.card').filter({ hasText: '检查构建' });
  const restingBackground = await hoverCard.evaluate(
    (card) => getComputedStyle(card).backgroundColor
  );
  await hoverCard.hover({ position: { x: 8, y: 8 } });
  await expect(hoverCard).toHaveCSS('cursor', 'pointer');
  await expect(hoverCard).not.toHaveCSS('background-color', restingBackground);
  await page.screenshot({ path: info.outputPath('scheduled-tasks-dark-hover.png') });
  const linkedSession = hoverCard.getByRole('button', { name: '定时会话：打开会话' });
  await expect(hoverCard.getByText('创建者', { exact: true })).toBeVisible();
  await expect(linkedSession).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const restingSessionColor = await linkedSession.evaluate(
    (button) => getComputedStyle(button).color
  );
  const bodyColor = await hoverCard.evaluate((card) => getComputedStyle(card).color);
  expect(restingSessionColor).not.toBe(bodyColor);
  await linkedSession.hover();
  await expect(hoverCard).toHaveCSS('background-color', restingBackground);
  await expect(linkedSession).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(linkedSession).toHaveCSS('color', bodyColor);
  await page.screenshot({ path: info.outputPath('scheduled-card-session-hover.png') });
  await panel.locator('.card').filter({ hasText: '检查构建' }).locator('.objective').hover();
  await expect(page.getByRole('tooltip')).toHaveText(promptPreview);
  await page.screenshot({ path: info.outputPath('scheduled-card-tooltip.png') });
  await page.keyboard.press('Escape');
  await page.locator('html').evaluate((element) => element.setAttribute('data-theme', 'daylight'));

  await panel.getByRole('button', { name: '新建定时', exact: true }).click();
  const editor = page.getByRole('dialog').and(page.locator('dialog'));
  const expectTargetLayout = async (stacked = false) => {
    const target = editor.getByRole('combobox', { name: '运行目标', exact: true });
    const session = editor.getByRole('combobox', { name: '运行会话', exact: true });
    await expect(target).toBeVisible();
    await expect(session).toBeVisible();
    const targetBox = (await target.boundingBox())!;
    const sessionBox = (await session.boundingBox())!;
    if (stacked) {
      expect(sessionBox.y).toBeGreaterThan(targetBox.y);
      expect(Math.abs(sessionBox.x - targetBox.x)).toBeLessThan(2);
    } else {
      expect(sessionBox.x).toBeGreaterThan(targetBox.x);
      expect(Math.abs(sessionBox.y - targetBox.y)).toBeLessThan(2);
    }
  };
  const select = async (name: string, option: string) => {
    await editor.getByRole('combobox', { name, exact: true }).click();
    await page.getByRole('option', { name: option, exact: true }).click();
  };
  await expect(editor.getByRole('combobox', { name: '执行节点', exact: true })).toHaveText(
    '选择执行节点'
  );
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
  await expectTargetLayout();
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
  await expectTargetLayout(true);
  await editor.getByText(notificationHint).scrollIntoViewIfNeeded();
  await expect(notification).toBeInViewport();
  const mobileEnabledBox = (await enabled.boundingBox())!;
  const mobileNotificationBox = (await notification.boundingBox())!;
  expect(Math.abs(mobileEnabledBox.x - mobileNotificationBox.x)).toBeLessThan(1);
  expect(mobileNotificationBox.y).toBeGreaterThan(mobileEnabledBox.y);
  await page.screenshot({ path: info.outputPath('scheduled-settings-mobile.png') });
  await page.setViewportSize(desktopViewport);
  await editor.getByRole('tab', { name: '执行时间', exact: true }).click();
  const active = () => editor.locator('.trigger-fields');
  const firstTime = editor.getByRole('textbox', { name: '时刻 1', exact: true });
  const addTime = editor.getByRole('button', { name: '添加执行时间' });
  const catchUp = editor.getByRole('switch', { name: '错过指定时间后补跑' });
  const fillTime = async (index: number, value: string) => {
    const input = editor.getByRole('textbox', { name: `时刻 ${index}`, exact: true });
    await input.fill(value);
    await input.press('Enter');
  };
  await expect(active().getByRole('radio', { name: '仅一次', exact: true })).toBeChecked();
  await expect(editor.getByText('按节点时区执行：Asia/Shanghai')).toBeVisible();
  expect(previews.at(-1)).toEqual(scope);
  await expect(catchUp).toHaveCount(0);
  await expect(firstTime).toHaveAttribute('placeholder', '选择时刻');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor.getByText('请选择时刻，并填写当前执行方式需要的日期。')).toBeVisible();
  expect(writes).toHaveLength(0);
  await active().getByRole('radio', { name: '每天', exact: true }).check();
  await expect(active().getByRole('textbox', { name: '日期 1' })).toHaveCount(0);
  await firstTime.click();
  const timePicker = page.getByRole('dialog', { name: '时间', exact: true });
  await timePicker
    .getByRole('group', { name: '小时' })
    .getByRole('button', { name: '10', exact: true })
    .click();
  await timePicker
    .getByRole('group', { name: '分钟' })
    .getByRole('button', { name: '00', exact: true })
    .click();
  await timePicker.getByRole('button', { name: '确定', exact: true }).click();
  await addTime.click();
  await active().getByRole('radio', { name: '每天', exact: true }).check();
  await fillTime(2, '20:00');
  await addTime.click();
  await active().getByRole('radio', { name: '每周', exact: true }).check();
  await active().getByRole('combobox', { name: '星期', exact: true }).click();
  await page.getByRole('option', { name: '周一', exact: true }).click();
  await page.getByRole('option', { name: '周五', exact: true }).click();
  await page.keyboard.press('Escape');
  await fillTime(3, weekly.time);
  await addTime.click();
  await active().getByRole('radio', { name: '每月', exact: true }).check();
  const monthDays = active().getByRole('combobox', { name: '每月几号', exact: true });
  await expect(monthDays).toHaveText('选择每月几号（可多选）');
  await monthDays.click();
  await page.getByRole('option', { name: '15', exact: true }).click();
  await page.getByRole('option', { name: '31', exact: true }).click();
  await page.keyboard.press('Escape');
  await fillTime(4, monthly.time);
  await addTime.click();
  await fillTime(5, once.time);
  const onceDateInput = active().getByRole('textbox', { name: '日期 5', exact: true });
  await expect(onceDateInput).toHaveValue('2028-02-29');
  expect(previews).toContainEqual({ ...scope, suggestTime: once.time });
  await onceDateInput.fill(once.date);
  await onceDateInput.press('Enter');
  await expect(catchUp).not.toBeChecked();
  await expect(editor.locator('.preview li')).toHaveText('2027-01-01 10:00:00');
  await editor.getByRole('button', { name: '收起执行时间 5' }).click();
  await expect(editor.getByText('每周 · 周一, 周五')).toBeVisible();
  await expect(editor.getByText('每月 15, 31 日')).toBeVisible();
  await expect(editor.getByText('2028-03-01 · 仅一次')).toBeVisible();
  await expect(editor.getByText('高级设置', { exact: true })).toHaveCount(0);
  await editor.locator('.mar-ui-dialog__body').evaluate((body) => (body.scrollTop = 0));
  await expect(editor.getByText('按节点时区执行：Asia/Shanghai')).toBeInViewport();
  await page.screenshot({ path: info.outputPath('scheduled-clock-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(editor.getByText('每周 · 周一, 周五')).toBeInViewport();
  await page.screenshot({ path: info.outputPath('scheduled-clock-mobile.png') });
  await editor.getByRole('button', { name: '编辑执行时间 3' }).click();
  await expect(active().getByRole('combobox', { name: '星期', exact: true })).toBeInViewport();
  await page.screenshot({ path: info.outputPath('scheduled-clock-weekly-mobile.png') });
  await page.setViewportSize(desktopViewport);
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(writes[0]?.csrf).toBeTruthy();
  expect(writes[0]?.body).toMatchObject({
    ...scope,
    name: '第三项任务',
    objective: 'Review the build',
    graceMinutes: 0,
    target: { kind: 'existing', sessionId: targetSession.externalSessionId },
    triggers: [...daily, weekly, monthly, once]
  });
  expect(writes[0]?.body).not.toHaveProperty('timezone');

  const card = panel.locator('.card').filter({ hasText: '检查构建' });
  await expect(
    panel
      .locator('.card')
      .filter({ hasText: '另一节点的相同任务 ID' })
      .getByRole('button', { name: '编辑' })
  ).toHaveCount(0);
  await card.getByRole('button', { name: '编辑', exact: true }).click();
  await expectTargetLayout();
  const deleteTask = editor.getByRole('button', { name: '删除任务', exact: true });
  await expect(deleteTask).toHaveText('删除任务');
  await expect(deleteTask.locator('svg')).toHaveCount(0);
  await expect(deleteTask).toHaveCSS('border-top-width', '1px');
  await editor.getByRole('tab', { name: '执行时间', exact: true }).click();
  await expect(editor.getByText('每月 15, 31 日')).toBeVisible();
  await expect(editor.getByRole('switch', { name: '错过指定时间后补跑' })).toHaveCount(0);
  await editor.getByRole('tab', { name: '任务设置', exact: true }).click();
  await editor.getByRole('textbox', { name: '任务提示词' }).fill('New prompt');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(writes[1]?.url.pathname).toBe('/api/scheduled-tasks/task');
  expect(writes[1]?.body).toMatchObject({
    ...scope,
    expectedRevision: 2,
    patch: { objective: 'New prompt', triggers, graceMinutes: 60 }
  });

  await panel.getByRole('button', { name: '新建定时', exact: true }).click();
  await select('执行节点', 'Node B');
  await select('工作区', 'project');
  await select('运行目标', '每次新建会话');
  const model = editor.getByRole('combobox', { name: '模型', exact: true });
  await expect(model).toBeDisabled();
  await expect(model).toHaveAttribute('placeholder', '搜索或选择模型');
  await expect(editor.getByRole('combobox', { name: '模型选择', exact: true })).toHaveCount(0);
  const runner = editor.getByRole('combobox', { name: 'Agent', exact: true });
  await expect(runner).toHaveText('选择 Agent');
  await runner.click();
  await expect(page.getByRole('listbox').getByRole('option')).toHaveText([
    'MAR Agent',
    'Codex',
    'Claude Code',
    'OpenCode'
  ]);
  const codex = page.getByRole('option', { name: 'Codex', exact: true });
  await expect(codex.locator('img')).toBeVisible();
  await expect(
    page.getByRole('option', { name: 'MAR Agent', exact: true }).locator('img')
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath('scheduled-runner-desktop.png'),
    animations: 'disabled'
  });
  await page.getByRole('option', { name: 'MAR Agent', exact: true }).click();
  await model.click();
  await expect(page.getByRole('option', { name: 'Dual-purpose model', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await runner.click();
  await codex.click();
  await expect(runner).toHaveText('Codex');
  await expect(editor.locator('img.mar-ui-select__icon[data-runner="codex"]')).toBeVisible();
  await editor.getByRole('textbox', { name: '任务名称' }).fill('固定模型定时');
  await editor.getByRole('textbox', { name: '任务提示词' }).fill('Check the build');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor.getByText('请选择一个固定模型。')).toBeVisible();
  expect(writes).toHaveLength(2);
  await model.click();
  await expect(page.getByRole('listbox').getByRole('option')).toHaveText([
    'Test model',
    'Another model'
  ]);
  await page.getByRole('option', { name: 'Another model', exact: true }).click();
  const effort = editor.getByRole('combobox', { name: '推理强度', exact: true });
  await expect(effort).toHaveText('Medium');
  await select('模型', 'Test model');
  await expect(effort).toHaveText('High');
  await runner.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('scheduled-agent-model-desktop.png') });
  // The searchable model has an input trigger; measure the visible Select frames, not their triggers.
  const [runnerTop, modelTop, effortTop] = await runner
    .or(model)
    .or(effort)
    .evaluateAll((triggers) =>
      triggers.map((trigger) => trigger.closest('.mar-ui-field-frame')!.getBoundingClientRect().top)
    );
  expect(Math.abs(modelTop! - runnerTop!)).toBeLessThan(1);
  expect(Math.abs(effortTop! - runnerTop!)).toBeLessThan(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await effort.scrollIntoViewIfNeeded();
  expect((await effort.boundingBox())!.y).toBeGreaterThan((await runner.boundingBox())!.y);
  await page.screenshot({ path: info.outputPath('scheduled-agent-model-mobile.png') });
  await page.setViewportSize(desktopViewport);
  await editor.getByRole('tab', { name: '执行时间', exact: true }).click();
  const onceDate = active().getByRole('textbox', { name: '日期 1', exact: true });
  await onceDate.fill('2028-12-01');
  await onceDate.press('Enter');
  await firstTime.fill('08:00');
  await firstTime.press('Enter');
  await expect(editor.locator('.preview li')).toBeVisible();
  await page.screenshot({ path: info.outputPath('scheduled-time-once-desktop.png') });
  await catchUp.click();
  await select('最多等待（分钟）', '20');
  await page.screenshot({ path: info.outputPath('scheduled-time-catch-up-desktop.png') });
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(writes[2]?.body).toMatchObject({
    ...scope,
    graceMinutes: 20,
    target: {
      kind: 'newSession',
      runner: 'codex',
      model: { kind: 'fixed', modelId: 'model' },
      effort: 'high'
    }
  });

  const recordsButton = card.getByRole('button', { name: '执行记录', exact: true });
  await recordsButton.click();
  const historyTable = editor.getByRole('table', { name: '执行记录列表', exact: true });
  await expect(historyTable.getByRole('row')).toHaveCount(2);
  await expect(header.getByRole('heading', { name: '全部定时' })).toBeVisible();
  expect(historyQueries.at(-1)?.searchParams.get('taskId')).toBe('task');
  await page.screenshot({
    path: info.outputPath('scheduled-task-history-desktop.png'),
    animations: 'disabled'
  });
  const taskPager = editor.getByRole('navigation', { name: '分页' });
  await taskPager.getByRole('button', { name: '下一页' }).click();
  await expect(editor.getByRole('alert')).toBeVisible();
  await expect(historyTable.getByRole('row')).toHaveCount(2);
  await taskPager.getByRole('button', { name: '下一页' }).click();
  await expect(historyTable.getByRole('button')).not.toHaveText('2027-01-01 10:00:00');
  await expect(historyTable.getByRole('row')).toHaveCount(2);
  await taskPager.getByRole('button', { name: '上一页' }).click();
  await expect(historyTable.getByRole('button')).toHaveText('2027-01-01 10:00:00');
  const recordButton = historyTable.getByRole('button').first();
  await recordButton.click();
  await expect(editor.getByText('Historical prompt')).toBeVisible();
  await expect(editor.getByRole('button', { name: '打开运行所在会话' })).toHaveCount(0);
  const requestsBeforeBack = historyQueries.length;
  await editor.getByRole('button', { name: '返回执行记录', exact: true }).click();
  await expect(historyTable.getByRole('row')).toHaveCount(2);
  await expect(recordButton).toBeFocused();
  expect(historyQueries).toHaveLength(requestsBeforeBack);
  await editor.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(recordsButton).toBeFocused();
  if (!(await scheduleMenu.isVisible())) await toggle.click();
  await scheduleMenu.getByRole('button', { name: '执行记录', exact: true }).click();
  const globalHistory = page.getByRole('region', { name: '执行记录', exact: true });
  const globalTable = globalHistory.getByRole('table', { name: '执行记录列表', exact: true });
  await expect(globalTable.getByRole('row')).toHaveCount(21);
  const globalPager = globalHistory.getByRole('navigation', { name: '分页' });
  await expect(globalPager.getByText(/27/)).toBeVisible();
  const query = () => historyQueries.at(-1)!.searchParams;
  expect([...query()]).toEqual([
    ['mine', 'false'],
    ['page', '1']
  ]);
  await globalPager.getByRole('button', { name: '下一页' }).click();
  await expect(globalTable.getByRole('row')).toHaveCount(8);
  expect(query().get('page')).toBe('2');
  await expect(globalPager).toBeInViewport();
  await page.screenshot({ path: info.outputPath('scheduled-global-history-desktop.png') });
  await expect(globalHistory.getByRole('combobox')).toHaveCount(1);
  await filterWorkspace(globalHistory, 'project · Node A');
  await expect(globalTable.getByRole('button', { name: '检查构建' })).toHaveCount(0);
  await expect(globalTable.getByRole('button', { name: '另一个任务的记录' })).toBeVisible();
  expect([...query()]).toEqual([
    ['nodeId', 'node-1'],
    ['workspaceId', 'workspace-1'],
    ['mine', 'false'],
    ['page', '1']
  ]);
  await filterWorkspace(globalHistory, 'project · Node B');
  await expect(globalTable.getByRole('button', { name: '检查构建' })).toBeVisible();
  expect([...query()]).toEqual([
    ['nodeId', 'node-2'],
    ['workspaceId', 'workspace-1'],
    ['mine', 'false'],
    ['page', '1']
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('aside.workspace-tree')).toBeHidden();
  const tableScroll = globalHistory.getByRole('region', { name: '执行记录列表', exact: true });
  await expect(tableScroll).toHaveAttribute('tabindex', '0');
  expect(await tableScroll.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
    true
  );
  await page
    .locator('html')
    .evaluate((element) => element.setAttribute('data-theme', 'vscode-dark-2026'));
  await page.screenshot({ path: info.outputPath('scheduled-global-history-mobile.png') });
  await expect(globalPager).toHaveCount(0);
  await globalTable.getByRole('row').last().scrollIntoViewIfNeeded();
  const retry = globalHistory.getByRole('button', { name: '加载失败，点击重试' });
  await expect(retry).toBeVisible();
  await expect(globalTable.getByRole('row')).toHaveCount(21);
  await retry.click();
  await expect(globalTable.getByRole('row')).toHaveCount(27);
  expect(query().get('page')).toBe('2');
  await globalTable.getByRole('button', { name: '检查构建', exact: true }).click();
  await expect(editor.getByText('触发时的提示词')).toBeVisible();
  await expect(editor).toBeInViewport();
  await page.screenshot({
    path: info.outputPath('scheduled-history-mobile.png'),
    animations: 'disabled'
  });
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
  await page.screenshot({ path: info.outputPath('scheduled-tasks-mobile.png') });
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await expect(panel.or(globalHistory)).toBeHidden();

  await page.setViewportSize(desktopViewport);
  const openAllSchedules = async () => {
    await clock.click();
    if (!(await scheduleMenu.isVisible())) await toggle.click();
    await scheduleMenu.getByRole('button', { name: '全部定时', exact: true }).click();
  };
  const navigationCard = panel.locator('.card').filter({ hasText: '另一节点的相同任务 ID' });
  await openAllSchedules();
  await expect(navigationCard.getByRole('link')).toHaveCount(0);
  await expect(navigationCard.getByRole('button', { name: 'project', exact: true })).toHaveCount(0);
  const cardTitle = hoverCard.getByRole('button', { name: '检查构建', exact: true });
  // The existing binding can be outside the session picker's first page.
  readerSessionPage = [];
  await hoverCard.getByText('Node B · project', { exact: true }).click();
  await expect(editor.getByRole('tablist', { name: '任务详情' })).toBeVisible();
  await expect(editor.getByRole('combobox', { name: '运行会话', exact: true })).toHaveAttribute(
    'placeholder',
    '定时会话'
  );
  await expectTargetLayout();
  await expect(editor.getByRole('button', { name: /^(保存|删除任务|接受|拒绝)$/ })).toHaveCount(0);
  await expect(editor.getByText('建议名称', { exact: true })).toBeVisible();
  await expect(editor.getByRole('textbox', { name: '任务提示词' })).toHaveAttribute('readonly', '');
  await page.screenshot({ path: info.outputPath('scheduled-card-readonly-detail.png') });
  await page.keyboard.press('Escape');
  await expect(editor).toBeHidden();
  await expect(cardTitle).toBeFocused();
  const unboundCard = panel.locator('.card').filter({ hasText: '复盘失败' });
  await expect(unboundCard.getByRole('button', { name: /打开会话/ })).toHaveCount(0);
  await unboundCard.locator('.objective').click();
  await expect(editor.getByRole('heading', { name: '复盘失败', exact: true })).toBeVisible();
  await expect(editor.getByRole('combobox', { name: '运行会话', exact: true })).toHaveCount(0);
  await expect(editor.getByRole('combobox', { name: '模型', exact: true })).toHaveAttribute(
    'placeholder',
    'retired-model'
  );
  await expect(editor.getByRole('combobox', { name: '推理强度', exact: true })).toHaveText('High');
  await page.keyboard.press('Escape');
  await expect(editor).toBeHidden();
  const objective = navigationCard.locator('.objective');
  await objective.evaluate((text) => {
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await objective.dispatchEvent('click');
  await expect(editor).toBeHidden();
  await expect(panel).toBeVisible();
  await objective.evaluate(() => document.getSelection()!.removeAllRanges());
  await navigationCard
    .getByRole('button', { name: '另一节点的相同任务 ID', exact: true })
    .press('Enter');
  await expect(editor.getByRole('tablist', { name: '任务详情' })).toBeVisible();
  await expect(editor.getByRole('button', { name: '保存', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(editor).toBeHidden();
  const openSession = navigationCard.getByRole('button', { name: '既有会话：打开会话' });
  await openSession.click();
  await expect(panel).toBeHidden();
  await expect(page.getByText('较早的对话', { exact: true })).toBeVisible();
  await openAllSchedules();
  await openSession.press('Enter');
  await expect(panel).toBeHidden();
  await expect(page.getByText('较早的对话', { exact: true })).toBeVisible();
});
