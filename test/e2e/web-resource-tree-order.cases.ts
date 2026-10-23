import { expect, test, type Locator, type Page } from '@playwright/test';
import { json, mockConsoleApi } from './support/web-console-api.js';

type BranchMotionSample = {
  heights: number[];
  followingNodeTops: number[];
  inert: boolean;
  duration: number;
};

async function branchMotionSamples(page: Page): Promise<BranchMotionSample[]> {
  return page.evaluate(
    () => (window as unknown as { branchMotionSamples: BranchMotionSample[] }).branchMotionSamples
  );
}

async function observeBranchMotion(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const samples: BranchMotionSample[] = [];
    Object.assign(window, { branchMotionSamples: samples });
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
      const heights: number[] = [];
      const followingNodeTops: number[] = [];
      for (const time of [0, duration / 2, duration]) {
        animation.currentTime = time;
        heights.push(branch.getBoundingClientRect().height);
        followingNodeTops.push(
          document.querySelector('.node-tree > li:nth-child(2)')!.getBoundingClientRect().top
        );
      }
      samples.push({ heights, followingNodeTops, inert: branch.inert, duration });
      animation.finish();
    });
  });
}

async function mockResourceTree(page: Page, workspaceCreatable = false) {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], [], 'DIRECTORY');
  let includeNewNode = false;
  const groupNames = new Map<string, string | null>();
  const mutations: string[] = [];
  const watchLifecycle: Array<{
    readonly path: string;
    readonly method: string;
    readonly watchId?: string;
  }> = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (/\/api\/(workspaces|agent-sessions)\/[^/]+\/watch$/u.test(path)) {
      const body = request.postDataJSON() as {
        readonly mode?: string;
        readonly watchId?: string;
      } | null;
      if (request.method() === 'DELETE' || (request.method() === 'POST' && body?.mode !== 'renew'))
        watchLifecycle.push({
          path,
          method: request.method(),
          ...(body?.watchId === undefined ? {} : { watchId: body.watchId })
        });
      return;
    }
    if (
      /\/api\/(nodes|workspaces)\//u.test(request.url()) &&
      ['PATCH', 'DELETE'].includes(request.method())
    )
      mutations.push(request.url());
  });
  await page.route('**/api/nodes', (route) =>
    json(route, {
      nodes: [1, 2, ...(includeNewNode ? [3] : [])].map((index) => ({
        id: `node-${index}`,
        displayName: `Node ${index}`,
        platform: 'linux',
        architecture: 'x64',
        nodeAppVersion: '0.9.6',
        nodeVersion: 'v24.15.0',
        connected: index !== 2,
        disabled: false,
        manageable: false,
        workspaceCreatable,
        capabilities: { codex: { available: true, version: '0.146' } }
      }))
    })
  );
  await page.route('**/api/workspaces?nodeId=node-1', (route) =>
    json(route, {
      workspaces: [
        { id: 'workspace-1', displayName: 'Workspace A', groupName: 'Team' },
        { id: 'workspace-2', displayName: 'Workspace B', groupName: 'Team' },
        { id: 'workspace-3', displayName: 'Workspace C', groupName: 'Solo' },
        { id: 'workspace-4', displayName: 'Workspace U', groupName: null },
        { id: 'workspace-5', displayName: 'Workspace V', groupName: null }
      ].map((workspace) => ({
        ...workspace,
        groupName: groupNames.has(workspace.id)
          ? groupNames.get(workspace.id)
          : workspace.groupName,
        path: `/project/${workspace.id}`,
        kind: 'DIRECTORY',
        manageable: false
      }))
    })
  );
  await page.route('**/api/workspaces/*?nodeId=*', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    const id = new URL(route.request().url()).pathname.split('/').at(-1)!;
    const { groupName } = route.request().postDataJSON() as { groupName: string | null };
    groupNames.set(id, groupName);
    return json(route, { workspace: { id, groupName } });
  });
  return {
    mutations,
    watchLifecycle,
    addNode: () => {
      includeNewNode = true;
    }
  };
}

async function openRowMenu(page: Page, row: Locator, contextMenu = true): Promise<Locator> {
  if (contextMenu) await row.click({ button: 'right' });
  const trigger = row.locator('..').locator('.tree-more-button');
  if (!contextMenu) await trigger.click();
  const menuId = await trigger.getAttribute('aria-controls');
  expect(menuId).toBeTruthy();
  const menu = page.locator(`[id="${menuId}"]`);
  await expect(menu).toBeVisible();
  return menu;
}

