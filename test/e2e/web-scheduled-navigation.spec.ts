import { expect, test } from '@playwright/test';
import { json, mockConsoleApi } from './support/web-console-api.js';

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
