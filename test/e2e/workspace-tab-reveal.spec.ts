import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/workbench-mobile-drawer.html');
});
test.afterAll(async () => {
  await fixture?.close();
});

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`Workspace Tab reveal skips branch animation measurements: ${reducedMotion}`, async ({
    page
  }) => {
    await page.emulateMedia({ reducedMotion });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.addInitScript(() => {
      const measurements = { height: 0, bounds: 0 };
      Object.assign(window, { branchMeasurements: measurements });
      const height = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight')!;
      Object.defineProperty(Element.prototype, 'scrollHeight', {
        ...height,
        get() {
          if (this.matches('.workspace-tree .workspace-branches')) measurements.height++;
          return height.get!.call(this);
        }
      });
      const bounds = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function () {
        if (this.matches('.workspace-tree .workspace-branches')) measurements.bounds++;
        return bounds.call(this);
      };
    });
    const measurements = () =>
      page.evaluate(
        () =>
          (window as unknown as { branchMeasurements: { height: number; bounds: number } })
            .branchMeasurements
      );
    const branchesReady = () =>
      page.evaluate(() => {
        const branches = [
          ...document.querySelectorAll<HTMLElement>('.workspace-tree .workspace-branches')
        ];
        return (
          branches.length > 0 &&
          branches.every(
            (branch) =>
              !branch.inert && branch.style.getPropertyValue('--workspace-branch-height') === ''
          )
        );
      });
    await page.goto(`${fixture.url}workbench-mobile-drawer.html?tree-reveal&locale=en-US`);
    for (const label of ['Remote', 'Target', 'Second', 'Plain', 'Target']) {
      const tab = page.getByRole('tab', { name: label, exact: true });
      await tab.click();
      await expect(tab).toBeFocused();
    }
    await expect(page.getByRole('button', { name: '/target', exact: true })).toBeInViewport();
    expect(await measurements()).toEqual({ height: 0, bounds: 0 });
    await expect.poll(branchesReady).toBe(true);

    const node = page.getByRole('button', { name: 'node', exact: true });
    await node.click();
    await expect(page.getByRole('button', { name: '/target', exact: true })).toBeHidden();
    await node.click();
    await expect(page.getByRole('button', { name: '/target', exact: true })).toBeVisible();
    await expect(
      page.locator('.workspace-branch-enter-active, .workspace-branch-leave-active')
    ).toHaveCount(0);
    await expect.poll(branchesReady).toBe(true);
    const target = page.getByRole('button', { name: '/target', exact: true });
    await target.focus();
    await expect(target).toBeFocused();
    const explicit = await measurements();
    if (reducedMotion === 'reduce') expect(explicit).toEqual({ height: 0, bounds: 0 });
    else {
      expect(explicit.height).toBeGreaterThan(0);
      expect(explicit.bounds).toBeGreaterThan(0);
    }
  });
}

