import { expect, test } from '@playwright/test';
import { json, mockConsoleApi } from './support/web-console-api.js';

test('Scheduled task cards replace desktop pages and append mobile pages with retry', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['session.schedule'], []);
  const tasks = Array.from({ length: 25 }, (_, index) => ({
    id: `task-${index + 1}`,
    name: `Schedule ${index + 1}`,
    nodeId: 'node-1',
    nodeName: 'Node A',
    workspaceId: 'workspace-1',
    workspaceName: 'Project',
    sessionId: null,
    targetKind: 'newSession',
    enabled: false,
    nextRunAt: null,
    mine: true
  }));
  const reads: number[] = [];
  let failNext = false;
  await page.route(/\/api\/scheduled-tasks(?:\?.*)?$/, (route) => {
    const query = new URL(route.request().url()).searchParams;
    expect(query.has('cursor')).toBe(false);
    const pageNumber = Number(query.get('page'));
    reads.push(pageNumber);
    if (pageNumber === 2 && failNext) {
      failNext = false;
      return json(
        route,
        { error: { code: 'TEST_READ_FAILED', message: 'Task list unavailable.' } },
        500
      );
    }
    return json(route, {
      items: tasks.slice((pageNumber - 1) * 20, pageNumber * 20),
      page: pageNumber,
      pageSize: 20,
      total: tasks.length,
      hasMore: pageNumber === 1,
      unavailableNodeIds: [],
      nodes: [],
      workspaces: []
    });
  });
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '定时任务', exact: true }).click();

  const panel = page.getByRole('region', { name: '我的定时', exact: true });
  const cards = panel.getByRole('list', { name: '任务', exact: true }).getByRole('listitem');
  const pager = panel.getByRole('navigation', { name: '分页' });
  const first = panel.getByRole('heading', { name: 'Schedule 1', exact: true });
  await expect(cards).toHaveCount(20);
  await expect(pager.getByText(/25/)).toBeVisible();
  await pager.getByRole('button', { name: '下一页' }).click();
  await expect(cards).toHaveCount(5);
  await expect(first).toHaveCount(0);
  expect(reads).toEqual([1, 2]);

  failNext = true;
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(pager).toHaveCount(0);
  await expect(cards).toHaveCount(20);
  await panel.locator('.management-pagination').scrollIntoViewIfNeeded();
  const retry = panel.getByRole('button', { name: '加载失败，点击重试' });
  await expect(retry).toBeInViewport();
  await expect(cards).toHaveCount(20);
  expect(reads).toEqual([1, 2, 1, 2]);
  await retry.click();
  await expect(cards).toHaveCount(25);
  await expect(first).toHaveCount(1);
  await expect(retry).toHaveCount(0);
  expect(reads).toEqual([1, 2, 1, 2, 2]);
});
