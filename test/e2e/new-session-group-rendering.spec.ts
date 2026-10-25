import { expect, test, type Page } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';
import {
  emitMockWorkspaceSnapshot,
  fulfillMockSessionWatch,
  fulfillMockWorkspaceWatch,
  mockConsoleApi
} from './support/web-console-api.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
let pageErrors: string[];
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/new-session-group.html');
});
test.afterAll(async () => {
  await fixture?.close();
});
test.beforeEach(({ page }) => {
  pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
});
test.afterEach(() => expect(pageErrors).toEqual([]));

async function openWorkspace(page: Page, grouping = true) {
  await mockConsoleApi(page, 'MANAGED', ['turn.start'], [], 'DIRECTORY');
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        mustChangePassword: false,
        username: 'admin',
        isAdmin: true
      }
    })
  );
  const main = {
    id: 'created-main',
    nodeId: 'node-1',
    workspaceId: 'workspace-1',
    customTitle: 'Created main',
    runner: 'codex',
    nativeControl: 'MAR_MANAGED',
    externalSessionId: 'native-main',
    activity: 'IDLE',
    control: { level: 'MANAGED', capabilities: ['turn.start'] }
  };
  const child = {
    ...main,
    id: 'child-session',
    customTitle: 'Child session',
    sessionGroup: 'CHILD'
  };
  let created = false;
  await page.route('**/api/nodes', (route) =>
    route.fulfill({
      json: {
        nodes: [
          {
            id: 'node-1',
            displayName: 'Linux Node',
            platform: 'linux',
            connected: true,
            workspacesRoot: '/workspace',
            nodeAppVersion: '0.11.19',
            capabilities: { workbenchWatch: { apiVersion: 1 } }
          }
        ]
      }
    })
  );
  await page.route('**/api/workspaces?nodeId=node-1', (route) =>
    route.fulfill({
      json: {
        workspaces: [
          { id: 'workspace-1', displayName: 'Workspace A', path: '/project', kind: 'DIRECTORY' }
        ]
      }
    })
  );
  await page.route('**/api/nodes/node-1/workbench-capabilities', (route) =>
    route.fulfill({
      json: {
        manifest: {
          manifestVersion: 1,
          observedAt: 1,
          conversation: { available: true, reasonCode: null },
          ...(grouping ? { sessionGroups: { apiVersion: 1 } } : {})
        }
      }
    })
  );
  await page.route('**/api/agent-sessions?*', (route) => {
    const group = new URL(route.request().url()).searchParams.get('sessionGroup');
    return route.fulfill({
      json: { sessions: group === 'CHILD' ? [child] : created ? [main] : [] }
    });
  });
  await page.route('**/api/workspaces/workspace-1/watch', (route) =>
    fulfillMockWorkspaceWatch(page, route, undefined, 'DIRECTORY')
  );
  await page.route('**/api/agent-sessions/start', (route) => {
    created = true;
    return route.fulfill({
      json: {
        session: main,
        delivery: 'STARTED',
        run: {
          id: 'created-run',
          sessionId: main.id,
          workspaceId: main.workspaceId,
          status: 'COMPLETED',
          startedAt: 1,
          completedAt: 2
        }
      }
    });
  });
  await page.route('**/api/agent-sessions/*/watch', (route) =>
    fulfillMockSessionWatch(page, route, main, { session: main, turns: [], latestRun: null })
  );
  await page.route('**/api/agent-sessions/*?nodeId=node-1', (route) =>
    route.fulfill({ json: { session: main } })
  );
  await page.route('**/api/agent-sessions/*/turns*', (route) =>
    route.fulfill({ json: { turns: [] } })
  );
  await page.goto(`${fixture.url}new-session-group.html`);
  await page.getByRole('button', { name: 'Linux Node' }).click();
  await page.getByRole('button', { name: 'Workspace A' }).click();
  await expect(page.locator('.composer-input')).toBeVisible();
  return { main, child };
}

for (const entry of ['button', 'shortcut'] as const) {
  test(`explicit New via ${entry} restores Main and keeps the first sent session reachable`, async ({
    page
  }) => {
    const { main } = await openWorkspace(page);
    const mainTab = page.locator('.conversation-sidebar [role="tab"][data-group="MAIN"]');
    const childTab = page.locator('.conversation-sidebar [role="tab"][data-group="CHILD"]');
    await childTab.click();
    await expect(childTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.session-row')).toContainText('Child session');
    const input = page.locator('.composer-input');
    await input.fill('Keep the explicit new-session draft');
    if (entry === 'button') await page.locator('.new-session-button').click();
    else await input.press('Control+n');
    await expect(mainTab).toHaveAttribute('aria-selected', 'true');
    await expect(input).toHaveValue('Keep the explicit new-session draft');
    await expect(page.locator('.composer-send-button')).toBeEnabled();
    const startRequest = page.waitForRequest('**/api/agent-sessions/start');
    await page.locator('.composer-send-button').click();
    const start = (await startRequest).postDataJSON();
    expect(start).not.toHaveProperty('parentSessionId');
    expect(start).not.toHaveProperty('sessionGroup');
    await expect(page.locator('.composer-input')).toHaveValue('');
    // Simulate the authoritative Node directory projection, not a local append/setter.
    await emitMockWorkspaceSnapshot(page, 'sessions', { sessions: [main], sessionGroup: 'MAIN' });
    const row = page.locator('.session-row').filter({ hasText: 'Created main' });
    await expect(row).toBeVisible();
    await expect(row).toHaveClass(/selected/);
    await childTab.click();
    await expect(row).toHaveCount(0);
    await expect(page.locator('.conversation-header h2')).toContainText('Created main');
    await mainTab.click();
    await expect(row).toBeVisible();
    await page.locator('.new-session-button').click();
    await expect(row).not.toHaveClass(/selected/);
    await row.locator('.session-link').click();
    await expect(row).toHaveClass(/selected/);
    await expect(page.locator('.conversation-header h2')).toContainText('Created main');
  });
}

test('manual group changes preserve the Composer draft', async ({ page }) => {
  await openWorkspace(page);
  const input = page.locator('.composer-input');
  await input.fill('Manual group changes keep this text');
  await page.locator('.conversation-sidebar [data-group="CHILD"]').click();
  await expect(input).toHaveValue('Manual group changes keep this text');
  await page.locator('.conversation-sidebar [data-group="MAIN"]').click();
  await expect(input).toHaveValue('Manual group changes keep this text');
});

test('legacy Nodes retain the mixed list after explicit New and first send', async ({ page }) => {
  await openWorkspace(page, false);
  const input = page.locator('.composer-input');
  await expect(page.locator('.conversation-sidebar [role="tab"]')).toHaveCount(0);
  await page.locator('.new-session-button').click();
  await input.fill('Legacy Node first message');
  const startRequest = page.waitForRequest('**/api/agent-sessions/start');
  await page.locator('.composer-send-button').click();
  await startRequest;
  await expect(input).toHaveValue('');
  await emitMockWorkspaceSnapshot(page, 'sessions', {
    sessions: [
      {
        id: 'created-main',
        workspaceId: 'workspace-1',
        customTitle: 'Created main',
        runner: 'codex',
        nativeControl: 'MAR_MANAGED',
        externalSessionId: 'native-main',
        activity: 'IDLE',
        control: { level: 'MANAGED', capabilities: ['turn.start'] }
      }
    ]
  });
  await expect(page.locator('.session-row')).toContainText('Created main');
  await expect(page.locator('.session-row')).toHaveClass(/selected/);
  await expect(page.locator('.conversation-header h2')).toContainText('Created main');
});
