import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, request as apiRequest, test } from '@playwright/test';
import { NodeConnector } from '../../mar-node/src/connector.js';
import { unavailableCapabilities } from '../../mar-node/src/capabilities.js';
import { INITIAL_ADMIN_PASSWORD } from '../../packages/server-core/src/password.js';

const execute = promisify(execFile);

test('Parent Git repositories preserve child Workspace files and support disabling and reopening from details', async ({
  page,
  baseURL
}) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const root = await mkdtemp(join(tmpdir(), 'mar-parent-git-flow-'));
  const repository = join(root, 'repository');
  const workspacePath = join(repository, 'child');
  await mkdir(workspacePath, { recursive: true });
  const password = 'ParentGitFlow123!';
  let passwordChanged = false;
  let connector: NodeConnector | undefined;
  let nodeId: string | undefined;
  let csrfToken: string | undefined;
  const headers = () => ({ origin: baseURL!, 'x-csrf-token': csrfToken! });
  try {
    await writeFile(join(repository, 'same.txt'), 'parent before\n');
    await writeFile(join(workspacePath, 'same.txt'), 'child unchanged\n');
    for (const args of [
      ['init', '-b', 'main'],
      ['config', 'user.name', 'Test'],
      ['config', 'user.email', 'test@example.invalid'],
      ['add', '.'],
      ['commit', '-m', 'fixture']
    ])
      await execute('git', args, { cwd: repository });
    await writeFile(join(repository, 'same.txt'), 'parent after\n');
    const login = await page.request.post('/api/auth/login', {
      data: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    expect(login.status()).toBe(200);
    csrfToken = (await login.json()).csrfToken;
    const changed = await page.request.post('/api/auth/change-password', {
      headers: headers(),
      data: { currentPassword: INITIAL_ADMIN_PASSWORD, password }
    });
    expect(changed.status()).toBe(200);
    passwordChanged = true;
    csrfToken = (await changed.json()).csrfToken;
    const registration = await page.request.post('/api/node-registration-tokens', {
      headers: headers(),
      data: { displayName: 'Parent Git fixture' }
    });
    expect(registration.status()).toBe(200);
    const serverURL = new URL(baseURL!);
    serverURL.port = process.env.MAR_E2E_SERVER_PORT ?? String(Number(serverURL.port) + 1);
    connector = new NodeConnector({
      configPath: join(root, 'node.json'),
      config: {
        serverUrl: serverURL.origin,
        allowedRoots: [workspacePath],
        dataDirectory: join(root, 'node-data'),
        registrationToken: (await registration.json()).token
      },
      capabilities: unavailableCapabilities(),
      reconnect: false
    });
    await connector.start();
    await expect
      .poll(async () => {
        const result = await page.request.get('/api/nodes');
        const nodes = (await result.json()).nodes as {
          id: string;
          connected: boolean;
          displayName: string;
        }[];
        nodeId = nodes.find(
          (node) => node.connected && node.displayName === 'Parent Git fixture'
        )?.id;
        return nodeId;
      })
      .toBeTruthy();
    const created = await page.request.post('/api/workspaces', {
      headers: headers(),
      data: { nodeId, path: workspacePath }
    });
    expect(created.status()).toBe(201);
    const workspaceId = (await created.json()).workspace.id as string;
    const base = `/api/workspaces/${workspaceId}`;
    const policyUrl = `${base}/git-policy?nodeId=${nodeId}`;
    const ordinaryUrl = `${base}/files/read?nodeId=${nodeId}&path=same.txt`;
    const gitUrl = `${ordinaryUrl}&repositoryPath=`;
    expect((await (await page.request.get(policyUrl)).json()).includeParentRepository).toBe(true);
    expect((await (await page.request.get(ordinaryUrl)).json()).file.content).toBe(
      'child unchanged\n'
    );
    expect((await (await page.request.get(gitUrl)).json()).file.content).toBe('parent after\n');
    const changes = await page.request.get(`${base}/changes?nodeId=${nodeId}`);
    expect(changes.status()).toBe(200);
    expect((await changes.json()).repositoryRoot).toBe(repository);
    const range = await page.request.get(
      `${base}/files/content?nodeId=${nodeId}&path=same.txt&repositoryPath=`,
      { headers: { range: 'bytes=0-5' } }
    );
    expect(range.status()).toBe(206);
    expect((await range.body()).toString()).toBe('parent');
    const history = await page.request.get(`${base}/git/history?nodeId=${nodeId}`);
    expect(history.status()).toBe(200);

    await page.goto(`/console?node=${nodeId}&workspace=${workspaceId}`);
    const tree = page.locator('.workspace-tree');
    await tree.getByRole('button', { name: 'Parent Git fixture', exact: true }).click();
    await tree.getByRole('button', { name: 'child', exact: true }).click();
    await expect(page.getByRole('treeitem', { name: 'same.txt', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Git 变更', exact: true }).click();
    await page.locator('.change-path[title="same.txt"]').click();
    await page.keyboard.press('Control+e');
    const preview = page.getByRole('dialog', { name: 'same.txt 文件预览', exact: true });
    await expect(preview).toContainText('parent after');
    await expect(preview).not.toContainText('child unchanged');
    await page.locator('.workspace-file-tab.is-active .workspace-file-tab-close').click();
    await page.locator('.workspace-file-tab.is-active .workspace-file-tab-close').click();
    await tree.getByRole('button', { name: 'child', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '工作区详情', exact: true }).click();
    const details = page.getByRole('dialog', { name: '工作区详情', exact: true });
    const checkbox = details.getByRole('checkbox', { name: '使用父级 Git 仓库', exact: true });
    await expect(checkbox).toBeChecked();
    await details.getByText('使用父级 Git 仓库', { exact: true }).click();
    await expect(checkbox).not.toBeChecked();
    await details
      .locator('.workspace-git-settings')
      .getByRole('button', { name: '保存', exact: true })
      .click();
    await expect
      .poll(async () => (await (await page.request.get(policyUrl)).json()).includeParentRepository)
      .toBe(false);
    await expect.poll(async () => (await page.request.get(gitUrl)).ok()).toBe(false);
    expect((await (await page.request.get(ordinaryUrl)).json()).file.content).toBe(
      'child unchanged\n'
    );
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`${base}/files?nodeId=${nodeId}`)).json()).workspace.kind
      )
      .toBe('DIRECTORY');
    const token = await page.request.post('/api/auth/csrf', { headers: { origin: baseURL! } });
    csrfToken = (await token.json()).csrfToken;
    const again = await page.request.post('/api/workspaces', {
      headers: headers(),
      data: { nodeId, path: workspacePath }
    });
    // Node preserves the existing registration; Server rejects duplicate resource ownership.
    expect(again.status()).toBe(400);
    expect(await again.json()).toMatchObject({ error: { code: 'WORKSPACE_ID_CONFLICT' } });
    expect((await (await page.request.get(policyUrl)).json()).includeParentRepository).toBe(false);
    await expect(
      page.getByRole('tab', { name: 'Git 变更', exact: true, includeHidden: true })
    ).toHaveCount(0);
    await details.getByText('使用父级 Git 仓库', { exact: true }).click();
    await expect(checkbox).toBeChecked();
    await details
      .locator('.workspace-git-settings')
      .getByRole('button', { name: '保存', exact: true })
      .click();
    await expect
      .poll(async () => (await (await page.request.get(policyUrl)).json()).includeParentRepository)
      .toBe(true);
    await expect.poll(async () => (await page.request.get(gitUrl)).ok()).toBe(true);
    await expect(
      page.getByRole('tab', { name: 'Git 变更', exact: true, includeHidden: true })
    ).toHaveCount(1);
    expect(await readFile(join(workspacePath, 'same.txt'), 'utf8')).toBe('child unchanged\n');
  } finally {
    await page.goto('about:blank').catch(() => undefined);
    await connector?.stop();
    try {
      if (passwordChanged) {
        const cleanup = await apiRequest.newContext({ baseURL });
        try {
          const login = await cleanup.post('/api/auth/login', {
            data: { username: 'admin', password }
          });
          expect(login.status()).toBe(200);
          csrfToken = (await login.json()).csrfToken;
          if (nodeId) await cleanup.delete(`/api/nodes/${nodeId}`, { headers: headers() });
          const restored = await cleanup.post('/api/auth/change-password', {
            headers: headers(),
            data: { currentPassword: password, password: INITIAL_ADMIN_PASSWORD }
          });
          expect(restored.status()).toBe(200);
        } finally {
          await cleanup.dispose();
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
