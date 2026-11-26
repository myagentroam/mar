import { expect, test, type Locator, type Page } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

// @test-covers packages/web-core/src/view/workspace/WorkspaceCollaborationDialog.vue
// @test-covers packages/web-core/src/view/workspace/WorkspaceCollaborationCanvas.vue

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/collaboration-network.html');
});
test.afterAll(async () => {
  await fixture?.close();
});

async function openNetwork(page: Page, theme: 'dark' | 'daylight', longTitles = false) {
  await page.goto(
    `${fixture.url}collaboration-network.html?theme=${theme}${longTitles ? '&longTitles' : ''}`
  );
  await page.getByRole('button', { name: '查看协作网络' }).click();
  const dialog = page.getByRole('dialog', { name: '协作网络', exact: true });
  const port = dialog.locator('.network-viewport');
  const current = port.locator('[aria-current="true"]');
  await expect(current).toBeVisible();
  return { dialog, port, current };
}

async function edgeHitPoint(edge: Locator, distance = 0) {
  return edge.evaluate((element, distance) => {
    const path = element as SVGPathElement;
    const transform = path.getScreenCTM()!;
    const length = path.getTotalLength();
    for (const fraction of [0.5, 0.25, 0.75, 0.125, 0.875]) {
      const point = path.getPointAtLength(length * fraction).matrixTransform(transform);
      const next = path.getPointAtLength(length * fraction + 1).matrixTransform(transform);
      const dx = next.x - point.x;
      const dy = next.y - point.y;
      const norm = Math.hypot(dx, dy);
      for (const side of [1, -1]) {
        const x = point.x - (dy / norm) * distance * side;
        const y = point.y + (dx / norm) * distance * side;
        const [top, ...overlaps] = document.elementsFromPoint(x, y);
        const isEdge = (el: Element) => el.matches('.edge-hit-area');
        if (
          distance === 0
            ? top === path || (top && isEdge(top) && overlaps.includes(path))
            : top === path && !overlaps.some(isEdge)
        ) {
          return { x, y };
        }
      }
    }
    throw new Error('The dashed edge has no visible hit area');
  }, distance);
}

test('shows clipped titles on demand and distinguishes shared boards from the selected session’s board', async ({
  page
}, info) => {
  await page.setViewportSize({ width: 1480, height: 940 });
  const { dialog, port, current } = await openNetwork(page, 'dark', true);
  const board = dialog.getByRole('region', { name: '白板', exact: true });
  const child = port.getByRole('button', { name: /^回归测试：核对[^·]+$/ });
  const anchorName = (await current.locator('.network-node-title').textContent())!;
  const childName = (await child.textContent())!.trim();
  const tooltip = dialog.getByRole('tooltip');
  await expect(dialog.getByRole('heading', { name: '协作网络' })).toHaveCSS('font-weight', '400');
  const anchorSubtitle = dialog.getByText(anchorName, { exact: true }).first();
  await expect(anchorSubtitle).toHaveCSS('text-overflow', 'ellipsis');
  await anchorSubtitle.hover();
  await expect(tooltip).toHaveText(anchorName);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(tooltip).not.toBeVisible();
  await child.hover();
  await expect(tooltip).toHaveText(childName);
  await page.mouse.move(1, 1);
  await expect(tooltip).not.toBeVisible();
  await port.getByRole('button', { name: '文档更新', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(child).toBeFocused();
  await expect(tooltip).toHaveText(childName);
  await expect(child.locator('.network-node-title')).toHaveCSS('font-weight', '400');
  await child.press('Enter');
  const heading = board.getByRole('heading', { name: `白板 · ${childName}`, exact: true });
  await expect(heading).toHaveCSS('font-weight', '400');
  const clippedTitle = heading.getByText(`白板 · ${childName}`, { exact: true });
  await expect(clippedTitle).toHaveCSS('white-space', 'nowrap');
  await expect(clippedTitle).toHaveCSS('text-overflow', 'ellipsis');
  await expect
    .poll(() => clippedTitle.evaluate((el) => el.scrollWidth > el.clientWidth))
    .toBe(true);
  await heading.hover();
  await expect(tooltip).toHaveText(`白板 · ${childName}`);
  await page.mouse.move(1, 1);
  await board.getByRole('button', { name: '在主工作面打开' }).focus();
  await page.keyboard.press('Tab');
  await expect(heading).toBeFocused();
  await expect(tooltip).toHaveText(`白板 · ${childName}`);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(tooltip).not.toBeVisible();

  await expect(board.getByRole('group', { name: '切换白板' })).toHaveCount(0);
  await expect(board.getByText('白板暂无内容。')).toBeVisible();
  const shared = port.getByRole('button', { name: `${anchorName} 向 ${childName} 共享白板` });
  await port.focus();
  await page.keyboard.press('Tab');
  await expect(shared).toBeFocused();
  await page.keyboard.press('Space');
  const sharedHeading = board.getByRole('heading', { name: `共享白板 · ${anchorName}` });
  await expect(sharedHeading).toBeVisible();
  await expect(shared).toBeFocused();
  await expect(shared).toHaveAttribute('aria-pressed', 'true');
  await expect(child).toHaveAttribute('aria-pressed', 'false');
  await expect(board.getByText('发布前先核对回归结果。')).toBeVisible();
  await sharedHeading.hover();
  await expect(tooltip).toHaveText(`共享白板 · ${anchorName}`);
  await page.screenshot({
    path: info.outputPath('collaboration-network-long-titles.png'),
    animations: 'disabled'
  });
  await child.click();
  await expect(heading).toBeVisible();
  await expect(shared).toHaveAttribute('aria-pressed', 'false');
  await expect(child).toHaveAttribute('aria-pressed', 'true');
  await expect(board.getByText('白板暂无内容。')).toBeVisible();
});

test('keeps stale board content hidden until the navigation retry succeeds', async ({ page }) => {
  const { dialog, current } = await openNetwork(page, 'dark');
  const board = dialog.getByRole('region', { name: '白板', exact: true });
  const content = board.getByText('发布前先核对回归结果。');
  await expect(content).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('fixture-board-failed')));
  await expect(content).toBeHidden();
  await dialog.getByRole('button', { name: '重试' }).click();
  await expect(board.getByRole('status', { name: '正在读取白板' })).toBeVisible();
  await expect(content).toBeHidden();
  await expect(board.getByRole('button', { name: '在主工作面打开' })).toBeDisabled();
  await expect(current).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('fixture-board-recovered')));
  await expect(content).toBeVisible();
  await expect(board.getByRole('button', { name: '在主工作面打开' })).toBeEnabled();
});

