import { expect, test, type Locator, type Page } from '@playwright/test';
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

async function openWorkspace(
  page: Page,
  grouping = true,
  marOnly = false,
  options: {
    manifestFailure?: boolean;
    pendingProfiles?: Promise<void>;
    createdRunner?: 'codex' | 'claude-code';
  } = {}
) {
  await mockConsoleApi(page, 'MANAGED', ['turn.start'], [], 'DIRECTORY');
  const pendingProfiles = options.pendingProfiles;
  if (pendingProfiles)
    await page.route('**/api/runner-profiles?*', async (route) => {
      await pendingProfiles;
      await route.fallback();
    });
  if (marOnly)
    await page.route('**/api/runner-profiles?*', (route) =>
      route.fulfill({
        json: {
          profiles: [
            {
              runner: 'mar-agent',
              models: [{ id: 'model', label: 'Model', supportedEfforts: [] }],
              accessOptions: [{ id: 'auto', label: 'Auto' }],
              commands: [],
              capabilities: ['turn.start']
            }
          ]
        }
      })
    );
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        userId: 1,
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
    runner: options.createdRunner ?? 'codex',
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
  await page.route('**/api/nodes/node-1/workbench-capabilities', (route) => {
    if (options.manifestFailure)
      return route.fulfill({
        status: 503,
        json: {
          error: { code: 'TEST_MANIFEST_FAILURE', message: 'Manifest could not be read.' }
        }
      });
    return route.fulfill({
      json: {
        manifest: {
          manifestVersion: 1,
          observedAt: 1,
          conversation: { available: true, reasonCode: null },
          ...(grouping ? { sessionGroups: { apiVersion: 1 } } : {})
        }
      }
    });
  });
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

test('A failed manifest read has one error and no unknown-capability placeholder', async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openWorkspace(page, true, false, { manifestFailure: true });
  await expect(page.locator('.mar-message')).toHaveCount(1);
  await expect(page.locator('.mar-message')).toContainText('Manifest could not be read.');
  const input = page.locator('.composer-input');
  await expect(input).toHaveJSProperty('readOnly', true);
  await expect(input).not.toHaveAttribute('placeholder', /capabilit|unknown|能力|只读/i);
  await expect(input).toHaveAttribute('placeholder', /^(Type \/|输入 \/)/);
  await expect(page.locator('.readonly-banner')).toHaveCount(0);
});

test('Workspace welcome does not advertise an Agent before profiles arrive', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 820 });
  await page.addInitScript(() => localStorage.setItem('mar.locale.v2', 'en-US'));
  const profiles = Promise.withResolvers<void>();
  const welcome = page.locator('.conversation-empty');
  const composerGap = async (description: Locator) => {
    const subtitle = (await description.boundingBox())!;
    const composer = (await page.locator('.composer-shell').boundingBox())!;
    return composer.y - (subtitle.y + subtitle.height);
  };
  let loadingGap: number;
  try {
    await openWorkspace(page, true, false, { pendingProfiles: profiles.promise });
    await expect(welcome.getByRole('heading')).toHaveText('What should we do?');
    await expect(welcome.getByRole('button', { name: /Switch Agent/ })).toHaveCount(0);
    loadingGap = await composerGap(welcome.locator('p'));
  } finally {
    profiles.resolve();
  }
  await expect(
    welcome.getByRole('button', { name: 'Switch Agent (current: Codex)' })
  ).toBeEnabled();
  const description = welcome.locator('.draft-session-description');
  expect(await composerGap(description)).toBeCloseTo(loadingGap, 0);
  const textBaselineDifference = await description.evaluate((line) => {
    const range = document.createRange();
    range.selectNodeContents(line.firstChild!);
    const subtitleTop = range.getBoundingClientRect().top;
    range.selectNodeContents(line.querySelector('.draft-agent-label > span')!);
    return Math.abs(subtitleTop - range.getBoundingClientRect().top);
  });
  expect(textBaselineDifference).toBeLessThanOrEqual(1);
});

