import { expect, test } from '@playwright/test';
import { json, mockConsoleApi } from './support/web-console-api.js';

test('Personal secret validation and CRUD reuse authoritative lists without submitting organization fields', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.route('**/api/auth/me', (route) =>
    json(route, {
      authenticated: true,
      mustChangePassword: false,
      username: 'admin',
      isAdmin: true,
      edition: 'COMMUNITY',
      managementWritable: true,
      csrfToken: 'csrf-1'
    })
  );
  const writes: { method: string; body: unknown }[] = [];
  let secrets: Record<string, unknown>[] = [];
  let failedCreates = 0;
  await page.route('**/api/environment-secrets**', (route) => {
    const method = route.request().method();
    if (method === 'GET') return json(route, { secrets });
    const body = method === 'DELETE' ? null : route.request().postDataJSON();
    if (method === 'POST' && failedCreates === 0) {
      failedCreates += 1;
      return json(route, { code: 'FORBIDDEN', message: 'Write denied by test fixture' }, 403);
    }
    writes.push({ method, body });
    if (method === 'POST')
      secrets = [
        {
          id: 'secret-personal',
          ...body,
          nodeId: null,
          organizationId: null,
          visibility: null,
          createdAt: 1,
          updatedAt: 1
        }
      ];
    else if (method === 'PUT')
      secrets = secrets.map((secret) => ({ ...secret, value: body.value }));
    else if (method === 'DELETE') secrets = [];
    return json(route, {});
  });
  await page.goto('/console?view=management&management=secrets');
  await page.getByRole('button', { name: '新增环境密钥', exact: true }).click();
  const create = page.getByRole('dialog', { name: '新增环境密钥' });
  await create.getByRole('button', { name: '保存', exact: true }).click();
  await expect(create.getByText('请输入密钥值', { exact: true })).toBeVisible();
  expect(writes).toHaveLength(0);
  await expect(create.locator('.el-cascader')).toHaveCount(0);
  await create.getByPlaceholder('请输入环境变量名').fill('PERSONAL_KEY');
  await create.getByPlaceholder('请输入密钥值').fill('personal-test-fixture');
  await create.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => failedCreates).toBe(1);
  await expect(create).toBeVisible();
  await expect(create.getByPlaceholder('请输入密钥值')).toHaveValue('personal-test-fixture');
  await expect(create.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  expect(writes).toHaveLength(0);
  await create.getByRole('button', { name: '保存', exact: true }).click();
  await expect(create).toBeHidden();
  await expect
    .poll(() => writes)
    .toEqual([
      {
        method: 'POST',
        body: { scope: 'PERSONAL', name: 'PERSONAL_KEY', value: 'personal-test-fixture' }
      }
    ]);
  const row = page.locator('.secret-table .el-table__row').filter({ hasText: 'PERSONAL_KEY' });
  await expect(row).toContainText('personal-test-fixture');
  await row.getByRole('button', { name: '更新', exact: true }).click();
  const replace = page.getByRole('dialog', { name: '更新密钥值' });
  await expect(replace.getByPlaceholder('请输入环境变量名')).toBeDisabled();
  await replace.getByPlaceholder('请输入密钥值').fill('replacement-test-fixture');
  await replace.getByRole('button', { name: '保存', exact: true }).click();
  await expect(row).toContainText('replacement-test-fixture');
  expect(writes[1]).toEqual({ method: 'PUT', body: { value: 'replacement-test-fixture' } });
  await row.getByRole('button', { name: '删除', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '删除环境密钥' });
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  expect(writes).toHaveLength(2);
  await row.getByRole('button', { name: '删除', exact: true }).click();
  await confirm.getByRole('button', { name: '删除', exact: true }).click();
  await expect(row).toHaveCount(0);
  expect(writes[2]).toEqual({ method: 'DELETE', body: null });
  expect(page.url()).not.toContain('test-fixture');
});

