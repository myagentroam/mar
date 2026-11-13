import { expect, test, type Page } from '@playwright/test';
import { startUserManagementFixture } from './support/user-management-vite.js';

// @test-covers ee/web/src/composition/enterprise-management.ts
// @test-covers ee/web/src/view/settings/EnterpriseUserManagementPage.vue
// @test-covers ee/web/src/view/settings/UserManagementPage.vue

let fixture: Awaited<ReturnType<typeof startUserManagementFixture>>;
test.beforeAll(async () => {
  fixture = await startUserManagementFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

interface UserInput {
  username: string;
  email?: string;
  nickname?: string;
  role: string;
  organizationId: number;
}
async function prepare(page: Page, locale = 'en-US') {
  const writes: UserInput[] = [];
  let reads = 0;
  const users: object[] = [];
  let respond = async (
    body: UserInput
  ): Promise<{ status: number; json: Record<string, unknown> }> => ({
    status: 201,
    json: { user: body, temporaryPassword: 'fixture-password' }
  });
  await page.route('**/api/management/users**', () => {
    throw new Error('Unregistered legacy users API reached');
  });
  await page.route('**/api/organizations', (route) =>
    route.fulfill({
      json: {
        organizations: [
          { id: 1, name: 'Root', parentOrganizationId: null },
          { id: 2, name: 'Team', parentOrganizationId: 1 }
        ]
      }
    })
  );
  await page.route('**/api/enterprise/users**', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as UserInput;
      writes.push(body);
      const response = await respond(body);
      if (response.status === 201)
        users.push({ id: users.length + 1, ...body, fixedAdmin: false, enabled: true });
      return route.fulfill(response);
    }
    reads += 1;
    return route.fulfill({
      json: { users, page: 1, pageSize: 20, total: users.length, hasMore: false }
    });
  });
  await page.goto(`${fixture.url}?locale=${locale}`);
  const create = page.locator('.mar-table-actions').getByRole('button', {
    name: locale === 'en-US' ? 'Create user' : '创建用户',
    exact: true
  });
  await expect(create).toBeVisible();
  return {
    writes,
    reads: () => reads,
    respond: (handler: typeof respond) => {
      respond = handler;
    },
    create,
    dialog: page.getByRole('dialog', {
      name: locale === 'en-US' ? 'Create User' : '创建用户',
      exact: true
    })
  };
}

for (const [locale, width] of [
  ['en-US', 1280],
  ['zh-CN', 390]
] as const) {
  test(`Registered users form clears cancelled drafts and validation in ${locale}`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const ui = await prepare(page, locale);
    for (const close of ['cancel', 'escape', 'icon', 'overlay']) {
      await ui.create.click();
      const username = ui.dialog.getByRole('textbox', {
        name: locale === 'en-US' ? 'Username' : '用户名'
      });
      const email = ui.dialog.getByRole('textbox', { name: locale === 'en-US' ? 'Email' : '邮箱' });
      const nickname = ui.dialog.getByRole('textbox', {
        name: locale === 'en-US' ? 'Display Name' : '显示名称'
      });
      await expect(username).toHaveValue('');
      await expect(email).toHaveValue('');
      await expect(nickname).toHaveValue('');
      await expect(ui.dialog.locator('.el-form-item__error')).toHaveCount(0);
      await username.fill('discarded');
      await email.fill('invalid-email');
      await nickname.fill('Discarded nickname');
      await ui.dialog
        .getByRole('button', { name: locale === 'en-US' ? 'Create user' : '创建用户', exact: true })
        .click();
      await expect(ui.dialog.locator('.el-form-item__error')).toHaveText([
        locale === 'en-US' ? 'Enter a valid email address' : '请输入有效邮箱'
      ]);
      expect(ui.writes).toHaveLength(0);
      expect((await ui.dialog.locator('.el-dialog').boundingBox())!.width).toBeLessThanOrEqual(
        width - 32
      );
      if (close === 'cancel')
        await ui.dialog
          .getByRole('button', { name: locale === 'en-US' ? 'Cancel' : '取消', exact: true })
          .click();
      else if (close === 'escape') await page.keyboard.press('Escape');
      else if (close === 'icon') await ui.dialog.locator('.el-dialog__headerbtn').click();
      else await page.mouse.click(4, 4);
      await expect(ui.dialog).toHaveCount(0);
      await expect(ui.create).toBeFocused();
    }
    await ui.create.click();
    await expect(ui.dialog.locator('.el-form-item__error')).toHaveCount(0);
  });
}

