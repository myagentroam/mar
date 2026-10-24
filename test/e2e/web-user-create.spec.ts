import { expect, test, type Page } from '@playwright/test';
import { startUserManagementFixture } from './support/user-management-vite.js';

// @test-covers ee/web/src/view/settings/UserManagementPage.vue

let fixture: Awaited<ReturnType<typeof startUserManagementFixture>>;
test.beforeAll(async () => {
  fixture = await startUserManagementFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

async function prepare(page: Page, locale = 'en-US') {
  const writes: { username: string; email: string; nickname: string }[] = [];
  let reads = 0;
  const users: { id: number; username: string; email: string; nickname: string }[] = [];
  let respond = async () => ({ status: 201, json: { temporaryPassword: 'fixture-password' } });
  await page.route('**/api/management/users**', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      writes.push(body);
      const response = await respond();
      if (response.status === 201) users.push({ id: writes.length, ...body });
      return route.fulfill(response);
    }
    reads += 1;
    return route.fulfill({
      json: { users, page: 1, pageSize: 20, total: users.length, hasMore: false }
    });
  });
  await page.goto(`${fixture.url}?locale=${locale}`);
  const create = page.locator('.table-actions').getByRole('button');
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
  test(`Create user cancellation clears drafts, errors and restores focus in ${locale}`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const ui = await prepare(page, locale);
    const inputs = ui.dialog.getByRole('textbox');
    for (const close of ['cancel', 'escape', 'icon', 'overlay']) {
      await ui.create.click();
      await expect(ui.dialog).toBeVisible();
      for (const input of await inputs.all()) await expect(input).toHaveValue('');
      await expect(ui.dialog.locator('.el-form-item__error')).toHaveCount(0);
      await inputs.nth(0).fill('discarded');
      await inputs.nth(1).fill('invalid-email');
      await inputs.nth(2).fill('Discarded nickname');
      await ui.dialog
        .getByRole('button', { name: locale === 'en-US' ? 'Create user' : '创建用户', exact: true })
        .click();
      await expect(ui.dialog.locator('.el-form-item__error')).toContainText([
        locale === 'en-US' ? 'Email must contain @.' : '邮箱必须包含 @。'
      ]);
      expect(ui.writes).toHaveLength(0);
      const bounds = (await ui.dialog.locator('.el-dialog').boundingBox())!;
      expect(bounds.width).toBeLessThanOrEqual(width - 32);
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
    for (const input of await inputs.all()) await expect(input).toHaveValue('');
    await expect(ui.dialog.locator('.el-form-item__error')).toHaveCount(0);
  });
}

test('Create user validates required, format and length boundaries without narrowing optional fields', async ({
  page
}) => {
  const ui = await prepare(page);
  await ui.create.click();
  const inputs = ui.dialog.getByRole('textbox');
  const submit = ui.dialog.getByRole('button', { name: 'Create user', exact: true });
  await submit.click();
  await expect(ui.dialog.locator('.el-form-item__error')).toHaveText(['Enter a username.']);
  expect(ui.writes).toHaveLength(0);
  await inputs.nth(0).fill('   ');
  await submit.click();
  await expect(ui.dialog.locator('.el-form-item__error')).toHaveText(['Enter a username.']);
  await inputs.nth(0).fill('u'.repeat(81));
  await inputs.nth(1).fill('@' + 'e'.repeat(254));
  await inputs.nth(2).fill('n'.repeat(81));
  await submit.click();
  await expect(ui.dialog.locator('.el-form-item__error')).toHaveText([
    'Use at most 80 characters.',
    'Use at most 254 characters.',
    'Use at most 80 characters.'
  ]);
  expect(ui.writes).toHaveLength(0);
  await inputs.nth(0).fill('😀'.repeat(41));
  await inputs.nth(1).fill('@' + '😀'.repeat(127));
  await inputs.nth(2).fill('😀'.repeat(41));
  await submit.click();
  await expect(ui.dialog.locator('.el-form-item__error')).toHaveText([
    'Use at most 80 characters.',
    'Use at most 254 characters.',
    'Use at most 80 characters.'
  ]);
  expect(ui.writes).toHaveLength(0);
  const boundary = {
    username: 'u'.repeat(80),
    email: '@' + 'e'.repeat(253),
    nickname: '😀'.repeat(40)
  };
  await inputs.nth(0).fill('  ' + boundary.username + '  ');
  await inputs.nth(1).fill('  ' + boundary.email + '  ');
  await inputs.nth(2).fill('  ' + boundary.nickname + '  ');
  await submit.click();
  await expect(ui.dialog).toHaveCount(0);
  const receipt = page.getByRole('dialog', { name: 'User Created', exact: true });
  await expect(receipt).toContainText('fixture-password');
  expect(ui.writes).toEqual([boundary]);
  await expect.poll(ui.reads).toBe(2);
  await receipt.locator('.el-dialog__headerbtn').click();
  await ui.create.click();
  await inputs.nth(0).fill('User with spaces / Unicode 用户');
  await inputs.nth(1).fill('   ');
  await inputs.nth(2).fill('   ');
  await submit.click();
  await expect(ui.dialog).toHaveCount(0);
  expect(ui.writes[1]).toEqual({
    username: 'User with spaces / Unicode 用户',
    email: '',
    nickname: ''
  });
});

