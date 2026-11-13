import { expect, test } from '@playwright/test';
import { json, mockConsoleApi, write } from './support/web-console-api.js';
import { mockPersonalResources } from './support/web-auth-settings-fixture.js';

// Node, workspace, and enterprise management scenarios.

for (const locale of ['zh-CN', 'en-US'] as const) {
  test(`Fixed admin edits only profile fields and respects read-only management (${locale})`, async ({
    page
  }) => {
    const text =
      locale === 'zh-CN'
        ? {
            admin: '管理',
            users: '用户管理',
            edit: '编辑',
            reset: '重置密码',
            remove: '删除',
            dialog: '编辑用户',
            username: '用户名',
            email: '邮箱',
            nickname: '显示名称',
            role: '角色',
            organization: '组织',
            save: '保存',
            cancel: '取消'
          }
        : {
            admin: 'Admin',
            users: 'Users',
            edit: 'Edit',
            reset: 'Reset password',
            remove: 'Delete',
            dialog: 'Edit User',
            username: 'Username',
            email: 'Email',
            nickname: 'Display Name',
            role: 'Role',
            organization: 'Organization',
            save: 'Save',
            cancel: 'Cancel'
          };
    await page.addInitScript((value) => localStorage.setItem('mar.locale.v2', value), locale);
    await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
    await mockPersonalResources(page);
    let writable = true;
    await page.route('**/api/auth/me', (route) =>
      json(route, {
        authenticated: true,
        mustChangePassword: false,
        username: 'admin',
        isAdmin: true,
        edition: 'ENTERPRISE',
        licenseState: writable ? 'ENTERPRISE_VALID' : 'ENTERPRISE_FROZEN',
        role: 'ADMIN',
        organizationId: 1,
        managementWritable: writable
      })
    );
    await page.route('**/api/organizations', (route) =>
      json(route, {
        organizations: [
          { id: 1, name: 'Root', parentOrganizationId: null, createdAt: 1, updatedAt: 1 }
        ]
      })
    );
    let user = {
      id: 1,
      username: 'admin',
      email: '',
      nickname: '',
      role: 'ADMIN',
      organizationId: 1,
      fixedAdmin: true,
      enabled: true
    };
    const updates: unknown[] = [];
    await page.route(/\/api\/enterprise\/users(?:\?.*)?$/, (route) =>
      json(route, { users: [user], page: 1, pageSize: 20, total: 1, hasMore: false })
    );
    await page.route('**/api/enterprise/users/1', (route) => {
      const body = route.request().postDataJSON();
      updates.push(body);
      user = { ...user, ...body };
      return json(route, { user });
    });
    await page.goto('/console');
    await page.getByRole('button', { name: text.admin, exact: true }).click();
    await page.getByRole('button', { name: text.users, exact: true }).click();
    const row = page.locator('.el-table__row').filter({ hasText: 'admin' });
    await expect(row.getByRole('button', { name: text.edit, exact: true })).toBeEnabled();
    await expect(row.getByRole('button', { name: text.reset, exact: true })).toBeDisabled();
    await expect(row.getByRole('button', { name: text.remove, exact: true })).toBeDisabled();
    await row.getByRole('button', { name: text.edit, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: text.dialog });
    await expect(dialog.getByLabel(text.username, { exact: true })).toBeDisabled();
    await expect(dialog.getByLabel(text.role, { exact: true })).toBeDisabled();
    await expect(dialog.getByLabel(text.organization, { exact: true })).toBeDisabled();
    await dialog.getByLabel(text.email, { exact: true }).fill('invalid-email');
    await dialog.getByRole('button', { name: text.save, exact: true }).click();
    await expect(dialog.locator('.el-form-item__error')).toBeVisible();
    expect(updates).toHaveLength(0);
    await dialog.getByLabel(text.email, { exact: true }).fill('admin@example.com');
    await dialog.getByLabel(text.nickname, { exact: true }).fill('恢复管理员');
    await dialog.getByRole('button', { name: text.save, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(updates).toEqual([
      { email: 'admin@example.com', nickname: '恢复管理员', role: 'ADMIN', organizationId: 1 }
    ]);
    await expect(row).toContainText('admin@example.com');
    await expect(row).toContainText('恢复管理员');
    await row.getByRole('button', { name: text.edit, exact: true }).click();
    await expect(dialog.getByLabel(text.nickname, { exact: true })).toHaveValue('恢复管理员');
    await dialog.getByLabel(text.nickname, { exact: true }).fill('Discarded');
    await dialog.getByRole('button', { name: text.cancel, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(updates).toHaveLength(1);
    const desktopViewport = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileUrl = page.url();
    await row.getByRole('button', { name: text.edit, exact: true }).click();
    await dialog.getByLabel(text.nickname, { exact: true }).fill('Discarded on Back');
    await page.goBack();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(mobileUrl);
    expect(updates).toHaveLength(1);
    await row.getByRole('button', { name: text.edit, exact: true }).click();
    await expect(dialog.getByLabel(text.nickname, { exact: true })).toHaveValue('恢复管理员');
    await dialog.getByRole('button', { name: text.cancel, exact: true }).click();
    if (desktopViewport !== null) await page.setViewportSize(desktopViewport);
    writable = false;
    await page.reload();
    await page.getByRole('button', { name: text.admin, exact: true }).click();
    await page.getByRole('button', { name: text.users, exact: true }).click();
    await expect(row.getByRole('button', { name: text.edit, exact: true })).toBeDisabled();
  });
}

for (const locale of ['zh-CN', 'en-US'] as const) {
  test(`Node registration confirms the new key separately and supports retries and reopening (${locale})`, async ({
    page
  }, testInfo) => {
    const text =
      locale === 'zh-CN'
        ? {
            login: '进入控制台',
            admin: '管理',
            nodes: '节点管理',
            register: '注册节点',
            name: '节点名称',
            create: '创建注册密钥',
            close: '关闭',
            success: '注册密钥已创建',
            help: '查看节点部署与自启动说明',
            required: '请输入节点名称',
            instructions: '设备连接成功后会显示在节点列表中。'
          }
        : {
            login: 'Open console',
            admin: 'Admin',
            nodes: 'Nodes',
            register: 'Register Node',
            name: 'Node Name',
            create: 'Create registration key',
            close: 'Close',
            success: 'Registration key created',
            help: 'View Node deployment and autostart guide',
            required: 'Enter a node name',
            instructions: 'The device will appear in the node list once it connects.'
          };
    await page.addInitScript((value) => localStorage.setItem('mar.locale.v2', value), locale);
    await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
    await mockPersonalResources(page);
    await page.route('**/api/management/nodes', (route) => json(route, { nodes: [] }));
    await page.route('**/api/organizations', (route) => json(route, { organizations: [] }));
    await page.route('**/api/enterprise/users', (route) => json(route, { users: [] }));
    const admin = {
      authenticated: true,
      mustChangePassword: false,
      username: 'admin',
      isAdmin: true,
      role: 'ADMIN',
      edition: locale === 'zh-CN' ? 'ENTERPRISE' : 'COMMUNITY',
      licenseState: locale === 'zh-CN' ? 'ENTERPRISE_VALID' : 'COMMUNITY',
      organizationId: null,
      managementWritable: true,
      csrfToken: 'csrf-1'
    };
    let authenticated = false;
    await page.route('**/api/auth/me', (route) =>
      json(route, authenticated ? admin : { authenticated: false, mustChangePassword: false })
    );
    await page.route('**/api/auth/login', (route) => {
      authenticated = true;
      return json(route, admin);
    });
    const writes: { csrf: string | undefined; body: unknown }[] = [];
    let completeCreation: (() => void) | undefined;
    const creation = new Promise<void>((resolve) => {
      completeCreation = resolve;
    });
    const token = `test-registration-key-${'a'.repeat(96)}`;
    await page.route('**/api/node-registration-tokens', async (route) => {
      writes.push({
        csrf: route.request().headers()['x-csrf-token'],
        body: route.request().postDataJSON()
      });
      if (writes.length === 1) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'REGISTRATION_UNAVAILABLE',
              message: 'Registration unavailable',
              requestId: 'registration-test-1'
            }
          })
        });
        return;
      }
      if (writes.length === 2) await creation;
      await json(route, { token: writes.length === 2 ? token : 'test-registration-key-new' });
    });
    await page.goto('/console');
    await page.getByRole('button', { name: text.login }).click();
    await page.getByRole('button', { name: text.admin, exact: true }).click();
    await page.getByRole('button', { name: text.nodes, exact: true }).click();
    await page.getByRole('button', { name: text.register, exact: true }).click();
    const form = page.getByRole('dialog', { name: text.register, exact: true });
    const receipt = page.getByRole('dialog', { name: text.success, exact: true });
    await expect(form.getByRole('link', { name: text.help })).toHaveCount(0);
    await form.getByRole('button', { name: text.create, exact: true }).click();
    await expect(form.locator('.el-form-item__error')).toHaveText(text.required);
    expect(writes).toHaveLength(0);
    await form.getByRole('textbox', { name: text.name }).fill('  test-node  ');
    await form.getByRole('button', { name: text.create, exact: true }).click();
    await expect(page.locator('.el-message--error')).toContainText('REGISTRATION_UNAVAILABLE');
    await expect(form).toBeVisible();
    await expect(receipt).toHaveCount(0);
    await expect(form.getByRole('textbox', { name: text.name })).toHaveValue('  test-node  ');
    await form.getByRole('button', { name: text.create, exact: true }).click();
    await expect.poll(() => writes.length).toBe(2);
    await expect(form.getByRole('button', { name: text.create, exact: true })).toBeDisabled();
    await expect(form.getByRole('button', { name: text.close, exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(form).toBeVisible();
    completeCreation!();
    await expect(form).toHaveCount(0);
    await expect(receipt).toBeVisible();
    await expect(receipt.locator('.registration-token')).toHaveText(token);
    await expect(receipt).toContainText(text.instructions);
    await expect(receipt.getByRole('link', { name: text.help })).toHaveAttribute(
      'href',
      locale === 'zh-CN'
        ? '/docs/deployment/node-installation'
        : '/docs/en-US/deployment/node-installation'
    );
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual({ csrf: 'csrf-1', body: { displayName: 'test-node' } });
    await page.setViewportSize({ width: 390, height: 720 });
    expect(
      await receipt.evaluate((element) => element.scrollWidth <= Math.ceil(element.clientWidth))
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`registration-receipt-${locale}.png`),
      animations: 'disabled'
    });
    await receipt.getByRole('button', { name: text.close, exact: true }).click();
    await expect(receipt).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole('button', { name: text.register, exact: true }).click();
    await expect(form.getByRole('textbox', { name: text.name })).toHaveValue('');
    await expect(page.getByText(token, { exact: true })).toHaveCount(0);
    await form.getByRole('textbox', { name: text.name }).fill('another-node');
    await form.getByRole('button', { name: text.create, exact: true }).click();
    await expect(receipt.locator('.registration-token')).toHaveText('test-registration-key-new');
    await page.keyboard.press('Escape');
    await expect(receipt).toHaveCount(0);
  });
}

