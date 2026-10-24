import { expect, test } from '@playwright/test';
import { json, mockConsoleApi } from './support/web-console-api.js';
import {
  mockPersonalResources,
  selectAppearanceOption
} from './support/web-auth-settings-fixture.js';
import { INITIAL_ADMIN_PASSWORD } from '../../packages/server-core/src/password.js';

// Authentication and account/settings scenarios.

test('Authentication recovery preserves CSRF after network failure and resumes the page on reload', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.addInitScript(() => sessionStorage.setItem('mar.user.csrf-token', 'saved-csrf'));
  let authenticationChecks = 0;
  await page.route('**/api/auth/me', (route) => {
    authenticationChecks += 1;
    if (authenticationChecks === 1) return route.abort('connectionfailed');
    return json(route, {
      authenticated: true,
      mustChangePassword: false,
      username: 'admin',
      isAdmin: true
    });
  });
  const businessRequests: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/') && !path.startsWith('/api/auth/')) businessRequests.push(path);
  });
  await page.goto('/console?view=settings&settings=account');
  await expect(page.locator('.el-message')).toContainText('无法确认登录状态，请刷新重试');
  await expect(page.getByRole('textbox', { name: '账户', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('workbench-brand')).toHaveCount(0);
  expect(businessRequests).toEqual([]);
  expect(await page.evaluate(() => sessionStorage.getItem('mar.user.csrf-token'))).toBe(
    'saved-csrf'
  );
  await page.reload();
  await expect(page.getByRole('heading', { name: '账户安全' })).toBeVisible();
  expect(authenticationChecks).toBe(2);
  expect(new URL(page.url()).searchParams.get('settings')).toBe('account');
});

test('CSRF renewal failure hides protected content and recovers after reload', async ({ page }) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.route('**/api/auth/me', (route) =>
    json(route, {
      authenticated: true,
      mustChangePassword: false,
      username: 'admin',
      isAdmin: true
    })
  );
  let renewals = 0;
  await page.route('**/api/auth/csrf', (route) => {
    renewals += 1;
    if (renewals === 1) return route.abort('connectionfailed');
    return json(route, { csrfToken: 'recovered-csrf' });
  });
  let nodeReads = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/nodes') nodeReads += 1;
  });
  await page.goto('/console?view=settings&settings=account');
  await expect(page.locator('.el-message')).toContainText('无法确认登录状态，请刷新重试');
  await expect(page.getByRole('textbox', { name: '账户', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('workbench-brand')).toHaveCount(0);
  expect(nodeReads).toBe(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: '账户安全' })).toBeVisible();
  expect(renewals).toBe(2);
  expect(await page.evaluate(() => sessionStorage.getItem('mar.user.csrf-token'))).toBe(
    'recovered-csrf'
  );
});

test('Explicit unauthenticated recovery clears CSRF and shows login', async ({ page }) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.addInitScript(() => sessionStorage.setItem('mar.user.csrf-token', 'expired-csrf'));
  await page.route('**/api/auth/me', (route) =>
    json(route, { error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' } }, 401)
  );
  await page.goto('/console');
  await expect(page.getByRole('textbox', { name: '账户', exact: true })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('mar.user.csrf-token'))).toBeNull();
  await expect(page.locator('.el-message')).toHaveCount(0);
});

test('Enterprise account identity keeps OAuth unlinking without passing roles to shared settings', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.route('**/api/auth/me', (route) =>
    json(route, {
      authenticated: true,
      mustChangePassword: false,
      username: 'member',
      isAdmin: false,
      edition: 'ENTERPRISE',
      licenseState: 'ENTERPRISE_VALID',
      role: 'MEMBER',
      organizationId: 7,
      managementWritable: true
    })
  );
  let bound = true;
  let deletes = 0;
  await page.route('**/api/oauth-bindings', (route) =>
    json(route, {
      bindings: [
        {
          providerKey: 'company',
          name: 'Company SSO',
          bound,
          externalUserId: bound ? 'external-user' : null
        }
      ]
    })
  );
  await page.route('**/api/oauth-bindings/company', (route) => {
    expect(route.request().method()).toBe('DELETE');
    deletes += 1;
    bound = false;
    return json(route, {});
  });
  await page.goto('/console?view=settings&settings=account');
  await expect(page.getByRole('heading', { name: '账户安全' })).toBeVisible();
  await expect(page.locator('.settings-content')).not.toHaveAttribute('role');
  await expect(page.locator('.settings-content')).not.toHaveAttribute('edition');
  const bindings = page.locator('.oauth-bindings');
  await expect(bindings.getByText('Company SSO')).toBeVisible();
  await bindings.getByRole('button', { name: '解绑', exact: true }).click();
  await page
    .getByRole('dialog', { name: '解除 OAuth 绑定' })
    .getByRole('button', { name: '取消', exact: true })
    .click();
  expect(deletes).toBe(0);
  await bindings.getByRole('button', { name: '解绑', exact: true }).click();
  await page
    .getByRole('dialog', { name: '解除 OAuth 绑定' })
    .getByRole('button', { name: '确定', exact: true })
    .click();
  await expect(bindings.getByRole('button', { name: '绑定', exact: true })).toBeVisible();
  expect(deletes).toBe(1);
});

test('Hidden management URLs fall back safely without requesting enterprise page APIs', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.route('**/api/auth/me', (route) =>
    json(route, {
      authenticated: true,
      mustChangePassword: false,
      username: 'member',
      isAdmin: false,
      edition: 'ENTERPRISE',
      licenseState: 'ENTERPRISE_VALID',
      role: 'MEMBER',
      organizationId: 7,
      managementWritable: true
    })
  );
  const forbiddenRequests: string[] = [];
  for (const endpoint of ['organizations', 'enterprise/users', 'oauth-providers', 'license']) {
    await page.route(`**/api/${endpoint}**`, (route) => {
      forbiddenRequests.push(route.request().url());
      return json(route, {});
    });
  }
  for (const section of ['users', 'oauth']) {
    await page.goto(`/console?view=management&management=${section}`);
    await expect(page.locator('.system-information')).toBeVisible();
    const menu = page.getByRole('navigation', { name: '管理菜单' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('button', { name: '用户管理', exact: true })).toHaveCount(0);
    await expect(page.locator('.license-management')).toHaveCount(0);
  }
  expect(forbiddenRequests).toEqual([]);
});

