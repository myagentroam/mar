import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

type BranchTransition = { start: number; middle: number; end: number; inert: boolean };

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/workbench-mobile-drawer.html');
});
test.afterAll(async () => {
  await fixture?.close();
});

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`Workspace Tab reveal animates live branch changes and respects reduced motion: ${reducedMotion}`, async ({
    page
  }) => {
    await page.emulateMedia({ reducedMotion });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.addInitScript(() => {
      const measurements = { height: 0, bounds: 0 };
      const transitions: BranchTransition[] = [];
      Object.assign(window, { branchMeasurements: measurements, branchTransitions: transitions });
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
      document.addEventListener('transitionrun', (event) => {
        const branch = event.target;
        if (
          event.propertyName !== 'height' ||
          !(branch instanceof HTMLElement) ||
          !branch.matches('.workspace-tree .workspace-branches')
        )
          return;
        const animation = branch
          .getAnimations()
          .find((item) => item instanceof CSSTransition && item.transitionProperty === 'height');
        if (!animation) return;
        animation.pause();
        const duration = Number(animation.effect!.getTiming().duration);
        const [start, middle, end] = [0, duration / 2, duration].map((time) => {
          animation.currentTime = time;
          return bounds.call(branch).height;
        });
        transitions.push({ start: start!, middle: middle!, end: end!, inert: branch.inert });
        animation.finish();
      });
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
    expect(await measurements()).toEqual({ height: 0, bounds: 0 });
    const targets = {
      Remote: '/remote',
      Target: '/target',
      Second: '/second-target',
      Plain: '/plain'
    };
    for (const label of ['Remote', 'Target', 'Second', 'Plain', 'Target'] as const) {
      const tab = page.getByRole('tab', { name: label, exact: true });
      await tab.click();
      await expect(tab).toBeFocused();
      const row = page.getByRole('button', { name: targets[label], exact: true });
      await expect(row).toHaveClass(/selected/);
      await expect(row).toBeInViewport();
      await expect.poll(branchesReady).toBe(true);
    }
    const automatic = await measurements();
    const transitions = await page.evaluate(
      () => (window as unknown as { branchTransitions: BranchTransition[] }).branchTransitions
    );
    if (reducedMotion === 'reduce') {
      expect(automatic).toEqual({ height: 0, bounds: 0 });
      expect(transitions).toEqual([]);
    } else {
      expect(automatic.height).toBeGreaterThan(0);
      expect(automatic.bounds).toBeGreaterThan(0);
      expect(transitions.some(({ start, end }) => start < end)).toBe(true);
      expect(transitions.some(({ start, end }) => start > end)).toBe(true);
      for (const { start, middle, end, inert } of transitions) {
        expect(middle).toBeGreaterThan(Math.min(start, end));
        expect(middle).toBeLessThan(Math.max(start, end));
        expect(inert).toBe(start > end);
      }
    }

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
      expect(explicit.height).toBeGreaterThan(automatic.height);
      expect(explicit.bounds).toBeGreaterThan(automatic.bounds);
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

test('A Tab switch during branch motion settles and reveals only the newest target', async ({
  page
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${fixture.url}workbench-mobile-drawer.html?tree-reveal&locale=en-US`);
  const targetTab = page.getByRole('tab', { name: 'Target', exact: true });
  const secondTab = page.getByRole('tab', { name: 'Second', exact: true });
  await secondTab.evaluate((tab) => {
    function switchDuringExpansion(event: TransitionEvent): void {
      const branch = event.target;
      if (
        event.propertyName !== 'height' ||
        !(branch instanceof Element) ||
        !branch.matches('.workspace-tree .workspace-branch-enter-active')
      )
        return;
      const expansion = branch
        .getAnimations()
        .find((item) => item instanceof CSSTransition && item.transitionProperty === 'height');
      if (!expansion) return;
      document.removeEventListener('transitionrun', switchDuringExpansion);
      expansion.pause();
      expansion.currentTime = Number(expansion.effect!.getTiming().duration) / 3;
      const interruptedHeight = branch.getBoundingClientRect().height;
      tab.focus();
      tab.click();
      queueMicrotask(() => {
        Object.assign(window, {
          interruptedHeight,
          collapseStartHeight: branch.getBoundingClientRect().height
        });
      });
    }
    document.addEventListener('transitionrun', switchDuringExpansion);
  });
  await targetTab.click();
  const selected = page.getByRole('button', { name: '/second-target', exact: true });
  await expect(secondTab).toBeFocused();
  await expect(selected).toBeInViewport();
  await expect(page.locator('.workspace-branch-button.selected')).toHaveCount(1);
  await expect(selected).toHaveClass(/selected/);
  await expect(page.locator('.workspace-tree [inert]')).toHaveCount(0);
  const heights = await page.evaluate(() => ({
    interrupted: Number(Reflect.get(window, 'interruptedHeight')),
    collapseStart: Number(Reflect.get(window, 'collapseStartHeight'))
  }));
  expect(heights.interrupted).toBeGreaterThan(0);
  expect(heights.collapseStart).toBeCloseTo(heights.interrupted, 0);
});

test('Workspace Tab highlight transitions between rows that are already visible in the tree', async ({
  page
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${fixture.url}workbench-mobile-drawer.html?tree-reveal&locale=en-US`);
  await page.getByRole('textbox', { name: 'Filter Nodes and Workspaces' }).fill('/');
  const row = page.getByRole('button', { name: '/plain', exact: true }).locator('..');
  await page.getByRole('tab', { name: 'Target', exact: true }).click();
  await expect(row).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await row.evaluate((element) => {
    element.addEventListener('transitionrun', function inspectTransition(event) {
      if (event.propertyName !== 'background-color') return;
      element.removeEventListener('transitionrun', inspectTransition);
      const transition = element
        .getAnimations()
        .find(
          (item) => item instanceof CSSTransition && item.transitionProperty === event.propertyName
        );
      if (!transition) return;
      transition.pause();
      const duration = Number(transition.effect!.getTiming().duration);
      const colors = [0, duration / 2, duration].map((time) => {
        transition.currentTime = time;
        return getComputedStyle(element).backgroundColor;
      });
      Object.assign(window, { selectionColors: colors });
      transition.finish();
    });
  });
  await page.getByRole('tab', { name: 'Plain', exact: true }).click();
  await expect(row).toHaveClass(/selected/);
  await expect
    .poll(() => page.evaluate(() => new Set(Reflect.get(window, 'selectionColors')).size))
    .toBe(3);
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

test('Editing the tree filter during a Tab reveal cancels the pending scroll', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${fixture.url}workbench-mobile-drawer.html?tree-reveal&locale=en-US`);
  const filter = page.getByRole('textbox', { name: 'Filter Nodes and Workspaces' });
  await filter.evaluate((element) => {
    const input = element as HTMLInputElement;
    function editDuringExpansion(event: TransitionEvent): void {
      const branch = event.target;
      if (
        event.propertyName !== 'height' ||
        !(branch instanceof HTMLElement) ||
        !branch.matches('.workspace-tree .workspace-branch-enter-active')
      )
        return;
      document.removeEventListener('transitionrun', editDuringExpansion);
      Object.assign(window, { interruptedBranch: branch });
      input.focus();
      input.value = '/';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    document.addEventListener('transitionrun', editDuringExpansion);
  });
  const remoteTab = page.getByRole('tab', { name: 'Remote', exact: true });
  await remoteTab.click();
  await expect(filter).toHaveValue('/');
  await expect(filter).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const interrupted = Reflect.get(window, 'interruptedBranch');
        return (
          interrupted instanceof HTMLElement &&
          !interrupted.classList.contains('workspace-branch-enter-active')
        );
      })
    )
    .toBe(true);
  const remote = page.getByRole('button', { name: '/remote', exact: true });
  await expect(remote).toHaveClass(/selected/);
  await expect(remote).not.toBeInViewport();
  await expect(filter).toBeInViewport();
  await remoteTab.click();
  await expect(remote).toBeInViewport();
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