test('Create user retains request failures for correction and retries with a visible credential receipt', async ({
  page
}) => {
  const ui = await prepare(page);
  ui.respond(async () => ({
    status: 409,
    json: { temporaryPassword: '', message: 'Username already exists' }
  }));
  await ui.create.click();
  const username = ui.dialog.getByRole('textbox', { name: 'Username' });
  await username.fill('duplicate');
  await ui.dialog.getByRole('button', { name: 'Create user', exact: true }).click();
  await expect(page.locator('.el-message--error')).toContainText('Username already exists');
  await expect(username).toHaveValue('duplicate');
  await expect(ui.dialog.getByRole('button', { name: 'Create user', exact: true })).toBeEnabled();
  ui.respond(async () => ({ status: 201, json: { temporaryPassword: 'corrected-user-password' } }));
  await username.fill('corrected');
  await ui.dialog.getByRole('button', { name: 'Create user', exact: true }).click();
  await expect(ui.dialog).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'User Created' })).toContainText(
    'corrected-user-password'
  );
  await expect(page.locator('.el-table')).toContainText('corrected');
  expect(ui.writes).toHaveLength(2);
});

for (const outcome of ['success', 'failure'] as const) {
  test(`Create user isolates a late ${outcome} during Dialog close and reopen`, async ({
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
        ? { status: 201, json: { temporaryPassword: 'old-user-password' } }
        : { status: 503, json: { temporaryPassword: '', message: 'Old request failed' } };
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
      (res) => res.request().method() === 'POST' && res.url().includes('/api/management/users')
    );
    release();
    await response;
    if (outcome === 'success') {
      const receipt = page.getByRole('dialog', { name: 'User Created', exact: true });
      await expect(receipt).toContainText('old-user-password');
      await expect.poll(ui.reads).toBe(2);
      await receipt.locator('.el-dialog__headerbtn').click();
    }
    await expect(username).toHaveValue('next-user');
    await expect(ui.dialog.getByRole('button', { name: 'Create user', exact: true })).toBeEnabled();
    await expect(page.locator('.el-message--error')).toHaveCount(0);
    expect(ui.writes).toHaveLength(1);
  });
}

test('Create user keeps the current one-time password visible until dismissal when an older write succeeds', async ({
  page
}) => {
  const ui = await prepare(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let count = 0;
  ui.respond(async () => {
    if (++count === 1) {
      await gate;
      return { status: 201, json: { temporaryPassword: 'old-password' } };
    }
    return { status: 201, json: { temporaryPassword: 'current-password' } };
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
  await receipt.locator('.el-dialog__headerbtn').click();
  await expect(receipt).toContainText('old-password');
  await expect(receipt).toContainText('old-user');
  await receipt.locator('.el-dialog__headerbtn').click();
  await expect(receipt).toHaveCount(0);
  await expect(ui.create).toBeFocused();
});
