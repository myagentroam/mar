import { expect, test, type Page, type Response } from '@playwright/test';
import mysql from 'mysql2/promise';
import { resolvePlaywrightTestDatabase } from './support/playwright-test-database.js';
import { INITIAL_ADMIN_PASSWORD } from '../../packages/server-core/src/password.js';

const HTTPS_SECRET = 'playwright-personal-git-token-only';
const DUPLICATE_SECRET = 'playwright-personal-git-duplicate-token';
const SSH_PRIVATE_KEY = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'test-only-private-key',
  '-----END OPENSSH PRIVATE KEY-----'
].join('\n');

interface PersonalGitCredential {
  readonly id: string;
  readonly name: string;
  readonly protocol: 'HTTPS' | 'SSH';
  readonly host: string;
  readonly port: number;
  readonly pathPrefix: string;
  readonly username: string;
  readonly commitName: string;
  readonly commitEmail: string;
  readonly hasSecret: boolean;
  readonly hasPassphrase: boolean;
  readonly secret?: unknown;
  readonly passphrase?: unknown;
}

interface PersonalGitConfiguration {
  readonly credentials: readonly PersonalGitCredential[];
}

interface PersonalGitResponse {
  readonly configuration: PersonalGitConfiguration;
}

test.beforeEach(async () => {
  const database = resolvePlaywrightTestDatabase(requiredTestRunId());
  const connection = await mysql.createConnection(database.databaseUrl);
  try {
    await connection.execute(
      "UPDATE users SET must_change_password=FALSE WHERE username='admin' AND is_fixed_admin=TRUE"
    );
  } finally {
    await connection.end();
  }
});