test('Administrators configure SMTP, view built-in templates, and test email through isolated APIs', async ({
  page
}) => {
  test.setTimeout(60_000);
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await mockPersonalResources(page);
  let authenticated = false;
  const admin = {
    authenticated: true,
    mustChangePassword: false,
    username: 'admin',
    isAdmin: true,
    edition: 'COMMUNITY',
    licenseState: 'COMMUNITY',
    role: 'ADMIN',
    organizationId: null,
    managementWritable: true,
    csrfToken: 'csrf-1'
  };
  await page.unroute('**/api/auth/me');
  await page.route('**/api/auth/me', (route) =>
    json(route, authenticated ? admin : { authenticated: false, mustChangePassword: false })
  );
  await page.unroute('**/api/auth/login');
  await page.route('**/api/auth/login', (route) => {
    authenticated = true;
    return json(route, admin);
  });
  let smtpConfiguration = '{}';
  const smtpWrites: Record<string, unknown>[] = [];
  await page.route('**/api/system-settings', (route) =>
    json(route, {
      smtpConfiguration,
      auditRetentionDays: 180,
      skillTlsVerificationDisabled: false
    })
  );
  await page.route('**/api/system-settings/mail-smtp', (route) => {
    const body = route.request().postDataJSON() as { config: string };
    const config = JSON.parse(body.config) as Record<string, unknown>;
    smtpWrites.push(config);
    smtpConfiguration =
      Object.keys(config).length === 0 ? '{}' : JSON.stringify({ ...config, password: '' });
    return json(route, {
      smtpConfiguration,
      auditRetentionDays: 180,
      skillTlsVerificationDisabled: false
    });
  });
  await page.route('**/api/mail/templates', (route) =>
    json(route, [
      {
        id: 'test-en-US',
        kind: 'TEST',
        locale: 'en-US',
        name: 'Test email',
        subject: 'SMTP test',
        body: 'Sent to {{email}}',
        revision: 1,
        isDefault: true
      },
      {
        id: 'test-zh-CN',
        kind: 'TEST',
        locale: 'zh-CN',
        name: '测试邮件',
        subject: 'SMTP 测试',
        body: '发送至 {{email}}',
        revision: 1,
        isDefault: true
      },
      {
        id: 'notification-en-US',
        kind: 'NOTIFICATION',
        locale: 'en-US',
        name: 'Run notification',
        subject: 'Run status',
        body: '{{message}}',
        revision: 1,
        isDefault: true
      },
      {
        id: 'notification-zh-CN',
        kind: 'NOTIFICATION',
        locale: 'zh-CN',
        name: '运行通知',
        subject: '运行状态',
        body: '{{message}}',
        revision: 1,
        isDefault: true
      }
    ])
  );
  await page.route('**/api/mail/templates/preview', (route) => {
    const body = route.request().postDataJSON() as { templateId: string };
    expect(['test-en-US', 'notification-en-US']).toContain(body.templateId);
    const isTest = body.templateId === 'test-en-US';
    const subject = isTest ? 'SMTP test' : 'Run status';
    const text = isTest ? 'Sent to user@example.com' : 'Example notification message';
    return json(route, {
      subject,
      text,
      html: `<!doctype html><html><body><h1>${subject}</h1><p>${text}</p></body></html>`
    });
  });
  const tests: unknown[] = [];
  await page.route('**/api/mail/test', (route) => {
    tests.push(route.request().postDataJSON());
    return json(route, { accepted: true });
  });
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '管理', exact: true }).click();
  await page.getByRole('button', { name: '系统配置' }).click();
  const row = page.locator('.el-table__row').filter({ hasText: '邮件SMTP配置' });
  await expect(row).toContainText('配置部署级 SMTP 发信服务。');
  await expect(row.locator('td').nth(2)).toHaveText('-');
  await row.getByRole('button', { name: '编辑' }).click();
  const smtpDialog = page.getByRole('dialog', { name: '邮件SMTP配置' });
  await expect(row.locator('textarea')).toHaveCount(0);
  await expect(smtpDialog.getByRole('switch', { name: '启用邮件发送' })).not.toBeChecked();
  await expect(smtpDialog.locator('.smtp-template-row + .smtp-dialog-hint')).toHaveCount(1);
  await smtpDialog.getByRole('button', { name: '查看邮件模板' }).click();
  const viewer = page.getByRole('dialog', { name: '邮件模板' });
  await expect(viewer).toContainText('Run notification');
  await expect(viewer).toContainText('测试邮件');
  await expect(viewer.getByRole('button', { name: '新增模板' })).toHaveCount(0);
  await expect(viewer.getByRole('button', { name: '编辑' })).toHaveCount(0);
  await expect(viewer.locator('.template-preview__postmark')).toHaveCount(0);
  await expect(viewer.getByText('可用变量：message、userName、workspaceName、email。')).toHaveCount(
    0
  );
  await expect(viewer.getByRole('button', { name: '预览', exact: true })).toHaveCount(0);
  await expect(viewer.locator('iframe')).toHaveAttribute('sandbox', '');
  await expect(viewer.frameLocator('iframe').getByText('Sent to user@example.com')).toBeVisible();
  await viewer.getByRole('button', { name: /Test email/ }).click();
  await expect(viewer.frameLocator('iframe').getByText('Sent to user@example.com')).toBeVisible();
  await viewer.getByRole('button', { name: /Run notification/ }).click();
  await expect(
    viewer.frameLocator('iframe').getByText('Example notification message')
  ).toBeVisible();
  await viewer.getByRole('button', { name: '关闭', exact: true }).click();
  await smtpDialog.locator('.smtp-toggle .el-switch').click();
  await expect(smtpDialog.locator('.smtp-form__pair .el-input-number .el-input__inner')).toHaveCSS(
    'text-align',
    'left'
  );
  await smtpDialog.getByRole('textbox', { name: 'SMTP 主机' }).fill('smtp.example.test');
  await smtpDialog.getByRole('textbox', { name: '发件地址' }).fill('agent@example.test');
  await smtpDialog.getByRole('textbox', { name: '发件人名称' }).fill('MAR Test');
  await smtpDialog.getByRole('textbox', { name: '认证账号（可选）' }).fill('agent@example.test');
  await smtpDialog.getByRole('button', { name: '保存' }).click();
  await expect(smtpDialog).toContainText('填写认证账号时请输入密码');
  expect(smtpWrites).toHaveLength(0);
  await smtpDialog.getByLabel('认证密码（可选）').fill('app-password');
  await smtpDialog.getByRole('button', { name: '保存' }).click();
  await expect(smtpDialog).toHaveCount(0);
  expect(smtpWrites).toEqual([
    {
      host: 'smtp.example.test',
      port: 587,
      tls: 'STARTTLS',
      from: 'agent@example.test',
      fromName: 'MAR Test',
      username: 'agent@example.test',
      password: 'app-password'
    }
  ]);
  await expect(row.locator('td').nth(2)).toHaveText('-');
  await row.getByRole('button', { name: '编辑' }).click();
  await expect(smtpDialog.getByRole('textbox', { name: 'SMTP 主机' })).toHaveValue(
    'smtp.example.test'
  );
  await expect(smtpDialog.getByLabel('认证密码（可选）')).toBeEmpty();
  await smtpDialog.getByRole('button', { name: '保存' }).click();
  expect(smtpWrites[1]).toMatchObject({ username: 'agent@example.test', password: '' });
  await row.getByRole('button', { name: '编辑' }).click();
  await smtpDialog.getByRole('button', { name: '查看邮件模板' }).click();
  const reopenedViewer = page.getByRole('dialog', { name: '邮件模板' });
  await reopenedViewer.getByRole('button', { name: '发送测试邮件' }).click();
  const dialog = page.getByRole('dialog', { name: '发送测试邮件' });
  await dialog.getByRole('textbox', { name: '收件邮箱' }).fill('admin@example.test');
  await dialog.getByRole('button', { name: '发送测试' }).click();
  await expect(dialog).toHaveCount(0);
  expect(tests).toEqual([{ email: 'admin@example.test', templateId: 'test-en-US' }]);
  await reopenedViewer.getByRole('button', { name: '关闭', exact: true }).click();
  await smtpDialog.locator('.smtp-toggle .el-switch').click();
  await smtpDialog.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('停用后将删除已保存的 SMTP 配置与密码')).toBeVisible();
  await page.getByRole('button', { name: '取消' }).last().click();
  expect(smtpWrites).toHaveLength(2);
  await smtpDialog.getByRole('button', { name: '保存' }).click();
  await page.getByRole('button', { name: '停用邮件发送' }).click();
  expect(smtpWrites[2]).toEqual({});
  await expect(row.locator('td').nth(2)).toHaveText('-');
});