async function dragOverRow(
  page: Page,
  source: Locator,
  target: Locator,
  position: 'before' | 'after'
) {
  // Let Playwright wait for both rows to be actionable before measuring drag coordinates.
  await source.hover();
  await target.hover();
  const sourceBounds = await source.boundingBox();
  const targetBounds = await target.boundingBox();
  expect(sourceBounds).not.toBeNull();
  expect(targetBounds).not.toBeNull();
  const sourceX = sourceBounds!.x + 30;
  const sourceY = sourceBounds!.y + sourceBounds!.height / 2;
  const targetX = targetBounds!.x + 30;
  const targetY = targetBounds!.y + (position === 'before' ? 4 : targetBounds!.height - 4);
  await page.mouse.move(sourceX, sourceY);
  await page.mouse.down();
  await page.mouse.move(sourceX + 8, sourceY, { steps: 3 });
  await page.mouse.move(targetX, targetY, { steps: 5 });
  await page.mouse.move(targetX, targetY);
}

test('Resource tree filtering settles interrupted motion without animating automatic expansion', async ({
  page
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => localStorage.setItem('mar.locale.v2', 'zh-CN'));
  await mockResourceTree(page);
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台', exact: true }).click();
  const tree = page.locator('aside.workspace-tree');
  await tree.getByRole('button', { name: 'Node 1', exact: true }).click();
  const group = tree.locator('.workspace-group-toggle[title="Team"]');
  await expect(group).toBeVisible();
  await tree.evaluate(async (element) => {
    await Promise.allSettled(element.getAnimations({ subtree: true }).map((item) => item.finished));
    Object.assign(window, { filterChevronMotions: [] as string[] });
    document.addEventListener('transitionrun', (event) => {
      if (event.target instanceof Element && event.target.matches('.workspace-tree .tree-chevron'))
        (window as unknown as { filterChevronMotions: string[] }).filterChevronMotions.push(
          event.propertyName
        );
    });
  });
  const filter = tree.locator('.workspace-tree-filter input');
  for (const query of ['Workspace A', '']) {
    await filter.fill(query);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    expect
      .soft(
        await page.evaluate(
          () => (window as unknown as { filterChevronMotions: string[] }).filterChevronMotions
        )
      )
      .toEqual([]);
  }

  // Pause real CSS motion so filtering cannot pass merely by waiting for it to finish.
  for (const expanded of [true, false]) {
    const filteredState = await group.evaluate(
      (button) =>
        new Promise((resolve) => {
          const row = button.parentElement!;
          const pause = (event: Event) => {
            if (
              !(event instanceof TransitionEvent) ||
              event.propertyName !== 'height' ||
              !(event.target instanceof HTMLElement) ||
              !event.target.classList.contains('workspace-group-branches')
            )
              return;
            const animation = event.target
              .getAnimations()
              .find(
                (item) => item instanceof CSSTransition && item.transitionProperty === 'height'
              );
            if (!animation) return;
            animation.pause();
            animation.currentTime = Number(animation.effect!.getTiming().duration) / 2;
            row.removeEventListener('transitionrun', pause);
            const expandedBeforeFilter = button.getAttribute('aria-expanded');
            const input = document.querySelector<HTMLInputElement>('.workspace-tree-filter input')!;
            input.value = 'Workspace A';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            // Observe the first filtered render, before Vue's transition timeout can finish it.
            void Promise.resolve().then(() => {
              const branch = document
                .querySelector('.workspace-group-toggle[title="Team"]')!
                .parentElement!.querySelector<HTMLElement>(':scope > .workspace-group-branches')!;
              resolve({
                expandedBeforeFilter,
                overflow: getComputedStyle(branch).overflow,
                inert: branch.inert,
                heightIsNatural:
                  Math.abs(branch.getBoundingClientRect().height - branch.scrollHeight) < 1,
                hasMotion: branch.getAnimations().length > 0
              });
            });
          };
          row.addEventListener('transitionrun', pause);
          (button as HTMLButtonElement).click();
        })
    );
    expect(filteredState).toEqual({
      expandedBeforeFilter: String(expanded),
      overflow: 'visible',
      inert: false,
      heightIsNatural: true,
      hasMotion: false
    });
    await filter.fill('');
    await expect(group).toHaveAttribute('aria-expanded', String(expanded));
  }

  // Interrupt real transitions without the geometry sampler forcing them to finish.
  const toggles = await group.evaluate(
    (button) =>
      new Promise<number>((resolve) => {
        const row = button.parentElement!;
        let count = 0;
        const interrupt = (event: Event) => {
          if (
            !(event instanceof TransitionEvent) ||
            event.propertyName !== 'height' ||
            !(event.target instanceof HTMLElement) ||
            !event.target.classList.contains('workspace-group-branches')
          )
            return;
          const animation = event.target
            .getAnimations()
            .find((item) => item instanceof CSSTransition && item.transitionProperty === 'height');
          if (!animation) return;
          count += 1;
          if (count === 3) {
            row.removeEventListener('transitionrun', interrupt);
            resolve(count);
            return;
          }
          animation.currentTime = Number(animation.effect!.getTiming().duration) / 2;
          (button as HTMLButtonElement).click();
        };
        row.addEventListener('transitionrun', interrupt);
        (button as HTMLButtonElement).click();
      })
  );
  expect(toggles).toBe(3);
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  const branches = group.locator('..').locator(':scope > .workspace-group-branches');
  await expect(branches).toHaveCount(1);
  await expect(
    tree.locator('.workspace-branch-enter-active, .workspace-branch-leave-active')
  ).toHaveCount(0);
  await expect(branches).toHaveCSS('overflow', 'visible');
  expect(
    await branches.evaluate(
      (branch) =>
        !(branch as HTMLElement).inert &&
        (branch as HTMLElement).style.getPropertyValue('--workspace-branch-height') === ''
    )
  ).toBe(true);
  await expect(branches.locator('.workspace-branch-button')).toHaveCount(2);
});

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`Resource tree expansion shares restrained motion and preserves navigation: ${reducedMotion}`, async ({
    page
  }) => {
    await page.emulateMedia({ reducedMotion });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addInitScript(() => localStorage.setItem('mar.locale.v2', 'zh-CN'));
    await observeBranchMotion(page);
    const fixture = await mockResourceTree(page);
    await page.goto('/console');
    await page.getByRole('button', { name: '进入控制台', exact: true }).click();
    const tree = page.locator('aside.workspace-tree');
    await tree.getByRole('button', { name: 'Node 1', exact: true }).click();
    const group = tree.locator('.workspace-group-toggle[title="Team"]');
    const nodeToggle = tree.locator('.node-expand-button').first();
    await expect(group).toBeVisible();
    await expect(tree.locator('.workspace-branch-enter-active')).toHaveCount(0);
    const initialCount = (await branchMotionSamples(page)).length;
    const duration = reducedMotion === 'reduce' ? '0s' : '0.16s';
    for (const toggle of [group, nodeToggle])
      await expect(toggle.locator('.tree-chevron')).toHaveCSS('transition-duration', duration);

    await group.focus();
    await group.press('Enter');
    await expect(group).toHaveAttribute('aria-expanded', 'true');
    await expect(group).toBeFocused();
    await expect(tree.getByRole('button', { name: 'Workspace A', exact: true })).toBeVisible();
    await expect(tree.locator('.workspace-branch-enter-active')).toHaveCount(0);
    await group.press('Enter');
    await expect(tree.getByRole('button', { name: 'Workspace A', exact: true })).toHaveCount(0);
    await expect(group).toBeFocused();
    await nodeToggle.click();
    await expect(group).toHaveCount(0);
    await nodeToggle.click();
    await expect(group).toBeVisible();
    await expect(tree.locator('.workspace-branch-enter-active')).toHaveCount(0);

    const samples = (await branchMotionSamples(page)).slice(initialCount);
    if (reducedMotion === 'reduce') expect(samples).toEqual([]);
    else {
      expect(samples).toHaveLength(4);
      for (const sample of samples) {
        const [start, middle, end] = sample.heights;
        expect(middle!).toBeGreaterThan(Math.min(start!, end!));
        expect(middle!).toBeLessThan(Math.max(start!, end!));
        const [topBefore, topDuring, topAfter] = sample.followingNodeTops;
        expect(topDuring!).toBeGreaterThan(Math.min(topBefore!, topAfter!));
        expect(topDuring!).toBeLessThan(Math.max(topBefore!, topAfter!));
        expect(sample.inert).toBe(start! > end!);
        expect(sample.duration).toBe(160);
      }
    }
    const beforeFilter = (await branchMotionSamples(page)).length;
    const filter = tree.locator('.workspace-tree-filter input');
    await filter.fill('Workspace A');
    await expect(tree.getByRole('button', { name: 'Workspace A', exact: true })).toBeVisible();
    await filter.fill('');
    await expect(group).toHaveAttribute('aria-expanded', 'false');
    expect((await branchMotionSamples(page)).length).toBe(beforeFilter);
    expect(fixture.mutations).toEqual([]);

    await group.click();
    await tree.getByRole('button', { name: 'Workspace A', exact: true }).click();
    await group.click();
    await expect(tree.getByRole('button', { name: 'Workspace A', exact: true })).toHaveCount(0);
    await page.reload();
    await expect(group).toBeVisible();
    expect(await branchMotionSamples(page)).toEqual([]);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '工作', exact: true }).click();
    await expect(tree).toBeVisible();
    await group.click();
    await expect(tree.getByRole('button', { name: 'Workspace A', exact: true })).toBeVisible();
    await expect(tree.locator('.workspace-branch-enter-active')).toHaveCount(0);
    expect((await branchMotionSamples(page)).length).toBe(reducedMotion === 'reduce' ? 0 : 1);
  });
}