test('Secret and OAuth management show read-only row details and organization secrets use cascading selectors', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.unroute('**/api/auth/me');
  await page.unroute('**/api/auth/login');
  let authenticated = true;
  const admin = {
    authenticated: true,
    mustChangePassword: false,
    username: 'admin',
    isAdmin: true,
    edition: 'ENTERPRISE' as const,
    licenseState: 'ENTERPRISE_VALID' as const,
    role: 'ADMIN' as const,
    organizationId: 1,
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
  await page.route('**/api/license', (route) =>
    json(route, {
      edition: 'ENTERPRISE',
      state: 'ENTERPRISE_VALID',
      reason: null,
      licenseId: 'license-1',
      enterpriseName: 'Credentials Enterprise',
      expiresAt: null,
      managementWritable: true
    })
  );
  await page.route('**/api/license/request-code', (route) =>
    json(route, { requestCode: 'MAR1.credentials-e2e.checksum' })
  );
  await page.route('**/api/resources*', (route) => json(route, { nodes: [], workspaces: [] }));
  await page.route('**/api/management/nodes', (route) => json(route, { nodes: [] }));
  await page.route('**/api/organizations', (route) =>
    json(route, {
      organizations: [
        { id: 1, name: '企业根', parentOrganizationId: null },
        { id: 2, name: '研发', parentOrganizationId: 1 },
        { id: 3, name: '平台', parentOrganizationId: 2 }
      ]
    })
  );
  await page.route('**/api/enterprise/users**', (route) => json(route, { users: [] }));
  let createdSecret: Record<string, unknown> | undefined;
  await page.route('**/api/environment-secrets**', (route) => {
    if (route.request().method() === 'POST') {
      createdSecret = route.request().postDataJSON() as Record<string, unknown>;
      return json(route, {});
    }
    return json(route, {
      secrets: [
        {
          id: 'secret-1',
          scope: 'ORGANIZATION',
          name: 'API_TOKEN',
          value: 'visible-secret',
          nodeId: null,
          organizationId: 3,
          visibility: 'PUBLIC',
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_100_000
        }
      ]
    });
  });
  let providerEnabled = true;
  let providerStatusRequests = 0;
  await page.route('**/api/oauth-providers', (route) =>
    json(route, {
      providers: [
        {
          providerKey: 'feishu',
          name: '飞书',
          clientId: 'client-id',
          authorizationEndpoint: 'https://accounts.example/authorize',
          tokenEndpoint: 'https://accounts.example/token',
          userinfoEndpoint: 'https://accounts.example/userinfo',
          scopes: ['openid', 'profile'],
          pkceMode: 'REQUIRED',
          tokenAuthMethod: 'client_secret_basic',
          autoProvisioningEnabled: true,
          mappings: { externalUserId: '/data/open_id', displayName: '/data/name' },
          enabled: providerEnabled,
          testedAt: 1_700_000_000_000
        }
      ]
    })
  );
  await page.route('**/api/oauth-providers/feishu/enabled', (route) => {
    providerStatusRequests += 1;
    providerEnabled = Boolean((route.request().postDataJSON() as { enabled?: unknown }).enabled);
    return route.fulfill({ status: 204 });
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '管理', exact: true }).click();
  await expect(page).toHaveURL(/view=management/);
  const managementMenu = page.getByRole('navigation', { name: '管理菜单' });
  await expect(managementMenu).toBeVisible();
  await managementMenu.getByRole('button', { name: '环境密钥管理', exact: true }).click();

  const secretRow = page.locator('.secret-table .el-table__row').filter({ hasText: 'API_TOKEN' });
  await expect(page.locator('.secret-table')).toHaveClass(/clickable-rows/);
  await expect(secretRow.getByRole('button', { name: '详情', exact: true })).toHaveCount(0);
  await expect(secretRow.locator('.row-actions .el-icon').first()).toBeVisible();
  await secretRow.click();
  const secretDetails = page.getByRole('dialog', { name: 'API_TOKEN' });
  await expect(secretDetails).toContainText('企业根 / 研发 / 平台');
  await expect(secretDetails).toContainText('公开');
  await secretDetails.getByRole('button', { name: '关闭', exact: true }).click();

  await page.getByRole('button', { name: '新增环境密钥', exact: true }).click();
  const secretDialog = page.getByRole('dialog', { name: '新增环境密钥' });
  await secretDialog.locator('.el-select').first().click();
  await page.getByRole('option', { name: '组织', exact: true }).click();
  await expect(secretDialog.locator('.el-cascader')).toBeVisible();
  await expect(secretDialog.getByRole('group', { name: '所属组织' })).toBeVisible();
  await secretDialog.getByPlaceholder('请输入环境变量名').fill('SHARED_KEY');
  await secretDialog.getByPlaceholder('请输入密钥值').fill('organization-test-fixture');
  await secretDialog.locator('.el-cascader input').fill('平台');
  await page.getByRole('listitem').filter({ hasText: '企业根 / 研发 / 平台' }).click();
  await secretDialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect
    .poll(() => createdSecret)
    .toEqual({
      scope: 'ORGANIZATION',
      name: 'SHARED_KEY',
      value: 'organization-test-fixture',
      organizationId: 3,
      visibility: 'PRIVATE'
    });
  await expect(secretDialog).toBeHidden();

  await managementMenu.getByRole('button', { name: 'OAuth 配置', exact: true }).click();
  const providerRow = page
    .locator('.oauth-provider-table .el-table__row')
    .filter({ hasText: '飞书' });
  await expect(page.locator('.oauth-provider-table')).toHaveClass(/clickable-rows/);
  await expect(providerRow.getByRole('button', { name: '详情', exact: true })).toHaveCount(0);
  await expect(providerRow.locator('.row-actions .el-icon').first()).toBeVisible();
  await expect(providerRow.locator('.el-tag')).toHaveText('启用');
  await expect(providerRow).toContainText('新用户将加入根组织并成为普通成员');
  await providerRow.click();
  const providerDetails = page.getByRole('dialog', { name: '飞书' });
  await expect(providerDetails).toContainText('https://accounts.example/authorize');
  await expect(providerDetails).toContainText('/data/open_id');
  await expect(providerDetails).toContainText('新用户将加入根组织并成为普通成员');
  await expect(providerDetails).not.toContainText('Client Secret');
  await providerDetails.getByRole('button', { name: '关闭', exact: true }).click();

  await providerRow.getByRole('button', { name: '停用', exact: true }).click();
  const disableConfirmation = page
    .getByRole('dialog')
    .filter({ hasText: '停用 OAuth 来源“飞书”？' });
  await expect(disableConfirmation).toBeVisible();
  await disableConfirmation.getByRole('button', { name: '取消', exact: true }).click();
  expect(providerStatusRequests).toBe(0);

  await providerRow.getByRole('button', { name: '停用', exact: true }).click();
  await disableConfirmation.getByRole('button', { name: '停用', exact: true }).click();
  await expect.poll(() => providerStatusRequests).toBe(1);
  await expect(providerRow.locator('.el-tag')).toHaveText('停用');

  await providerRow.getByRole('button', { name: '启用', exact: true }).click();
  const enableConfirmation = page
    .getByRole('dialog')
    .filter({ hasText: '启用 OAuth 来源“飞书”？' });
  await expect(enableConfirmation).toBeVisible();
  await enableConfirmation.getByRole('button', { name: '启用', exact: true }).click();
  await expect.poll(() => providerStatusRequests).toBe(2);
  await expect(providerRow.locator('.el-tag')).toHaveText('启用');

  await providerRow.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(
    page
      .getByRole('dialog', { name: '编辑 OAuth 来源' })
      .getByText('允许自动开户（新用户将加入根组织并成为普通成员）')
  ).toBeVisible();
});