for (const locale of ['zh-CN', 'en-US'] as const) {
  test(`Loaded MCP distinguishes persistent installation from MAR runtime capabilities and supports older Nodes (${locale})`, async ({
    page
  }) => {
    await page.addInitScript((value) => localStorage.setItem('mar.locale.v2', value), locale);
    const labels =
      locale === 'zh-CN'
        ? {
            enter: '进入控制台',
            work: '工作',
            more: '更多工作区操作',
            loadedMcp: '已加载 MCP',
            schedule: 'MAR 定时任务',
            scheduleDescription: '查看、创建和更新当前会话的定时任务。',
            notification: 'MAR 邮件通知',
            notificationDescription: '向指定邮箱发送通知邮件。',
            injected: '执行时注入',
            loaded: '已加载',
            noDescription: '暂无描述'
          }
        : {
            enter: 'Open console',
            work: 'Work',
            more: 'More workspace actions',
            loadedMcp: 'Loaded MCP',
            schedule: 'MAR scheduled tasks',
            scheduleDescription:
              'View, create, and update scheduled tasks for the current session.',
            notification: 'MAR email notifications',
            notificationDescription: 'Send notification emails to a specified recipient.',
            injected: 'Injected during execution',
            loaded: 'Loaded',
            noDescription: 'No description'
          };

    await mockConsoleApi(
      page,
      'MANAGED',
      ['history.read', 'turn.start'],
      [],
      'GIT_WORKSPACE',
      true,
      undefined,
      undefined,
      '0.9.73'
    );
    let reportBuiltIns = true;
    let catalogVersion = '1.0.0';
    await page.route('**/api/mcp-catalog', (route) =>
      json(route, {
        entries: [
          {
            id: 'browser',
            sourceId: 'registry',
            scope: 'PERSONAL',
            serverName: 'browser',
            displayName: 'Browser tools',
            description: 'Browser automation tools',
            version: catalogVersion,
            featured: false,
            tags: [],
            runtime: { transport: 'STDIO' }
          }
        ]
      })
    );
    await page.route(/\/api\/workspaces\/workspace-1\/mcps\?nodeId=node-1$/, (route) =>
      json(route, {
        targetKind: 'WORKSPACE',
        installations: [
          {
            catalogEntryId: 'browser',
            serverName: 'browser',
            displayName: 'Browser tools',
            version: '1.0.0',
            origin: 'NODE',
            enabled: true,
            status: 'CURRENT',
            installedAt: 1
          }
        ],
        ...(reportBuiltIns ? { executionBuiltIns: ['mar_schedule', 'mar_notification'] } : {})
      })
    );
    await page.goto('/console');
    await page.getByRole('button', { name: labels.enter }).click();
    await page.getByRole('button', { name: labels.work, exact: true }).click();
    await page
      .locator('.workspace-tree')
      .getByRole('button', { name: /node-1/ })
      .click();
    await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
    async function openLoadedMcps(): Promise<void> {
      await page.getByRole('button', { name: labels.more }).click();
      await page.getByRole('menuitem', { name: labels.loadedMcp }).click();
    }
    await openLoadedMcps();
    const dialog = page.getByRole('dialog', { name: labels.loadedMcp });
    await expect(dialog).toContainText('Browser tools');
    await expect(dialog).toContainText('Browser automation tools');
    await expect(dialog).toContainText(labels.schedule);
    await expect(dialog).toContainText('mar_schedule');
    await expect(dialog).toContainText(labels.scheduleDescription);
    await expect(dialog).toContainText(labels.notification);
    await expect(dialog).toContainText('mar_notification');
    await expect(dialog).toContainText(labels.notificationDescription);
    const meta = dialog.locator('.effective-mcp-meta').first();
    await expect(meta).toHaveText('browser · 1.0.0');
    expect(
      await meta.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))
    ).toBeLessThan(
      await dialog
        .locator('.effective-skill-row p')
        .first()
        .evaluate((element) => parseFloat(getComputedStyle(element).fontSize))
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true
    );
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(dialog.getByText(labels.injected, { exact: true })).toHaveCount(2);
    await expect(dialog.getByText(labels.loaded, { exact: true })).toHaveCount(1);
    await expect(dialog).not.toContainText('以下内建 MCP 仅在普通工作区执行时注入');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    reportBuiltIns = false;
    catalogVersion = '2.0.0';
    await openLoadedMcps();
    await expect(dialog).toContainText('Browser tools');
    await expect(dialog).toContainText(labels.noDescription);
    await expect(dialog).not.toContainText('Browser automation tools');
    await expect(dialog).not.toContainText('mar_schedule');
    await expect(dialog).not.toContainText('mar_notification');
  });
}

test('Node and workspace management show resource names and use default controls', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await mockPersonalResources(page);
  await page.route('**/api/runner-usage/status?nodeId=node-1', (route) =>
    json(route, { statuses: [] })
  );
  const deletes: { readonly csrf: string | undefined }[] = [];
  await page.route('**/api/nodes/node-1', (route) => {
    if (route.request().method() !== 'DELETE') return route.fulfill({ status: 405 });
    deletes.push({ csrf: route.request().headers()['x-csrf-token'] });
    return route.fulfill({ status: 204 });
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await expect(page.getByText(/还没有绑定节点？前往节点管理创建注册密钥/)).toBeVisible();
  await page.getByRole('button', { name: '前往节点管理' }).click();
  await page.getByRole('button', { name: '工作区管理' }).click();
  await expect(page.getByRole('cell', { name: '研发节点', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '节点管理' }).click();
  await page.locator('.resource-management-panel .el-table__body tbody tr').first().click();

  const details = page.getByRole('dialog', { name: '节点详情' });
  await expect(details).toContainText('node-1');
  await details.getByRole('button', { name: '关闭', exact: true }).click();
  const deleteButton = page
    .locator('.resource-management-panel')
    .getByRole('button', { name: '删除', exact: true });
  await expect(deleteButton).not.toHaveClass(/el-button--small/);
  await expect(deleteButton).toBeDisabled();
  expect(deletes).toEqual([]);
});

test('Bulk Node upgrades span filters and pages, skip ineligible Nodes, and summarize partial failures', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  let authenticated = false;
  const admin = {
    authenticated: true,
    mustChangePassword: false,
    username: 'admin',
    isAdmin: true,
    role: 'ADMIN',
    managementWritable: true,
    csrfToken: 'csrf-1'
  };
  await page.route('**/api/auth/me', (route) =>
    json(route, authenticated ? admin : { authenticated: false, mustChangePassword: false })
  );
  await page.route('**/api/auth/login', (route) => {
    authenticated = true;
    return json(route, admin);
  });
  const nodes = [
    {
      id: 'node-a',
      displayName: '可升级甲',
      connected: true,
      upgradeAvailability: { state: 'AVAILABLE', targetVersion: '0.9.131' }
    },
    {
      id: 'node-b',
      displayName: '可升级乙',
      connected: true,
      upgradeAvailability: { state: 'AVAILABLE', targetVersion: '0.9.131' }
    },
    ...Array.from({ length: 10 }, (_, index) => ({
      id: `current-${index}`,
      displayName: `当前版本-${index}`,
      connected: true,
      upgradeAvailability: { state: 'CURRENT', targetVersion: '0.9.131' }
    })),
    {
      id: 'node-c',
      displayName: '可升级丙',
      connected: true,
      upgradeAvailability: { state: 'AVAILABLE', targetVersion: '0.9.131' }
    },
    {
      id: 'offline',
      displayName: '离线节点',
      connected: false,
      upgradeAvailability: { state: 'AVAILABLE', targetVersion: '0.9.131' }
    }
  ];
  await page.route('**/api/resources*', (route) =>
    json(route, {
      nodes: nodes.map(({ id, displayName }) => ({
        id,
        displayName,
        ownership: { ownerType: 'PERSONAL', ownerUserId: id === 'node-c' ? 2 : 1 }
      })),
      workspaces: []
    })
  );
  let upgradeable = true;
  let canManageNodeC = true;
  let pendingNodeA = false;
  await page.route('**/api/nodes', (route) =>
    json(route, {
      nodes: nodes.map((node) => ({
        ...node,
        disabled: false,
        manageable: node.id !== 'node-c' || canManageNodeC,
        ...(node.id === 'node-a' && pendingNodeA
          ? { metadata: { upgrade: { state: 'WAITING_FOR_RUNS' } } }
          : {}),
        upgradeAvailability:
          !upgradeable && node.upgradeAvailability.state === 'AVAILABLE'
            ? { state: 'CURRENT', targetVersion: '0.9.131' }
            : node.upgradeAvailability
      }))
    })
  );
  const pushed: string[] = [];
  let failNodeB = true;
  await page.route(/\/api\/nodes\/[^/]+\/upgrade$/, (route) => {
    const id = route.request().url().split('/').at(-2)!;
    pushed.push(id);
    if (id === 'node-b' && failNodeB)
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'NODE_OFFLINE', message: 'Node offline', requestId: 'bulk-mock-1' }
        })
      });
    return json(route, {});
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '管理', exact: true }).click();
  await page.getByRole('button', { name: '节点管理' }).click();
  const panel = page.locator('.resource-management-panel');
  await expect(panel.getByRole('cell', { name: '可升级丙' })).toHaveCount(0);
  await panel.getByPlaceholder('请输入名称或 ID').fill('可升级甲');
  await expect(panel.getByRole('cell', { name: '可升级乙' })).toHaveCount(0);
  await panel.getByRole('button', { name: '推送全部' }).click();
  const confirmation = page.getByRole('dialog', { name: '确认推送全部升级' });
  await expect(confirmation).toContainText('3 台可升级节点');
  await confirmation.getByRole('button', { name: '取消' }).click();
  expect(pushed).toEqual([]);
  await panel.getByRole('button', { name: '推送全部' }).click();
  await confirmation.getByRole('button', { name: '推送全部' }).click();
  const report = page.locator('.bulk-upgrade-result');
  await expect(report).toContainText(/已推送 2 台，失败 1 台：可升级乙/);
  await expect(report).toContainText('NODE_OFFLINE');
  await report.getByRole('button', { name: '关闭', exact: true }).click();
  expect(pushed).toEqual(['node-a', 'node-b', 'node-c']);
  failNodeB = false;
  await panel.getByRole('button', { name: '推送全部' }).click();
  await confirmation.getByRole('button', { name: '推送全部' }).click();
  await expect(page.getByText('已向 3 台节点推送升级。')).toBeVisible();
  expect(pushed).toEqual(['node-a', 'node-b', 'node-c', 'node-a', 'node-b', 'node-c']);
  upgradeable = false;
  await panel.getByRole('button', { name: '刷新' }).click();
  await expect(panel.getByRole('button', { name: '推送全部' })).toBeDisabled();
  upgradeable = true;
  canManageNodeC = false;
  pendingNodeA = true;
  await panel.getByRole('button', { name: '刷新' }).click();
  await panel.getByRole('button', { name: '推送全部' }).click();
  await expect(confirmation).toContainText('1 台可升级节点');
  await confirmation.getByRole('button', { name: '取消' }).click();
  expect(pushed).toHaveLength(6);
});

test('Workspace management neither displays nor requests workspace groups', async ({ page }) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  let groupRequests = 0;
  const resourceResponse = () => ({
    nodes: [
      {
        id: 'node-1',
        displayName: '研发节点',
        connected: true,
        disabled: false,
        ownership: { ownerType: 'PERSONAL', ownerUserId: 1 }
      }
    ],
    workspaces: [
      {
        nodeId: 'node-1',
        nodeDisplayName: '研发节点',
        workspaceId: 'workspace-1',
        displayName: '研发工作区',
        groupName: 'Platform',
        ownership: { ownerType: 'PERSONAL', ownerUserId: 1 }
      }
    ]
  });
  await page.route('**/api/resources*', (route) => json(route, resourceResponse()));
  await page.route(/\/api\/nodes$/, (route) =>
    json(route, {
      nodes: [
        {
          id: 'node-1',
          displayName: '研发节点',
          connected: true,
          disabled: false,
          registeredAddress: '127.0.0.1',
          nodeAppVersion: '0.9.63',
          upgradeAvailability: { state: 'CURRENT', targetVersion: '0.9.63' }
        }
      ]
    })
  );
  await page.route('**/api/workspace-groups', (route) => {
    groupRequests += 1;
    return route.fulfill({ status: 500 });
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '管理', exact: true }).click();
  await page.getByRole('button', { name: '工作区管理' }).click();
  await expect(page.getByRole('cell', { name: '研发工作区', exact: true })).toBeVisible();
  await expect(page.getByText('Platform', { exact: true })).toHaveCount(0);
  expect(groupRequests).toBe(0);
});