for (const locale of ['zh-CN', 'en-US'] as const) {
  test(`Local Node and Workspace ordering supports menus, Node dragging, and reload restoration: ${locale}`, async ({
    page
  }) => {
    const labels =
      locale === 'zh-CN'
        ? { enter: '进入控制台', up: '上移', down: '下移' }
        : { enter: 'Open console', up: 'Move up', down: 'Move down' };
    await page.addInitScript((value) => localStorage.setItem('mar.locale.v2', value), locale);
    const fixture = await mockResourceTree(page);
    await page.goto('/console');
    await page.getByRole('button', { name: labels.enter, exact: true }).click();
    const tree = page.locator('aside.workspace-tree');
    const nodeRows = tree.locator('.tree-node');
    const node = (name: string) => tree.getByRole('button', { name, exact: true });
    let activeMenu: Locator;
    const openMenu = async (name: string) => {
      activeMenu = await openRowMenu(page, node(name));
    };
    const menu = (name: string) => activeMenu.getByRole('menuitem', { name, exact: true });
    const team = tree
      .locator('.workspace-group')
      .filter({ has: page.locator('.workspace-group-toggle[title="Team"]') });
    const teamWorkspaces = team.locator('.workspace-branch-button');
    await node('Node 1').click();
    await tree.locator('.workspace-group-toggle[title="Team"]').click();
    await node('Workspace A').click();
    await page.locator('.session-list .session-link').first().click();
    const tab = page.getByRole('tab', { name: /Workspace A/ });
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(teamWorkspaces).toHaveText(['Workspace A', 'Workspace B']);
    await expect
      .poll(
        () => fixture.watchLifecycle.filter((entry) => entry.path.includes('/workspaces/')).length
      )
      .toBe(1);
    await expect
      .poll(
        () =>
          fixture.watchLifecycle.filter((entry) => entry.path.includes('/agent-sessions/')).length
      )
      .toBe(1);
    const watchesBeforeOrdering = [...fixture.watchLifecycle];

    await openMenu('Workspace A');
    await expect(menu(labels.up)).toBeDisabled();
    await menu(labels.down).click();
    await expect(teamWorkspaces).toHaveText(['Workspace B', 'Workspace A']);
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await openMenu('Workspace A');
    await expect(menu(labels.down)).toBeDisabled();
    await menu(labels.up).click();
    await expect(teamWorkspaces).toHaveText(['Workspace A', 'Workspace B']);
    await openMenu('Workspace A');
    await menu(labels.down).click();

    await openMenu('Workspace V');
    await menu(labels.up).click();
    const ungrouped = tree
      .locator('.node-tree > li')
      .first()
      .locator(':scope > .workspace-branches > li > .workspace-branch-button');
    await expect(ungrouped).toHaveText(['Workspace V', 'Workspace U']);
    await tree.locator('.workspace-group-toggle[title="Solo"]').click();
    await openMenu('Workspace C');
    await expect(menu(labels.up)).toBeDisabled();
    await expect(menu(labels.down)).toBeDisabled();
    await tree.locator('.workspace-tree-filter input').click();

    await openMenu('Node 1');
    await expect(menu(labels.up)).toBeDisabled();
    await menu(labels.down).click();
    await expect(nodeRows).toHaveText(['Node 2', 'Node 1']);
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await openMenu('Node 2');
    await menu(labels.down).click();
    await expect(nodeRows).toHaveText(['Node 1', 'Node 2']);
    await node('Node 2').dragTo(node('Node 1'), { targetPosition: { x: 30, y: 4 } });
    await expect(nodeRows).toHaveText(['Node 2', 'Node 1']);
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(
      tree.locator('.tree-node-row.dragging, .tree-node-row.drop-before, .tree-node-row.drop-after')
    ).toHaveCount(0);

    const filter = tree.locator('.workspace-tree-filter input');
    await filter.fill('Workspace');
    await openMenu('Node 1');
    await expect(menu(labels.up)).toBeDisabled();
    await expect(menu(labels.down)).toBeDisabled();
    await filter.click();
    await expect(node('Node 1')).toHaveAttribute('draggable', 'false');
    await openMenu('Workspace A');
    await expect(menu(labels.up)).toBeDisabled();
    await expect(menu(labels.down)).toBeDisabled();
    await filter.click();
    await filter.fill('');
    await expect(tab).toHaveAttribute('aria-selected', 'true');

    const saved = await page.evaluate(() => ({
      layout: JSON.parse(sessionStorage.getItem('mar.workbench.layout.v1') ?? '{}'),
      localLayout: localStorage.getItem('mar.workbench.layout.v1')
    }));
    expect(saved.layout.nodeOrder).toEqual(['node-2', 'node-1']);
    expect(saved.localLayout).toBeNull();
    expect(fixture.watchLifecycle).toEqual(watchesBeforeOrdering);
    fixture.addNode();
    await page.reload();
    await expect(nodeRows).toHaveText(['Node 2', 'Node 1', 'Node 3']);
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await tree.locator('.workspace-group-toggle[title="Team"]').click();
    await expect(teamWorkspaces).toHaveText(['Workspace B', 'Workspace A']);
    const restoredBranch = tree
      .locator('.node-tree > li')
      .filter({ has: page.getByRole('button', { name: 'Node 1', exact: true }) });
    await expect(
      restoredBranch.locator(':scope > .workspace-branches > li > .workspace-branch-button')
    ).toHaveText(['Workspace V', 'Workspace U']);
    expect(fixture.mutations).toEqual([]);
  });
}

