import { expect, test } from '@playwright/test';
import { json, mockConsoleApi } from './support/web-console-api.js';
import { mockPersonalResources } from './support/web-auth-settings-fixture.js';

for (const locale of ['zh-CN', 'en-US'] as const) {
  for (const width of [1280, 390]) {
    test(`Members can register personal Nodes and manage Workspaces without admin directories (${locale}, ${width}px)`, async ({
      page
    }, testInfo) => {
      const text =
        locale === 'zh-CN'
          ? {
              management: '管理',
              nodes: '节点管理',
              workspaces: '工作区管理',
              register: '注册节点',
              name: '节点名称',
              create: '创建注册密钥',
              receipt: '注册密钥已创建',
              close: '关闭',
              restricted: ['组织管理', '用户管理', 'OAuth', '审计日志', '系统配置']
            }
          : {
              management: 'Admin',
              nodes: 'Nodes',
              workspaces: 'Workspaces',
              register: 'Register Node',
              name: 'Node Name',
              create: 'Create registration key',
              receipt: 'Registration key created',
              close: 'Close',
              restricted: ['Organizations', 'Users', 'OAuth', 'Audit Log', 'System Configuration']
            };
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem('mar.locale.v2', value), locale);
      await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
      await mockPersonalResources(page);
      let writable = true;
      await page.route('**/api/auth/me', (route) =>
        json(route, {
          authenticated: true,
          mustChangePassword: false,
          username: 'member',
          isAdmin: false,
          role: 'MEMBER',
          edition: 'ENTERPRISE',
          licenseState: writable ? 'ENTERPRISE_VALID' : 'ENTERPRISE_FROZEN',
          organizationId: 1,
          managementWritable: writable,
          csrfToken: 'csrf-1'
        })
      );
      const directoryRequests: string[] = [];
      await page.route(/\/api\/(?:organizations|enterprise\/users)(?:\?.*)?$/u, (route) => {
        directoryRequests.push(route.request().url());
        return route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'RBAC_DENIED', message: 'Forbidden' } })
        });
      });
      await page.route('**/api/management/nodes', (route) => json(route, { nodes: [] }));
      const registrations: { body: unknown; csrf: string | undefined }[] = [];
      await page.route('**/api/node-registration-tokens', (route) => {
        registrations.push({
          body: route.request().postDataJSON(),
          csrf: route.request().headers()['x-csrf-token']
        });
        return json(route, { token: 'member-personal-node-registration-key' });
      });
      const selectManagement = async (label: string) => {
        const button = page.getByRole('button', { name: label, exact: true });
        if (width === 390 || !(await button.isVisible()))
          await page.getByRole('button', { name: text.management, exact: true }).click();
        await expect(page.locator('.settings-nav')).toBeVisible();
        await button.click();
        if (width === 390)
          await expect(page.locator('.workspace-tree')).not.toHaveClass(/mobile-open/u);
      };

      await page.goto('/console');
      await selectManagement(text.nodes);
      for (const label of text.restricted)
        await expect(
          page.locator('.settings-nav').getByRole('button', { name: label, exact: true })
        ).toHaveCount(0);
      await expect(page.getByRole('button', { name: text.register, exact: true })).toBeEnabled();
      await page.screenshot({
        path: testInfo.outputPath(`member-node-management-${locale}-${width}.png`),
        animations: 'disabled'
      });
      await page.getByRole('button', { name: text.register, exact: true }).click();
      const form = page.getByRole('dialog', { name: text.register, exact: true });
      await expect(form).toBeVisible();
      await expect(form.getByRole('combobox')).toHaveCount(0);
      await form.getByLabel(text.name).fill('My personal Node');
      await form.getByRole('button', { name: text.create, exact: true }).click();
      const receipt = page.getByRole('dialog', { name: text.receipt, exact: true });
      await expect(receipt.locator('.registration-token')).toHaveText(
        'member-personal-node-registration-key'
      );
      expect(registrations).toEqual([
        { body: { displayName: 'My personal Node' }, csrf: 'csrf-1' }
      ]);
      await receipt.getByRole('button', { name: text.close, exact: true }).click();
      await selectManagement(text.workspaces);
      await expect(page.getByRole('cell', { name: '研发节点', exact: true })).toBeVisible();
      expect(directoryRequests).toEqual([]);

      writable = false;
      await page.reload();
      await selectManagement(text.nodes);
      await expect(page.getByRole('button', { name: text.register, exact: true })).toBeDisabled();
      await selectManagement(text.workspaces);
      await expect(page.getByRole('cell', { name: '研发节点', exact: true })).toBeVisible();
      expect(registrations).toHaveLength(1);
      expect(directoryRequests).toEqual([]);
    });
  }
}