test('Registered users form retains its existing validation and optional role/organization payload', async ({
  page
}) => {
  const ui = await prepare(page);
  await ui.create.click();
  const username = ui.dialog.getByRole('textbox', { name: 'Username' });
  const email = ui.dialog.getByRole('textbox', { name: 'Email' });
  const nickname = ui.dialog.getByRole('textbox', { name: 'Display Name' });
  const submit = ui.dialog.getByRole('button', { name: 'Create user', exact: true });
  await expect(ui.dialog.getByRole('combobox', { name: 'Role' })).toBeVisible();
  await expect(ui.dialog.getByRole('textbox', { name: 'Organization' })).toHaveValue('Root');
  await submit.click();
  await expect(ui.dialog.locator('.el-form-item__error')).toHaveText(['Enter a username']);
  await username.fill('   ');
  await submit.click();
  await expect(ui.dialog.locator('.el-form-item__error')).toHaveText(['Enter a username']);
  await username.fill('u'.repeat(81));
  const boundaryEmail =
    'a'.repeat(64) + '@' + 'b'.repeat(63) + '.' + 'c'.repeat(63) + '.' + 'd'.repeat(61);
  await email.fill(boundaryEmail + 'd');
  await nickname.fill('n'.repeat(81));
  await submit.click();
  await expect(ui.dialog.locator('.el-form-item__error')).toHaveText([
    'The username cannot exceed 80 characters',
    'The email address cannot exceed 254 characters',
    'The display name cannot exceed 80 characters'
  ]);
  expect(ui.writes).toHaveLength(0);
  await username.fill('valid');
  await email.fill('not-an-email');
  await nickname.fill('');
  await submit.click();
  await expect(ui.dialog.locator('.el-form-item__error')).toHaveText([
    'Enter a valid email address'
  ]);
  expect(ui.writes).toHaveLength(0);
  const boundary = {
    username: 'u'.repeat(80),
    email: boundaryEmail,
    nickname: 'n'.repeat(80),
    role: 'MEMBER',
    organizationId: 1
  };
  await username.fill(boundary.username);
  await email.fill(boundary.email);
  await nickname.fill(boundary.nickname);
  await submit.click();
  const receipt = page.getByRole('dialog', { name: 'User Created', exact: true });
  await expect(receipt).toContainText('fixture-password');
  expect(ui.writes).toEqual([boundary]);
  await expect.poll(ui.reads).toBe(2);
  await receipt.getByRole('button', { name: 'Done', exact: true }).click();
  await ui.create.click();
  await username.fill('User with spaces 用户');
  await submit.click();
  await expect(ui.dialog).toHaveCount(0);
  expect(ui.writes[1]).toEqual({
    username: 'User with spaces 用户',
    role: 'MEMBER',
    organizationId: 1
  });
  await receipt.getByRole('button', { name: 'Done', exact: true }).click();
  await ui.create.click();
  await username.fill('scoped-user');
  await ui.dialog.getByRole('combobox', { name: 'Role' }).press('Enter');
  await page.getByRole('option', { name: /organization administrator/i }).click();
  await ui.dialog.getByRole('textbox', { name: 'Organization' }).click();
  await page.getByRole('menuitem', { name: 'Root' }).click();
  await expect(page.getByRole('menuitem', { name: 'Team' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Team' }).click();
  await expect(ui.dialog.getByRole('textbox', { name: 'Organization' })).toHaveValue(/Team/);
  await submit.click();
  await expect(receipt).toContainText('scoped-user');
  expect(ui.writes[2]).toEqual({ username: 'scoped-user', role: 'ORG_ADMIN', organizationId: 2 });
});

test('Registered users form preserves failures for correction and delivers successful credentials', async ({
  page
}) => {
  const ui = await prepare(page);
  ui.respond(async () => ({ status: 409, json: { message: 'Username already exists' } }));
  await ui.create.click();
  const username = ui.dialog.getByRole('textbox', { name: 'Username' });
  await username.fill('duplicate');
  await ui.dialog.getByRole('button', { name: 'Create user', exact: true }).click();
  await expect(page.locator('.el-message--error')).toContainText('Username already exists');
  await expect(username).toHaveValue('duplicate');
  ui.respond(async () => ({
    status: 201,
    json: { user: { username: 'returned-user' }, temporaryPassword: 'corrected-user-password' }
  }));
  await username.fill('corrected');
  await ui.dialog.getByRole('button', { name: 'Create user', exact: true }).click();
  await expect(ui.dialog).toHaveCount(0);
  const receipt = page.getByRole('dialog', { name: 'User Created' });
  await expect(receipt).toContainText('returned-user');
  await expect(receipt).toContainText('corrected-user-password');
  await expect(page.locator('.el-table')).toContainText('corrected');
  expect(ui.writes).toHaveLength(2);
});

for (const outcome of ['success', 'failure'] as const) {
  test(`Registered users isolates a late ${outcome} after cancelling and reopening`, async ({
    page
  }) => {
    const ui = await prepare(page);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    ui.respond(async () => {
      await pending;
      return outcome === 'success'
        ? {
            status: 201,
            json: { user: { username: 'old-user' }, temporaryPassword: 'old-user-password' }
          }
        : { status: 503, json: { message: 'Old request failed' } };
    });
    await ui.create.click();
    await ui.dialog.getByRole('textbox', { name: 'Username' }).fill('old-user');
    await ui.dialog.getByRole('button', { name: 'Create user', exact: true }).click();
    await expect.poll(() => ui.writes.length).toBe(1);
    await ui.dialog.locator('.el-dialog__headerbtn').click();
    await expect(ui.dialog).toHaveCount(0);
    await ui.create.click();
    const username = ui.dialog.getByRole('textbox', { name: 'Username' });
    await expect(username).toHaveValue('');
    await username.fill('next-user');
    const response = page.waitForResponse(
      (res) => res.request().method() === 'POST' && res.url().includes('/api/enterprise/users')
    );
    release();
    await response;
    if (outcome === 'success') {
      const receipt = page.getByRole('dialog', { name: 'User Created', exact: true });
      await expect(receipt).toContainText('old-user-password');
      await expect.poll(ui.reads).toBe(2);
      await receipt.getByRole('button', { name: 'Done', exact: true }).click();
    }
    await expect(username).toHaveValue('next-user');
    await expect(ui.dialog.getByRole('button', { name: 'Create user', exact: true })).toBeEnabled();
    await expect(page.locator('.el-message--error')).toHaveCount(0);
    expect(ui.writes).toHaveLength(1);
  });
}

test('Registered users preserves both one-time credentials when the old write finishes last', async ({
  page
}) => {
  const ui = await prepare(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let count = 0;
  ui.respond(async (body) => {
    if (++count === 1) {
      await gate;
      return { status: 201, json: { user: body, temporaryPassword: 'old-password' } };
    }
    return { status: 201, json: { user: body, temporaryPassword: 'current-password' } };
  });
  await ui.create.click();
  await ui.dialog.getByRole('textbox', { name: 'Username' }).fill('old-user');
  await ui.dialog.getByRole('button', { name: 'Create user', exact: true }).click();
  await expect.poll(() => ui.writes.length).toBe(1);
  await ui.dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await ui.create.click();
  await ui.dialog.getByRole('textbox', { name: 'Username' }).fill('current-user');
  await ui.dialog.getByRole('button', { name: 'Create user', exact: true }).click();
  const receipt = page.getByRole('dialog', { name: 'User Created', exact: true });
  await expect(receipt).toContainText('current-password');
  release();
  await expect.poll(ui.reads).toBe(3);
  await expect(receipt).toContainText('current-password');
  await expect(receipt).not.toContainText('old-password');
  await receipt.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(receipt).toContainText('old-password');
  await expect(receipt).toContainText('old-user');
  await receipt.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(receipt).toHaveCount(0);
});

type ClipboardBehavior = 'missing' | 'non-callable' | 'throws' | 'rejects' | 'succeeds';

async function preparePersonalCredentials(
  page: import('@playwright/test').Page,
  locale: 'en-US' | 'zh-CN',
  clipboardBehavior: ClipboardBehavior
) {
  const writes: Record<string, unknown>[] = [];
  let pageErrors = 0;
  page.on('pageerror', () => {
    pageErrors += 1;
  });
  await page.addInitScript((behavior: ClipboardBehavior) => {
    const fixture = { calls: 0, copiedText: '', unhandledRejections: 0 };
    Object.defineProperty(window, '__credentialClipboardFixture', { value: fixture });
    window.addEventListener('unhandledrejection', (event) => {
      fixture.unhandledRejections += 1;
      event.preventDefault();
    });
    const writeText =
      behavior === 'missing'
        ? undefined
        : behavior === 'non-callable'
          ? null
          : (value: string) => {
              fixture.calls += 1;
              if (behavior === 'throws') throw new Error('Fixture clipboard write failed');
              if (behavior === 'rejects')
                return Promise.reject(new Error('Fixture clipboard write failed'));
              fixture.copiedText = value;
              return Promise.resolve();
            };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: behavior === 'missing' ? undefined : { writeText }
    });
  }, clipboardBehavior);
  await page.route('**/api/management/users**', async (route) => {
    const method = route.request().method();
    if (method === 'POST') {
      writes.push(route.request().postDataJSON() as Record<string, unknown>);
      return route.fulfill({
        status: 201,
        json: { temporaryPassword: 'fixture-temporary-password' }
      });
    }
    if (method === 'GET')
      return route.fulfill({
        json: { users: [], page: 1, pageSize: 20, total: 0, hasMore: false }
      });
    throw new Error(`Unexpected user-management method: ${method}`);
  });
  await page.goto(`${fixture.url}?locale=${locale}&page=personal`);

  const copy = locale === 'en-US' ? 'Copy username and password' : '复制用户名和密码';
  const create = locale === 'en-US' ? 'Create user' : '创建用户';
  const createTitle = locale === 'en-US' ? 'Create User' : '创建用户';
  const createdTitle = locale === 'en-US' ? 'User Created' : '创建成功';
  const usernameLabel = locale === 'en-US' ? 'Username' : '用户名';
  const createTrigger = page.locator('.mar-table-actions').getByRole('button', {
    name: create,
    exact: true
  });
  await expect(createTrigger).toBeVisible();
  await createTrigger.click();
  const createDialog = page.getByRole('dialog', { name: createTitle, exact: true });
  await createDialog.getByRole('textbox', { name: usernameLabel }).fill('fixture-user');
  await createDialog.getByRole('button', { name: create, exact: true }).click();

  const credentials = page.getByRole('dialog', { name: createdTitle, exact: true });
  await expect(credentials).toBeVisible();
  await expect(credentials.locator('.credential-result dd')).toHaveText([
    'fixture-user',
    'fixture-temporary-password'
  ]);
  return {
    credentials,
    copy: credentials.getByRole('button', { name: copy, exact: true }),
    writes,
    pageErrors: () => pageErrors,
    clipboardFixture: () =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __credentialClipboardFixture: {
                calls: number;
                copiedText: string;
                unhandledRejections: number;
              };
            }
          ).__credentialClipboardFixture
      )
  };
}

