import { expect, test } from '@playwright/test';
import { fulfillMockSessionWatch, json, mockConsoleApi } from './support/web-console-api.js';

test('Session schedules identify an empty scope, lock creation, and exit for a conversation notification', async ({
  page
}, info) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start', 'session.schedule'], []);
  const scope = { nodeId: 'node-1', workspaceId: 'workspace-1' };
  const title = '构建巡检会话';
  const session = {
    id: 'session-1',
    externalSessionId: 'vscode-thread-1',
    workspaceId: scope.workspaceId,
    runner: 'codex',
    runnerTitle: title,
    activity: 'IDLE',
    nativeControl: 'EXTERNAL',
    runtime: { level: 'MANAGED', capabilities: ['history.read', 'turn.start', 'session.schedule'] }
  };
  await page.route('**/api/agent-sessions/session-1?nodeId=node-1', (route) =>
    json(route, { session })
  );
  await page.route('**/api/agent-sessions/session-1/watch*', (route) =>
    fulfillMockSessionWatch(page, route, session, {
      kind: 'session-watch-snapshot',
      sequence: 1,
      session,
      runs: [],
      queue: { version: 0, paused: false, items: [] },
      context: null,
      conversation: {
        unit: 'SEGMENT',
        source: 'official',
        readAt: 1,
        latestVisibleAt: 1,
        nextCursor: null,
        snapshotSequence: 1,
        segments: []
      }
    })
  );
  let candidateSessionReads = 0;
  await page.route(/\/api\/agent-sessions\?nodeId=node-1(?:&.*)?$/, (route) => {
    if (new URL(route.request().url()).searchParams.get('limit') === '50') candidateSessionReads++;
    return json(route, { sessions: [session], nextCursor: null });
  });
  const reads: Record<string, string>[] = [];
  const writes: unknown[] = [];
  await page.route(/\/api\/scheduled-tasks(?:\?.*)?$/, (route) => {
    if (route.request().method() === 'POST') {
      writes.push(route.request().postDataJSON());
      return json(route, { task: { id: 'created' } });
    }
    const query = new URL(route.request().url()).searchParams;
    reads.push(Object.fromEntries(query));
    return json(route, {
      items: [],
      nodes: [{ id: scope.nodeId, name: '开发节点', connected: true, supported: true }],
      page: 1,
      pageSize: 20,
      total: 0,
      hasMore: false,
      unavailableNodeIds: [],
      workspaces: [{ ...scope, nodeName: '开发节点', workspaceName: 'project' }]
    });
  });
  await page.route('**/api/scheduled-tasks/preview', (route) =>
    json(route, {
      timezone: 'Asia/Shanghai',
      times: [],
      ...(route.request().postDataJSON()?.suggestTime ? { suggestedDate: '2028-02-29' } : {})
    })
  );
  const now = Date.now();
  const entry = {
    id: 'schedule-session-notification',
    kind: 'run',
    title: '巡检已完成',
    message: '返回原会话查看结果。',
    createdAt: now,
    updatedAt: now,
    expiresAt: now + 300_000,
    read: false,
    target: { ...scope, targetType: 'WORKSPACE_SESSION', sessionId: session.id }
  };
  await page.route('**/api/notifications', (route) => json(route, { notifications: [entry] }));
  await page.route('**/api/notifications/*/read', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    entry.read = true;
    return json(route, {});
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  const tree = page.locator('.workspace-tree');
  await tree.getByRole('button', { name: /node-1/ }).click();
  await tree.getByRole('button', { name: 'project', exact: true }).click();
  await page.locator('.session-list').getByText(title, { exact: true }).click();
  const conversation = page.locator('.conversation-header').getByRole('button', { name: title });
  const openFromSession = async () => {
    await conversation.click();
    await page.getByRole('menuitem', { name: '定时任务', exact: true }).click();
  };
  await openFromSession();

  const scoped = page.getByRole('region', { name: '会话定时任务', exact: true });
  await expect(scoped.getByText(`当前会话：${title}`, { exact: true })).toBeVisible();
  await expect(scoped.getByText('此会话暂无定时任务。', { exact: true })).toBeVisible();
  expect(reads.at(-1)).toMatchObject({ ...scope, sessionId: session.externalSessionId, page: '1' });
  await page.screenshot({
    path: info.outputPath('session-schedules-empty-desktop.png'),
    animations: 'disabled'
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(scoped.getByRole('button', { name: '返回全部定时' })).toBeInViewport();
  await expect(scoped.getByText(`当前会话：${title}`, { exact: true })).toBeInViewport();
  await page.screenshot({
    path: info.outputPath('session-schedules-empty-mobile.png'),
    animations: 'disabled'
  });
  await page.setViewportSize({ width: 1280, height: 860 });

  const priorReads = candidateSessionReads;
  await scoped.getByRole('button', { name: '新建定时', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '新建定时', exact: true });
  for (const name of ['执行节点', '工作区', '运行目标', '运行会话']) {
    await expect(editor.getByRole('combobox', { name, exact: true })).toBeDisabled();
  }
  await expect(editor.getByRole('combobox', { name: '运行会话' })).toHaveText(title);
  await expect(editor.getByRole('combobox', { name: '工作区' })).toHaveText('/project');
  expect(candidateSessionReads).toBe(priorReads);
  await page.screenshot({
    path: info.outputPath('session-schedules-create-locked.png'),
    animations: 'disabled'
  });
  await editor.getByRole('textbox', { name: '任务名称' }).fill('每日巡检');
  await editor.getByRole('textbox', { name: '任务提示词' }).fill('汇总构建结果。');
  await editor.getByRole('tab', { name: /^(时间组合|执行时间)$/ }).click();
  const time = editor.getByRole('textbox', { name: '时刻 1', exact: true });
  await time.fill('10:00');
  await time.press('Enter');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).toBeHidden();
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    ...scope,
    target: { kind: 'existing', sessionId: session.externalSessionId }
  });

  await scoped.getByRole('button', { name: '返回全部定时' }).click();
  const all = page.getByRole('region', { name: '全部定时', exact: true });
  await expect(all.getByRole('combobox', { name: '工作区' })).toBeVisible();
  await expect.poll(() => reads.at(-1)).toEqual({ mine: 'false', page: '1' });

  await page.getByRole('button', { name: '会话与通知', exact: true }).click();
  const activity = page.locator('.workbench-activity-panel:visible');
  await activity.getByRole('tab', { name: '通知', exact: true }).click();
  await activity.getByRole('button', { name: /^巡检已完成/ }).click();
  await expect(all).toHaveCount(0);
  await expect(conversation).toBeVisible();

  await openFromSession();
  await page.getByRole('button', { name: '定时任务', exact: true }).click();
  await page
    .getByRole('navigation', { name: '定时任务', exact: true })
    .getByRole('button', { name: '全部定时', exact: true })
    .click();
  await expect(all).toBeVisible();
  await expect.poll(() => reads.at(-1)).toEqual({ mine: 'false', page: '1' });
});