test('Importing a License refreshes product capabilities and enterprise menus', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  let imported = false;
  let capabilityReads = 0;
  const status = () => ({
    edition: imported ? 'ENTERPRISE' : 'COMMUNITY',
    state: imported ? 'ENTERPRISE_VALID' : 'COMMUNITY',
    reason: null,
    licenseId: imported ? 'composition-license' : null,
    enterpriseName: imported ? 'Composition Enterprise' : null,
    expiresAt: null,
    managementWritable: true
  });
  await page.route('**/api/auth/me', (route) => {
    capabilityReads += 1;
    return json(route, {
      authenticated: true,
      mustChangePassword: false,
      username: 'admin',
      isAdmin: true,
      edition: status().edition,
      licenseState: status().state,
      role: imported ? 'ADMIN' : null,
      organizationId: imported ? 1 : null,
      managementWritable: true
    });
  });
  await page.route('**/api/license', (route) => json(route, status()));
  await page.route('**/api/license/request-code', (route) =>
    json(route, { requestCode: 'MAR1.composition.checksum' })
  );
  await page.route('**/api/license/import', (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toEqual({ document: 'composition-license-fixture' });
    imported = true;
    return json(route, status());
  });
  await page.goto('/console?view=management&management=system');
  const menu = page.getByRole('navigation', { name: '管理菜单' });
  await expect(page.locator('.license-management')).toBeVisible();
  await expect(menu.getByRole('button', { name: '用户管理', exact: true })).toHaveCount(0);
  const beforeImportReads = capabilityReads;
  await page.locator('#license-document').fill('composition-license-fixture');
  await page.getByRole('button', { name: '导入 License', exact: true }).click();
  await expect(menu.getByRole('button', { name: '用户管理', exact: true })).toBeVisible();
  await expect(page.locator('.license-management')).toContainText('Composition Enterprise');
  expect(capabilityReads).toBeGreaterThan(beforeImportReads);
});

test('Login shows multiple OAuth 2.0 SSO entries by provider identity', async ({ page }) => {
  await page.route('**/api/auth/me', (route) =>
    json(route, { authenticated: false, mustChangePassword: false })
  );
  await page.route('**/api/oauth/providers', (route) =>
    json(route, {
      providers: [
        { providerKey: 'feishu', name: '飞书企业' },
        { providerKey: 'corp-sso', name: '公司统一认证' }
      ]
    })
  );
  await page.goto('/console');
  await expect(page.locator('.auth-form .el-input input').first()).toHaveValue('');
  await expect(page.getByRole('link', { name: '使用 飞书企业 登录' })).toHaveAttribute(
    'href',
    '/api/oauth/feishu/login?locale=zh-CN'
  );
  await expect(page.getByRole('link', { name: '使用 公司统一认证 登录' })).toHaveAttribute(
    'href',
    '/api/oauth/corp-sso/login?locale=zh-CN'
  );
});

test('OAuth callback errors show Chinese messages in account security and login', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.goto(
    '/console?view=settings&settings=account&oauthError=OAUTH_IDENTITY_ALREADY_BOUND'
  );
  await page.getByRole('button', { name: '进入控制台' }).click();
  await expect(page.getByRole('heading', { name: '账户安全' })).toBeVisible();
  await expect(page.locator('.settings-content')).not.toHaveAttribute('edition');
  await expect(page.locator('.settings-content')).not.toHaveAttribute('role');
  await expect(page.locator('.settings-content')).not.toHaveAttribute('management-writable');
  await expect(page.getByRole('alert')).toContainText('此 OAuth 身份已绑定到其他账号');

  await page.route('**/api/auth/me', (route) =>
    json(route, { authenticated: false, mustChangePassword: false })
  );
  await page.route('**/api/oauth/providers', (route) => json(route, { providers: [] }));
  await page.goto('/console?oauthError=OAUTH_CALLBACK_INVALID');
  await expect(page.getByRole('heading', { name: '继续你的 Agent 工作。' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('OAuth 授权未完成');
});

test('Required password change shows minimum length and rejects short passwords', async ({
  page
}) => {
  let changeRequests = 0;
  await page.route('**/api/auth/me', (route) =>
    json(route, { authenticated: true, mustChangePassword: true, csrfToken: 'csrf-1' })
  );
  await page.route('**/api/auth/change-password', (route) => {
    changeRequests += 1;
    json(route, { authenticated: true, mustChangePassword: false, csrfToken: 'csrf-2' });
  });
  await page.route('**/api/auth/csrf', (route) => json(route, { csrfToken: 'csrf-1' }));

  await page.goto('/console');
  await expect(page.getByText('新密码至少需要 8 个字符。')).toBeVisible();
  const input = page.getByRole('textbox', { name: '新密码', exact: true });
  await input.fill('short');
  await expect(page.getByRole('button', { name: '保存并继续' })).toBeDisabled();
  expect(changeRequests).toBe(0);
});

test('UNAUTHENTICATED from Admin APIs clears authentication and returns to login', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await page.route('**/api/nodes/node-1/workbench-capabilities', (route) =>
    json(route, { error: { code: 'UNAUTHENTICATED' } }, 401)
  );
  await page.addInitScript(() => sessionStorage.setItem('mar.user.csrf-token', 'csrf-1'));

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();

  await expect(page.getByRole('heading', { name: '继续你的 Agent 工作。' })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem('mar.user.csrf-token')))
    .toBeNull();
});

test('Legacy CSRF storage keys cannot restore Admin authentication', async ({ page }) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await expect(page.getByRole('button', { name: '工作', exact: true })).toBeVisible();
  await page.evaluate(() => {
    sessionStorage.removeItem('mar.user.csrf-token');
    sessionStorage.setItem('mar.owner.csrf-token', 'legacy-csrf');
  });
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem('mar.user.csrf-token')))
    .not.toBeNull();
});