for (const viewport of [1600, 390]) {
  test.describe(`Workspace draft at ${viewport}px`, () => {
    test.use({ hasTouch: viewport < 768 });
    // @test-covers packages/web-core/src/view/workbench/WorkspaceSessionPane.vue
    // @test-covers packages/web-core/src/view/composer/ComposerToolbar.vue
    test('chooses its Agent from the welcome prompt', async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1600, height: 820 });
      await page.addInitScript(() => localStorage.setItem('mar.locale.v2', 'zh-CN'));
      await openWorkspace(page, true, false, { createdRunner: 'claude-code' });
      await page.setViewportSize({ width: viewport, height: 820 });

      const welcome = page.locator('.conversation-empty');
      const agent = welcome.getByRole('button', { name: /切换 Agent/ });
      const toolbar = page.locator('.composer-toolbar');
      const model = toolbar.getByRole('combobox', { name: '模型与思考强度' });
      const input = page.locator('.composer-input');
      await expect(welcome.getByRole('heading')).toHaveText('我们要做什么？');
      const description = welcome.locator('.draft-session-description');
      await expect(description).toHaveText('使用 Codex 创建新会话', { useInnerText: true });
      await expect(agent).toHaveCSS('font-weight', '400');
      const agentIcon = agent.locator('img');
      await expect(agentIcon).toBeVisible();
      await expect(agent).toHaveAttribute('aria-haspopup', 'menu');
      await expect(welcome.getByRole('combobox')).toHaveCount(0);
      await expect(toolbar.getByRole('combobox', { name: 'Agent' })).toHaveCount(0);
      await expect(model).toContainText('GPT-5.6');
      await welcome.getByRole('heading').click();
      await page.screenshot({
        path: testInfo.outputPath(`workspace-draft-${viewport}.png`),
        animations: 'disabled'
      });

      if (viewport >= 768) {
        const descriptionBox = (await description.boundingBox())!;
        const composerBox = (await page.locator('.composer-shell').boundingBox())!;
        const gap = composerBox.y - (descriptionBox.y + descriptionBox.height);
        expect(gap).toBeGreaterThan(0);
        expect(gap).toBeLessThanOrEqual(20);
        const hover = await agent.evaluate((button) => {
          const marker = document.createElement('span');
          marker.style.backgroundColor = 'var(--mar-fill-row-hover)';
          button.append(marker);
          const color = getComputedStyle(marker).backgroundColor;
          marker.remove();
          return color;
        });
        await expect(agent).not.toHaveCSS('background-color', hover);
        await agent.hover();
        await expect(agent).toHaveCSS('background-color', hover);
        await page.screenshot({
          path: testInfo.outputPath(`workspace-agent-hover-${viewport}.png`),
          animations: 'disabled'
        });
        await agent.focus();
        await agent.press('ArrowDown');
      } else {
        await agent.tap();
      }
      const options = welcome.getByRole('menu', { name: 'Agent' });
      const codex = options.getByRole('menuitem', { name: 'Codex' });
      await expect(codex).toHaveAttribute('aria-current', 'true');
      await expect(options.locator('[data-mar-icon="check"]')).toHaveCount(0);
      const selectedColor = await codex.evaluate((item) => {
        const marker = document.createElement('span');
        marker.style.backgroundColor = 'var(--mar-fill-selection)';
        item.append(marker);
        const color = getComputedStyle(marker).backgroundColor;
        marker.remove();
        return color;
      });
      await expect(codex).toHaveCSS('background-color', selectedColor);
      const claude = options.getByRole('menuitem', { name: 'Claude Code' });
      await expect(claude.locator('img')).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`workspace-agent-menu-${viewport}.png`),
        animations: 'disabled'
      });
      const claudeIcon = await claude.locator('img').getAttribute('src');
      if (viewport >= 768) {
        await expect(codex).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(agent).toBeFocused();
      }
      await input.click();
      await expect(options).toBeHidden();
      await input.fill('Keep this draft');
      if (viewport >= 768) {
        await agent.press('Enter');
        await expect(codex).toBeFocused();
        await page.keyboard.press('ArrowDown');
        await expect(claude).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(agent).toBeFocused();
      } else {
        await agent.tap();
        await claude.tap();
      }
      await expect(options).toBeHidden();
      await expect(welcome.locator('.draft-session-description')).toHaveText(
        '使用 Claude Code 创建新会话',
        { useInnerText: true }
      );
      await expect(agentIcon).toHaveAttribute('src', claudeIcon!);
      await expect(model).toContainText('Claude Sonnet');
      await expect(input).toHaveValue('Keep this draft');
      if (viewport >= 768) {
        await input.press('Alt+m');
        await expect(model).toHaveAttribute('aria-expanded', 'true');
        await page.keyboard.press('Escape');
        await expect(model).toHaveAttribute('aria-expanded', 'false');
      }
      const startRequest = page.waitForRequest('**/api/agent-sessions/start');
      await page.locator('.composer-send-button').click();
      expect((await startRequest).postDataJSON()).toMatchObject({
        runner: 'claude-code',
        modelId: 'sonnet',
        content: 'Keep this draft'
      });
      await expect(welcome).toBeHidden();
    });
  });
}