test('Mobile Node and Workspace menus reorder locally without enabling Node dragging', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await mockResourceTree(page);
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台', exact: true }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  const tree = page.locator('aside.workspace-tree');
  const node = (name: string) => tree.getByRole('button', { name, exact: true });
  const branch = tree
    .locator('.node-tree > li')
    .filter({ has: page.getByRole('button', { name: 'Node 1', exact: true }) });
  await expect(node('Node 1')).toHaveAttribute('draggable', 'false');
  const nodeMenu = await openRowMenu(page, node('Node 1'), false);
  await nodeMenu.getByRole('menuitem', { name: '下移', exact: true }).click();
  await expect(tree.locator('.tree-node')).toHaveText(['Node 2', 'Node 1']);
  await branch.locator('.node-expand-button').click();
  const workspaceMenu = await openRowMenu(page, node('Workspace V'), false);
  await workspaceMenu.getByRole('menuitem', { name: '上移', exact: true }).click();
  await expect(
    branch.locator(':scope > .workspace-branches > li > .workspace-branch-button')
  ).toHaveText(['Workspace V', 'Workspace U']);
  expect(fixture.mutations).toEqual([]);
});

test('Node dragging ignores Workspace and group targets, cancellation preserves order, and Workspace sorting still works', async ({
  page
}) => {
  const fixture = await mockResourceTree(page, true);
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台', exact: true }).click();
  const tree = page.locator('aside.workspace-tree');
  const node = (name: string) => tree.getByRole('button', { name, exact: true });
  await node('Node 1').click();
  const group = tree.locator('.workspace-group-toggle[title="Team"]').locator('..');
  const source = node('Workspace U');
  const target = node('Workspace V');
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  try {
    await node('Node 2').dispatchEvent('dragstart', { dataTransfer: transfer });
    await group
      .locator('.workspace-group-toggle')
      .dispatchEvent('dragenter', { dataTransfer: transfer });
    await target.dispatchEvent('dragenter', { dataTransfer: transfer });
    await expect(
      tree.locator(
        '.workspace-group.drop-target, .workspace-branches > li.drop-target, .workspace-branches > li.drop-before, .workspace-branches > li.drop-after'
      )
    ).toHaveCount(0);
    await node('Node 1').dispatchEvent('dragover', { dataTransfer: transfer });
    await expect(tree.locator('.tree-node-row.drop-before')).toHaveCount(1);
    await node('Node 2').dispatchEvent('dragend', { dataTransfer: transfer });
    await expect(
      tree.locator('.tree-node-row.dragging, .tree-node-row.drop-before, .tree-node-row.drop-after')
    ).toHaveCount(0);
    await expect(tree.locator('.tree-node')).toHaveText(['Node 1', 'Node 2']);

    await source.dispatchEvent('dragstart', { dataTransfer: transfer });
    await target.dispatchEvent('dragenter', { dataTransfer: transfer });
    await expect(target.locator('..')).toHaveClass(/drop-before/u);
    await group
      .locator('.workspace-group-toggle')
      .dispatchEvent('dragenter', { dataTransfer: transfer });
    await expect(group).toHaveClass(/drop-target/u);
    const targetBounds = await target.boundingBox();
    await target.dispatchEvent('drop', {
      dataTransfer: transfer,
      clientY: targetBounds!.y + targetBounds!.height - 2
    });
    await source.dispatchEvent('dragend', { dataTransfer: transfer });
    await expect(
      tree
        .locator('.node-tree > li')
        .first()
        .locator(':scope > .workspace-branches > li > .workspace-branch-button')
    ).toHaveText(['Workspace V', 'Workspace U']);
    await expect(
      tree.locator(
        '.workspace-group.drop-target, .workspace-branches > li.drop-target, .workspace-branches > li.drop-before, .workspace-branches > li.drop-after'
      )
    ).toHaveCount(0);
    expect(fixture.mutations).toEqual([]);
  } finally {
    await transfer.dispose();
  }
});