test('Account security shows at most five redacted login sessions', async ({ page }) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  let sessionReads = 0;
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await page.route('**/api/auth/sessions', (route) => {
    sessionReads += 1;
    return json(route, {
      sessions: [
        {
          current: true,
          id: 'session-1',
          createdAt: 1_785_000_000_000,
          expiresAt: 1_785_604_800_000,
          ipAddress: '192.0.2.8',
          userAgent: 'MyAgentRoam Test Browser'
        }
      ]
    });
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();

  await expect(page.getByRole('heading', { name: '账户安全' })).toBeVisible();
  await expect(page.locator('.settings-panel').first()).toHaveCSS('border-top-width', '0px');
  await expect(page.locator('.settings-panel').first()).toHaveCSS('max-width', '960px');
  await expect(page.locator('.account-summary')).toHaveCSS('font-size', '14px');
  await expect(page.getByRole('heading', { name: '登录会话（1/5）' })).toBeVisible();
  await expect(page.getByText('当前设备')).toBeVisible();
  const userAgent = page.getByText('MyAgentRoam Test Browser');
  await expect(userAgent).toBeVisible();
  await expect(userAgent).toHaveAttribute('title', 'MyAgentRoam Test Browser');
  await expect(page.getByText(/192\.0\.2\.8/)).toBeVisible();
  await expect(page.locator('.admin-sessions li')).toHaveCSS('display', 'grid');
  await expect(page.getByRole('button', { name: '注销' })).toHaveClass(/el-button--danger/);

  const updatePassword = page.getByRole('button', { name: '修改密码' });
  await expect(updatePassword).toBeEnabled();
  const logout = page.getByRole('button', { name: '退出登录' });
  await expect(logout).not.toHaveClass(/el-button--small/);
  await expect(page.locator('.account-actions')).toHaveCSS('border-top-width', '1px');
  await updatePassword.click();
  await expect(page.getByRole('dialog', { name: '修改密码' })).toBeVisible();
  await page.getByRole('textbox', { name: '当前密码' }).fill(INITIAL_ADMIN_PASSWORD);
  await page.getByRole('textbox', { name: '新密码', exact: true }).fill('short');
  await page.getByRole('textbox', { name: '再次输入新密码' }).fill('short');
  await page.getByRole('button', { name: '确认修改' }).click();
  await expect(page.getByRole('alert')).toHaveText('新密码至少需要 8 个字符。');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '修改密码' })).toHaveCount(0);
  await page.getByRole('button', { name: '刷新登录会话', exact: true }).click();
  await expect.poll(() => sessionReads).toBeGreaterThanOrEqual(2);
});

test('Personal password dialog closes only after success and reopens without sensitive fields or errors', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  let requests = 0;
  let finish!: () => Promise<void>;
  await page.route('**/api/auth/change-password', async (route) => {
    requests += 1;
    expect(route.request().headers()['x-csrf-token']).toBe('csrf-1');
    expect(route.request().postDataJSON()).toEqual({
      currentPassword: 'old-password',
      password: 'updated-password'
    });
    if (requests === 1)
      return json(
        route,
        { error: { code: 'INVALID_PASSWORD', message: 'Fixture password rejected' } },
        400
      );
    await new Promise<void>((resolve) => {
      finish = async () => {
        await json(route, {
          authenticated: true,
          mustChangePassword: false,
          csrfToken: 'updated-csrf'
        });
        resolve();
      };
    });
  });
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const open = page.getByRole('button', { name: '修改密码', exact: true });
  const dialog = page.getByRole('dialog', { name: '修改密码', exact: true });
  const current = dialog.getByRole('textbox', { name: '当前密码', exact: true });
  const next = dialog.getByRole('textbox', { name: '新密码', exact: true });
  const confirmation = dialog.getByRole('textbox', { name: '再次输入新密码', exact: true });
  const submit = dialog.getByRole('button', { name: '确认修改' });
  await open.click();
  await submit.click();
  await expect(dialog.getByRole('alert')).toContainText('8');
  expect(requests).toBe(0);
  await current.fill('old-password');
  await next.fill('short');
  await confirmation.fill('short');
  await submit.click();
  await expect(dialog.getByRole('alert')).toContainText('8');
  expect(requests).toBe(0);
  await next.fill('updated-password');
  await confirmation.fill('different-password');
  await submit.click();
  await expect(dialog.getByRole('alert')).toHaveText('两次输入的新密码不一致。');
  expect(requests).toBe(0);
  await confirmation.fill('updated-password');
  await submit.click();
  await expect(
    page.locator('.el-message').filter({ hasText: 'Fixture password rejected' })
  ).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(current).toHaveValue('old-password');
  await expect(next).toHaveValue('updated-password');
  await expect(submit).not.toHaveClass(/is-loading/);
  await submit.click();
  await expect.poll(() => requests).toBe(2);
  await expect(dialog).toBeVisible();
  await expect(submit).toHaveClass(/is-loading/);
  await finish();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.el-message').filter({ hasText: '密码已更新' })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('mar.user.csrf-token'))).toBe(
    'updated-csrf'
  );
  await open.click();
  for (const input of [current, next, confirmation]) await expect(input).toHaveValue('');
  await expect(dialog.locator('.el-form-item__error')).toHaveCount(0);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
});

test('Personal password dialog clears drafts and validation on every manual close path', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const open = page.getByRole('button', { name: '修改密码', exact: true });
  const dialog = page.getByRole('dialog', { name: '修改密码', exact: true });
  for (const method of ['cancel', 'header', 'escape', 'backdrop'] as const) {
    await open.click();
    await dialog.getByRole('textbox', { name: '当前密码', exact: true }).fill('draft-password');
    await dialog.getByRole('textbox', { name: '新密码', exact: true }).fill('short');
    await dialog.getByRole('textbox', { name: '再次输入新密码', exact: true }).fill('short');
    await dialog.getByRole('button', { name: '确认修改' }).click();
    await expect(dialog.getByRole('alert')).toContainText('8');
    if (method === 'cancel')
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
    else if (method === 'header') await dialog.locator('.el-dialog__headerbtn').click();
    else if (method === 'escape') await page.keyboard.press('Escape');
    else await dialog.click({ position: { x: 5, y: 5 } });
    await expect(dialog).toHaveCount(0);
    await open.click();
    for (const name of ['当前密码', '新密码', '再次输入新密码']) {
      await expect(dialog.getByRole('textbox', { name, exact: true })).toHaveValue('');
    }
    await expect(dialog.locator('.el-form-item__error')).toHaveCount(0);
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
  }
});