test('opens the full network from a deep Aside session and centers only its entry', async ({
  page
}) => {
  await page.setViewportSize({ width: 1480, height: 940 });
  const { dialog, port } = await openNetwork(page, 'dark');
  const layout = () =>
    port.locator('.network-node').evaluateAll((nodes) =>
      nodes
        .map((node) => {
          const { dataset, style } = node as HTMLElement;
          return [dataset.networkSession, style.left, style.top].join(':');
        })
        .sort()
    );
  const mainLayout = await layout();
  expect(mainLayout).toHaveLength(31);
  const edgeLayout = () =>
    port
      .locator('.edge-parent, .edge-sharing')
      .evaluateAll((paths) =>
        paths
          .map((path) => `${path.getAttribute('class')?.split(' ')[0]}:${path.getAttribute('d')}`)
          .sort()
      );
  const mainEdges = await edgeLayout();
  await port.getByRole('button', { name: '发布前冒烟' }).press('Enter');
  await dialog.getByRole('button', { name: '在侧栏打开' }).click();
  await expect(dialog).toBeHidden();
  await page
    .getByRole('complementary', { name: 'Aside' })
    .getByRole('button', { name: '查看协作网络' })
    .click();
  const current = port.locator('[aria-current="true"]');
  await expect(current).toHaveAccessibleName('发布前冒烟 当前会话');
  await expect.poll(layout).toEqual(mainLayout);
  await expect(port.locator('.edge-parent')).toHaveCount(27);
  await expect(port.locator('.edge-sharing')).toHaveCount(6);
  await expect.poll(edgeLayout).toEqual(mainEdges);
  await expect(dialog.getByRole('heading', { name: '白板 · 发布前冒烟' })).toBeVisible();
  await expect
    .poll(async () => {
      const [viewport, node] = await Promise.all([port.boundingBox(), current.boundingBox()]);
      return Math.hypot(
        node!.x + node!.width / 2 - viewport!.x - viewport!.width / 2,
        node!.y + node!.height / 2 - viewport!.y - viewport!.height / 2
      );
    })
    .toBeLessThan(2);
});

test('keeps focus in the canvas when a selected peer disappears from the live network', async ({
  page
}) => {
  const { dialog, port, current } = await openNetwork(page, 'dark');
  const peer = port.getByRole('button', { name: '安全审查', exact: true });
  await peer.press('Enter');
  await expect(peer).toBeFocused();
  await expect(peer).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => window.dispatchEvent(new Event('fixture-board-detached')));
  await expect(peer).toHaveCount(0);
  await expect(port).toBeFocused();
  await expect(dialog.getByRole('heading', { name: '白板 · 安全审查' })).toBeVisible();
  await expect(dialog.getByText('核对权限审查的结论。')).toBeVisible();
  await page.keyboard.press('Home');
  await expect(port).toBeFocused();
  await expect(current).toBeInViewport();
});

