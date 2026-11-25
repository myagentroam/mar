import { expect, test } from '@playwright/test';
import { json, mockConsoleApi } from './support/web-console-api.js';

// @test-covers packages/web-core/src/view/workbench/WorkbenchNavigation.vue
// @test-covers ee/web/src/composition/enterprise-management.ts

const menus = [
  {
    id: 'management',
    entry: '管理',
    label: '管理菜单',
    current: '系统信息',
    items: [
      ['组织管理', 'organization'],
      ['用户管理', 'users'],
      ['节点管理', 'node'],
      ['工作区管理', 'folder'],
      ['技能配置', 'skill'],
      ['技能源管理', 'skill-source'],
      ['MCP 源管理', 'connection'],
      ['环境密钥管理', 'secret'],
      ['MAR Agent 模型', 'model'],
      ['OAuth 配置', 'oauth'],
      ['对话模板', 'collection'],
      ['操作审计', 'audit'],
      ['系统配置', 'adjustments'],
      ['系统信息', 'system']
    ]
  },
  {
    id: 'settings',
    entry: '设置',
    label: '设置菜单',
    current: '账户安全',
    items: [
      ['账户安全', 'user'],
      ['用量统计', 'bar-chart'],
      ['外观', 'sun'],
      ['主题', 'palette'],
      ['系统通知', 'notification'],
      ['快捷提示词', 'quote'],
      ['个性化提示词', 'document'],
      ['Git 配置', 'branch'],
      ['浏览器设置', 'web'],
      ['快捷键', 'keyboard'],
      ['关于', 'info']
    ]
  },
  {
    id: 'schedules',
    entry: '定时任务',
    label: '定时任务',
    current: '我的定时',
    items: [
      ['我的定时', 'calendar-check'],
      ['全部定时', 'calendar'],
      ['执行记录', 'clock']
    ]
  }
] as const;

for (const theme of ['dark', 'daylight']) {
  for (const mobile of [false, true]) {
    test.describe(`${theme}, ${mobile ? 'mobile' : 'desktop'}`, () => {
      test.use({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 830 },
        hasTouch: mobile
      });

      test('Workbench secondary menu icons share the row color and keep the text label', async ({
        page
      }, testInfo) => {
        await mockConsoleApi(page, 'MANAGED', ['session.schedule'], []);
        await page.route('**/api/auth/me', (route) =>
          json(route, {
            authenticated: true,
            userId: 1,
            mustChangePassword: false,
            username: 'admin',
            isAdmin: true,
            edition: 'ENTERPRISE',
            licenseState: 'ENTERPRISE_VALID',
            role: 'ADMIN',
            organizationId: 1,
            managementWritable: true
          })
        );
        await page.route('**/api/organizations', (route) => json(route, { organizations: [] }));
        await page.route(/\/api\/enterprise\/users(?:\?.*)?$/u, (route) =>
          json(route, { users: [], page: 1, pageSize: 20, total: 0, hasMore: false })
        );
        await page.route('**/api/oauth-bindings', (route) => json(route, { bindings: [] }));
        await page.route('**/api/license', (route) =>
          json(route, {
            edition: 'ENTERPRISE',
            state: 'ENTERPRISE_VALID',
            reason: null,
            licenseId: 'fixture',
            enterpriseName: 'Demo',
            expiresAt: 253_402_300_799_000,
            managementWritable: true,
            activationAvailable: false
          })
        );
        await page.route(/\/api\/scheduled-tasks(?:\?.*)?$/u, (route) =>
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
        await page.addInitScript((value) => localStorage.setItem('mar.theme', value), theme);
        await page.goto('/console');
        if (theme === 'daylight') await expect(page.locator('html')).not.toHaveClass(/\bdark\b/u);
        else await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        const rail = page.getByRole('navigation', { name: '主导航' });
        for (const { id, entry, label, current, items } of menus) {
          const trigger = rail.getByRole('button', { name: entry, exact: true });
          await trigger.click();
          const menu = page.getByRole('navigation', { name: label, exact: true });
          if (mobile && (await trigger.getAttribute('aria-expanded')) === 'false') {
            await trigger.tap();
          }
          await expect(menu).toBeInViewport();
          const rows = menu.getByRole('button');
          await expect(rows).toHaveCount(items.length);
          const currentRow = menu.getByRole('button', { name: current, exact: true });
          if ((await currentRow.getAttribute('aria-current')) !== 'page') {
            await currentRow.click();
            if (mobile) await trigger.tap();
          }
          await expect(menu).toBeInViewport();
          await expect(currentRow).toHaveAttribute('aria-current', 'page');

          for (const [index, [label, iconName]] of items.entries()) {
            const row = rows.nth(index);
            await expect(row).toHaveAccessibleName(label);
            const icon = row.locator('svg.mar-icon');
            await expect(icon).toBeVisible();
            await expect(icon).toHaveAttribute('data-mar-icon', iconName);
            await expect(icon).toHaveAttribute('aria-hidden', 'true');
            const style = await icon.evaluate((element) => ({
              stroke: getComputedStyle(element).stroke,
              rowColor: getComputedStyle(element.parentElement!).color,
              width: parseFloat(getComputedStyle(element).width),
              height: parseFloat(getComputedStyle(element).height),
              rootFontSize: parseFloat(getComputedStyle(document.documentElement).fontSize)
            }));
            expect(style.stroke).toBe(style.rowColor);
            // A fractional rem is rounded to the browser's layout precision.
            expect(style.width).toBeCloseTo(style.rootFontSize, 1);
            expect(style.height).toBeCloseTo(style.rootFontSize, 1);
          }

          await page.mouse.move(1, 1);
          await page.screenshot({
            path: testInfo.outputPath(`${id}-${theme}-${mobile ? 'mobile' : 'desktop'}.png`),
            animations: 'disabled'
          });
        }
      });
    });
  }
}