test('Mobile password dialog returns without submitting and reopens without the old draft', async ({
  page
}) => {
  const writes: { url: string; csrf: string | undefined; body: string }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '账户安全', exact: true }).click();
  const open = page.getByRole('button', { name: '修改密码', exact: true });
  const dialog = page.getByRole('dialog', { name: '修改密码', exact: true });
  const url = page.url();
  await open.click();
  await dialog.getByRole('textbox', { name: '当前密码', exact: true }).fill('draft-password');
  await page.goBack();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(url);
  expect(writes.filter((item) => item.url.includes('/change-password'))).toHaveLength(0);
  await open.click();
  await expect(dialog.getByRole('textbox', { name: '当前密码', exact: true })).toHaveValue('');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
});

test('Personal password dialog ignores a previous opening completing after it is reopened', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  let finish!: () => Promise<void>;
  await page.route('**/api/auth/change-password', async (route) => {
    await new Promise<void>((resolve) => {
      finish = async () => {
        await json(route, {
          authenticated: true,
          mustChangePassword: false,
          csrfToken: 'updated-csrf'
        });
        resolve();
      };
    });
  });
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const open = page.getByRole('button', { name: '修改密码', exact: true });
  const dialog = page.getByRole('dialog', { name: '修改密码', exact: true });
  await open.click();
  await dialog.getByRole('textbox', { name: '当前密码', exact: true }).fill('old-password');
  await dialog.getByRole('textbox', { name: '新密码', exact: true }).fill('updated-password');
  await dialog
    .getByRole('textbox', { name: '再次输入新密码', exact: true })
    .fill('updated-password');
  await dialog.getByRole('button', { name: '确认修改' }).click();
  await expect.poll(() => typeof finish).toBe('function');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await open.click();
  const current = dialog.getByRole('textbox', { name: '当前密码', exact: true });
  await expect(current).toHaveValue('');
  await current.fill('new-draft-password');
  await finish();
  await expect(dialog.getByRole('button', { name: '确认修改' })).not.toHaveClass(/is-loading/);
  await expect(dialog).toBeVisible();
  await expect(current).toHaveValue('new-draft-password');
});

for (const delayedStep of ['workbench recovery', 'session refresh'] as const) {
  test('Personal password dialog closes while ' + delayedStep + ' is pending', async ({ page }) => {
    await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
    let confirmed = false;
    let blocked = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recoveryPath =
      delayedStep === 'workbench recovery' ? '**/api/nodes' : '**/api/auth/sessions';
    await page.route(recoveryPath, async (route) => {
      if (!confirmed) return route.fallback();
      blocked = true;
      await gate;
      await route.fallback();
    });
    await page.route('**/api/auth/change-password', (route) => {
      expect(route.request().headers()['x-csrf-token']).toBe('csrf-1');
      confirmed = true;
      return json(route, {
        authenticated: true,
        mustChangePassword: false,
        csrfToken: 'confirmed-csrf'
      });
    });
    await page.goto('/console');
    await page.getByRole('button', { name: '进入控制台' }).click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByRole('heading', { name: '登录会话（0/5）' })).toBeVisible();
    const open = page.getByRole('button', { name: '修改密码', exact: true });
    const dialog = page.getByRole('dialog', { name: '修改密码', exact: true });
    const submit = dialog.getByRole('button', { name: '确认修改' });
    await open.click();
    await dialog.getByRole('textbox', { name: '当前密码', exact: true }).fill('old-password');
    await dialog.getByRole('textbox', { name: '新密码', exact: true }).fill('updated-password');
    await dialog
      .getByRole('textbox', { name: '再次输入新密码', exact: true })
      .fill('updated-password');
    try {
      await submit.click();
      await expect.poll(() => blocked).toBe(true);
      await expect(dialog).toHaveCount(0);
      await expect(page.locator('.el-message').filter({ hasText: '密码已更新' })).toBeVisible();
      expect(await page.evaluate(() => sessionStorage.getItem('mar.user.csrf-token'))).toBe(
        'confirmed-csrf'
      );
      await open.click();
      for (const name of ['当前密码', '新密码', '再次输入新密码']) {
        await expect(dialog.getByRole('textbox', { name, exact: true })).toHaveValue('');
      }
      await expect(dialog.getByRole('alert')).toHaveCount(0);
      await expect(submit).toHaveClass(/is-loading/);
    } finally {
      release();
      await expect(submit).not.toHaveClass(/is-loading/);
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
    }
  });
}