const manualCopyMessage = {
  'en-US': 'Unable to access the clipboard. Copy the username and password manually.',
  'zh-CN': '无法访问剪贴板，请手动复制用户名和密码。'
} as const;

for (const locale of ['en-US', 'zh-CN'] as const) {
  for (const behavior of ['missing', 'non-callable', 'throws', 'rejects'] as const) {
    test(`Personal user credentials show manual-copy feedback for ${behavior} clipboard API (${locale})`, async ({
      page
    }) => {
      const ui = await preparePersonalCredentials(page, locale, behavior);
      await ui.copy.click();

      const errorMessage = page.locator('.el-message--error');
      await expect(errorMessage).toHaveCount(1);
      await expect(errorMessage.locator('.el-message__content')).toHaveText(
        manualCopyMessage[locale]
      );
      await expect(ui.credentials).toBeVisible();
      await expect(ui.credentials.locator('.credential-result dd')).toHaveText([
        'fixture-user',
        'fixture-temporary-password'
      ]);
      const selections = await ui.credentials
        .locator('.credential-result dd')
        .evaluateAll((nodes) =>
          nodes.map((node) => {
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(node);
            selection?.removeAllRanges();
            selection?.addRange(range);
            return {
              text: selection?.toString(),
              userSelect: getComputedStyle(node).userSelect
            };
          })
        );
      expect(selections.map((selection) => selection.text)).toEqual([
        'fixture-user',
        'fixture-temporary-password'
      ]);
      expect(selections.every((selection) => selection.userSelect !== 'none')).toBe(true);
      await expect(errorMessage).not.toContainText('fixture-user');
      await expect(errorMessage).not.toContainText('fixture-temporary-password');
      expect(ui.writes).toHaveLength(1);
      const clipboard = await ui.clipboardFixture();
      expect(clipboard.calls).toBe(behavior === 'missing' || behavior === 'non-callable' ? 0 : 1);
      expect(clipboard.unhandledRejections).toBe(0);
      expect(ui.pageErrors()).toBe(0);
    });
  }

  test(`Personal user credentials copy the existing format on clipboard success (${locale})`, async ({
    page
  }) => {
    const ui = await preparePersonalCredentials(page, locale, 'succeeds');
    await ui.copy.click();
    const expectedPayload =
      locale === 'en-US'
        ? 'Username: fixture-user\nPassword: fixture-temporary-password'
        : '用户名：fixture-user\n密码：fixture-temporary-password';
    const clipboard = await ui.clipboardFixture();
    expect(clipboard.calls).toBe(1);
    expect(clipboard.copiedText).toBe(expectedPayload);
    expect(clipboard.unhandledRejections).toBe(0);
    expect(ui.pageErrors()).toBe(0);
    await expect(page.locator('.el-message')).toHaveCount(0);
    await expect(ui.credentials).toBeVisible();
    expect(ui.writes).toHaveLength(1);

    await ui.credentials.locator('.el-dialog__headerbtn').click();
    await expect(ui.credentials).toHaveCount(0);
    await page
      .locator('.mar-table-actions')
      .getByRole('button', { name: locale === 'en-US' ? 'Create user' : '创建用户', exact: true })
      .click();
    await expect(
      page.getByRole('dialog', {
        name: locale === 'en-US' ? 'Create User' : '创建用户',
        exact: true
      })
    ).toBeVisible();
    expect(ui.writes).toHaveLength(1);
  });
}