test('ADMIN can inspect other users personal resources in management while business trees stay isolated', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.unroute('**/api/auth/me');
  await page.route('**/api/auth/me', (route) =>
    json(route, {
      authenticated: true,
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
  await page.route('**/api/resources*', (route) =>
    json(route, {
      nodes: [
        {
          id: 'other-node',
          displayName: '其他用户节点',
          connected: false,
          disabled: false,
          ownership: { ownerType: 'PERSONAL', ownerUserId: 2 }
        }
      ],
      workspaces: [
        {
          nodeId: 'other-node',
          nodeDisplayName: '其他用户节点',
          workspaceId: 'other-workspace',
          displayName: '其他用户工作区',
          ownership: { ownerType: 'PERSONAL', ownerUserId: 2 }
        }
      ]
    })
  );
  await page.route('**/api/management/nodes', (route) =>
    json(route, {
      nodes: [
        {
          id: 'other-node',
          displayName: '其他用户节点',
          connected: false,
          disabled: false,
          ownerUserId: 2,
          ownerUsername: 'member',
          nodeAppVersion: '0.9.1',
          upgradeAvailability: { state: 'CURRENT', targetVersion: '0.9.1' }
        }
      ]
    })
  );
  await page.route('**/api/organizations', (route) => json(route, { organizations: [] }));
  await page.route('**/api/enterprise/users', (route) => json(route, { users: [] }));
  await page.route('**/api/workspaces?nodeId=other-node', (route) =>
    json(route, { workspaces: [{ id: 'other-workspace', path: '/workspace' }] })
  );
  await page.route('**/api/environment-secrets**', (route) => json(route, { secrets: [] }));

  await page.goto('/console');
  await expect(page.getByText('其他用户节点', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '管理', exact: true }).click();
  await page.getByRole('button', { name: '节点管理' }).click();
  await expect(page.locator('.workbench-header .breadcrumb strong')).toHaveText('节点管理');
  await expect(page.getByRole('cell', { name: '其他用户节点', exact: true })).toBeVisible();

  await page.getByRole('button', { name: '工作区管理' }).click();
  await expect(page.locator('.workbench-header .breadcrumb strong')).toHaveText('工作区管理');
  await expect(page.getByRole('cell', { name: '其他用户工作区', exact: true })).toBeVisible();
  await page.locator('.resource-management-panel .el-table__body tbody tr').first().click();
  await expect(
    page.getByRole('dialog', { name: '工作区详情' }).getByRole('button', { name: '新增环境密钥' })
  ).toBeVisible();
});

test('ADMIN enables hosting only on organization Nodes and can disable existing hosting', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.unroute('**/api/auth/me');
  await page.route('**/api/auth/me', (route) =>
    json(route, {
      authenticated: true,
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
  await page.route('**/api/resources*', (route) =>
    json(route, {
      nodes: [
        {
          id: 'personal-node',
          displayName: '个人托管节点',
          connected: true,
          disabled: false,
          ownership: { ownerType: 'PERSONAL', ownerUserId: 1 }
        },
        {
          id: 'node-1',
          displayName: '托管节点',
          connected: true,
          disabled: false,
          ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 }
        }
      ],
      page: 1,
      pageSize: 20,
      total: 2,
      hasMore: false,
      workspaces: []
    })
  );
  await page.route('**/api/management/nodes', (route) =>
    json(route, {
      nodes: [
        {
          id: 'personal-node',
          displayName: '个人托管节点',
          connected: true,
          disabled: false,
          ownerUserId: 1,
          ownerUsername: 'admin',
          platform: 'linux',
          architecture: 'x64',
          nodeAppVersion: '0.9.37',
          nodeVersion: process.version,
          capabilities: {
            marAgent: { available: true, version: '0.9.37' },
            conversationHosting: {
              state: 'DISABLED',
              apiVersion: 1,
              acceptsNewConversations: false,
              supportsExistingConversations: false,
              capacity: 'AVAILABLE'
            },
            computerUse: {
              apiVersion: 1,
              enabled: false,
              state: 'DISABLED',
              backend: 'PYAUTOGUI',
              supportsScreenshot: false,
              supportsInput: false,
              supportsUnicodePaste: false,
              supportsPrimaryDisplay: false,
              measuredAt: 1_788_304_800_000
            }
          },
          upgradeAvailability: { state: 'CURRENT', targetVersion: '0.9.37' }
        },
        {
          id: 'node-1',
          displayName: '托管节点',
          connected: true,
          disabled: false,
          ownerUserId: 1,
          ownerUsername: 'admin',
          platform: 'linux',
          architecture: 'x64',
          nodeAppVersion: '0.9.37',
          nodeVersion: process.version,
          capabilities: {
            marAgent: { available: true, version: '0.9.37' },
            conversationHosting: {
              state: 'DISABLED',
              apiVersion: 1,
              acceptsNewConversations: false,
              supportsExistingConversations: false,
              capacity: 'AVAILABLE'
            },
            computerUse: {
              apiVersion: 1,
              enabled: false,
              state: 'DISABLED',
              backend: 'PYAUTOGUI',
              supportsScreenshot: false,
              supportsInput: false,
              supportsUnicodePaste: false,
              supportsPrimaryDisplay: false,
              measuredAt: 1_788_304_800_000
            }
          },
          upgradeAvailability: { state: 'CURRENT', targetVersion: '0.9.37' }
        }
      ]
    })
  );
  await page.route('**/api/organizations', (route) =>
    json(route, {
      organizations: [{ id: 1, name: '根组织', parentOrganizationId: null, depth: 0, path: [1] }]
    })
  );
  await page.route(/\/api\/enterprise\/users(?:\?.*)?$/, (route) =>
    json(route, { users: [], page: 1, pageSize: 20, total: 0, hasMore: false })
  );
  await page.route('**/api/runner-usage/status?nodeId=node-1', (route) =>
    json(route, { statuses: [] })
  );
  await page.route('**/api/runner-usage/status?nodeId=personal-node', (route) =>
    json(route, { statuses: [] })
  );
  await page.route('**/api/environment-secrets**', (route) => json(route, { secrets: [] }));
  let hostingCapability:
    | {
        readonly state: 'DISABLED';
        readonly apiVersion: 1;
        readonly acceptsNewConversations: false;
        readonly supportsExistingConversations: false;
        readonly capacity: 'AVAILABLE';
      }
    | {
        readonly state: 'AVAILABLE';
        readonly apiVersion: 1;
        readonly sandboxBackend: 'BUBBLEWRAP';
        readonly sandboxPolicyVersion: 1;
        readonly acceptsNewConversations: true;
        readonly supportsExistingConversations: true;
        readonly capacity: 'AVAILABLE';
      } = {
    state: 'DISABLED',
    apiVersion: 1,
    acceptsNewConversations: false,
    supportsExistingConversations: false,
    capacity: 'AVAILABLE'
  };
  let computerUseCapability: {
    apiVersion: 1;
    enabled: boolean;
    state: 'DISABLED' | 'INITIALIZING';
    backend: 'PYAUTOGUI';
    supportsScreenshot: boolean;
    supportsInput: boolean;
    supportsUnicodePaste: boolean;
    supportsPrimaryDisplay: boolean;
    measuredAt: number;
  } = {
    apiVersion: 1,
    enabled: false,
    state: 'DISABLED',
    backend: 'PYAUTOGUI',
    supportsScreenshot: false,
    supportsInput: false,
    supportsUnicodePaste: false,
    supportsPrimaryDisplay: false,
    measuredAt: 1_788_304_800_000
  };
  let nodeDirectoryRequests = 0;
  await page.route('**/api/nodes', (route) => {
    nodeDirectoryRequests += 1;
    return json(route, {
      nodes: [
        {
          id: 'node-1',
          displayName: '托管节点',
          registeredAddress: '127.0.0.1',
          platform: 'linux',
          architecture: 'x64',
          nodeAppVersion: '0.9.37',
          nodeVersion: process.version,
          connected: true,
          disabled: false,
          manageable: true,
          ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 },
          capabilities: {
            marAgent: { available: true, version: '0.9.37' },
            conversationHosting: hostingCapability,
            computerUse: computerUseCapability
          }
        }
      ]
    });
  });
  const enableRequests: Array<{ readonly csrf: string | undefined; readonly body: string }> = [];
  await page.route('**/api/management/nodes/node-1/conversation-hosting/enable', (route) => {
    enableRequests.push({
      csrf: route.request().headers()['x-csrf-token'],
      body: route.request().postData() ?? ''
    });
    hostingCapability = {
      state: 'AVAILABLE',
      apiVersion: 1,
      sandboxBackend: 'BUBBLEWRAP',
      sandboxPolicyVersion: 1,
      acceptsNewConversations: true,
      supportsExistingConversations: true,
      capacity: 'AVAILABLE'
    };
    return json(route, {
      capability: hostingCapability
    });
  });
  const disableRequests: Array<{ readonly csrf: string | undefined; readonly body: string }> = [];
  await page.route('**/api/management/nodes/node-1/conversation-hosting/disable', (route) => {
    disableRequests.push({
      csrf: route.request().headers()['x-csrf-token'],
      body: route.request().postData() ?? ''
    });
    hostingCapability = {
      state: 'DISABLED',
      apiVersion: 1,
      acceptsNewConversations: false,
      supportsExistingConversations: false,
      capacity: 'AVAILABLE'
    };
    return json(route, {
      capability: hostingCapability
    });
  });
  const computerUseEnableRequests: Array<{
    readonly csrf: string | undefined;
    readonly body: string;
  }> = [];
  await page.route('**/api/management/nodes/node-1/computer-use/enable', (route) => {
    computerUseEnableRequests.push({
      csrf: route.request().headers()['x-csrf-token'],
      body: route.request().postData() ?? ''
    });
    computerUseCapability = {
      ...computerUseCapability,
      enabled: true,
      state: 'INITIALIZING',
      measuredAt: 1_788_304_801_000
    };
    return json(route, { capability: computerUseCapability });
  });
  await page.route('**/api/management/nodes/node-1/conversation-hosting/storage', (route) =>
    json(route, {
      storage: {
        hostedStorageUsedBytes: 0,
        filesystemTotalBytes: 100_000,
        filesystemAvailableBytes: 100_000,
        filesystemUsageBasisPoints: 0,
        capacity: 'AVAILABLE',
        acceptsNewConversations: true,
        automaticCleanupInactiveDays: 60,
        measuredAt: 1_788_304_800_000
      }
    })
  );

  await page.goto('/console');
  await expect.poll(() => nodeDirectoryRequests).toBeGreaterThanOrEqual(1);
  await page.getByRole('button', { name: '管理', exact: true }).click();
  await page.getByRole('button', { name: '节点管理' }).click();
  await page.getByRole('cell', { name: '个人托管节点', exact: true }).click();
  const personalDetails = page.getByRole('dialog', { name: '节点详情' });
  await expect(
    personalDetails.getByRole('button', { name: '启用托管对话', exact: true })
  ).toHaveCount(0);
  await expect(personalDetails.getByText('托管对话', { exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(personalDetails).toHaveCount(0);

  await page.getByRole('cell', { name: '托管节点', exact: true }).click();
  const details = page.getByRole('dialog', { name: '节点详情' });
  const enable = details.getByRole('button', { name: '启用托管对话', exact: true });
  await expect(enable).toBeEnabled();
  await expect(enable).toHaveClass(/el-button--primary/);
  await expect(enable.locator('.el-icon')).toHaveCount(1);
  await expect(
    details.locator('.mar-detail-descriptions').getByRole('button', { name: '启用托管对话' })
  ).toHaveCount(1);
  const computerUseSwitch = details.locator('.computer-use-control .el-switch');
  await expect(computerUseSwitch).toHaveCount(1);
  await expect(details.getByText('GUI 支持未启用', { exact: true })).toBeVisible();
  await computerUseSwitch.click();
  await expect.poll(() => computerUseEnableRequests.length).toBe(1);
  expect(computerUseEnableRequests).toEqual([
    { csrf: 'csrf-1', body: JSON.stringify({ enabled: true }) }
  ]);
  await expect(details.getByText('正在初始化和探测', { exact: true })).toBeVisible();
  await expect(details.locator('.hosting-maintenance-card')).toHaveCount(0);

  await enable.click();
  const confirmation = page.getByRole('dialog').filter({ hasText: '启用托管对话？' });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  expect(enableRequests).toHaveLength(0);

  await enable.click();
  await confirmation.getByRole('button', { name: '启用托管对话', exact: true }).click();

  await expect.poll(() => enableRequests.length).toBe(1);
  expect(enableRequests).toEqual([
    {
      csrf: 'csrf-1',
      body: JSON.stringify({ enabled: true })
    }
  ]);
  await expect.poll(() => nodeDirectoryRequests).toBeGreaterThanOrEqual(2);
  const disable = details.getByRole('button', { name: '禁用托管对话', exact: true });
  await expect(disable).toBeEnabled();
  await expect(disable).toHaveClass(/el-button--warning/);
  await expect(
    details.locator('.mar-detail-descriptions').getByRole('button', { name: '禁用托管对话' })
  ).toHaveCount(1);
  await expect(disable).not.toHaveClass(/el-button--primary/);
  await expect(disable.locator('.el-icon')).toHaveCount(1);
  await expect(page.getByText('托管对话已启用。', { exact: true })).toBeVisible();
  const maintenanceCard = details.locator('.hosting-maintenance-card');
  await expect(maintenanceCard.getByRole('heading', { name: '对话存储维护' })).toBeVisible();
  const baseRadius = await details.evaluate((element) =>
    getComputedStyle(element).getPropertyValue('--el-border-radius-base').trim()
  );
  expect(baseRadius).not.toBe('');
  await expect(maintenanceCard).toHaveCSS('border-radius', baseRadius);
  await expect(maintenanceCard.locator('.capacity-readout')).toHaveCSS('border-radius', baseRadius);
  await expect(maintenanceCard.locator('.storage-facts')).toHaveCSS('border-radius', baseRadius);

  await disable.click();
  const disableConfirmation = page.getByRole('dialog').filter({ hasText: '禁用托管对话？' });
  await expect(disableConfirmation).toBeVisible();
  await disableConfirmation.getByRole('button', { name: '取消', exact: true }).click();
  expect(disableRequests).toHaveLength(0);

  await disable.click();
  await disableConfirmation.getByRole('button', { name: '禁用托管对话', exact: true }).click();
  await expect.poll(() => disableRequests.length).toBe(1);
  expect(disableRequests).toEqual([{ csrf: 'csrf-1', body: '{}' }]);
  await expect.poll(() => nodeDirectoryRequests).toBeGreaterThanOrEqual(3);
  await expect(details.getByRole('button', { name: '启用托管对话', exact: true })).toBeEnabled();
  await expect(maintenanceCard).toHaveCount(0);
});

test('Node environment secrets use default controls, compact layout, and plain-text display', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await mockPersonalResources(page);
  await page.route('**/api/resources?*', (route) =>
    json(route, {
      nodes: [
        {
          id: 'node-1',
          displayName: '研发节点',
          connected: true,
          disabled: false,
          ownership: { ownerType: 'PERSONAL', ownerUserId: 1 }
        }
      ],
      workspaces: [],
      page: 1,
      pageSize: 20,
      total: 1,
      hasMore: false
    })
  );
  await page.route('**/api/runner-usage/status?nodeId=node-1', (route) =>
    json(route, { statuses: [] })
  );
  await page.route('**/api/environment-secrets**', (route) =>
    json(route, {
      secrets: [
        {
          id: 'secret-1',
          scope: 'NODE',
          name: 'API_TOKEN',
          value: 'visible-secret',
          nodeId: 'node-1',
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台', exact: true }).click();
  await page.getByRole('button', { name: '管理', exact: true }).click();
  await page.getByRole('button', { name: '节点管理' }).click();
  await page.getByRole('cell', { name: '研发节点', exact: true }).click();
  const details = page.getByRole('dialog', { name: '节点详情' });
  const spacing = await details.evaluate((element) => {
    const descriptions = element.querySelector('.el-descriptions')!.getBoundingClientRect();
    const secrets = element.querySelector('.node-secret-manager')!.getBoundingClientRect();
    return Math.round(secrets.top - descriptions.bottom);
  });
  expect(spacing).toBeGreaterThanOrEqual(10);
  expect(spacing).toBeLessThanOrEqual(16);
  const secretTable = details.locator('.secret-table');
  await expect(secretTable).toBeVisible();
  await expect(secretTable).toHaveClass(/el-table/);
  await expect(secretTable).not.toHaveClass(/el-table--small/);
  await expect(secretTable.locator('.el-table__header-wrapper th')).toHaveText([
    '环境变量名',
    '密钥值',
    '范围',
    '操作'
  ]);
  await expect(secretTable.locator('.caret-wrapper')).toHaveCount(3);
  await secretTable
    .locator('.el-table__header-wrapper th')
    .filter({ hasText: '环境变量名' })
    .click();
  await expect(details).toContainText('visible-secret');
  await expect(details.getByRole('button', { name: '删除', exact: true })).toBeDisabled();
  await expect(details.getByRole('button', { name: '更新' })).toBeDisabled();
  expect(writes.some((entry) => entry.url.includes('/api/environment-secrets/'))).toBe(false);
});

test('Enterprise management exposes role-based sections and disables writes when frozen', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await mockPersonalResources(page);
  await page.route('**/api/auth/me', (route) =>
    json(route, {
      authenticated: true,
      mustChangePassword: false,
      username: 'admin',
      isAdmin: true,
      edition: 'ENTERPRISE',
      licenseState: 'ENTERPRISE_FROZEN',
      role: 'ADMIN',
      organizationId: 1,
      managementWritable: false
    })
  );
  await page.route('**/api/license', (route) =>
    json(route, {
      edition: 'ENTERPRISE',
      state: 'ENTERPRISE_FROZEN',
      reason: 'LICENSE_EXPIRED',
      licenseId: 'license-1',
      enterpriseName: '示例企业',
      expiresAt: 253_402_300_799_000,
      managementWritable: false
    })
  );
  await page.route('**/api/license/request-code', (route) =>
    json(route, { requestCode: 'MAR1.random-license-request.checksum' })
  );
  await page.route('**/api/organizations', (route) =>
    json(route, {
      organizations: [
        { id: 1, name: '企业根', parentOrganizationId: null, createdAt: 1, updatedAt: 1 }
      ]
    })
  );
  await page.route(/\/api\/enterprise\/users(?:\?.*)?$/, (route) =>
    json(route, {
      users: [
        {
          id: 2,
          username: 'member',
          email: null,
          nickname: null,
          role: 'MEMBER',
          organizationId: 1,
          fixedAdmin: false,
          enabled: true
        }
      ],
      page: 1,
      pageSize: 20,
      total: 1,
      hasMore: false
    })
  );
  await page.route('**/api/oauth-providers', (route) => json(route, { providers: [] }));
  const auditFixture: { events: Record<string, unknown>[] } = {
    events: [
      {
        id: 'audit-1',
        eventType: 'organization.deleted',
        occurredAt: 1_787_300_000_000,
        result: 'DENIED',
        errorCode: 'RBAC_DENIED',
        actorUserId: 1,
        actorUsername: 'admin',
        authenticationMethod: 'PASSWORD',
        providerId: null,
        requestId: 'request-1',
        operationId: 'operation-1',
        targetType: 'ORGANIZATION',
        targetId: '2',
        organizationId: 2,
        nodeId: null,
        workspaceId: null,
        agentSessionId: null,
        runId: null,
        clientMessageId: null,
        inputMode: null,
        targetName: 'Audit target team',
        metadata: { action: 'DELETE', before: { name: 'Audit target team' } }
      },
      {
        id: 'audit-2',
        eventType: 'session.command.execute',
        occurredAt: 1_787_299_000_000,
        result: 'SUCCESS',
        errorCode: null,
        actorUserId: 1,
        actorUsername: 'admin',
        authenticationMethod: 'PASSWORD',
        providerId: null,
        requestId: 'request-2',
        operationId: 'operation-2',
        targetType: null,
        targetId: null,
        organizationId: null,
        nodeId: 'node-1',
        workspaceId: null,
        agentSessionId: null,
        runId: null,
        clientMessageId: null,
        inputMode: null,
        metadata: { action: 'session.command.execute' }
      },
      {
        id: 'audit-3',
        eventType: 'operation',
        occurredAt: 1_787_298_000_000,
        result: 'SUCCESS',
        errorCode: null,
        actorUserId: 1,
        actorUsername: 'admin',
        authenticationMethod: 'PASSWORD',
        providerId: null,
        requestId: 'request-3',
        operationId: 'operation-3',
        targetType: null,
        targetId: null,
        organizationId: null,
        nodeId: null,
        workspaceId: null,
        agentSessionId: null,
        runId: null,
        clientMessageId: null,
        inputMode: null,
        metadata: { action: 'PATCH /api/future-domain/:id' }
      }
    ]
  };
  auditFixture.events.push(
    {
      ...auditFixture.events[0],
      id: 'audit-4',
      eventType: 'image_model.created',
      result: 'SUCCESS',
      errorCode: null,
      targetType: 'IMAGE_MODEL',
      targetName: 'Team image model',
      metadata: {}
    },
    {
      ...auditFixture.events[0],
      id: 'audit-5',
      eventType: 'system_setting.updated',
      result: 'SUCCESS',
      errorCode: null,
      targetType: 'SYSTEM_SETTING',
      targetName: 'SMTP settings',
      metadata: {}
    },
    {
      ...auditFixture.events[0],
      id: 'audit-6',
      eventType: 'user.updated',
      result: 'SUCCESS',
      errorCode: null,
      targetType: 'USER',
      targetName: 'Membership change',
      metadata: { before: { role: 'MEMBER' }, after: { role: 'ORG_ADMIN' } }
    }
  );
  const namedTime = await page.evaluate(() => new Date(2026, 9, 11, 19, 41, 4).getTime());
  const midnight = await page.evaluate(() => new Date(2026, 9, 11, 0, 0, 0).getTime());
  auditFixture.events.push(
    {
      ...auditFixture.events[0],
      id: 'audit-7',
      eventType: 'shared_conversation_input_accepted',
      occurredAt: namedTime,
      result: 'SUCCESS',
      errorCode: null,
      targetType: 'SESSION',
      targetId: 'session-named',
      targetName: 'Named audit session',
      nodeId: 'node-named',
      workspaceId: 'workspace-named',
      agentSessionId: 'session-named',
      metadata: {
        nodeName: 'Build host',
        workspaceName: 'Document project',
        sessionName: 'Named audit session',
        organizationName: 'Audit team'
      }
    },
    {
      ...auditFixture.events[0],
      id: 'audit-8',
      eventType: 'node_display_name_updated',
      occurredAt: midnight,
      result: 'SUCCESS',
      errorCode: null,
      targetType: 'NODE',
      targetId: 'node-renamed',
      nodeId: 'node-renamed',
      targetName: 'Historical Node',
      metadata: { nodeName: 'Historical Node', organizationName: 'Audit team' }
    }
  );
  await page.route('**/api/audit-events/audit-7', (route) => json(route, auditFixture.events[6]));
  await page.route('**/api/audit-events?*', (route) =>
    json(route, {
      ...auditFixture,
      page: 1,
      pageSize: 20,
      total: auditFixture.events.length,
      hasMore: false
    })
  );
  await page.route('**/api/audit-events/audit-1', (route) => json(route, auditFixture.events[0]));
  await page.route('**/api/audit-events/audit-6', (route) => json(route, auditFixture.events[5]));
  await page.route('**/api/system-settings', (route) =>
    json(route, { auditRetentionDays: 180, skillTlsVerificationDisabled: false })
  );
  await page.route('**/api/resources*', (route) => json(route, { nodes: [], workspaces: [] }));
  await page.route('**/api/management/nodes', (route) => json(route, { nodes: [] }));
  await page.route('**/api/environment-secrets', (route) => json(route, { secrets: [] }));

  await page.goto('/console');
  await page.getByRole('button', { name: '管理', exact: true }).click();
  await expect(page.getByText(/企业 License 已冻结/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'License', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '系统信息' }).click();
  await expect(page.getByLabel('MyAgentRoam 版本')).toContainText('MyAgentRoam');
  await expect(page.locator('.system-brand img')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'License 授权' })).toBeVisible();
  await expect(page.getByText('企业版', { exact: true })).toBeVisible();
  await expect(page.locator('.license-version .el-tag')).toHaveText('过期');
  await expect(page.getByText('主机指纹')).toHaveCount(0);
  await expect(page.locator('.license-code-input input')).toHaveValue(
    'MAR1.random-license-request.checksum'
  );
  await expect(page.getByText('永久有效')).toBeVisible();
  await expect(page.getByRole('button', { name: '复制 License 申请码' })).toBeEnabled();
  await expect(page.locator('.license-code-input')).toHaveClass(/el-input-group/);
  await expect(page.getByRole('button', { name: '组织管理' })).toBeVisible();
  await expect(page.getByRole('button', { name: '用户管理' })).toBeVisible();
  await expect(page.getByRole('button', { name: '节点管理' })).toBeVisible();
  await expect(page.getByRole('button', { name: '工作区管理' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'OAuth 配置' })).toBeVisible();
  await expect(page.getByRole('button', { name: '操作审计' })).toBeVisible();
  await expect(page.getByRole('button', { name: '系统配置' })).toBeVisible();
  await expect(page.getByRole('button', { name: '环境密钥管理' })).toBeVisible();
  await page.getByRole('button', { name: '环境密钥管理' }).click();
  await expect(page.locator('.workbench-header .breadcrumb strong')).toHaveText('环境密钥管理');
  await expect(page.getByRole('button', { name: '新增环境密钥' })).toHaveCount(0);

  await page.getByRole('button', { name: 'OAuth 配置' }).click();
  await expect(page.getByRole('button', { name: '添加来源' })).toBeDisabled();
  expect(
    await page
      .locator('.oauth-management')
      .getByRole('columnheader', { name: '操作' })
      .evaluate((element) => Math.round(element.getBoundingClientRect().width))
  ).toBeGreaterThanOrEqual(300);

  await page.getByRole('button', { name: '组织管理' }).click();
  await expect(page.getByRole('columnheader', { name: '组织名称' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '组织 ID' })).toBeVisible();
  await expect(page.getByRole('button', { name: '编辑', exact: true }).first()).toBeDisabled();
  await expect(page.getByRole('button', { name: '新增下级' }).first()).toBeDisabled();
  await page.getByRole('button', { name: '用户管理' }).click();
  await expect(page.getByRole('button', { name: '用户管理' })).toHaveCSS('border-radius', '6px');
  await expect(page.getByRole('button', { name: '创建用户' })).toBeDisabled();
  await expect(page.locator('.el-table').getByText('成员', { exact: true })).toBeVisible();
  await expect(page.locator('.mar-management-page .el-table')).toHaveCSS('font-size', '14px');
  await expect(page.locator('.mar-management-page .el-table')).not.toHaveClass(/el-table--small/);
  await expect(page.locator('.mar-row-actions').first()).toHaveCSS('white-space', 'nowrap');
  await expect(page.getByRole('button', { name: '重置密码' })).toHaveCSS('font-size', '14px');
  await expect(page.getByRole('combobox')).toHaveCount(2);
  await expect(page.getByPlaceholder('请输入用户、邮箱或显示名称')).not.toHaveClass(
    /el-input--small/
  );
  await expect(page.getByPlaceholder('请选择组织')).toBeVisible();
  await expect(page.getByRole('button', { name: '重置密码' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '删除', exact: true })).toBeDisabled();

  await page.getByRole('button', { name: '节点管理' }).click();
  await expect(page.getByPlaceholder('请输入名称或 ID')).toBeVisible();
  await expect(page.locator('.mar-resource-filters').getByRole('combobox')).toHaveCount(2);
  await expect(page.getByRole('combobox', { name: /状态/ })).toBeVisible();
  await expect(page.getByText('暂无数据', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '操作审计' }).click();
  await expect(page.getByText('组织: 删除', { exact: true })).toBeVisible();
  await expect(page.getByText('Session: 执行命令', { exact: true })).toBeVisible();
  await expect(page.getByText('其他: 历史操作', { exact: true })).toBeVisible();
  await expect(page.getByText('图片模型: 创建', { exact: true })).toBeVisible();
  await expect(page.getByText('系统配置: 修改', { exact: true })).toBeVisible();
  await expect(page.getByText('POST /api/runner-commands', { exact: true })).toHaveCount(0);
  await expect(page.getByText('PATCH /api/future-domain/:id', { exact: true })).toHaveCount(0);
  await expect(page.getByText('已拒绝', { exact: true })).toBeVisible();
  const auditTable = page.locator('.audit-management .el-table');
  await expect(auditTable.getByRole('columnheader', { name: '错误' })).toHaveCount(0);
  await expect(auditTable.getByRole('columnheader', { name: '操作', exact: true })).toHaveCount(0);
  const auditRow = auditTable.locator('.el-table__row').filter({ hasText: '已拒绝' });
  await expect(auditRow.getByRole('button', { name: '查看', exact: true })).toHaveCount(0);
  await auditRow.click();
  const auditDetails = page.getByRole('dialog', { name: /^(审计详情|Audit Details)$/ });
  await expect(auditDetails).toContainText('权限不足');
  await expect(auditDetails.getByText('请求 ID', { exact: true })).toBeVisible();
  await expect(
    auditDetails.locator('.el-descriptions__label').getByText('组织', { exact: true })
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(auditDetails).toBeHidden();
  await auditTable.locator('.el-table__row').filter({ hasText: 'Membership change' }).click();
  await expect(auditDetails).toContainText('角色');
  await expect(auditDetails).toContainText('成员');
  await expect(auditDetails).toContainText('组织管理员');
  await page.evaluate(() =>
    window.dispatchEvent(new StorageEvent('storage', { key: 'mar.locale.v2', newValue: 'en-US' }))
  );
  await expect(page.getByText('Image model: Create', { exact: true })).toBeVisible();
  await expect(page.getByText('System setting: Update', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('Organization administrator');
  await expect(page.getByRole('dialog')).toContainText('Member');
  expect(
    await page
      .getByRole('dialog')
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
  ).toBe(true);
  await page.evaluate(() =>
    window.dispatchEvent(new StorageEvent('storage', { key: 'mar.locale.v2', newValue: 'zh-CN' }))
  );
  await expect(auditDetails).toContainText('组织管理员');
  await page.keyboard.press('Escape');
  await expect(auditDetails).toBeHidden();

  await auditTable.locator('.el-table__row').filter({ hasText: 'Named audit session' }).click();
  await expect(auditDetails).toContainText('Session: 发送消息');
  await expect(auditDetails).toContainText('19:41:04');
  for (const text of [
    'Build host / node-named',
    'Document project / workspace-named',
    'Named audit session / session-named',
    'Audit team / 2',
    'admin / 1'
  ])
    await expect(auditDetails.getByText(text, { exact: true }).first()).toBeVisible();
  await expect(
    auditDetails.locator('.el-descriptions__label').getByText('Node', { exact: true })
  ).toBeVisible();
  await expect(
    auditDetails.locator('.el-descriptions__label').getByText('Workspace', { exact: true })
  ).toBeVisible();
  await expect(
    auditDetails.locator('.el-descriptions__label').getByText('Session', { exact: true })
  ).toBeVisible();
  await expect(auditDetails.getByText('节点 ID', { exact: true })).toHaveCount(0);
  await page.evaluate(() =>
    window.dispatchEvent(new StorageEvent('storage', { key: 'mar.locale.v2', newValue: 'en-US' }))
  );
  await expect(auditDetails).toContainText('Session: Send message');
  await expect(auditDetails).toContainText('19:41:04');
  await expect(auditDetails).not.toContainText(/\b(?:AM|PM)\b/);
  await expect(
    auditTable.locator('.el-table__row').filter({ hasText: 'Historical Node' })
  ).toContainText('Node: Rename');
  await expect(
    auditTable.locator('.el-table__row').filter({ hasText: 'Historical Node' })
  ).toContainText('00:00:00');
  await page.keyboard.press('Escape');
  await page.evaluate(() =>
    window.dispatchEvent(new StorageEvent('storage', { key: 'mar.locale.v2', newValue: 'zh-CN' }))
  );

  await page.getByRole('button', { name: '系统配置' }).click();
  const frozenSettingNames = [
    '审计保留天数',
    '使用资源 URL',
    '邮件SMTP配置',
    'Web Push 离线推送',
    'HTML 预览域名',
    '关闭 Skill 回源 TLS 证书校验'
  ];
  await expect(page.getByRole('button', { name: '编辑' })).toHaveCount(frozenSettingNames.length);
  for (const name of frozenSettingNames) {
    const row = page
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name, exact: true }) });
    await expect(row.getByRole('button', { name: '编辑', exact: true })).toBeDisabled();
  }
  await expect(page.getByRole('button', { name: '保存' })).toHaveCount(0);
});

for (const locale of ['zh-CN', 'en-US'] as const) {
  test(`System configuration omits deployment keys and never requests the retired API (${locale})`, async ({
    page
  }) => {
    await page.addInitScript((value) => localStorage.setItem('mar.locale.v2', value), locale);
    await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
    await mockPersonalResources(page);
    const admin = {
      authenticated: true,
      mustChangePassword: false,
      username: 'admin',
      isAdmin: true,
      edition: 'COMMUNITY',
      licenseState: 'COMMUNITY',
      role: 'ADMIN',
      organizationId: null,
      managementWritable: true,
      csrfToken: 'csrf-1'
    };
    let authenticated = false;
    await page.route('**/api/auth/me', (route) =>
      json(route, authenticated ? admin : { authenticated: false, mustChangePassword: false })
    );
    await page.route('**/api/auth/login', (route) => {
      authenticated = true;
      return json(route, admin);
    });
    let settingsRequests = 0;
    await page.route('**/api/system-settings', (route) => {
      settingsRequests += 1;
      return json(route, {
        skillTlsVerificationDisabled: false,
        htmlPreviewOrigin: '',
        smtpConfiguration: '{}'
      });
    });
    const retiredRequests: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/system-settings/management-key')
        retiredRequests.push(request.method());
    });
    const text =
      locale === 'zh-CN'
        ? {
            login: '进入控制台',
            admin: '管理',
            settings: '系统配置',
            refresh: '刷新',
            smtp: '邮件SMTP配置',
            key: '运维管理密钥'
          }
        : {
            login: 'Open console',
            admin: 'Admin',
            settings: 'System Configuration',
            refresh: 'Refresh',
            smtp: 'Email SMTP configuration',
            key: 'Operations management key'
          };
    await page.goto('/console');
    await page.getByRole('button', { name: text.login }).click();
    await page.getByRole('button', { name: text.admin, exact: true }).click();
    await page.getByRole('button', { name: text.settings }).click();
    await expect(page.locator('.el-table__row').filter({ hasText: text.smtp })).toBeVisible();
    await expect(page.getByText(text.key, { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: text.refresh, exact: true }).click();
    await expect.poll(() => settingsRequests).toBe(2);
    await expect(page.locator('.el-loading-mask')).toHaveCount(0);
    expect(retiredRequests).toEqual([]);
  });
}

test('System settings consistently edit before saving and reuse snapshot APIs and feedback', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  const settings = { auditRetentionDays: 180, skillTlsVerificationDisabled: false };
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await mockPersonalResources(page);
  let authenticated = false;
  const admin = {
    authenticated: true,
    mustChangePassword: false,
    username: 'admin',
    isAdmin: true,
    edition: 'COMMUNITY' as const,
    licenseState: 'COMMUNITY' as const,
    role: 'ADMIN' as const,
    organizationId: null,
    managementWritable: true,
    csrfToken: 'csrf-1'
  };
  await page.unroute('**/api/auth/me');
  await page.route('**/api/auth/me', (route) =>
    json(route, authenticated ? admin : { authenticated: false, mustChangePassword: false })
  );
  await page.unroute('**/api/auth/login');
  await page.route('**/api/auth/login', (route) => {
    authenticated = true;
    return json(route, admin);
  });
  await page.route('**/api/system-settings', (route) => json(route, { ...settings }));
  await page.route('**/api/system-settings/*', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (path.endsWith('/audit-retention')) settings.auditRetentionDays = Number(body.days);
    if (path.endsWith('/skill-tls'))
      settings.skillTlsVerificationDisabled = Boolean(body.verificationDisabled);
    await write(route, writes, { ...settings });
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '管理', exact: true }).click();
  await page.getByRole('button', { name: '系统配置' }).click();

  const auditRow = page.locator('.el-table__row').filter({ hasText: '审计保留天数' });
  const tlsRow = page.locator('.el-table__row').filter({ hasText: '关闭 Skill 回源 TLS 证书校验' });
  // Deployment settings are a complete configuration catalog, not a paged query.
  await expect(page.locator('.management-pagination .el-pagination')).toHaveCount(0);
  await expect(auditRow.getByRole('spinbutton')).toHaveCount(0);
  await expect(tlsRow.getByRole('switch')).toBeDisabled();

  await auditRow.getByRole('button', { name: '编辑' }).click();
  await expect(auditRow.getByRole('spinbutton')).toBeVisible();
  await auditRow.getByRole('spinbutton').fill('365');
  await auditRow.getByRole('button', { name: '取消' }).click();
  await expect(auditRow.getByRole('spinbutton')).toHaveCount(0);
  await expect(auditRow.getByText('180', { exact: true })).toBeVisible();

  await auditRow.getByRole('button', { name: '编辑' }).click();
  await auditRow.getByRole('spinbutton').fill('365');
  await auditRow.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('系统配置已保存')).toBeVisible();
  await expect(auditRow.getByText('365', { exact: true })).toBeVisible();

  await tlsRow.getByRole('button', { name: '编辑' }).click();
  await expect(tlsRow.getByRole('switch')).toBeEnabled();
  await tlsRow.locator('.el-switch').click();
  await tlsRow.getByRole('button', { name: '取消' }).click();
  await expect(tlsRow.getByRole('switch')).toBeDisabled();
  await expect(tlsRow.getByRole('switch')).toHaveAttribute('aria-checked', 'false');

  await tlsRow.getByRole('button', { name: '编辑' }).click();
  await tlsRow.locator('.el-switch').click();
  await tlsRow.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('系统配置已保存').last()).toBeVisible();
  await expect(tlsRow.getByRole('switch')).toBeDisabled();
  await expect(tlsRow.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  await expect(tlsRow.getByText(/默认关闭此开关/u)).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Skill 回源 TLS' })).toHaveCount(0);

  expect(writes.filter((entry) => entry.url.includes('/api/system-settings/'))).toEqual([
    expect.objectContaining({
      url: expect.stringContaining('/api/system-settings/audit-retention'),
      body: JSON.stringify({ days: 365 })
    }),
    expect.objectContaining({
      url: expect.stringContaining('/api/system-settings/skill-tls'),
      body: JSON.stringify({ verificationDisabled: true })
    })
  ]);
});

test('Node details enable Usage only for official OAuth Runners and show normalized quota windows', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await mockPersonalResources(page);
  await page.route('**/api/runner-usage/status?nodeId=node-1', (route) =>
    json(route, {
      statuses: [
        { runner: 'codex', available: true, reasonCode: null },
        { runner: 'claude-code', available: false, reasonCode: 'OFFICIAL_OAUTH_REQUIRED' }
      ]
    })
  );
  await page.route('**/api/runner-usage?nodeId=node-1&runner=codex', (route) =>
    json(route, {
      usage: {
        runner: 'codex',
        windows: [
          { id: 'primary_window', label: '5 小时额度', usedPercentage: 42, resetsAt: null },
          { id: 'secondary_window', label: '7 天额度', usedPercentage: 71, resetsAt: null }
        ],
        fetchedAt: 1_785_000_000_000,
        cached: false
      }
    })
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '管理', exact: true }).click();
  await page.getByRole('button', { name: '节点管理' }).click();
  await page.locator('.resource-management-panel .el-table__body tbody tr').first().click();
  const details = page.getByRole('dialog', { name: '节点详情' });
  const usageButtons = details.getByRole('button', { name: '用量' });
  await expect(usageButtons).toHaveCount(2);
  await expect(usageButtons.nth(0)).toBeEnabled();
  await expect(usageButtons.nth(1)).toBeDisabled();
  await usageButtons.nth(0).click();
  const usage = page.getByRole('dialog', { name: 'Codex 用量' });
  await expect(usage.getByText('5 小时额度', { exact: true })).toBeVisible();
  await expect(usage.getByText('7 天额度', { exact: true })).toBeVisible();
  await expect(usage).toContainText('42%');
  await expect(usage).toContainText('71%');
  await expect(usage).not.toContainText('缓存');
  await usage.getByRole('button', { name: '关闭', exact: true }).click();
});