test('Quick prompts save on Enter without reloading the page', async ({ page }) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  const prompts: {
    readonly id: string;
    readonly phrase: string;
    readonly prompt: string;
    readonly updatedAt: number;
  }[] = [];
  let createRequests = 0;
  let holdRead = false;
  let finishRead!: () => void;
  const pendingRead = new Promise<void>((resolve) => {
    finishRead = resolve;
  });
  await page.route('**/api/quick-prompts', async (route) => {
    if (route.request().method() === 'GET') {
      if (holdRead) await pendingRead;
      return json(route, { prompts });
    }
    createRequests += 1;
    prompts.push({ id: 'prompt-1', phrase: 'review', prompt: '请审查当前改动', updatedAt: 1 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    return json(route, {
      prompt: { id: 'prompt-1', phrase: 'review', prompt: '请审查当前改动', updatedAt: 1 }
    });
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  holdRead = true;
  await page.getByRole('button', { name: '快捷提示词', exact: true }).click();
  const panel = page.locator('.quick-prompts');
  await expect(panel).toHaveAttribute('aria-busy', 'true');
  await expect(panel.locator(':scope > .el-loading-mask')).toBeVisible();
  await expect(panel.locator('.prompt-empty')).toHaveCount(0);
  finishRead();
  await expect(panel).toHaveAttribute('aria-busy', 'false');
  await expect(panel.locator(':scope > .el-loading-mask')).toBeHidden();
  await page.getByRole('button', { name: '新增提示词' }).click();

  const phrase = page.getByRole('textbox', { name: '短语' });
  await phrase.fill('review');
  await page.getByRole('textbox', { name: '提示词（Prompt）' }).fill('请审查当前改动');
  const saved = page.waitForResponse(
    (response) =>
      response.url().includes('/api/quick-prompts') && response.request().method() === 'POST'
  );
  await phrase.press('Enter');
  await expect.poll(() => createRequests).toBe(1);
  await phrase.press('Enter');
  await saved;

  expect(createRequests).toBe(1);
  await expect(page.getByRole('dialog', { name: '新增提示词' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '快捷提示词' })).toBeVisible();
  await expect(page.getByText('#review', { exact: true })).toBeVisible();
});

test('Personalized prompts put the common option first and select it by default', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  let finishRead!: () => void;
  const pendingRead = new Promise<void>((resolve) => {
    finishRead = resolve;
  });
  await page.route('**/api/personal-instructions', async (route) => {
    await pendingRead;
    return json(route, {
      instructions: {
        common: '公共规则',
        codex: 'Codex 规则',
        claudeCode: 'Claude Code 规则',
        openCode: 'OpenCode 规则',
        marAgent: 'MAR Agent 规则'
      }
    });
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '个性化提示词', exact: true }).click();

  const panel = page.locator('.personal-instructions');
  await expect(panel).toHaveAttribute('aria-busy', 'true');
  await expect(panel.locator(':scope > .el-loading-mask')).toBeVisible();
  await expect(panel.getByRole('textbox', { name: '个性化提示词' })).toBeDisabled();
  finishRead();
  await expect(panel).toHaveAttribute('aria-busy', 'false');
  await expect(panel.locator(':scope > .el-loading-mask')).toBeHidden();

  const scopes = page.locator('.instruction-scopes [role="tab"]');
  await expect(scopes).toHaveText(['公共', 'MAR Agent', 'Codex', 'Claude Code', 'OpenCode']);
  await expect(scopes.first()).toHaveClass(/is-checked/);
  await expect(page.getByRole('textbox', { name: '个性化提示词' })).toHaveValue('公共规则');
});

test('Appearance switches UI and file icon themes independently in local browser storage', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '外观', exact: true }).click();
  await expect(page.getByRole('heading', { name: '外观' })).toBeVisible();

  const root = page.locator('html');
  await expect(root).not.toHaveAttribute('data-theme', /.*/);
  await selectAppearanceOption(page, '主题', '暗色');
  await expect(root).toHaveAttribute('data-theme', 'vscode-dark-2026');
  await expect(root).toHaveClass(/dark/);
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(14, 17, 22)');

  await page.reload();
  await expect(root).toHaveAttribute('data-theme', 'vscode-dark-2026');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(14, 17, 22)');

  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '外观', exact: true }).click();
  await selectAppearanceOption(page, '主题', '浅色');
  await expect(root).not.toHaveAttribute('data-theme', /.*/);
  await expect(root).not.toHaveClass(/dark/);

  await selectAppearanceOption(page, '图标主题', 'Material');
  await selectAppearanceOption(page, '文件默认打开方式', '只读');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('mar.icon-theme')))
    .toBe('material');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('mar.file-editor.default-mode')))
    .toBe('read-only');

  await page.reload();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '外观', exact: true }).click();
  await expect(
    page
      .getByRole('combobox', { name: '图标主题', exact: true })
      .locator(
        'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " el-select ")][1]'
      )
  ).toContainText('Material');
  await expect(
    page
      .getByRole('combobox', { name: '文件默认打开方式', exact: true })
      .locator(
        'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " el-select ")][1]'
      )
  ).toContainText('只读');
});

test('About shows versions, documentation, and third-party notices without duplicating system information', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '关于', exact: true }).click();

  await expect(page.getByLabel('关于').getByText('MyAgentRoam', { exact: true })).toBeVisible();
  await expect(page.getByText('Visual Studio Code Seti File Icon Theme')).toBeVisible();
  await expect(page.getByRole('link', { name: '打开文档中心' })).toHaveAttribute(
    'href',
    '/docs/getting-started/overview'
  );
  await expect(page.getByText('系统运行情况')).toHaveCount(0);
});

test('Switching appearance to English keeps navigation and settings actions accessible', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await page.route('**/api/auth/preferences/locale', (route) => json(route, { locale: 'en-US' }));

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '外观', exact: true }).click();
  await selectAppearanceOption(page, '语言', 'English');

  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Account Security' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Keyboard Shortcuts' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();
  await page.getByRole('button', { name: 'About', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Open documentation' })).toHaveAttribute(
    'href',
    '/docs/en-US/getting-started/overview'
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => window.innerWidth)
  );

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
});

