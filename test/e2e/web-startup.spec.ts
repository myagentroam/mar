import { expect, test } from '@playwright/test';
import { json, mockConsoleApi } from './support/web-console-api.js';

// These browser cases use mock APIs to isolate startup dependency ordering.
for (const resource of ['notifications', 'workbench-capabilities'] as const) {
  for (const failed of [false, true]) {
    test(`restores the selected session while ${resource} is pending, then ${failed ? 'fails' : 'completes'}`, async ({
      page
    }) => {
      await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
      await page.addInitScript(() => {
        sessionStorage.setItem('mar.user.csrf-token', 'csrf-1');
        localStorage.setItem(
          'mar.workbench.selection.v1',
          JSON.stringify({
            workspace: { nodeId: 'node-1', workspaceId: 'workspace-1' },
            sessionId: 'session-1'
          })
        );
      });
      await page.route('**/api/auth/me', (route) =>
        json(route, {
          authenticated: true,
          mustChangePassword: false,
          username: 'admin',
          isAdmin: true
        })
      );
      let release!: () => void;
      const pending = new Promise<void>((resolve) => (release = resolve));
      await page.route(`**/api/${resource}`, async (route) => {
        await pending;
        return route.fulfill({
          status: failed ? 503 : 200,
          contentType: 'application/json',
          body: JSON.stringify(
            failed
              ? { error: { code: 'SERVICE_UNAVAILABLE', message: 'Temporarily unavailable.' } }
              : resource === 'notifications'
                ? { notifications: [], recentRuns: [] }
                : { serverVersion: '0.11.3' }
          )
        });
      });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        const requested = page.waitForRequest(`**/api/${resource}`);
        await page.goto('/console');
        await requested;
        await expect(page.locator('.conversation-timeline')).toContainText('正在同步对话');
        const completed = page.waitForResponse(`**/api/${resource}`);
        release();
        expect((await completed).status()).toBe(failed ? 503 : 200);
        await expect(page.locator('.conversation-timeline')).toContainText('正在同步对话');
        expect(errors).toEqual([]);
      } finally {
        release();
      }
    });
  }
}

test('does not resume a pending workbench restoration after authentication is revoked', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.route('**/api/auth/me', (route) =>
    json(route, {
      authenticated: true,
      mustChangePassword: false,
      username: 'admin',
      isAdmin: true
    })
  );
  let releaseNodes!: () => void;
  let revokeAuthentication!: () => void;
  const pendingNodes = new Promise<void>((resolve) => (releaseNodes = resolve));
  const pendingNotifications = new Promise<void>((resolve) => (revokeAuthentication = resolve));
  await page.route('**/api/nodes', async (route) => {
    await pendingNodes;
    return route.fallback();
  });
  await page.route('**/api/notifications', async (route) => {
    await pendingNotifications;
    return route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' }
      })
    });
  });
  try {
    const nodesRequested = page.waitForRequest('**/api/nodes');
    await page.goto('/console');
    await nodesRequested;
    revokeAuthentication();
    await expect(page.getByRole('button', { name: '进入控制台', exact: true })).toBeVisible();
    const nodesReturned = page.waitForResponse('**/api/nodes');
    releaseNodes();
    await nodesReturned;
    await expect(page.getByRole('button', { name: '进入控制台', exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => {
        const sockets = (
          window as unknown as {
            __consoleMockWorkbenchWebSocket: { instances: { url: string }[] };
          }
        ).__consoleMockWorkbenchWebSocket.instances;
        return sockets.filter((socket) => socket.url.includes('/api/workbench/live')).length;
      })
    ).toBe(0);
  } finally {
    revokeAuthentication();
    releaseNodes();
  }
});