test('Workspaces support real local drag ordering without group-management permission', async ({
  page
}) => {
  const fixture = await mockResourceTree(page);
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台', exact: true }).click();
  const tree = page.locator('aside.workspace-tree');
  const workspace = (name: string) => tree.getByRole('button', { name, exact: true });
  await workspace('Node 1').click();
  await dragOverRow(page, workspace('Workspace U'), workspace('Workspace V'), 'after');
  await expect(workspace('Workspace V').locator('..')).toHaveClass(/drop-after/u);
  await page.mouse.up();
  await expect(
    tree
      .locator('.node-tree > li')
      .first()
      .locator(':scope > .workspace-branches > li > .workspace-branch-button')
  ).toHaveText(['Workspace V', 'Workspace U']);
  const teamHeading = tree.locator('.workspace-group-toggle[title="Team"]');
  await workspace('Workspace U').dragTo(teamHeading);
  await teamHeading.click();
  await workspace('Workspace A').dragTo(workspace('Workspace V'));
  await workspace('Workspace A').dragTo(workspace('Node 1'));
  await expect(teamHeading.locator('..').locator('.workspace-branch-button')).toHaveText([
    'Workspace A',
    'Workspace B'
  ]);
  const filter = tree.locator('.workspace-tree-filter input');
  await filter.fill('Workspace');
  await expect(workspace('Workspace U').locator('..')).toHaveAttribute('draggable', 'false');
  expect(fixture.mutations).toEqual([]);
});

