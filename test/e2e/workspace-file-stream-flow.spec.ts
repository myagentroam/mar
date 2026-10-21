import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { NodeConnector } from '../../mar-node/src/connector.js';
import { unavailableCapabilities } from '../../mar-node/src/capabilities.js';
import { recordWebm, silentWave } from './support/file-preview-media.js';
import { INITIAL_ADMIN_PASSWORD } from '../../packages/server-core/src/password.js';

const executeFile = promisify(execFile);

test('Media previews play through real Web, Server, and Node while preserving Git Range windows', async ({
  page,
  baseURL,
  browser
}) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), 'mar-file-stream-flow-'));
  const workspacePath = join(root, 'project');
  await mkdir(workspacePath);
  let connector: NodeConnector | undefined;
  let nodeId: string | undefined;
  let csrfToken: string | undefined;
  let passwordChanged = false;
  const mediaRequests: { path: string; range: string | undefined }[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/files/content'))
      mediaRequests.push({
        path: url.searchParams.get('path') ?? '',
        range: request.headers()['range']
      });
  });
  try {
    const login = await page.request.post('/api/auth/login', {
      data: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    expect(login.status()).toBe(200);
    const bootstrapCookie = login.headers()['set-cookie']!.split(';')[0]!;
    const changed = await page.request.post('/api/auth/change-password', {
      headers: {
        origin: baseURL!,
        cookie: bootstrapCookie,
        'x-csrf-token': ((await login.json()) as { csrfToken: string }).csrfToken
      },
      data: { currentPassword: INITIAL_ADMIN_PASSWORD, password: 'FileStreamFlow123!' }
    });
    expect(changed.status()).toBe(200);
    passwordChanged = true;
    csrfToken = ((await changed.json()) as { csrfToken: string }).csrfToken;
    const cookie = changed.headers()['set-cookie']!.split(';')[0]!;
    await page.context().addCookies([
      {
        name: cookie.slice(0, cookie.indexOf('=')),
        value: decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1)),
        url: baseURL!,
        httpOnly: true,
        sameSite: 'Lax',
        secure: false
      }
    ]);
    // Generate media without bootstrapping Console and rotating the fixture's CSRF token.
    await page.goto('/manifest.webmanifest');
    const audio = silentWave();
    await writeFile(join(workspacePath, 'sound.wav'), audio);
    await writeFile(join(workspacePath, 'clip.webm'), await recordWebm(page));
    for (const args of [
      ['init', '-b', 'main'],
      ['config', 'user.name', 'Test'],
      ['config', 'user.email', 'test@example.invalid'],
      ['add', 'sound.wav', 'clip.webm'],
      ['commit', '-m', 'media fixtures']
    ])
      await executeFile('git', args, { cwd: workspacePath });
    const commit = (
      await executeFile('git', ['rev-parse', 'HEAD'], { cwd: workspacePath })
    ).stdout.trim();
    const registration = await page.request.post('/api/node-registration-tokens', {
      headers: { origin: baseURL!, 'x-csrf-token': csrfToken },
      data: { displayName: 'File stream fixture' }
    });
    expect(registration.status()).toBe(200);
    const serverURL = new URL(baseURL!);
    serverURL.port = process.env['MAR_E2E_SERVER_PORT'] ?? String(Number(serverURL.port) + 1);
    connector = new NodeConnector({
      configPath: join(root, 'node.json'),
      config: {
        serverUrl: serverURL.origin,
        allowedRoots: [root],
        dataDirectory: join(root, 'node-data'),
        registrationToken: ((await registration.json()) as { token: string }).token
      },
      capabilities: unavailableCapabilities(),
      reconnect: false
    });
    await connector.start();
    await expect
      .poll(async () => {
        const result = await page.request.get('/api/nodes');
        const { nodes } = (await result.json()) as {
          nodes: { id: string; connected: boolean; displayName: string }[];
        };
        nodeId = nodes.find(
          (node) => node.connected && node.displayName === 'File stream fixture'
        )?.id;
        return nodeId;
      })
      .toBeTruthy();
    const created = await page.request.post('/api/workspaces', {
      headers: { origin: baseURL!, 'x-csrf-token': csrfToken },
      data: { nodeId, path: workspacePath }
    });
    expect(created.status()).toBe(201);
    const workspaceId = ((await created.json()) as { workspace: { id: string } }).workspace.id;
    const contentUrl = `/api/workspaces/${workspaceId}/files/content?nodeId=${nodeId}&path=sound.wav`;
    const head = await page.request.head(contentUrl);
    expect(head.status()).toBe(200);
    expect(head.headers()['content-length']).toBe(String(audio.length));
    const range = await page.request.get(contentUrl, { headers: { range: 'bytes=524280-524304' } });
    expect(range.status()).toBe(206);
    expect((await range.body()).equals(audio.subarray(524280, 524305))).toBe(true);
    const anonymous = await browser.newContext();
    try {
      expect((await anonymous.request.get(`${baseURL}${contentUrl}`)).status()).toBe(401);
    } finally {
      await anonymous.close();
    }
    await page.goto(`/console?node=${nodeId}&workspace=${workspaceId}`);
    const tree = page.locator('.workspace-tree');
    await tree.getByRole('button', { name: 'File stream fixture', exact: true }).click();
    await tree.getByRole('button', { name: 'project', exact: true }).click();
    for (const [path, tag] of [
      ['sound.wav', 'audio'],
      ['clip.webm', 'video']
    ] as const) {
      await page.getByRole('treeitem', { name: path }).click();
      const preview = page.getByRole('dialog', { name: `${path} 文件预览` });
      const player = preview.locator(tag);
      await expect(player).toBeVisible();
      await expect(player).toHaveAttribute('src', /\/files\/content\?/u);
      await expect
        .poll(() => player.evaluate((element: HTMLMediaElement) => element.readyState))
        .toBeGreaterThanOrEqual(2);
      expect(
        mediaRequests.some(
          (request) => request.path === path && request.range?.startsWith('bytes=')
        )
      ).toBe(true);
      await player.evaluate(async (element: HTMLMediaElement) => {
        element.muted = true;
        await element.play();
      });
      await expect
        .poll(() => player.evaluate((element: HTMLMediaElement) => element.currentTime))
        .toBeGreaterThan(0);
      await player.evaluate((element: HTMLMediaElement) => element.pause());
      if (tag === 'audio') {
        await player.evaluate((element: HTMLMediaElement) => {
          element.currentTime = 120;
        });
        await expect
          .poll(() => player.evaluate((element: HTMLMediaElement) => element.seeking))
          .toBe(false);
        expect(
          await player.evaluate((element: HTMLMediaElement) => element.currentTime)
        ).toBeCloseTo(120);
      }
      expect(await player.evaluate((element: HTMLMediaElement) => element.error)).toBeNull();
      await page.locator('.workspace-file-tab.is-active .workspace-file-tab-close').click();
      await expect(preview).toHaveCount(0);
    }
    const historyUrl = `/api/workspaces/${workspaceId}/git/commits/${commit}/files/content?nodeId=${nodeId}&path=sound.wav`;
    const history = await page.request.get(historyUrl, { headers: { range: 'bytes=20971512-' } });
    expect(history.status()).toBe(206);
    expect(history.headers()['content-range']).toBe(`bytes 20971512-20971519/${audio.length}`);
    expect((await history.body()).length).toBe(8);
    const invalid = await page.request.get(historyUrl, { headers: { range: 'bytes=20971520-' } });
    expect(invalid.status()).toBe(416);
  } finally {
    await page.goto('about:blank');
    await connector?.stop();
    if (passwordChanged) {
      const current = await page.request.post('/api/auth/csrf', { headers: { origin: baseURL! } });
      expect(current.status()).toBe(200);
      csrfToken = ((await current.json()) as { csrfToken: string }).csrfToken;
    }
    if (nodeId !== undefined && csrfToken !== undefined)
      await page.request.delete(`/api/nodes/${nodeId}`, {
        headers: { origin: baseURL!, 'x-csrf-token': csrfToken }
      });
    if (passwordChanged && csrfToken !== undefined) {
      const restored = await page.request.post('/api/auth/change-password', {
        headers: { origin: baseURL!, 'x-csrf-token': csrfToken },
        data: { currentPassword: 'FileStreamFlow123!', password: INITIAL_ADMIN_PASSWORD }
      });
      expect(restored.status()).toBe(200);
    }
    await rm(root, { recursive: true, force: true });
  }
});