for (const locale of ['zh-CN', 'en-US'] as const) {
  test(`Workspace secrets support independent CRUD, isolation, and frozen-state behavior (${locale})`, async ({
    page
  }) => {
    const text =
      locale === 'zh-CN'
        ? {
            details: '工作区详情',
            add: '新增环境密钥',
            save: '保存',
            name: '请输入环境变量名',
            value: '请输入密钥值',
            update: '更新',
            replace: '更新密钥值',
            remove: '删除',
            confirm: '删除环境密钥',
            cancel: '取消',
            close: '关闭',
            scope: '工作区'
          }
        : {
            details: 'Workspace Details',
            add: 'Add Environment Secret',
            save: 'Save',
            name: 'Enter an environment variable name',
            value: 'Enter a secret value',
            update: 'Update',
            replace: 'Update Secret Value',
            remove: 'Delete',
            confirm: 'Delete Environment Secret',
            cancel: 'Cancel',
            close: 'Close',
            scope: 'Workspace'
          };
    await page.addInitScript((value) => localStorage.setItem('mar.locale.v2', value), locale);
    await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
    let writable = true;
    await page.route('**/api/auth/me', (route) =>
      json(route, {
        authenticated: true,
        mustChangePassword: false,
        username: 'admin',
        isAdmin: true,
        role: 'ADMIN',
        edition: 'COMMUNITY',
        licenseState: 'COMMUNITY',
        managementWritable: writable,
        csrfToken: 'csrf-1'
      })
    );
    await page.route('**/api/resources*', (route) =>
      json(route, {
        nodes: [
          {
            id: 'node-1',
            displayName: 'Node A',
            connected: false,
            disabled: false,
            ownership: { ownerType: 'PERSONAL', ownerUserId: 1 }
          }
        ],
        workspaces: ['a', 'b'].map((id) => ({
          nodeId: 'node-1',
          nodeDisplayName: 'Node A',
          workspaceId: `workspace-${id}`,
          displayName: `Project ${id.toUpperCase()}`,
          ownership: { ownerType: 'PERSONAL', ownerUserId: 1 }
        }))
      })
    );
    const queries: string[] = [];
    const writes: { method: string; body: Record<string, unknown> | null; csrf?: string }[] = [];
    const secrets = new Map<string, Record<string, unknown>[]>([
      ['workspace-a', []],
      [
        'workspace-b',
        [
          {
            id: 'secret-b',
            scope: 'WORKSPACE',
            nodeId: 'node-1',
            workspaceId: 'workspace-b',
            name: 'PROJECT_TOKEN',
            value: 'workspace-b-fixture',
            createdAt: 1,
            updatedAt: 1
          }
        ]
      ]
    ]);
    await page.route('**/api/environment-secrets**', (route) => {
      const url = new URL(route.request().url());
      const method = route.request().method();
      if (method === 'GET') {
        queries.push(url.search);
        return json(route, {
          secrets: secrets.get(url.searchParams.get('workspaceId') ?? '') ?? []
        });
      }
      const body =
        method === 'DELETE' ? null : (route.request().postDataJSON() as Record<string, unknown>);
      const csrf = route.request().headers()['x-csrf-token'];
      writes.push({ method, body, ...(csrf === undefined ? {} : { csrf }) });
      if (method === 'POST' && body !== null) {
        const workspaceId = String(body.workspaceId);
        secrets.set(workspaceId, [
          { id: `secret-${workspaceId}`, ...body, createdAt: 1, updatedAt: 1 }
        ]);
      } else {
        const id = url.pathname.split('/').at(-1);
        for (const [workspaceId, entries] of secrets) {
          secrets.set(
            workspaceId,
            method === 'DELETE'
              ? entries.filter((secret) => secret.id !== id)
              : entries.map((secret) =>
                  secret.id === id ? { ...secret, value: body?.value } : secret
                )
          );
        }
      }
      return json(route, {});
    });

    await page.goto('/console?view=management&management=resource-workspaces');
    await page.getByRole('cell', { name: 'Project A', exact: true }).click();
    const details = page.getByRole('dialog', { name: text.details, exact: true });
    await expect(details.getByRole('button', { name: text.add, exact: true })).toBeVisible();
    await expect.poll(() => queries).toContain('?nodeId=node-1&workspaceId=workspace-a');
    await expect(details).not.toContainText('workspace-b-fixture');
    await details.getByRole('button', { name: text.add, exact: true }).click();
    const create = page.getByRole('dialog', { name: text.add, exact: true });
    await create.getByRole('button', { name: text.save, exact: true }).click();
    expect(writes).toHaveLength(0);
    await create.getByPlaceholder(text.name).fill('PROJECT_TOKEN');
    await create.getByPlaceholder(text.value).fill('workspace-a-fixture');
    await create.getByRole('button', { name: text.save, exact: true }).click();
    await expect(create).toBeHidden();
    expect(writes[0]).toEqual({
      method: 'POST',
      csrf: 'csrf-1',
      body: {
        scope: 'WORKSPACE',
        name: 'PROJECT_TOKEN',
        value: 'workspace-a-fixture',
        nodeId: 'node-1',
        workspaceId: 'workspace-a'
      }
    });
    const row = details
      .locator('.secret-table .el-table__row')
      .filter({ hasText: 'PROJECT_TOKEN' });
    await expect(row).toContainText(text.scope);
    await expect(row).toContainText('workspace-a-fixture');
    await row.getByRole('button', { name: text.update, exact: true }).click();
    const replace = page.getByRole('dialog', { name: text.replace, exact: true });
    await expect(replace.getByPlaceholder(text.name)).toBeDisabled();
    await replace.getByPlaceholder(text.value).fill('workspace-a-replacement-fixture');
    await replace.getByRole('button', { name: text.save, exact: true }).click();
    await expect(row).toContainText('workspace-a-replacement-fixture');
    await row.getByRole('button', { name: text.remove, exact: true }).click();
    const confirm = page.getByRole('dialog', { name: text.confirm, exact: true });
    await confirm.getByRole('button', { name: text.cancel, exact: true }).click();
    expect(writes).toHaveLength(2);
    await row.getByRole('button', { name: text.remove, exact: true }).click();
    await confirm.getByRole('button', { name: text.remove, exact: true }).click();
    await expect(row).toHaveCount(0);
    expect(writes[2]?.method).toBe('DELETE');
    await details.getByRole('button', { name: text.close, exact: true }).click();
    await page.getByRole('cell', { name: 'Project B', exact: true }).click();
    await expect(details).toContainText('workspace-b-fixture');
    await expect(details).not.toContainText('workspace-a-replacement-fixture');
    expect(queries.every((query) => query.includes('workspaceId='))).toBe(true);
    expect(page.url()).not.toContain('fixture');
    expect(
      await page.evaluate(() =>
        Object.values(localStorage).some((value) => String(value).includes('workspace-b-fixture'))
      )
    ).toBe(false);
    writable = false;
    await page.reload();
    await page.getByRole('cell', { name: 'Project B', exact: true }).click();
    await expect(details).toContainText('workspace-b-fixture');
    await expect(details.getByRole('button', { name: text.add, exact: true })).toHaveCount(0);
    await expect(details.getByRole('button', { name: text.update, exact: true })).toBeDisabled();
    await expect(details.getByRole('button', { name: text.remove, exact: true })).toBeDisabled();
    expect(writes).toHaveLength(3);
  });
}
