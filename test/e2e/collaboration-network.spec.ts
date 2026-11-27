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

async function openNetwork(
  page: Page,
  theme: 'dark' | 'daylight',
  titleMode?: 'long' | 'unbroken'
) {
  await page.goto(
    `${fixture.url}collaboration-network.html?theme=${theme}${titleMode ? `&titleMode=${titleMode}` : ''}`
  );
  await page.getByRole('button', { name: '查看协作网络' }).click();
  const dialog = page.getByRole('dialog', { name: '协作网络', exact: true });
  const port = dialog.locator('.network-viewport');
  const current = port.locator('[aria-current="true"]');
  await expect(current).toBeVisible();
  return { dialog, port, current };
}

function titleLayout(label: Locator) {
  return label.evaluate((el) => ({
    lines: Math.round(
      el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)
    ),
    clipped: el.scrollHeight > el.clientHeight
  }));
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
  const { dialog, port, current } = await openNetwork(page, 'dark', 'long');
  const board = dialog.getByRole('region', { name: '协作白板', exact: true });
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
  await port.getByRole('button', { name: '会话操作：文档更新', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(child).toBeFocused();
  await expect(tooltip).toHaveText(childName);
  await expect(child.locator('.network-node-title')).toHaveCSS('font-weight', '400');
  await child.press('Enter');
  const heading = board.getByRole('heading', { name: `协作白板 · ${childName}`, exact: true });
  await expect(heading).toHaveCSS('font-weight', '400');
  const clippedTitle = heading.getByText(`协作白板 · ${childName}`, { exact: true });
  await expect.poll(() => titleLayout(clippedTitle)).toEqual({ lines: 2, clipped: true });
  const [clippedBox, clippedIconBox] = await Promise.all([
    clippedTitle.boundingBox(),
    heading.locator('[data-mar-icon="collection"]').boundingBox()
  ]);
  expect(
    Math.abs(
      clippedBox!.y + clippedBox!.height / 4 - clippedIconBox!.y - clippedIconBox!.height / 2
    )
  ).toBeLessThan(1);
  await heading.hover();
  await expect(tooltip).toHaveText(`协作白板 · ${childName}`);
  await page.mouse.move(1, 1);
  await dialog.getByRole('button', { name: '定位', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(heading).toBeFocused();
  await expect(tooltip).toHaveText(`协作白板 · ${childName}`);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(tooltip).not.toBeVisible();

  await expect(board.getByRole('group', { name: '切换协作白板' })).toHaveCount(0);
  await expect(board.getByText('协作白板暂无内容。')).toBeVisible();
  const shared = port.getByRole('button', { name: `${anchorName} 向 ${childName} 共享协作白板` });
  await port.focus();
  await page.keyboard.press('Tab');
  await expect(shared).toBeFocused();
  await page.keyboard.press('Space');
  const sharedHeading = board.getByRole('heading', { name: `共享协作白板 · ${anchorName}` });
  await expect(sharedHeading).toBeVisible();
  await expect(shared).toBeFocused();
  await expect(shared).toHaveAttribute('aria-pressed', 'true');
  await expect(child).toHaveAttribute('aria-pressed', 'false');
  await expect(board.getByText('发布前先核对回归结果。')).toBeVisible();
  await page.screenshot({
    path: info.outputPath('collaboration-network-board-title-desktop.png'),
    animations: 'disabled'
  });
  await sharedHeading.hover();
  await expect(tooltip).toHaveText(`共享协作白板 · ${anchorName}`);
  await page.screenshot({
    path: info.outputPath('collaboration-network-long-titles.png'),
    animations: 'disabled'
  });
  await child.click();
  await expect(heading).toBeVisible();
  await expect(shared).toHaveAttribute('aria-pressed', 'false');
  await expect(child).toHaveAttribute('aria-pressed', 'true');
  await expect(board.getByText('协作白板暂无内容。')).toBeVisible();
});

test('keeps a two-line current node highlighted while another board is selected', async ({
  page
}, info) => {
  await page.setViewportSize({ width: 1480, height: 940 });
  const { dialog, port, current } = await openNetwork(page, 'dark', 'long');
  const zoomIn = dialog.getByRole('button', { name: '放大', exact: true });
  await zoomIn.focus();
  for (let step = 0; step < 14; step++) await page.keyboard.press('Enter');
  await expect(dialog.locator('output')).toHaveText('100%');
  await dialog.getByRole('button', { name: '定位', exact: true }).click();

  const currentTitle = current.locator('.network-node-title');
  await expect.poll(() => titleLayout(currentTitle)).toEqual({ lines: 2, clipped: true });
  await expect(current).toHaveCSS('border-top-color', 'rgb(77, 163, 255)');
  const child = port.getByRole('button', { name: /^回归测试：核对[^·]+$/ });
  await expect
    .poll(() => titleLayout(child.locator('.network-node-title')))
    .toEqual({
      lines: 2,
      clipped: true
    });
  await child.click();
  await expect(child).toHaveAttribute('aria-pressed', 'true');
  await expect(child).not.toHaveCSS('border-top-color', 'rgb(77, 163, 255)');
  await expect(current).toHaveAttribute('aria-pressed', 'false');
  await expect(current).toHaveCSS('border-top-color', 'rgb(77, 163, 255)');
  const [nodeBox, badgeBox] = await Promise.all([
    current.boundingBox(),
    current.getByText('当前会话', { exact: true }).boundingBox()
  ]);
  expect(badgeBox!.y + badgeBox!.height).toBeLessThan(nodeBox!.y + nodeBox!.height - 1);

  const arrows = await port.locator('.edge-parent').evaluateAll((edges) =>
    edges.map((edge) => {
      const path = edge as SVGPathElement;
      const length = path.getTotalLength();
      const beforeArrow = path.getPointAtLength(length - 8);
      const tip = path.getPointAtLength(length);
      const markerId = path.getAttribute('marker-end')!.slice(5, -1);
      const marker = document.getElementById(markerId)!.firstElementChild!;
      return {
        straight: Math.abs(tip.x - beforeArrow.x) < 0.1 && tip.y - beforeArrow.y > 7.9,
        sameStroke: getComputedStyle(path).stroke === getComputedStyle(marker).stroke
      };
    })
  );
  expect(arrows).toHaveLength(27);
  expect(arrows.every(({ straight, sameStroke }) => straight && sameStroke)).toBe(true);
  await page.mouse.move(1, 1);
  await dialog.screenshot({ path: info.outputPath('collaboration-network-current-node.png') });
});

test('keeps stale board content hidden until the navigation retry succeeds', async ({ page }) => {
  const { dialog, port, current } = await openNetwork(page, 'dark');
  const board = dialog.getByRole('region', { name: '协作白板', exact: true });
  const more = dialog.getByRole('button', { name: '会话操作：发布协调', exact: true });
  const content = board.getByText('发布前先核对回归结果。');
  await expect(content).toBeVisible();
  await more.press('Enter');
  await expect(dialog.getByRole('menuitem', { name: '在侧栏打开' })).toBeFocused();
  await page.evaluate(() => window.dispatchEvent(new Event('fixture-board-failed')));
  await expect(dialog.getByRole('menu')).toBeHidden();
  await expect(port).toBeFocused();
  await expect(content).toBeHidden();
  await dialog.getByRole('button', { name: '重试' }).click();
  await expect(board.getByRole('status', { name: '正在读取协作白板' })).toBeVisible();
  await expect(content).toBeHidden();
  await expect(more).toBeDisabled();
  await expect(current).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('fixture-board-recovered')));
  await expect(content).toBeVisible();
  await expect(more).toBeEnabled();
});