test('Mobile detail lists use shared layout and constrain long content overflow', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await mockPersonalResources(page);
  const claudeAgentTitle =
    'Claude Code · 2.1.150 (Claude Code desktop integration build 2026.08.30)';
  await page.route('**/api/nodes', (route) =>
    json(route, {
      nodes: [
        {
          id: 'node-1',
          platform: 'linux',
          architecture: 'x64',
          nodeAppVersion: '0.9.22',
          nodeVersion: 'v24.15.0',
          connected: true,
          disabled: false,
          capabilities: {
            codex: { available: true, version: '0.146' },
            claudeCode: {
              available: true,
              version: '2.1.150 (Claude Code desktop integration build 2026.08.30)'
            }
          }
        }
      ]
    })
  );
  await page.route('**/api/runner-usage/status?nodeId=node-1', (route) =>
    json(route, { statuses: [] })
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '管理', exact: true }).click();
  await page.getByRole('button', { name: '节点管理' }).click({ force: true });
  await page.setViewportSize({ width: 390, height: 720 });
  await page.locator('.resource-management-panel .el-table__body tbody tr').first().click();

  const details = page.getByRole('dialog', { name: '节点详情' });
  const descriptions = details.locator('.mar-detail-descriptions');
  const claudeAgent = details.locator('.supported-agent-label').filter({ hasText: 'Claude Code' });
  await expect(descriptions).toBeVisible();
  await expect(claudeAgent).toHaveCSS('white-space', 'nowrap');
  await expect
    .poll(() => claudeAgent.evaluate((element) => element.scrollWidth > element.clientWidth))
    .toBe(true);
  await claudeAgent.hover();
  await expect(page.getByRole('tooltip')).toHaveText(claudeAgentTitle);
  const overflow = await descriptions.evaluate((element) => {
    return element.scrollWidth > Math.ceil(element.clientWidth + 1);
  });
  expect(overflow).toBe(false);
});