for (const entry of ['button', 'shortcut'] as const) {
  test(`explicit New via ${entry} restores Main and keeps the first sent session reachable`, async ({
    page
  }) => {
    const { main } = await openWorkspace(page);
    const mainTab = page.locator('.conversation-sidebar input[value="MAIN"]');
    const childTab = page.locator('.conversation-sidebar input[value="CHILD"]');
    await childTab.click();
    await expect(childTab).toBeChecked();
    await expect(page.locator('.session-row')).toContainText('Child session');
    const input = page.locator('.composer-input');
    await input.fill('Keep the explicit new-session draft');
    if (entry === 'button') await page.locator('.new-session-button').click();
    else await input.press('Control+n');
    await expect(mainTab).toBeChecked();
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
    await expect(page.locator('.conversation-header').getByRole('heading')).toContainText(
      'Created main'
    );
    await mainTab.click();
    await expect(row).toBeVisible();
    await input.fill('Keep this message when opening a new session');
    if (entry === 'shortcut') await page.keyboard.press('Alt+n');
    else await page.locator('.new-session-button').click();
    await expect(row).not.toHaveClass(/selected/);
    await expect(input).toHaveValue('Keep this message when opening a new session');
    await row.locator('.session-link').click();
    await expect(row).toHaveClass(/selected/);
    await expect(page.locator('.conversation-header').getByRole('heading')).toContainText(
      'Created main'
    );
    await expect(input).toHaveValue('Keep this message when opening a new session');
  });
}

for (const width of [1280, 390]) {
  test(`New preserves a slash-prefixed draft when selecting an available Runner at ${width}px`, async ({
    page
  }) => {
    const { main } = await openWorkspace(page, true, true);
    // Let the initial Main directory settle before simulating a newly discovered session.
    await expect(page.locator('.conversation-sidebar .sidebar-empty')).toHaveText(
      /^(No main sessions|暂无主会话)$/u
    );
    await emitMockWorkspaceSnapshot(page, 'sessions', { sessions: [main], sessionGroup: 'MAIN' });
    await page
      .locator('.session-row')
      .filter({ hasText: 'Created main' })
      .locator('.session-link')
      .click();
    await expect(page.locator('.conversation-header').getByRole('heading')).toContainText(
      'Created main'
    );
    await page.setViewportSize({ width, height: 900 });
    const input = page.locator('.composer-input');
    await input.fill('/src/review.ts — keep this draft');
    if (width < 768)
      await page.getByRole('button', { name: /打开会话列表|Open session list/u }).click();
    await page.locator('.new-session-button').click();
    await expect(page.locator('.session-row.selected')).toHaveCount(0);
    await expect(input).toHaveValue('/src/review.ts — keep this draft');
    await expect(input).toBeFocused();
  });
}

test('manual group changes preserve the Composer draft', async ({ page }) => {
  await openWorkspace(page);
  const input = page.locator('.composer-input');
  await input.fill('Manual group changes keep this text');
  await page.locator('.conversation-sidebar input[value="CHILD"]').click();
  await expect(input).toHaveValue('Manual group changes keep this text');
  await page.locator('.conversation-sidebar input[value="MAIN"]').click();
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
  await expect(page.locator('.conversation-header').getByRole('heading')).toContainText(
    'Created main'
  );
});