test('English mobile navigation stays on one line without hiding notifications', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await page.setViewportSize({ width: 320, height: 720 });
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await page.route('**/api/auth/preferences/locale', (route) => json(route, { locale: 'en-US' }));

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '外观', exact: true }).click();
  await selectAppearanceOption(page, '语言', 'English');

  const navigation = page.locator('.activity-rail nav');
  const bounds = await page
    .getByRole('button', { name: 'Admin', exact: true })
    .evaluate((button) => {
      const rail = button.closest('.activity-rail');
      const navigation = button.closest('nav');
      const notification = document.querySelector<HTMLElement>('.global-notification-center');
      const railBounds = rail?.getBoundingClientRect();
      const notificationBounds = notification?.getBoundingClientRect();
      const buttonBounds = button.getBoundingClientRect();
      const navigationStyle =
        navigation instanceof HTMLElement ? getComputedStyle(navigation) : undefined;
      return {
        whiteSpace: getComputedStyle(button.querySelector<HTMLElement>('.rail-label')!).whiteSpace,
        buttonHeight: Math.round(buttonBounds.height),
        labelHeight: Math.round(
          button.querySelector<HTMLElement>('.rail-label')!.getBoundingClientRect().height
        ),
        railRight: Math.round(railBounds?.right ?? 0),
        notificationLeft: Math.round(notificationBounds?.left ?? 0),
        navigationClientWidth: navigation?.clientWidth ?? 0,
        navigationScrollWidth: navigation?.scrollWidth ?? 0,
        navigationMinWidth: navigationStyle?.minWidth,
        navigationTouchAction: navigationStyle?.touchAction,
        navigationOverscrollInline: navigationStyle?.overscrollBehaviorInline,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth
      };
    });

  expect(bounds.whiteSpace).toBe('nowrap');
  expect(bounds.labelHeight).toBeLessThan(bounds.buttonHeight / 2);
  expect(bounds.railRight).toBeLessThanOrEqual(bounds.notificationLeft);
  expect(bounds.navigationScrollWidth).toBeGreaterThanOrEqual(bounds.navigationClientWidth);
  expect(bounds.navigationMinWidth).toBe('0px');
  expect(bounds.navigationTouchAction).toContain('pan-x');
  expect(bounds.navigationTouchAction).toContain('pinch-zoom');
  expect(bounds.navigationOverscrollInline).toBe('contain');
  expect(bounds.documentWidth).toBeLessThanOrEqual(bounds.viewportWidth);
  if (bounds.navigationScrollWidth > bounds.navigationClientWidth) {
    await navigation.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    const maxScrollLeft = await navigation.evaluate(
      (element) => element.scrollWidth - element.clientWidth
    );
    await expect
      .poll(() => navigation.evaluate((element) => element.scrollLeft))
      .toBe(maxScrollLeft);
  }
  expect(writes).toEqual([]);
});