test('Real Workspace dragging supports within-group sorting, grouping, and moving out through the owning Node', async ({
  page
}) => {
  const fixture = await mockResourceTree(page, true);
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台', exact: true }).click();
  const tree = page.locator('aside.workspace-tree');
  const workspace = (name: string) => tree.getByRole('button', { name, exact: true });
  await workspace('Node 1').click();
  const teamHeading = tree.locator('.workspace-group-toggle[title="Team"]');
  await teamHeading.click();
  await dragOverRow(page, workspace('Workspace A'), workspace('Workspace B'), 'after');
  await expect(workspace('Workspace B').locator('..')).toHaveClass(/drop-after/u);
  await expect(teamHeading.locator('..')).not.toHaveClass(/drop-target/u);
  await page.mouse.up();
  await expect(teamHeading.locator('..').locator('.workspace-branch-button')).toHaveText([
    'Workspace B',
    'Workspace A'
  ]);
  await workspace('Workspace U').dragTo(teamHeading);
  await expect(teamHeading.locator('..').locator('.workspace-branch-button')).toHaveText([
    'Workspace B',
    'Workspace A',
    'Workspace U'
  ]);
  await workspace('Workspace V').dragTo(teamHeading);
  await expect(teamHeading.locator('..').locator('.workspace-branch-button')).toHaveCount(4);
  await tree.locator('.workspace-group-toggle[title="Solo"]').click();
  await workspace('Workspace C').dragTo(teamHeading);
  await expect(teamHeading.locator('..').locator('.workspace-branch-button')).toHaveCount(5);
  await expect(
    tree
      .locator('.node-tree > li')
      .first()
      .locator(':scope > .workspace-branches > li > .workspace-branch-button')
  ).toHaveCount(0);

  await workspace('Workspace A').dragTo(workspace('Node 2'));
  await expect(teamHeading.locator('..').locator('.workspace-branch-button')).toHaveCount(5);
  expect(fixture.mutations).toHaveLength(3);
  const patch = page.waitForRequest(
    (request) =>
      request.method() === 'PATCH' && request.url().includes('/api/workspaces/workspace-1')
  );
  await dragOverRow(page, workspace('Workspace A'), workspace('Node 1'), 'before');
  await expect(workspace('Node 1').locator('..')).toHaveClass(/drop-target/u);
  await expect(tree.locator('.tree-node-row.drop-before, .tree-node-row.drop-after')).toHaveCount(
    0
  );
  await page.mouse.up();
  expect((await patch).postDataJSON()).toEqual({ groupName: null });
  await expect(
    tree
      .locator('.node-tree > li')
      .first()
      .locator(':scope > .workspace-branches > li > .workspace-branch-button')
  ).toHaveText(['Workspace A']);
  await expect(tree.locator('.drop-target, .drop-before, .drop-after')).toHaveCount(0);
  await page.reload();
  const nodeToggle = tree.locator('.node-expand-button').first();
  await expect(nodeToggle).toHaveAttribute('aria-expanded', 'true');
  // Reopen the restored Node to fetch its lazy Workspace list without an active Workspace.
  await nodeToggle.click();
  await nodeToggle.click();
  await expect(
    tree
      .locator('.node-tree > li')
      .first()
      .locator(':scope > .workspace-branches > li > .workspace-branch-button')
  ).toHaveText(['Workspace A']);
});