test('Resource filters align left on desktop and keep actions accessible after mobile reflow', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await mockPersonalResources(page);

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '管理', exact: true }).click();
  await page.getByRole('button', { name: '节点管理' }).click();

  const filters = page.locator('.mar-resource-filters');
  await expect(filters).toBeVisible();
  const nodeDesktopLayout = await filters
    .locator(':scope > .mar-filter-field')
    .evaluateAll((fields) => {
      const container = fields[0]?.parentElement?.getBoundingClientRect();
      const rects = fields.map((field) => field.getBoundingClientRect());
      return {
        count: rects.length,
        topSpread:
          Math.max(...rects.map((rect) => rect.top)) - Math.min(...rects.map((rect) => rect.top)),
        widthSpread:
          Math.max(...rects.map((rect) => rect.width)) -
          Math.min(...rects.map((rect) => rect.width)),
        leftGap: container === undefined ? Number.NaN : rects[0]!.left - container.left,
        rightGap:
          container === undefined
            ? Number.NaN
            : container.right - Math.max(...rects.map((rect) => rect.right))
      };
    });
  expect(nodeDesktopLayout.count).toBe(3);
  expect(nodeDesktopLayout.topSpread).toBeLessThanOrEqual(1);
  expect(nodeDesktopLayout.widthSpread).toBeLessThanOrEqual(1);
  expect(nodeDesktopLayout.leftGap).toBeLessThanOrEqual(1);
  expect(nodeDesktopLayout.rightGap).toBeGreaterThan(100);

  await page.getByRole('button', { name: '工作区管理' }).click();
  await expect(page.locator('.workbench-header .breadcrumb strong')).toHaveText('工作区管理');
  await expect(filters.locator(':scope > .mar-filter-field')).toHaveCount(2);
  const workspaceDesktopLayout = await filters
    .locator(':scope > .mar-filter-field')
    .evaluateAll((fields) => {
      const container = fields[0]?.parentElement?.getBoundingClientRect();
      const rects = fields.map((field) => field.getBoundingClientRect());
      return {
        count: rects.length,
        topSpread:
          Math.max(...rects.map((rect) => rect.top)) - Math.min(...rects.map((rect) => rect.top)),
        widthSpread:
          Math.max(...rects.map((rect) => rect.width)) -
          Math.min(...rects.map((rect) => rect.width)),
        rightGap:
          container === undefined
            ? Number.NaN
            : container.right - Math.max(...rects.map((rect) => rect.right))
      };
    });
  expect(workspaceDesktopLayout.count).toBe(2);
  expect(workspaceDesktopLayout.topSpread).toBeLessThanOrEqual(1);
  expect(workspaceDesktopLayout.widthSpread).toBeLessThanOrEqual(1);
  expect(workspaceDesktopLayout.rightGap).toBeGreaterThan(100);

  await page.getByRole('button', { name: '节点管理' }).click();
  await expect(page.locator('.workbench-header .breadcrumb strong')).toHaveText('节点管理');
  await expect(filters.locator(':scope > .mar-filter-field')).toHaveCount(3);
  await page.setViewportSize({ width: 390, height: 844 });
  const layout = await filters.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      filterLeft: rect.left,
      filterRight: rect.right,
      filterClientWidth: element.clientWidth,
      filterScrollWidth: element.scrollWidth,
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth
    };
  });
  expect(layout.filterLeft).toBeGreaterThanOrEqual(0);
  expect(layout.filterRight).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.filterScrollWidth).toBeLessThanOrEqual(layout.filterClientWidth);
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
  await expect(page.locator('.mar-management-page .el-table__fixed-right')).toHaveCount(0);
  const tableScroll = page.locator(
    '.mar-management-page .el-table__body-wrapper .el-scrollbar__wrap'
  );
  const tableLayout = await tableScroll.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
    return {
      clientWidth: element.clientWidth,
      scrollLeft: element.scrollLeft,
      scrollWidth: element.scrollWidth
    };
  });
  expect(tableLayout.scrollWidth).toBeGreaterThan(tableLayout.clientWidth);
  expect(tableLayout.scrollLeft).toBeGreaterThan(0);
  await expect(page.getByRole('columnheader', { name: '操作', exact: true })).toBeInViewport();
  const rowActions = page.locator('.mar-management-page .mar-row-actions').first();
  const actionLayout = await rowActions.evaluate((element) => {
    const actions = element.getBoundingClientRect();
    const scrollViewport = element.closest('.el-scrollbar__wrap')?.getBoundingClientRect();
    return {
      actionsLeft: actions.left,
      actionsRight: actions.right,
      scrollLeft: scrollViewport?.left ?? 0,
      scrollRight: scrollViewport?.right ?? 0
    };
  });
  expect(actionLayout.actionsLeft).toBeGreaterThanOrEqual(actionLayout.scrollLeft - 1);
  expect(actionLayout.actionsRight).toBeLessThanOrEqual(actionLayout.scrollRight + 1);
  await expect(rowActions.getByRole('button', { name: '编辑', exact: true })).toBeInViewport();
});