test('Branding spans the two left columns while settings panels switch on the right', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await page.addInitScript(() => {
    class PassiveWorkbenchSocket extends EventTarget {
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      readyState = PassiveWorkbenchSocket.OPEN;

      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event('open')));
      }

      send(): void {}

      close(): void {
        if (this.readyState === PassiveWorkbenchSocket.CLOSED) return;
        this.readyState = PassiveWorkbenchSocket.CLOSED;
        this.dispatchEvent(new CloseEvent('close'));
      }
    }
    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      value: PassiveWorkbenchSocket
    });
  });
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await page.route('**/api/nodes', (route) => {
    if (route.request().method() !== 'GET') {
      writes.push({
        url: route.request().url(),
        csrf: route.request().headers()['x-csrf-token'],
        body: route.request().postData() ?? ''
      });
      return json(route, {});
    }
    return json(route, {
      nodes: [
        {
          id: 'node-1',
          platform: 'linux',
          architecture: 'x64',
          nodeAppVersion: '0.1.6',
          nodeVersion: 'v24.15.0',
          connected: true,
          disabled: false,
          capabilities: { codex: { available: true, version: '0.146' } },
          upgradeAvailability: { state: 'AVAILABLE', targetVersion: '0.1.7' }
        }
      ]
    });
  });
  await page.route('**/api/runner-usage/status?nodeId=node-1', (route) =>
    json(route, { statuses: [] })
  );
  await page.route('**/api/license', (route) =>
    json(route, {
      edition: 'COMMUNITY',
      state: 'COMMUNITY',
      reason: null,
      licenseId: null,
      enterpriseName: null,
      expiresAt: null,
      managementWritable: true
    })
  );
  await page.route('**/api/license/request-code', (route) =>
    json(route, { requestCode: 'MAR1.mobile-layout.checksum' })
  );

  await page.goto('/console');
  const loginPanel = page.locator('.gate-panel');
  await expect(loginPanel).toHaveCSS('border-radius', '8px');
  await expect(loginPanel).toHaveCSS('box-shadow', 'none');
  await expect(loginPanel.locator('.el-input__wrapper').first()).toHaveCSS('min-height', '34px');
  await expect(page.getByRole('button', { name: '进入控制台' })).toHaveCSS('min-height', '34px');
  const gateLayout = await loginPanel.evaluate((panel) => {
    const rect = panel.getBoundingClientRect();
    return {
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentHeight: document.documentElement.scrollHeight
    };
  });
  expect(Math.abs(gateLayout.centerX - gateLayout.viewportWidth / 2)).toBeLessThanOrEqual(1);
  expect(Math.abs(gateLayout.centerY - gateLayout.viewportHeight / 2)).toBeLessThanOrEqual(1);
  expect(gateLayout.documentHeight).toBeLessThanOrEqual(gateLayout.viewportHeight);
  await page.getByRole('button', { name: '进入控制台' }).click();
  const brand = page.getByTestId('workbench-brand');
  await expect(brand).toBeVisible();
  const performanceIndicator = page.getByRole('button', { name: 'Web 性能诊断' });
  await expect(performanceIndicator).toBeVisible();
  const [performanceBounds, railBounds] = await Promise.all([
    performanceIndicator.boundingBox(),
    page.locator('.activity-rail').boundingBox()
  ]);
  expect(performanceBounds?.x).toBeGreaterThanOrEqual(railBounds?.x ?? 0);
  expect(performanceBounds?.y).toBeGreaterThan(
    (railBounds?.y ?? 0) + (railBounds?.height ?? 0) / 2
  );
  await performanceIndicator.hover();
  const performancePanel = page.getByLabel('Web 性能诊断').filter({ hasText: '实时连接' });
  await expect(performancePanel).toContainText('消息吞吐');
  await expect(performancePanel).toContainText('活动 Run 会话');
  await expect(performancePanel).toContainText('JS Heap');
  await expect(page.getByRole('button', { name: '复制详细诊断信息' })).toBeVisible();
  await expect(brand.getByRole('link', { name: '返回 MyAgentRoam 首页' })).toHaveAttribute(
    'href',
    '/'
  );
  await expect(brand).toContainText('MyAgentRoam');
  await expect(brand).toContainText('管理你的 Agent 工作空间');
  await expect(brand.getByRole('img', { name: 'MyAgentRoam' })).toHaveAttribute(
    'src',
    /(?:src\/assets\/logo-icon|assets\/logo-icon-[\w-]+)\.png$/
  );
  const documentationLink = page.getByRole('link', { name: '帮助' });
  const notificationsButton = page.getByRole('button', { name: '打开通知中心' });
  await expect(documentationLink.locator('.rail-label')).toHaveText('帮助');
  await expect(documentationLink.locator('.rail-label')).toBeVisible();
  await expect(documentationLink).toHaveAttribute('target', '_blank');
  const [documentationBounds, notificationBounds] = await Promise.all([
    documentationLink.boundingBox(),
    notificationsButton.boundingBox()
  ]);
  expect(documentationBounds?.x).toBeLessThan(notificationBounds?.x ?? 0);
  expect(
    Math.abs(
      (documentationBounds?.y ?? 0) +
        (documentationBounds?.height ?? 0) / 2 -
        ((notificationBounds?.y ?? 0) + (notificationBounds?.height ?? 0) / 2)
    )
  ).toBeLessThanOrEqual(1);
  await documentationLink.hover();
  await expect(documentationLink).toHaveCSS('text-decoration-line', 'none');
  const brandBounds = await brand.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right };
  });
  expect(brandBounds).toEqual({ left: 0, right: 296 });
  await expect(brand).toHaveCSS('border-right-color', 'rgb(204, 214, 224)');
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await expect(page.getByText('资源管理器', { exact: true })).toHaveCount(0);
  await expect(page.locator('.activity-rail .rail-meta')).toHaveCount(0);
  await expect(page.locator('.workbench-header .breadcrumb')).toHaveCount(0);
  await expect(page.locator('.workbench-header .workspace-tabs-slot')).toBeVisible();
  await expect(page.getByRole('button', { name: '收起侧栏' })).toBeVisible();
  const headerAlignment = await page.locator('.workbench-header').evaluate((header) => {
    const toggle = header.querySelector<HTMLElement>('.workbench-tree-toggle');
    const workspaceTabs = header.querySelector<HTMLElement>('.workspace-tabs-slot');
    if (toggle === null || workspaceTabs === null) return null;
    const toggleRect = toggle.getBoundingClientRect();
    const workspaceTabsRect = workspaceTabs.getBoundingClientRect();
    return Math.abs(
      toggleRect.top +
        toggleRect.height / 2 -
        (workspaceTabsRect.top + workspaceTabsRect.height / 2)
    );
  });
  expect(headerAlignment).not.toBeNull();
  expect(headerAlignment).toBeLessThanOrEqual(1);
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  const selectedNodeRow = page.locator('.tree-node-row.selected');
  await expect(selectedNodeRow).toHaveClass(/selected/);
  await expect(selectedNodeRow).toHaveCSS('border-radius', '6px');
  expect(
    await selectedNodeRow.evaluate((element) => getComputedStyle(element).backgroundColor)
  ).not.toBe('rgba(0, 0, 0, 0)');
  const nodeActions = selectedNodeRow.locator('.node-tree-actions');
  const nodeActionsButton = selectedNodeRow.getByRole('button', { name: '节点操作' });
  await nodeActionsButton.focus();
  await expect(nodeActions).toHaveCSS('opacity', '1');
  await nodeActionsButton.click();
  await expect(page.getByRole('menuitem', { name: '添加工作区' })).toBeEnabled();
  await page.keyboard.press('Escape');
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  const newSessionButton = page.getByRole('button', { name: '新建会话', exact: true });
  const refreshSessionsButton = page.getByRole('button', { name: '刷新当前工作区会话' });
  await expect(newSessionButton.locator('.el-icon svg')).toHaveCount(1);
  await expect(newSessionButton).toHaveCSS('height', '32px');
  await expect(refreshSessionsButton).toHaveCSS('height', '26px');
  const selectedWorkspace = page.locator('.workspace-branches > li.selected');
  await expect(selectedWorkspace).toHaveCSS('box-shadow', 'none');
  expect(
    await selectedWorkspace.evaluate((element) => getComputedStyle(element, '::before').content)
  ).toBe('none');
  const workspaceTreeLine = await page
    .locator('.workspace-branches')
    .evaluate((element) => getComputedStyle(element, '::before').getPropertyValue('content'));
  expect(workspaceTreeLine).toBe('none');
  const nodeTreeFilterGap = await page.locator('.workspace-tree').evaluate((tree) => {
    const filter = tree.querySelector<HTMLElement>('.workspace-tree-filter');
    const nodeTree = tree.querySelector<HTMLElement>('.node-tree');
    if (filter === null || nodeTree === null) throw new Error('workspace tree layout is missing');
    return nodeTree.getBoundingClientRect().top - filter.getBoundingClientRect().bottom;
  });
  expect(nodeTreeFilterGap).toBeGreaterThanOrEqual(-1);
  expect(nodeTreeFilterGap).toBeLessThanOrEqual(1);
  const sidebarMenuIcon = await page
    .getByRole('button', { name: '收起侧栏' })
    .locator('.el-icon svg')
    .evaluate((element) => element.outerHTML);
  await page.getByRole('button', { name: '收起侧栏' }).click();
  const expandSidebarButton = page.getByRole('button', { name: '展开侧栏' });
  await expect(expandSidebarButton).toHaveAttribute('aria-expanded', 'false');
  await expect
    .poll(() =>
      expandSidebarButton.locator('.el-icon svg').evaluate((element) => element.outerHTML)
    )
    .not.toBe(sidebarMenuIcon);
  await expect(brand.getByText('MyAgentRoam', { exact: true })).toBeHidden();
  await expect(brand.getByText('管理你的 Agent 工作空间', { exact: true })).toBeHidden();
  await page.waitForTimeout(200);
  const collapsedBounds = await page.locator('.workbench.compact').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      treeWidth: document.querySelector('.workspace-tree')?.getBoundingClientRect().width
    };
  });
  expect(collapsedBounds).toEqual({ left: 52, treeWidth: 0 });
  await page.getByRole('button', { name: '设置' }).click();
  await expect(page.getByRole('navigation', { name: '设置菜单' })).toBeVisible();
  await expect(page.getByRole('button', { name: '账户安全' })).toHaveCSS('border-radius', '6px');
  await expect(page.getByRole('button', { name: '收起侧栏' })).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  await expect
    .poll(() =>
      page
        .getByRole('button', { name: '收起侧栏' })
        .locator('.el-icon svg')
        .evaluate((element) => element.outerHTML)
    )
    .toBe(sidebarMenuIcon);
  await expect(page.locator('.workspace-tree').getByText('设置', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '账户安全' })).toBeVisible();
  await page.getByRole('button', { name: '收起侧栏' }).click();
  await expect(page.getByRole('navigation', { name: '设置菜单' })).toHaveCount(0);
  await page.waitForTimeout(200);
  const collapsedSettingsBounds = await page
    .locator('.workbench.settings.compact')
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        treeWidth: document.querySelector('.workspace-tree')?.getBoundingClientRect().width
      };
    });
  expect(collapsedSettingsBounds).toEqual({ left: 52, treeWidth: 0 });
  await page.getByRole('button', { name: '展开侧栏' }).click();
  await expect(page.getByRole('navigation', { name: '设置菜单' })).toBeVisible();
  await page.waitForTimeout(200);
  const bounds = await page.locator('.workbench.settings').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, viewportWidth: window.innerWidth };
  });

  expect(bounds.left).toBe(296);
  expect(Math.abs(bounds.top)).toBeLessThanOrEqual(1);
  expect(bounds.right).toBe(bounds.viewportWidth);
  await mockPersonalResources(page);
  await page.getByRole('button', { name: '管理', exact: true }).click();
  await page.getByRole('button', { name: '节点管理' }).click();
  await expect(page).toHaveURL(/view=management/);
  await expect(page).toHaveURL(/management=resource-nodes/);
  await expect(page.getByRole('button', { name: '刷新' })).toBeVisible();
  await expect(page.locator('.el-tag').getByText('在线', { exact: true })).toBeVisible();
  await expect(page.getByText('可升级到 0.1.7', { exact: true })).toBeVisible();
  await page.getByRole('cell', { name: '研发节点', exact: true }).click();
  const nodeDetails = page.getByRole('dialog', { name: '节点详情' });
  await expect(nodeDetails.getByText('可升级到 0.1.7', { exact: true })).toBeVisible();
  await nodeDetails.getByRole('button', { name: '关闭', exact: true }).click();
  const nodeStatusTrigger = page
    .locator('.resource-filters .filter-field')
    .filter({ hasText: '状态：' })
    .locator('.el-select__wrapper');
  await nodeStatusTrigger.click();
  await page.getByRole('option', { name: '离线', exact: true }).click();
  await expect(page).toHaveURL(/nodes.status=offline/);
  await expect(page.locator('.el-tag').getByText('在线', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.workbench-header .breadcrumb strong')).toHaveText('节点管理');
  await expect(
    page
      .locator('.resource-filters .filter-field')
      .filter({ hasText: '状态：' })
      .locator('.el-select__placeholder')
  ).toContainText('离线');
  const registrationButton = page.getByRole('button', { name: '注册节点' });
  await expect(registrationButton).toBeVisible();
  await page.setViewportSize({ width: 700, height: 720 });
  await expect(brand.getByText('MyAgentRoam', { exact: true })).toBeHidden();
  await expect(brand.locator('.brand-version')).toBeHidden();
  await expect(brand.getByText('管理你的 Agent 工作空间', { exact: true })).toBeHidden();
  await expect(brand.getByRole('img', { name: 'MyAgentRoam' })).toBeVisible();
  await expect(brand).toHaveCSS('flex-shrink', '0');
  await expect(page.getByRole('button', { name: '收起侧栏' })).toHaveCount(0);
  await page.getByRole('button', { name: '设置' }).click();
  const [settingsBrandBounds, settingsRailBounds] = await Promise.all([
    brand.boundingBox(),
    page.locator('.activity-rail').boundingBox()
  ]);
  expect(settingsBrandBounds?.height).toBe(settingsRailBounds?.height);
  const mobileSettingsMenu = page.getByRole('navigation', { name: '设置菜单' });
  await expect(mobileSettingsMenu).toBeVisible();
  await expect(page.getByRole('button', { name: '修改密码' })).toHaveCSS('min-height', '36px');
  const settingsMenuTopInset = await mobileSettingsMenu.evaluate((menu) => {
    const drawer = menu.closest('.workspace-tree');
    const firstItem = menu.querySelector('button');
    return drawer === null || firstItem === null
      ? Number.NaN
      : Math.round(firstItem.getBoundingClientRect().top - drawer.getBoundingClientRect().top);
  });
  await page.getByRole('button', { name: '管理', exact: true }).click();
  const managementMenu = page.getByRole('navigation', { name: '管理菜单' });
  await expect(managementMenu).toBeVisible();
  const managementMenuTopInset = await managementMenu.evaluate((menu) => {
    const drawer = menu.closest('.workspace-tree');
    const firstItem = menu.querySelector('button');
    return drawer === null || firstItem === null
      ? Number.NaN
      : Math.round(firstItem.getBoundingClientRect().top - drawer.getBoundingClientRect().top);
  });
  expect(settingsMenuTopInset).toBe(8);
  expect(settingsMenuTopInset).toBe(managementMenuTopInset);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.locator('.workbench.settings.compact')).toHaveCSS('margin-left', '0px');
  const mobileSettingsBounds = await page
    .locator('.workbench.settings.compact')
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, viewportWidth: window.innerWidth };
    });
  expect(mobileSettingsBounds).toEqual({
    left: 0,
    right: mobileSettingsBounds.viewportWidth,
    viewportWidth: mobileSettingsBounds.viewportWidth
  });
  await page.getByRole('button', { name: '关闭侧滑菜单' }).click();
  await expect(page.getByRole('navigation', { name: '设置菜单' })).toHaveCount(0);
  await page.getByRole('button', { name: '管理', exact: true }).click();
  await page.getByRole('button', { name: '系统信息' }).click();
  await expect(page.locator('.workbench')).toHaveClass(/settings/);
  await expect(page.locator('.license-management')).toBeVisible();
  const importLicenseButton = page.getByRole('button', { name: '导入 License' });
  await importLicenseButton.scrollIntoViewIfNeeded();
  await expect(importLicenseButton).toBeInViewport();
  expect(writes).toEqual([]);
});