test('Real Node dragging shows upper and lower insertion borders and inserts on the selected side', async ({
  page
}) => {
  const fixture = await mockResourceTree(page);
  fixture.addNode();
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台', exact: true }).click();
  const tree = page.locator('aside.workspace-tree');
  const node = (name: string) => tree.getByRole('button', { name, exact: true });
  await dragOverRow(page, node('Node 1'), node('Node 2'), 'before');
  await expect(node('Node 2').locator('..')).toHaveClass(/drop-before/u);
  await expect(node('Node 2').locator('..')).not.toHaveClass(/drop-after/u);
  await page.mouse.up();
  await expect(tree.locator('.tree-node')).toHaveText(['Node 1', 'Node 2', 'Node 3']);
  await dragOverRow(page, node('Node 1'), node('Node 2'), 'after');
  await expect(node('Node 2').locator('..')).toHaveClass(/drop-after/u);
  await expect(node('Node 2').locator('..')).not.toHaveClass(/drop-before/u);
  await page.mouse.up();
  await expect(tree.locator('.tree-node')).toHaveText(['Node 2', 'Node 1', 'Node 3']);
  await dragOverRow(page, node('Node 3'), node('Node 2'), 'before');
  await expect(node('Node 2').locator('..')).toHaveClass(/drop-before/u);
  await page.mouse.up();
  await expect(tree.locator('.tree-node')).toHaveText(['Node 3', 'Node 2', 'Node 1']);
  await dragOverRow(page, node('Node 3'), node('Node 1'), 'after');
  await page.mouse.up();
  await expect(tree.locator('.tree-node')).toHaveText(['Node 2', 'Node 1', 'Node 3']);
  await expect(tree.locator('.drop-target, .drop-before, .drop-after')).toHaveCount(0);
  expect(fixture.mutations).toEqual([]);
});