test('Enterprise user creation and password reset expose directly copyable temporary credentials', async ({
  page
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as typeof window & { copiedCredential?: string }).copiedCredential = value;
        }
      }
    });
  });
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await mockPersonalResources(page);
  await page.route('**/api/auth/me', (route) =>
    json(route, {
      authenticated: true,
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
  await page.route('**/api/organizations', (route) =>
    json(route, {
      organizations: [
        { id: 1, name: '企业根', parentOrganizationId: null, createdAt: 1, updatedAt: 1 }
      ]
    })
  );
  await page.route('**/api/enterprise/users', (route) => {
    if (route.request().method() === 'POST')
      return json(route, {
        user: { id: 3, username: 'new-member' },
        temporaryPassword: 'create-pass'
      });
    return json(route, {
      users: [
        {
          id: 2,
          username: 'member',
          email: null,
          nickname: null,
          role: 'MEMBER',
          organizationId: 1,
          fixedAdmin: false,
          enabled: true
        }
      ]
    });
  });
  await page.route('**/api/management/users/2/reset-password', (route) =>
    json(route, { temporaryPassword: 'reset-pass' })
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '管理', exact: true }).click();
  await page.getByRole('button', { name: '用户管理' }).click();
  await page.getByRole('button', { name: '创建用户' }).click();
  const createDialog = page.getByRole('dialog', { name: '创建用户' });
  await createDialog.getByLabel('用户名').fill('new-member');
  await createDialog.getByRole('button', { name: '创建用户', exact: true }).click();
  const credentialDialog = page.getByRole('dialog', { name: '用户已创建' });
  await credentialDialog.getByRole('button', { name: '复制用户名和密码' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as typeof window & { copiedCredential?: string }).copiedCredential
      )
    )
    .toBe('用户名：new-member\n密码：create-pass');
  await credentialDialog.getByRole('button', { name: '我已保存' }).click();

  await page.getByRole('button', { name: '重置密码', exact: true }).click();
  await page.getByRole('button', { name: '重置密码', exact: true }).last().click();
  const resetDialog = page.getByRole('dialog', { name: '密码已重置' });
  await resetDialog.getByRole('button', { name: '复制用户名和密码' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as typeof window & { copiedCredential?: string }).copiedCredential
      )
    )
    .toBe('用户名：member\n密码：reset-pass');
});

