import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { NodeConnector } from '../../mar-node/src/connector.js';
import { NodeDatabase } from '../../mar-node/src/database.js';
import { unavailableCapabilities } from '../../mar-node/src/capabilities.js';
import type { RunnerRegistry } from '../../mar-node/src/runner/runner-registry.js';
import type { WorkspaceSessionService } from '../../mar-node/src/workspace/workspace-session-service.js';
import { INITIAL_ADMIN_PASSWORD } from '../../packages/server-core/src/password.js';

test('Cold Node session discovery streams batches through the real relay and slow Runner retries do not expose persistent titles early', async ({
  page,
  baseURL
}) => {
  const root = await mkdtemp(join(tmpdir(), 'mar-session-discovery-flow-'));
  const workspacePath = join(root, 'project');
  await mkdir(workspacePath);
  const fast = deferred();
  const firstSlow = deferred();
  const retrySlow = deferred();
  const reads = new Map<string, number>();
  let connector: NodeConnector | undefined;
  let nodeId: string | undefined;
  let csrfToken: string | undefined;
  let passwordChanged = false;
  try {
    const login = await page.request.post('/api/auth/login', {
      data: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    expect(login.status()).toBe(200);
    const initial = (await login.json()) as { csrfToken: string };
    const bootstrapCookie = login.headers()['set-cookie']!.split(';')[0]!;
    const changed = await page.request.post('/api/auth/change-password', {
      headers: { origin: baseURL!, cookie: bootstrapCookie, 'x-csrf-token': initial.csrfToken },
      data: { currentPassword: INITIAL_ADMIN_PASSWORD, password: 'SessionDiscoveryFlow123!' }
    });
    expect(changed.status()).toBe(200);
    passwordChanged = true;
    csrfToken = ((await changed.json()) as { csrfToken: string }).csrfToken;
    const cookie = changed.headers()['set-cookie']!.split(';')[0]!;
    // The isolated E2E server is plaintext HTTP, including when production defaults mark cookies secure.
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
    const registration = await page.request.post('/api/node-registration-tokens', {
      headers: { origin: baseURL!, 'x-csrf-token': csrfToken },
      data: { displayName: 'Session discovery fixture' }
    });
    expect(registration.status()).toBe(200);
    const database = new NodeDatabase(':memory:', 'session-discovery-fixture');
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
      reconnect: false,
      database
    });
    const internals = connector as unknown as {
      runners: RunnerRegistry;
      workspaceSessionService: WorkspaceSessionService;
    };
    for (const runner of internals.runners.advertised()) {
      const name = runner.name;
      runner.available = () => name === 'mar-agent' || name === 'codex';
      runner.refreshProfile = async () => undefined;
      runner.discoverSessions = async (context, workspace) => {
        const count = (reads.get(name) ?? 0) + 1;
        reads.set(name, count);
        await (name === 'mar-agent'
          ? fast.promise
          : count === 1
            ? firstSlow.promise
            : retrySlow.promise);
        if (workspace === undefined) throw new Error('TEST_WORKSPACE_REQUIRED');
        return (
          name === 'mar-agent'
            ? [
                'fast-native',
                'explicit-custom',
                ...Array.from({ length: 45 }, (_, index) => `child-${index}`)
              ]
            : ['slow-custom']
        ).map((id) =>
          context.createProjection({
            workspace,
            runner: name as 'mar-agent' | 'codex',
            externalSessionId: id,
            cwd: workspace.path,
            title: id.startsWith('child-')
              ? `Child session ${id.slice(6)}`
              : id === 'fast-native'
                ? 'Fast native title'
                : 'Runner title',
            titleOrigin: 'OFFICIAL',
            lastActivityAt: id.startsWith('child-')
              ? 1000 + Number(id.slice(6))
              : id === 'fast-native'
                ? 200
                : 100
          })
        );
      };
    }
    await connector.start();
    await expect
      .poll(async () => {
        const response = await page.request.get('/api/nodes');
        const nodes = (await response.json()) as {
          nodes: { id: string; connected: boolean; displayName: string }[];
        };
        nodeId = nodes.nodes.find(
          (node) => node.connected && node.displayName === 'Session discovery fixture'
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
    for (let index = 0; index < 45; index += 1)
      database.saveNativeSessionMetadata({
        runner: 'mar-agent',
        externalSessionId: `child-${index}`,
        workspaceId,
        parentSessionId: 'fast-native'
      });
    database.saveNativeSessionMetadata({
      runner: 'mar-agent',
      externalSessionId: 'explicit-custom',
      workspaceId,
      customTitle: 'New Session'
    });
    database.saveNativeSessionMetadata({
      runner: 'codex',
      externalSessionId: 'slow-custom',
      workspaceId,
      customTitle: 'Pinned slow custom title',
      pinned: true
    });
    await page.goto(`/console?node=${nodeId}&workspace=${workspaceId}`);
    const tree = page.locator('.workspace-tree');
    await tree.getByRole('button', { name: 'Session discovery fixture', exact: true }).click();
    await tree.getByRole('button', { name: 'project', exact: true }).click();
    await expect.poll(() => reads.get('mar-agent')).toBe(1);
    await expect.poll(() => reads.get('codex')).toBe(1);
    const rows = page.locator('.session-list .session-link');
    await page.waitForTimeout(600);
    await expect(rows).toHaveCount(0);
    fast.resolve();
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: 'Fast native title' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'New Session' })).toHaveCount(1);
    await expect(page.getByRole('tab', { name: '主会话', exact: true })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await page.getByRole('tab', { name: '子会话', exact: true }).click();
    await expect(rows.filter({ hasText: 'Child session' }).first()).toBeVisible();
    await expect(rows.filter({ hasText: 'Fast native title' })).toHaveCount(0);
    await page.getByRole('tab', { name: '主会话', exact: true }).click();
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: 'Child session' })).toHaveCount(0);
    await expect(rows.filter({ hasText: 'Pinned slow custom title' })).toHaveCount(0);
    firstSlow.reject(new Error('TEST_NATIVE_DISCOVERY_FAILED'));
    expect(internals.workspaceSessionService.discoveryPending(workspaceId)).toBe(true);
    await page.getByRole('button', { name: '刷新当前工作区会话' }).click();
    await expect.poll(() => reads.get('codex')).toBe(2);
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: 'Pinned slow custom title' })).toHaveCount(0);
    retrySlow.resolve();
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText('Pinned slow custom title');
    await expect(rows.filter({ hasText: 'Fast native title' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'New Session' })).toHaveCount(1);
    await page.getByRole('tab', { name: '子会话', exact: true }).click();
    const child = page.locator('.session-list li').filter({ hasText: 'Child session 44' });
    await child.hover();
    await child.locator('.session-more-button').click();
    await page.getByRole('menuitem', { name: '移动到主会话' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '移动', exact: true }).click();
    await expect(child).toHaveCount(0);
    await expect(page.getByRole('tab', { name: '子会话', exact: true })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(
      database.getNativeSessionMetadata('mar-agent', 'child-44', workspaceId)?.parentSessionId
    ).toBeNull();
    await page.getByRole('tab', { name: '主会话', exact: true }).click();
    await expect(rows.filter({ hasText: 'Child session 44' })).toHaveCount(1);
  } finally {
    fast.resolve();
    firstSlow.resolve();
    retrySlow.resolve();
    await page.goto('about:blank');
    await connector?.stop();
    if (passwordChanged) {
      const current = await page.request.post('/api/auth/csrf', { headers: { origin: baseURL! } });
      expect(current.status()).toBe(200);
      csrfToken = ((await current.json()) as { csrfToken: string }).csrfToken;
    }
    if (csrfToken !== undefined && nodeId !== undefined)
      await page.request.delete(`/api/nodes/${nodeId}`, {
        headers: { origin: baseURL!, 'x-csrf-token': csrfToken }
      });
    if (passwordChanged && csrfToken !== undefined) {
      const restored = await page.request.post('/api/auth/change-password', {
        headers: { origin: baseURL!, 'x-csrf-token': csrfToken },
        data: { currentPassword: 'SessionDiscoveryFlow123!', password: INITIAL_ADMIN_PASSWORD }
      });
      expect(restored.status()).toBe(200);
    }
    await rm(root, { recursive: true, force: true });
  }
});

function deferred(): { promise: Promise<void>; resolve(): void; reject(error: Error): void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