test('explains that the display limit can omit relationships as well as sessions', async ({
  page
}) => {
  await page.goto(`${fixture.url}collaboration-network.html?truncated`);
  await page.getByRole('button', { name: '查看协作网络' }).click();
  const dialog = page.getByRole('dialog', { name: '协作网络', exact: true });
  await expect(dialog.locator('.collaboration-feedback')).toHaveText(
    '此网络超过显示上限，部分会话或连线已省略。'
  );
  await expect(dialog.locator('.network-node')).toHaveCount(31);
});

test('focuses the current session in a complex network, zooms at the pointer and reads a board in place', async ({
  page
}, info) => {
  await page.setViewportSize({ width: 1480, height: 940 });
  const { dialog, port, current } = await openNetwork(page, 'dark');
  const centered = async () => {
    const [viewport, node] = await Promise.all([port.boundingBox(), current.boundingBox()]);
    return Math.hypot(
      node!.x + node!.width / 2 - viewport!.x - viewport!.width / 2,
      node!.y + node!.height / 2 - viewport!.y - viewport!.height / 2
    );
  };
  await expect.poll(centered).toBeLessThan(2);
  const agentIcon = '[data-mar-icon="agent-session"]';
  await expect(port.locator(`.network-node:has(${agentIcon}[aria-hidden="true"])`)).toHaveCount(31);
  await expect(current.locator(agentIcon)).toBeVisible();
  await expect(port.locator('.edge-parent')).toHaveCount(27);
  await expect(port.locator('.edge-sharing')).toHaveCount(6);
  await expect(dialog.locator('output')).toHaveText('80%');
  const board = dialog.getByRole('region', { name: '白板', exact: true });
  await expect(board.getByText('发布前先核对回归结果。')).toBeVisible();
  await expect(board.getByRole('heading', { name: '最近变更' })).toBeVisible();
  await expect(board.getByText('Added 2 entries')).toBeVisible();
  await expect(board.getByText('只读', { exact: true })).toHaveCount(0);
  const heading = board.getByRole('heading', { name: '白板 · 发布协调' });
  const actions = board.getByRole('group', { name: '打开 发布协调' });
  await expect(heading).toBeVisible();
  expect((await actions.boundingBox())!.y + (await actions.boundingBox())!.height).toBeLessThan(
    (await heading.boundingBox())!.y
  );
  const [titleBox, boardIconBox] = await Promise.all([
    heading.locator('.clip-title').boundingBox(),
    heading.locator('[data-mar-icon="collection"]').boundingBox()
  ]);
  expect(
    Math.abs(titleBox!.y + titleBox!.height / 2 - boardIconBox!.y - boardIconBox!.height / 2)
  ).toBeLessThan(1);
  await expect(dialog.getByText('会话详情', { exact: true })).toHaveCount(0);
  await expect(current).toHaveAccessibleDescription(/父会话：发布计划.*关注 安全审查 的白板/);
  await expect(
    board.getByRole('button', { name: '在主工作面打开' }).locator('[data-mar-icon="external-link"]')
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath('collaboration-network-desktop.png'),
    animations: 'disabled'
  });

  const viewport = (await port.boundingBox())!;
  const icon = (await current.locator(agentIcon).boundingBox())!;
  const start = { x: icon.x + icon.width / 2, y: icon.y + icon.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 86, start.y + 37, { steps: 5 });
  await page.mouse.up();
  await expect.poll(centered).toBeGreaterThan(70);
  await dialog.getByRole('button', { name: '定位当前' }).click();
  await expect.poll(centered).toBeLessThan(2);
  await page.mouse.move(viewport.x + viewport.width * 0.28, viewport.y + viewport.height * 0.35);
  await page.mouse.wheel(0, -240);
  await expect(dialog.locator('output')).not.toHaveText('80%');
  await expect.poll(centered).toBeGreaterThan(30);
  await dialog.getByRole('button', { name: '定位当前' }).click();
  await expect.poll(centered).toBeLessThan(2);
  const clickEdge = async (name: string) => {
    const edge = port.getByRole('button', { name, exact: true });
    const hit = await edgeHitPoint(edge);
    await page.mouse.click(hit.x, hit.y);
    await expect(edge).toHaveAttribute('aria-pressed', 'true');
    await expect(port.locator('.is-selected-edge')).toHaveCount(1);
  };
  await clickEdge('安全审查 向 发布协调 共享白板');
  await expect(board.getByText('核对权限审查的结论。')).toBeVisible();
  await expect(board.getByText('Added 2 entries')).toBeVisible();
  await clickEdge('发布协调 向 安全审查 共享白板');
  await expect(board.getByText('发布前先核对回归结果。')).toBeVisible();
  await expect(board.getByRole('heading', { name: '共享白板 · 发布协调' })).toBeVisible();
  await expect(dialog.getByText('Added 2 entries')).toBeVisible();
  await page.screenshot({
    path: info.outputPath('collaboration-network-whiteboard.png'),
    animations: 'disabled'
  });
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: '查看协作网络' })).toBeFocused();
  await page.getByRole('button', { name: '查看协作网络' }).click();
  await current.click();
  const detachedEdge = port.getByRole('button', { name: '安全审查 向 发布协调 共享白板' });
  await detachedEdge.press('Enter');
  await expect(detachedEdge).toBeFocused();
  await expect(board.getByText('Added 2 entries')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('fixture-board-detached')));
  await expect(port.locator('.edge-sharing')).toHaveCount(4);
  await expect(port).toBeFocused();
  await expect(board.getByText('核对权限审查的结论。')).toBeVisible();
  await expect(port.locator('.is-selected-edge')).toHaveCount(0);
  await expect(board.getByRole('heading', { name: '共享白板 · 安全审查' })).toBeVisible();
  await board.getByRole('button', { name: '在主工作面打开' }).click();
  await expect(page.getByRole('status')).toHaveText('main: peer-a');
});