test('opens the full network from a deep Aside session and centers only its entry', async ({
  page
}) => {
  await page.setViewportSize({ width: 1480, height: 940 });
  const { dialog, port } = await openNetwork(page, 'dark');
  const layout = () =>
    port.locator('[data-network-node]').evaluateAll((nodes) =>
      nodes
        .map((node) => {
          const { dataset, style } = node as HTMLElement;
          return [dataset.networkNode, style.left, style.top].join(':');
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
  await port.getByRole('button', { name: '发布前冒烟', exact: true }).press('Shift+F10');
  await dialog.getByRole('menuitem', { name: '在侧栏打开' }).click();
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
  await expect(dialog.getByRole('heading', { name: '协作白板 · 发布前冒烟' })).toBeVisible();
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
  await expect(dialog.getByRole('heading', { name: '协作白板 · 安全审查' })).toBeVisible();
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
  const scale = dialog.locator('output');
  await expect.poll(async () => Number.parseInt(await scale.innerText())).toBeLessThan(80);
  const board = dialog.getByRole('region', { name: '协作白板', exact: true });
  await expect(board.getByText('发布前先核对回归结果。')).toBeVisible();
  await expect(board.getByRole('heading', { name: '最近变更' })).toBeVisible();
  await expect(board.getByText('Added 2 entries')).toBeVisible();
  await expect(board.getByText('只读', { exact: true })).toHaveCount(0);
  const heading = board.getByRole('heading', { name: '协作白板 · 发布协调' });
  await expect(heading).toBeVisible();
  await expect(board.getByRole('button', { name: /打开/ })).toHaveCount(0);
  const [titleBox, boardIconBox] = await Promise.all([
    heading.locator('.board-title-label').boundingBox(),
    heading.locator('[data-mar-icon="collection"]').boundingBox()
  ]);
  expect(
    Math.abs(titleBox!.y + titleBox!.height / 2 - boardIconBox!.y - boardIconBox!.height / 2)
  ).toBeLessThan(1);
  await expect(dialog.getByText('会话详情', { exact: true })).toHaveCount(0);
  await expect(current).toHaveAccessibleDescription(/父会话：发布计划.*关注 安全审查 的协作白板/);
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
  await dialog.getByRole('button', { name: '定位', exact: true }).click();
  await expect.poll(centered).toBeLessThan(2);
  const beforeWheel = Number.parseInt(await scale.innerText());
  await page.mouse.move(viewport.x + viewport.width * 0.28, viewport.y + viewport.height * 0.35);
  await page.mouse.wheel(0, -240);
  await expect
    .poll(async () => Number.parseInt(await scale.innerText()))
    .toBeGreaterThan(beforeWheel);
  await expect.poll(centered).toBeGreaterThan(30);
  await dialog.getByRole('button', { name: '定位', exact: true }).click();
  await expect.poll(centered).toBeLessThan(2);
  const clickEdge = async (name: string) => {
    const edge = port.getByRole('button', { name, exact: true });
    const hit = await edgeHitPoint(edge);
    await page.mouse.click(hit.x, hit.y);
    await expect(edge).toHaveAttribute('aria-pressed', 'true');
    await expect(port.locator('.is-selected-edge')).toHaveCount(1);
  };
  await clickEdge('安全审查 向 发布协调 共享协作白板');
  await expect(board.getByText('核对权限审查的结论。')).toBeVisible();
  await expect(board.getByText('Added 2 entries')).toBeVisible();
  await clickEdge('发布协调 向 安全审查 共享协作白板');
  await expect(board.getByText('发布前先核对回归结果。')).toBeVisible();
  await expect(board.getByRole('heading', { name: '共享协作白板 · 发布协调' })).toBeVisible();
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
  const detachedEdge = port.getByRole('button', { name: '安全审查 向 发布协调 共享协作白板' });
  await detachedEdge.press('Enter');
  await expect(detachedEdge).toBeFocused();
  await expect(board.getByText('Added 2 entries')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('fixture-board-detached')));
  await expect(port.locator('.edge-sharing')).toHaveCount(4);
  await expect(port).toBeFocused();
  await expect(board.getByText('核对权限审查的结论。')).toBeVisible();
  await expect(port.locator('.is-selected-edge')).toHaveCount(0);
  await expect(board.getByRole('heading', { name: '共享协作白板 · 安全审查' })).toBeVisible();
});

test('opens the same node menu by More and right click without selecting that node', async ({
  page
}, info) => {
  await page.setViewportSize({ width: 1480, height: 940 });
  const { dialog, port, current } = await openNetwork(page, 'dark');
  const node = port.getByRole('button', { name: '安全审查', exact: true });
  const more = port.getByRole('button', { name: '会话操作：安全审查', exact: true });
  const menu = dialog.getByRole('menu');
  const aside = menu.getByRole('menuitem', { name: '在侧栏打开' });
  const main = menu.getByRole('menuitem', { name: '在主工作面打开' });
  await expect(more.locator('[data-mar-icon="more"]')).toBeVisible();
  await more.click();
  await expect(aside).toBeFocused();
  await expect(aside.locator('[data-mar-icon="split"]')).toBeVisible();
  await expect(main.locator('[data-mar-icon="external-link"]')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(main).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(more).toBeFocused();

  await node.click({ button: 'right' });
  await expect(aside).toBeFocused();
  await expect(current).toHaveAttribute('aria-pressed', 'true');
  await expect(node).toHaveAttribute('aria-pressed', 'false');
  await expect(dialog.getByRole('heading', { name: '协作白板 · 发布协调' })).toBeVisible();
  await page.screenshot({
    path: info.outputPath('collaboration-network-node-menu.png'),
    animations: 'disabled'
  });
  await main.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status')).toHaveText('main: peer-a');
});

test('keeps the three zoom controls together and fits the network at 320px in English', async ({
  page
}, info) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto(`${fixture.url}collaboration-network.html?theme=dark&locale=en-US`);
  await page.getByRole('button', { name: 'View collaboration network' }).click();
  const dialog = page.getByRole('dialog', { name: 'Collaboration network', exact: true });
  await expect(
    dialog.getByRole('heading', { name: 'Collaboration whiteboard · 发布协调' })
  ).toBeVisible();
  const legendLineCounts = await dialog.locator('.network-legend > span').evaluateAll((items) =>
    items.map((item) => {
      const label = document.createRange();
      label.selectNodeContents(item.lastChild!);
      return label.getClientRects().length;
    })
  );
  expect(legendLineCounts).toEqual([1, 1]);
  const controls = dialog.getByRole('group', { name: 'Canvas controls' });
  const zoom = controls.getByRole('group', { name: 'Zoom', exact: true });
  const out = zoom.getByRole('button', { name: 'Zoom out' });
  const scale = zoom.getByRole('status');
  const plus = zoom.getByRole('button', { name: 'Zoom in' });
  const fit = controls.getByRole('button', { name: 'Fit network' });
  const locate = controls.getByRole('button', { name: 'Locate', exact: true });
  await expect.poll(async () => Number.parseInt(await scale.innerText())).toBeLessThan(80);
  const fitted = await scale.innerText();
  await expect(fit.locator('[data-mar-icon="fit"]')).toBeVisible();
  const [outBox, scaleBox, plusBox, controlsBox, locateBox] = await Promise.all(
    [out, scale, plus, controls, locate].map((locator) => locator.boundingBox())
  );
  expect(outBox!.y).toBe(plusBox!.y);
  expect(outBox!.x + outBox!.width).toBeCloseTo(scaleBox!.x);
  expect(scaleBox!.x + scaleBox!.width).toBeCloseTo(plusBox!.x);
  expect(locateBox!.x + locateBox!.width).toBeLessThanOrEqual(controlsBox!.x + controlsBox!.width);

  await out.focus();
  for (let step = 0; step < 14; step++) await page.keyboard.press('Enter');
  await expect(scale).toHaveText('10%');
  await expect(out).toBeDisabled();
  await expect(out).toBeFocused();
  await out.press('Space');
  await expect(scale).toHaveText('10%');
  await page.keyboard.press('Tab');
  await expect(plus).toBeFocused();
  for (let step = 0; step < 14; step++) await page.keyboard.press('Enter');
  await expect(scale).toHaveText('100%');
  await expect(plus).toBeDisabled();
  await expect(plus).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(fit).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(scale).toHaveText(fitted);
  await locate.click();
  await page.screenshot({
    path: info.outputPath('collaboration-network-zoom-mobile.png'),
    animations: 'disabled'
  });
});

test.describe('narrow viewport', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('wraps an unbroken board title before truncating it', async ({ page }) => {
    const { dialog } = await openNetwork(page, 'daylight', 'unbroken');
    const board = dialog.getByRole('region', { name: '协作白板', exact: true });
    const heading = board.getByRole('heading', { name: /^协作白板 · ReleaseVerification/ });
    const label = heading.locator('.board-title-label');
    await expect.poll(() => titleLayout(label)).toEqual({ lines: 2, clipped: true });
    expect(await label.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);
    await dialog.getByRole('button', { name: '定位', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(heading).toBeFocused();
    await expect(dialog.getByRole('tooltip')).toHaveText((await label.textContent())!.trim());
  });

  test('clamps long board headings to two lines at a mobile width without wrapping short ones', async ({
    page
  }, info) => {
    const { dialog, port, current } = await openNetwork(page, 'daylight', 'long');
    const board = dialog.getByRole('region', { name: '协作白板', exact: true });
    const label = board
      .getByRole('heading', { name: /^协作白板 · 发布协调/ })
      .locator('.board-title-label');
    await expect.poll(() => titleLayout(label)).toEqual({ lines: 2, clipped: true });
    const edge = port.getByRole('button', { name: /^安全审查 向 发布协调/ });
    await edge.press('Enter');
    const short = board.getByRole('heading', { name: '共享协作白板 · 安全审查' });
    await expect
      .poll(() => titleLayout(short.locator('.board-title-label')))
      .toEqual({
        lines: 1,
        clipped: false
      });
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
    'Simulated multitouch and touch panning require Chromium CDP.'
  );
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('pans at maximum zoom and continues dragging after one finger lifts', async ({ page }) => {
    const { dialog, port, current } = await openNetwork(page, 'daylight');
    const scale = dialog.locator('output');
    const zoomIn = dialog.getByRole('button', { name: '放大', exact: true });
    for (let step = 0; step < 13 && (await scale.innerText()) !== '100%'; step++) {
      await zoomIn.tap();
    }
    await expect(scale).toHaveText('100%');
    await dialog.getByRole('button', { name: '定位', exact: true }).tap();
    const initial = (await current.boundingBox())!;
    const x = Math.round(initial.x + initial.width / 2);
    const y = Math.round(initial.y + initial.height / 2);
    const input = await page.context().newCDPSession(page);
    try {
      await input.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [
          { x, y, id: 1 },
          { x: x + 64, y, id: 2 }
        ]
      });
      await input.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          { x: x - 32, y, id: 1 },
          { x: x + 64, y, id: 2 }
        ]
      });
      await input.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          { x: x - 32, y, id: 1 },
          { x: x + 32, y, id: 2 }
        ]
      });
      await expect
        .poll(async () => (await current.boundingBox())!.x - initial.x)
        .toBeCloseTo(-32, 0);
      await expect(scale).toHaveText('100%');
      await input.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [{ x: x + 32, y, id: 2 }]
      });
      await input.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x - 56, y, id: 1 }]
      });
      await expect
        .poll(async () => (await current.boundingBox())!.x - initial.x)
        .toBeCloseTo(-56, 0);
      await expect(scale).toHaveText('100%');
      await input.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    } finally {
      await input.detach();
    }
    await expect(port).not.toHaveClass(/is-dragging/);
    const parent = port.getByRole('button', { name: '发布计划', exact: true });
    await parent.tap();
    await expect(parent).toHaveAttribute('aria-pressed', 'true');
  });
  test('zooms with two fingers without changing the selected whiteboard', async ({ page }) => {
    const { dialog, port, current } = await openNetwork(page, 'daylight');
    const parent = port.getByRole('button', { name: '发布计划', exact: true });
    await parent.tap();
    const scale = dialog.locator('output');
    const before = Number.parseInt(await scale.innerText());
    const initial = (await current.boundingBox())!;
    const x = Math.round(initial.x + initial.width / 2);
    const y = Math.round(initial.y + initial.height / 2);
    const input = await page.context().newCDPSession(page);
    try {
      await input.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [
          { x, y, id: 1 },
          { x: x + 64, y, id: 2 }
        ]
      });
      await input.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          { x: x - 32, y, id: 1 },
          { x: x + 96, y, id: 2 }
        ]
      });
      await expect
        .poll(async () => Number.parseInt(await scale.innerText()))
        .toBeGreaterThan(before);
      const zoomed = (await current.boundingBox())!;
      expect(zoomed.width / initial.width).toBeCloseTo(2, 1);
      expect(zoomed.x + zoomed.width / 2).toBeCloseTo(x - 32, 0);
      await input.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          { x: x + 28, y, id: 1 },
          { x: x + 36, y, id: 2 }
        ]
      });
      await expect(scale).toHaveText('10%');
      await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally {
      await input.detach();
    }
    await expect(port).not.toHaveClass(/is-dragging/);
    await expect(parent).toHaveAttribute('aria-pressed', 'true');
    await current.tap();
    await expect(current).toHaveAttribute('aria-pressed', 'true');
  });
  test('finishes a pinch when a touched session leaves the live network', async ({ page }) => {
    const { port, current } = await openNetwork(page, 'daylight');
    const peer = port.getByRole('button', { name: '安全审查', exact: true });
    const center = async (locator: Locator) => {
      const { x, y, width, height } = (await locator.boundingBox())!;
      return { x: Math.round(x + width / 2), y: Math.round(y + height / 2) };
    };
    const first = { ...(await center(current)), id: 1 };
    const second = { ...(await center(peer)), id: 2 };
    const viewport = (await port.boundingBox())!;
    const input = await page.context().newCDPSession(page);
    try {
      await input.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [first, second]
      });
      await input.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [first, { ...second, x: second.x + 3 }]
      });
      await expect(port).toHaveClass(/is-dragging/);
      await page.evaluate(() => window.dispatchEvent(new Event('fixture-board-detached')));
      await expect(peer).toHaveCount(0);
      await input.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [first, { ...second, y: Math.ceil(viewport.y + viewport.height + 20) }]
      });
      await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally {
      await input.detach();
    }
    await expect(port).not.toHaveClass(/is-dragging/);
  });
  test('does not enter a phantom pinch after a touched session is removed before dragging', async ({
    page
  }) => {
    const { port, current } = await openNetwork(page, 'daylight');
    const errors: Error[] = [];
    page.on('pageerror', (error) => errors.push(error));
    const peer = port.getByRole('button', { name: '安全审查', exact: true });
    const { x, y, width, height } = (await peer.boundingBox())!;
    const touch = { x: Math.round(x + width / 2), y: Math.round(y + height / 2), id: 1 };
    const viewport = (await port.boundingBox())!;
    const input = await page.context().newCDPSession(page);
    try {
      await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch] });
      await page.evaluate(() => window.dispatchEvent(new Event('fixture-board-detached')));
      await expect(peer).toHaveCount(0);
      await input.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ ...touch, y: Math.ceil(viewport.y + viewport.height + 20) }]
      });
      await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      const node = (await current.boundingBox())!;
      await port.evaluate((element) => {
        element.addEventListener('pointerdown', () => element.setAttribute('data-touched', ''), {
          once: true
        });
      });
      await input.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: node.x + node.width / 2, y: node.y + node.height / 2, id: 2 }]
      });
      await expect(port).toHaveAttribute('data-touched', '');
      await expect(port).not.toHaveClass(/is-dragging/);
      await input.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
      expect(errors).toEqual([]);
    } finally {
      await input.detach();
    }
  });
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
    await dialog.getByRole('button', { name: '定位', exact: true }).tap();
    await expect
      .poll(async () => Math.abs((await current.boundingBox())!.x - initial.x))
      .toBeLessThan(2);
    await current.tap();
    await expect(current).toHaveAttribute('aria-pressed', 'true');
    // Leave the fitted overview before testing a precise touch on two overlapping hit areas.
    const zoomIn = dialog.getByRole('button', { name: '放大', exact: true });
    const scale = dialog.locator('output');
    for (let step = 0; step < 13 && Number.parseInt(await scale.innerText()) < 80; step++) {
      await zoomIn.tap();
    }
    await expect
      .poll(async () => Number.parseInt(await scale.innerText()))
      .toBeGreaterThanOrEqual(80);
    await dialog.getByRole('button', { name: '定位', exact: true }).tap();
    const reverse = port.getByRole('button', { name: '发布协调 向 安全审查 共享协作白板' });
    const reverseHit = await edgeHitPoint(reverse);
    await page.touchscreen.tap(reverseHit.x, reverseHit.y);
    await expect(reverse).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByRole('heading', { name: '共享协作白板 · 发布协调' })).toBeVisible();
    const edge = port.getByRole('button', { name: '安全审查 向 发布协调 共享协作白板' });
    const hit = await edgeHitPoint(edge, 9);
    await page.touchscreen.tap(hit.x, hit.y);
    await expect(edge).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByRole('heading', { name: '共享协作白板 · 安全审查' })).toBeVisible();
    await page.screenshot({
      path: info.outputPath('collaboration-network-mobile.png'),
      animations: 'disabled'
    });
    await port.getByRole('button', { name: '会话操作：发布协调', exact: true }).tap();
    const menu = dialog.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(edge).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({
      path: info.outputPath('collaboration-network-mobile-menu.png'),
      animations: 'disabled'
    });
    await menu.getByRole('menuitem', { name: '在侧栏打开' }).tap();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('status')).toHaveText('aside: release-current');
  });
});
