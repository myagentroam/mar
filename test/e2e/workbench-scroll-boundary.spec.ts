import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';
import { json, mockConsoleApi } from './support/web-console-api.js';

// @test-covers packages/web-core/src/view/workbench/WorkbenchPage.vue
// @test-covers packages/web-core/src/view/workbench/WorkbenchSurface.vue
// @test-covers packages/web-core/src/view/workspace/WorkspaceFileTree.vue
// @test-covers packages/web-core/src/view/workspace/WorkspaceGitChanges.vue
// @test-covers packages/web-core/src/view/workspace/WorkspaceTabs.vue
// @test-covers packages/web-core/src/view/workbench/WorkbenchNavigation.vue
// @test-covers packages/web-core/src/view/terminal/TerminalTabView.vue
let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/new-session-group.html');
});
test.afterAll(async () => {
  await fixture?.close();
});

test('Desktop Files scrolls independently without moving the workbench frame', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], [], 'DIRECTORY', true);
  const entries = Array.from({ length: 80 }, (_, index) => {
    const name = `file-${String(index).padStart(2, '0')}.ts`;
    return { path: name, name, kind: 'FILE', size: 25, modifiedAt: 1 };
  });
  await page.route(/\/api\/workspaces\/workspace-1\/files(?:\?.*)?$/, (route) =>
    json(route, { files: { entries, nextCursor: null, truncated: false } })
  );
  const lastEntry = entries.at(-1)!;
  await page.route(/\/api\/workspaces\/workspace-1\/files\/search(?:\?.*)?$/, (route) =>
    json(route, { files: { entries: [lastEntry], nextCursor: null, truncated: false } })
  );
  await page.route(/\/api\/workspaces\/workspace-1\/files\/read(?:\?.*)?$/, (route) =>
    json(route, {
      file: {
        path: lastEntry.path,
        encoding: 'utf-8',
        size: lastEntry.size,
        content: 'export const answer = 42;',
        truncated: false,
        nextOffset: null
      }
    })
  );
  await page.route('**/api/auth/me', (route) =>
    json(route, { authenticated: true, userId: 1, username: 'admin', isAdmin: true })
  );
  await page.goto(`${fixture.url}new-session-group.html`);
  const resources = page.locator('.workspace-tree');
  await resources.getByRole('button', { name: /node-1/ }).click();
  await resources.getByRole('button', { name: 'project' }).click();

  const tree = page.locator('.workspace-aside .workspace-file-tree');
  const shell = page.locator('.console-shell');
  const workbench = shell.locator('.workbench');
  const header = workbench.locator('.workbench-header');
  const firstFile = tree.getByRole('treeitem', { name: 'file-00.ts', exact: true });
  await expect(firstFile).toBeVisible();
  const headerTop = (await header.boundingBox())!.y;
  const panelTop = (await workbench.boundingBox())!.y;
  expect(panelTop).toBeGreaterThan(0);
  const treeTop = () => tree.evaluate((element) => element.scrollTop);
  await tree.hover();
  await page.mouse.wheel(0, 320);
  await expect.poll(treeTop).toBeGreaterThan(0);
  await page.mouse.wheel(0, -1000);
  await expect.poll(treeTop).toBe(0);
  await page.mouse.wheel(0, -1000);
  await expect(tree).toHaveCSS('overscroll-behavior-x', 'contain');
  await expect(tree).toHaveCSS('overscroll-behavior-y', 'contain');
  expect((await header.boundingBox())!.y).toBe(headerTop);
  expect((await workbench.boundingBox())!.y).toBe(panelTop);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  await firstFile.focus();
  for (let index = 0; index < 30; index++) await page.keyboard.press('ArrowDown');
  const keyboardFile = tree.getByRole('treeitem', { name: 'file-30.ts', exact: true });
  await expect(keyboardFile).toBeFocused();
  await expect(keyboardFile).toBeInViewport({ ratio: 0.98 });
  await expect.poll(treeTop).toBeGreaterThan(0);

  await page.keyboard.press('Control+Shift+O');
  const quickOpen = page.getByRole('dialog', { name: /Quick Open|快速打开/i });
  await quickOpen.getByRole('textbox').fill(lastEntry.name);
  await quickOpen.getByText(lastEntry.name, { exact: true }).first().click();
  const revealedFile = tree.getByRole('treeitem', { name: lastEntry.name, exact: true });
  await expect(revealedFile).toHaveAttribute('aria-selected', 'true');
  await expect(revealedFile).toBeInViewport({ ratio: 0.98 });

  // Focus and scroll APIs can move a hidden-overflow frame whenever a child overflows.
  for (const frame of [shell, workbench]) {
    expect(
      await frame.evaluate((element) => {
        const overflow = document.createElement('div');
        overflow.style.minHeight = '200vh';
        element.append(overflow);
        element.scrollTop = 64;
        const offset = element.scrollTop;
        overflow.remove();
        return offset;
      })
    ).toBe(0);
  }
  expect((await header.boundingBox())!.y).toBe(headerTop);
  expect((await workbench.boundingBox())!.y).toBe(panelTop);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test('Desktop Git Changes contains both axes without disabling ordinary scrolling', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  const changes = Array.from({ length: 80 }, (_, index) => ({
    repositoryPath: '',
    repositoryName: 'project',
    source: 'ROOT',
    path: `src/change-${String(index).padStart(2, '0')}.ts`,
    state: 'UNSTAGED',
    change: 'MODIFIED',
    diffAvailable: true
  }));
  await page.route(/\/api\/workspaces\/workspace-1\/changes(?:\?.*)?$/, (route) =>
    json(route, {
      workspace: { id: 'workspace-1', kind: 'GIT_WORKSPACE', path: '/project' },
      changes,
      worktrees: [],
      repositories: [
        { repositoryPath: '', repositoryName: 'project', source: 'ROOT', current: true, changes }
      ]
    })
  );
  await page.route('**/api/auth/me', (route) =>
    json(route, { authenticated: true, userId: 1, username: 'admin', isAdmin: true })
  );
  await page.goto(`${fixture.url}new-session-group.html`);
  const resources = page.locator('.workspace-tree');
  await resources.getByRole('button', { name: /node-1/ }).click();
  await resources.getByRole('button', { name: 'project' }).click();
  await page.getByRole('tab', { name: /Git Changes|Git 变更/i }).click();

  const list = page.locator('.workspace-aside .change-list');
  await expect(list.getByText('change-00.ts', { exact: true })).toBeVisible();
  const header = page.locator('.workbench-header');
  const frame = await header.boundingBox();
  const listScrollTop = () => list.evaluate((element) => element.scrollTop);
  await list.hover();
  await page.mouse.wheel(0, 320);
  await expect.poll(listScrollTop).toBeGreaterThan(0);
  await page.mouse.wheel(0, -1000);
  await expect.poll(listScrollTop).toBe(0);
  await page.mouse.wheel(-700, 0);
  await page.mouse.wheel(0, -700);
  // Headless Chromium does not guarantee visual elasticity. Check the mounted scroll policy.
  await expect(list).toHaveCSS('overscroll-behavior-x', 'contain');
  await expect(list).toHaveCSS('overscroll-behavior-y', 'contain');
  await expect(header.locator('.workspace-tabs')).toHaveCSS('overscroll-behavior', 'contain');
  await expect(page.locator('.activity-rail nav')).toHaveCSS('overscroll-behavior', 'contain');
  await expect(page.locator('html')).toHaveCSS('overscroll-behavior', 'auto');
  expect(await header.boundingBox()).toEqual(frame);
});

test('Desktop Terminal contains gestures around its virtual scrollback', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.route('**/api/auth/me', (route) =>
    json(route, { authenticated: true, userId: 1, username: 'admin', isAdmin: true })
  );
  await page.goto(`${fixture.url}new-session-group.html`);
  const resources = page.locator('.workspace-tree');
  await resources.getByRole('button', { name: /node-1/ }).click();
  await resources.getByRole('button', { name: 'project' }).click();
  await page.getByRole('tab', { name: /^(Terminal|终端)$/ }).click();
  const body = page.locator('.terminal-dock .admin-terminal-body:visible');
  await expect(body.locator('.xterm')).toBeVisible();
  await expect(body).toHaveCSS('overscroll-behavior', 'contain');
  await expect(page.locator('html')).toHaveCSS('overscroll-behavior', 'auto');
});