test.describe('narrow viewport', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('keeps long board headings on one line at a mobile width', async ({ page }, info) => {
    const { dialog, port, current } = await openNetwork(page, 'daylight', true);
    const board = dialog.getByRole('region', { name: '白板', exact: true });
    const label = board.getByRole('heading', { name: /^白板 · 发布协调/ }).locator('.clip-title');
    await expect(label).toHaveCSS('white-space', 'nowrap');
    await expect.poll(() => label.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    const edge = port.getByRole('button', { name: /^安全审查 向 发布协调/ });
    await edge.press('Enter');
    await expect(board.getByRole('heading', { name: '共享白板 · 安全审查' })).toBeVisible();
    await current.click();
    await expect(label).toBeVisible();
    await page.screenshot({
      path: info.outputPath('collaboration-network-long-titles-mobile.png'),
      animations: 'disabled'
    });
  });
});

test.describe('touch viewport', () => {
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'Touch panning requires Chromium CDP.'
  );
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('pans diagonally without selecting the touched session and returns to current', async ({
    page
  }, info) => {
    const { dialog, port, current } = await openNetwork(page, 'daylight');
    const initial = (await current.boundingBox())!;
    const viewport = (await port.boundingBox())!;
    expect(initial.x + initial.width / 2).toBeCloseTo(viewport.x + viewport.width / 2, 0);
    expect(initial.y + initial.height / 2).toBeCloseTo(viewport.y + viewport.height / 2, 0);
    const x = Math.round(initial.x + initial.width / 2);
    const y = Math.round(initial.y + initial.height / 2);
    const parent = port.getByRole('button', { name: '发布计划', exact: true });
    await parent.tap();
    await expect(parent).toHaveAttribute('aria-pressed', 'true');
    const input = await page.context().newCDPSession(page);
    try {
      await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await input.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x + 48, y: y + 23 }]
      });
      await input.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x + 94, y: y + 46 }]
      });
      await expect
        .poll(async () => (await current.boundingBox())!.x - initial.x)
        .toBeGreaterThan(70);
      await expect
        .poll(async () => (await current.boundingBox())!.y - initial.y)
        .toBeGreaterThan(30);
      await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally {
      await input.detach();
    }
    await expect(port).not.toHaveClass(/is-dragging/);
    await expect(parent).toHaveAttribute('aria-pressed', 'true');
    await dialog.getByRole('button', { name: '定位当前' }).tap();
    await expect
      .poll(async () => Math.abs((await current.boundingBox())!.x - initial.x))
      .toBeLessThan(2);
    await current.tap();
    await expect(current).toHaveAttribute('aria-pressed', 'true');
    const reverse = port.getByRole('button', { name: '发布协调 向 安全审查 共享白板' });
    const reverseHit = await edgeHitPoint(reverse);
    await page.touchscreen.tap(reverseHit.x, reverseHit.y);
    await expect(reverse).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByRole('heading', { name: '共享白板 · 发布协调' })).toBeVisible();
    const edge = port.getByRole('button', { name: '安全审查 向 发布协调 共享白板' });
    const hit = await edgeHitPoint(edge, 9);
    await page.touchscreen.tap(hit.x, hit.y);
    await expect(edge).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByRole('heading', { name: '共享白板 · 安全审查' })).toBeVisible();
    await page.screenshot({
      path: info.outputPath('collaboration-network-mobile.png'),
      animations: 'disabled'
    });
  });
});