test('Personal Git settings persist commit identity in the unified Server, redact secrets, reject duplicate scopes, and support deletion', async ({
  page
}, testInfo) => {
  const credentialName = `Playwright HTTPS ${testInfo.project.name}`;
  const editedCredentialName = `${credentialName} edited`;
  const remotePath = `team-a/${testInfo.project.name}-project.git`;
  const remoteUrl = `https://git.example.test/${remotePath}`;
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 844 });
  await login(page);
  await openPersonalGitSettings(page);

  const settings = page.locator('.personal-git-settings');
  await expect(settings.getByRole('heading', { name: 'Git 配置' })).toBeVisible();
  await expect(settings.locator('.git-page-hint')).toHaveText(
    '仅用于 MyAgentRoam 后续新建的 Agent 执行和 Web 终端；主机终端、IDE 和其他程序不受影响。'
  );
  expect(pageErrors).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  const credentialDialog = page.getByRole('dialog', { name: '新增凭据' });
  await settings.getByRole('button', { name: '新增凭据', exact: true }).click();
  expect(pageErrors).toEqual([]);
  await expect(credentialDialog).toBeVisible();
  await credentialDialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(credentialDialog.getByText('请输入凭据名称。', { exact: true })).toBeVisible();
  await expect(
    credentialDialog.getByText('请输入有效的 HTTPS/SSH 远程地址，或 git@SSH 主机。', {
      exact: true
    })
  ).toBeVisible();
  await credentialDialog.getByRole('textbox', { name: '凭据名称' }).fill(credentialName);
  await credentialDialog.getByRole('textbox', { name: 'Git 远程地址' }).fill(remoteUrl);
  await credentialDialog.getByRole('textbox', { name: '认证用户名' }).fill('playwright');
  await credentialDialog.getByRole('textbox', { name: '提交姓名' }).fill('Playwright Git User');
  await credentialDialog
    .getByRole('textbox', { name: '提交邮箱' })
    .fill('playwright.git@example.test');
  await credentialDialog.getByRole('textbox', { name: 'Token 或密码' }).fill(HTTPS_SECRET);

  const createCredential = page.waitForResponse(
    isPersonalGitResponse('POST', '/api/personal-git/credentials')
  );
  await credentialDialog.getByRole('button', { name: '保存', exact: true }).click();
  const created = await personalGitResponse(createCredential);
  expect(created.configuration.credentials).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: credentialName,
        protocol: 'HTTPS',
        host: 'git.example.test',
        port: 443,
        pathPrefix: remotePath,
        username: 'playwright',
        commitName: 'Playwright Git User',
        commitEmail: 'playwright.git@example.test',
        hasSecret: true,
        hasPassphrase: false
      })
    ])
  );
  expect(JSON.stringify(created)).not.toContain(HTTPS_SECRET);
  expect(created.configuration.credentials[0]).not.toHaveProperty('secret');
  expect(created.configuration.credentials[0]).not.toHaveProperty('passphrase');
  await expect(credentialDialog).toHaveCount(0);

  const firstCredential = created.configuration.credentials.find(
    (credential) => credential.name === credentialName
  );
  if (firstCredential === undefined) throw new Error('PERSONAL_GIT_CREDENTIAL_MISSING');
  expect(firstCredential.id).toEqual(expect.any(String));

  const storedAfterCreate = await browserStorage(page);
  expect(storedAfterCreate).not.toContain(HTTPS_SECRET);
  expect(storedAfterCreate).not.toContain(DUPLICATE_SECRET);

  const detailDialog = page.getByRole('dialog', { name: '凭据详情' });
  const editDialog = page.getByRole('dialog', { name: '编辑凭据' });
  const credentialRow = settings.getByRole('row').filter({ hasText: credentialName });
  await expect(credentialRow).toHaveCSS('cursor', 'pointer');
  await credentialRow.click();
  await expect(detailDialog).toBeVisible();
  await expect(detailDialog.getByText(remoteUrl, { exact: true })).toBeVisible();
  await expect(detailDialog.getByRole('button', { name: '编辑', exact: true })).toHaveCount(0);
  await expect(detailDialog.getByRole('button', { name: '删除', exact: true })).toHaveCount(0);
  await detailDialog.getByRole('button', { name: '关闭', exact: true }).click();
  await credentialRow.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(editDialog).toBeVisible();
  await expect(editDialog.getByRole('textbox', { name: 'Git 远程地址' })).toHaveValue(remoteUrl);
  await expect(editDialog.getByRole('textbox', { name: 'Token 或密码' })).toHaveValue('');
  await editDialog.getByRole('textbox', { name: '凭据名称' }).fill(editedCredentialName);

  const updateCredential = page.waitForResponse(
    isPersonalGitResponse('PUT', `/api/personal-git/credentials/${firstCredential.id}`)
  );
  await editDialog.getByRole('button', { name: '保存', exact: true }).click();
  const updatedResponse = await updateCredential;
  const updatedRequest = updatedResponse.request().postDataJSON() as Record<string, unknown>;
  expect(updatedRequest).not.toHaveProperty('secret');
  const updated = await personalGitResponse(Promise.resolve(updatedResponse));
  expect(updated.configuration.credentials).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: firstCredential.id,
        name: editedCredentialName,
        hasSecret: true,
        hasPassphrase: false
      })
    ])
  );
  expect(JSON.stringify(updated)).not.toContain(HTTPS_SECRET);

  const sshCredentialName = `Playwright SSH host ${testInfo.project.name}`;
  const editedSshCredentialName = `${sshCredentialName} edited`;
  const sshHost = `ssh-${testInfo.project.name}.example.test`;
  await settings.getByRole('button', { name: '新增凭据', exact: true }).click();
  await expect(credentialDialog).toBeVisible();
  const sshRemote = credentialDialog.getByRole('textbox', { name: 'Git 远程地址' });
  await sshRemote.fill('git@');
  await sshRemote.blur();
  await expect(credentialDialog.locator('.el-form-item__error')).toHaveCount(0);
  await sshRemote.fill(`git@${sshHost}`);
  await expect(credentialDialog.getByRole('textbox', { name: '认证用户名' })).toHaveCount(0);
  await credentialDialog.getByRole('textbox', { name: '凭据名称' }).fill(sshCredentialName);
  await credentialDialog.getByRole('textbox', { name: '提交姓名' }).fill('Playwright SSH User');
  await credentialDialog
    .getByRole('textbox', { name: '提交邮箱' })
    .fill('playwright.ssh@example.test');
  await credentialDialog.getByRole('textbox', { name: 'SSH 私钥' }).fill(SSH_PRIVATE_KEY);
  const createSshCredential = page.waitForResponse(
    isPersonalGitResponse('POST', '/api/personal-git/credentials')
  );
  await credentialDialog.getByRole('button', { name: '保存', exact: true }).click();
  const sshCreated = await personalGitResponse(createSshCredential);
  expect(sshCreated.configuration.credentials).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: sshCredentialName,
        protocol: 'SSH',
        host: sshHost,
        port: 22,
        pathPrefix: '',
        username: 'git',
        commitName: 'Playwright SSH User',
        commitEmail: 'playwright.ssh@example.test',
        hasSecret: true,
        hasPassphrase: false
      })
    ])
  );
  expect(JSON.stringify(sshCreated)).not.toContain(SSH_PRIVATE_KEY);
  expect(await browserStorage(page)).not.toContain(SSH_PRIVATE_KEY);
  const sshCredential = sshCreated.configuration.credentials.find(
    (credential) => credential.name === sshCredentialName
  );
  if (sshCredential === undefined) throw new Error('PERSONAL_GIT_SSH_CREDENTIAL_MISSING');

  const sshCredentialRow = settings.getByRole('row').filter({ hasText: sshCredentialName });
  await sshCredentialRow.click();
  await expect(detailDialog).toBeVisible();
  await expect(detailDialog.getByRole('button', { name: '编辑', exact: true })).toHaveCount(0);
  await expect(detailDialog.getByRole('button', { name: '删除', exact: true })).toHaveCount(0);
  await detailDialog.getByRole('button', { name: '关闭', exact: true }).click();
  await sshCredentialRow.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(editDialog.getByRole('textbox', { name: 'Git 远程地址' })).toHaveValue(
    `git@${sshHost}`
  );
  await expect(editDialog.getByRole('textbox', { name: 'SSH 私钥' })).toHaveValue('');
  await editDialog.getByRole('textbox', { name: '凭据名称' }).fill(editedSshCredentialName);
  const updateSshCredential = page.waitForResponse(
    isPersonalGitResponse('PUT', `/api/personal-git/credentials/${sshCredential.id}`)
  );
  await editDialog.getByRole('button', { name: '保存', exact: true }).click();
  const updatedSshResponse = await updateSshCredential;
  expect(updatedSshResponse.request().postDataJSON()).not.toHaveProperty('secret');
  const sshUpdated = await personalGitResponse(Promise.resolve(updatedSshResponse));
  expect(sshUpdated.configuration.credentials).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: sshCredential.id,
        name: editedSshCredentialName,
        hasSecret: true
      })
    ])
  );

  await settings.getByRole('button', { name: '新增凭据', exact: true }).click();
  await expect(credentialDialog).toBeVisible();
  await credentialDialog.getByRole('textbox', { name: '凭据名称' }).fill('Duplicate HTTPS scope');
  await credentialDialog.getByRole('textbox', { name: 'Git 远程地址' }).fill(remoteUrl);
  await credentialDialog.getByRole('textbox', { name: '认证用户名' }).fill('other-user');
  await credentialDialog.getByRole('textbox', { name: '提交姓名' }).fill('Other Git User');
  await credentialDialog.getByRole('textbox', { name: '提交邮箱' }).fill('other.git@example.test');
  await credentialDialog.getByRole('textbox', { name: 'Token 或密码' }).fill(DUPLICATE_SECRET);
  const duplicateResponse = page.waitForResponse(
    isPersonalGitResponse('POST', '/api/personal-git/credentials')
  );
  await credentialDialog.getByRole('button', { name: '保存', exact: true }).click();
  expect((await duplicateResponse).status()).toBe(409);
  await expect(credentialDialog).toBeVisible();
  await credentialDialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(credentialDialog).toHaveCount(0);

  let deleteRequests = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'DELETE' &&
      new URL(request.url()).pathname === `/api/personal-git/credentials/${firstCredential.id}`
    )
      deleteRequests += 1;
  });
  const deleteButton = settings
    .getByRole('row')
    .filter({ hasText: editedCredentialName })
    .getByRole('button', { name: '删除', exact: true });
  await deleteButton.click();
  const deleteDialog = page.getByRole('dialog', { name: '删除' });
  await expect(deleteDialog).toBeVisible();
  await deleteDialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(deleteDialog).toHaveCount(0);
  expect(deleteRequests).toBe(0);

  await deleteButton.click();
  const deleted = page.waitForResponse(
    isPersonalGitResponse('DELETE', `/api/personal-git/credentials/${firstCredential.id}`)
  );
  await page
    .getByRole('dialog', { name: '删除' })
    .getByRole('button', { name: '确定', exact: true })
    .click();
  const deletedConfiguration = await personalGitResponse(deleted);
  expect(deleteRequests).toBe(1);
  expect(deletedConfiguration.configuration.credentials).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ id: firstCredential.id })])
  );

  const refreshed = page.waitForResponse(isPersonalGitResponse('GET', '/api/personal-git'));
  await page.reload();
  await openPersonalGitSettings(page);
  const reloaded = await personalGitResponse(refreshed);
  expect(reloaded.configuration.credentials).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ id: firstCredential.id })])
  );
  expect(await browserStorage(page)).not.toContain(HTTPS_SECRET);
  expect(await browserStorage(page)).not.toContain(DUPLICATE_SECRET);
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '外观', exact: true }).click();
  await page.getByRole('combobox', { name: '语言', exact: true }).press('Enter');
  const languageSaved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === '/api/auth/preferences/locale'
  );
  await page.getByRole('option', { name: 'English', exact: true }).click();
  expect((await languageSaved).ok()).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Git configuration', exact: true }).click();
  await expect(
    settings.getByRole('heading', { name: 'Git configuration', exact: true })
  ).toBeVisible();
  await expect(settings.locator('.git-page-hint')).toHaveText(
    'Applies only to new Agent executions and Web terminals created by MyAgentRoam; host terminals, IDEs, and other programs are unaffected.'
  );
  await expect(settings.getByRole('button', { name: 'Add credential', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(pageErrors).toEqual([]);
});

async function login(page: Page): Promise<void> {
  await page.goto('/console');
  await expect(page.getByRole('heading', { name: '继续你的 Agent 工作。' })).toBeVisible();
  await page.getByRole('textbox', { name: '账户' }).fill('admin');
  await page.getByRole('textbox', { name: '密码' }).fill(INITIAL_ADMIN_PASSWORD);
  await page.getByRole('button', { name: '进入控制台', exact: true }).click();

  await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible();
}

function requiredTestRunId(): string {
  const value = process.env['MAR_TEST_RUN_ID'];
  if (value === undefined || value === '') throw new Error('MAR_TEST_RUN_ID_REQUIRED');
  return value;
}

async function openPersonalGitSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: 'Git 配置', exact: true }).click();
}

function isPersonalGitResponse(method: string, path: string): (response: Response) => boolean {
  return (response) =>
    response.request().method() === method && new URL(response.url()).pathname === path;
}

async function personalGitResponse(response: Promise<Response>): Promise<PersonalGitResponse> {
  const result = await response;
  expect(result.ok()).toBeTruthy();
  return (await result.json()) as PersonalGitResponse;
}

async function browserStorage(page: Page): Promise<string> {
  return page.evaluate(() =>
    JSON.stringify({
      localStorage: Object.fromEntries(
        Array.from({ length: localStorage.length }, (_, index) => {
          const key = localStorage.key(index) ?? '';
          return [key, localStorage.getItem(key)];
        })
      ),
      sessionStorage: Object.fromEntries(
        Array.from({ length: sessionStorage.length }, (_, index) => {
          const key = sessionStorage.key(index) ?? '';
          return [key, sessionStorage.getItem(key)];
        })
      )
    })
  );
}