test('Workspace Tabs reveal the target and collapse other Nodes and groups without moving focus', async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${fixture.url}workbench-mobile-drawer.html?tree-reveal&locale=en-US`);
  const targetTab = page.getByRole('tab', { name: 'Target', exact: true });
  const target = page.getByRole('button', { name: '/target', exact: true });
  const remote = page.getByRole('button', { name: '/remote', exact: true });
  const group = page.getByRole('button', { name: 'Collapse Workspace group Team', exact: true });
  await page.getByRole('tab', { name: 'Remote', exact: true }).click();
  await expect(remote).toBeVisible();
  await targetTab.click();
  await expect(target).toBeInViewport();
  await expect(targetTab).toBeFocused();
  await expect(target).toHaveClass(/selected/);
  await expect(remote).toBeHidden();
  await expect(page.locator('.node-expand-button.expanded')).toHaveCount(1);
  await expect(page.locator('.workspace-group-toggle.expanded')).toHaveCount(1);

  await page.getByRole('button', { name: 'other', exact: true }).click();
  await expect(remote).toBeHidden();
  await page
    .getByRole('button', { name: 'Expand Workspace group Other team', exact: true })
    .click();
  await expect(remote).toBeVisible();
  await expect(remote).not.toHaveClass(/selected/);
  await expect(page.locator('.node-expand-button.expanded')).toHaveCount(2);
  await expect(page.locator('.workspace-group-toggle.expanded')).toHaveCount(2);
  await targetTab.click();
  await expect(remote).toBeHidden();
  await expect(page.locator('.node-expand-button.expanded')).toHaveCount(1);

  await page.getByRole('tab', { name: 'Second', exact: true }).click();
  await expect(page.getByRole('button', { name: '/second-target', exact: true })).toBeInViewport();
  await expect(target).toBeHidden();
  await expect(page.locator('.workspace-group-toggle.expanded')).toHaveCount(1);
  await page.getByRole('tab', { name: 'Plain', exact: true }).click();
  await expect(page.locator('.workspace-group-toggle.expanded')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '/plain', exact: true })).toBeInViewport();
  await targetTab.click();

  await group.click();
  await expect(target).toBeHidden();
  await targetTab.click();
  await expect(target).toBeInViewport();
  await page.getByRole('button', { name: 'node', exact: true }).click();
  await expect(target).toBeHidden();
  await targetTab.click();
  await expect(target).toBeInViewport();
  await expect(targetTab).toBeFocused();
});

test('Workspace Tab reveal preserves filters and a closed desktop sidebar', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${fixture.url}workbench-mobile-drawer.html?tree-reveal&locale=en-US`);
  const filter = page.getByRole('textbox', { name: 'Filter Nodes and Workspaces' });
  const targetTab = page.getByRole('tab', { name: 'Target', exact: true });
  const target = page.getByRole('button', { name: '/target', exact: true });
  await filter.fill('plain');
  await targetTab.click();
  await expect(filter).toHaveValue('plain');
  await expect(target).toBeHidden();
  await filter.fill('');
  await expect(target).toBeInViewport();

  await page.getByRole('button', { name: 'Toggle resource sidebar', exact: true }).click();
  await expect(filter).toBeHidden();
  await targetTab.click();
  await expect(filter).toBeHidden();
  await expect(targetTab).toBeFocused();
  await page.getByRole('button', { name: 'Toggle resource sidebar', exact: true }).click();
  await expect(target).toBeInViewport();
});

test('Workspace reveal waits for cached resources and keeps only the newest target selected', async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${fixture.url}workbench-mobile-drawer.html?tree-reveal&locale=en-US`);
  const remote = page.getByRole('button', { name: '/remote', exact: true });
  const target = page.getByRole('button', { name: '/target', exact: true });
  await page.getByRole('button', { name: 'Unload remote resources', exact: true }).click();
  await page.getByRole('button', { name: 'Switch targets quickly', exact: true }).click();
  await expect(remote).toBeHidden();
  await page.getByRole('button', { name: 'Load remote resources', exact: true }).click();
  await expect(remote).toBeInViewport();
  await expect(remote).toHaveClass(/selected/);
  await expect(target).toBeHidden();
  await expect(page.locator('.workspace-branch-button.selected')).toHaveCount(1);
});

test('Editing a matching tree filter does not scroll away from the input', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${fixture.url}workbench-mobile-drawer.html?tree-reveal&locale=en-US`);
  await page.getByRole('tab', { name: 'Target', exact: true }).click();
  await page.getByRole('tab', { name: 'Remote', exact: true }).click();
  const remote = page.getByRole('button', { name: '/remote', exact: true });
  await page.getByRole('button', { name: 'node', exact: true }).click();
  await remote.scrollIntoViewIfNeeded();
  await expect(remote).toBeInViewport();
  const filter = page.getByRole('textbox', { name: 'Filter Nodes and Workspaces' });
  await filter.click();
  await expect(filter).toBeInViewport();
  await filter.fill('/');
  await expect(filter).toBeFocused();
  await expect(filter).toBeInViewport();
  await expect(remote).toHaveClass(/selected/);
  await filter.fill('/folder-');
  await expect(remote).toBeHidden();
  await filter.fill('');
  await expect(filter).toBeFocused();
  await expect(filter).toBeInViewport();
  await expect(remote).toHaveClass(/selected/);
});

test('Mobile Workspace Tabs keep the resource drawer closed and reveal the target on opening', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${fixture.url}workbench-mobile-drawer.html?tree-reveal&locale=en-US`);
  const drawer = page.locator('.workspace-tree');
  const targetTab = page.getByRole('tab', { name: 'Target', exact: true });
  const target = page.getByRole('button', { name: '/target', exact: true });
  await expect(drawer).toBeHidden();
  await targetTab.click();
  await expect(drawer).toBeHidden();
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  await expect(target).toBeInViewport();
  const bounds = (await drawer.boundingBox())!;
  const row = (await target.boundingBox())!;
  expect(row.y + row.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
});