test('Reload restores CSRF and temporary directories and Workspaces are created only after confirmation', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await page.route('**/api/workspaces?nodeId=node-1', (route) => {
    if (!writes.some((write) => /\/api\/workspaces$/u.test(write.url))) return route.fallback();
    return json(route, {
      workspaces: [
        { id: 'workspace-1', path: '/project', kind: 'DIRECTORY' },
        { id: 'workspace-created', path: '/another-project', kind: 'DIRECTORY' }
      ]
    });
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.reload();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.getByRole('button', { name: '节点操作' }).click();
  await page.getByRole('menuitem', { name: '添加工作区' }).click();
  const selectionPanel = page.locator('.workspace-selection-panel');
  await expect(selectionPanel).toHaveCSS('overflow-y', 'auto');
  await expect(selectionPanel.getByLabel('终端')).toHaveCount(0);
  const upwardButton = selectionPanel.getByLabel('返回上一级');
  await expect(upwardButton).toBeVisible();
  await expect(upwardButton).toContainText('返回上一级');
  await expect(upwardButton).toHaveClass(/is-text/);
  const createDirectoryButton = selectionPanel.getByRole('button', { name: '新建目录' });
  await expect(createDirectoryButton.locator('.el-icon')).toBeVisible();
  const selectCurrentButton = selectionPanel.getByRole('button', { name: '选择当前目录' });
  await expect(selectCurrentButton).toHaveClass(/el-button/);
  await expect(selectCurrentButton).not.toHaveClass(/is-text/);
  await expect(selectionPanel.getByText('从当前 节点的允许根目录开始')).toHaveCount(0);
  const directoryFilter = selectionPanel.getByRole('textbox', { name: '显示过滤' });
  await directoryFilter.fill('missing');
  await expect(selectionPanel.getByText('没有匹配的文件或目录。')).toBeVisible();
  await directoryFilter.clear();
  await expect(selectionPanel.getByText('another-project', { exact: true })).toBeVisible();
  await createDirectoryButton.click();
  const createDirectory = page.getByRole('dialog', { name: '新建目录' });
  await createDirectory.getByPlaceholder('请输入目录名称').fill('nested/project');
  await createDirectory.getByRole('button', { name: '确定', exact: true }).click();
  await expect(createDirectory.getByText('请输入不含路径分隔符的单级目录名称')).toBeVisible();
  await createDirectory.getByPlaceholder('请输入目录名称').fill('temporary-project');
  await createDirectory.getByPlaceholder('请输入目录名称').press('Enter');
  await expect(createDirectory).toHaveCount(0);
  await expect(selectionPanel.getByText('待创建', { exact: true })).toBeVisible();
  await expect(selectionPanel.locator('code')).toContainText('已选择：');
  await expect(selectionPanel.locator('code')).toContainText('/home/node/temporary-project');
  expect(writes).toHaveLength(0);
  await selectionPanel.getByLabel('刷新目录').click();
  await expect(selectionPanel.getByText('待创建', { exact: true })).toHaveCount(0);
  await selectionPanel.getByRole('button', { name: '新建目录' }).click();
  await page
    .getByRole('dialog', { name: '新建目录' })
    .getByPlaceholder('请输入目录名称')
    .fill('temporary-project');
  await page
    .getByRole('dialog', { name: '新建目录' })
    .getByRole('button', { name: '确定', exact: true })
    .click();
  await selectionPanel.getByRole('button', { name: '创建并登记', exact: true }).click();

  const registration = writes.find((write) => /\/api\/workspaces$/u.test(write.url));
  expect(registration).toMatchObject({ csrf: 'csrf-1' });
  expect(JSON.parse(registration!.body)).toMatchObject({
    path: '/home/node',
    createDirectoryName: 'temporary-project'
  });
  await expect(page.getByRole('tab', { name: /another-project/ })).toHaveAttribute(
    'aria-selected',
    'true'
  );
});
