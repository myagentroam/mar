import { expect, test, type Page } from '@playwright/test';
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

async function openNetwork(page: Page, theme: 'dark' | 'daylight') {
  await page.goto(`${fixture.url}collaboration-network.html?theme=${theme}`);
  await page.getByRole('button', { name: '查看协作网络' }).click();
  const dialog = page.getByRole('dialog', { name: '协作网络', exact: true });
  const port = dialog.locator('.network-viewport');
  const current = port.locator('[aria-current="true"]');
  await expect(current).toBeVisible();
  return { dialog, port, current };
}

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
  const clickEdge = async (index: number) => {
    const edge = port.locator('.edge-hit-area').nth(index);
    const hit = await edge.evaluate((element) => {
      const path = element as unknown as SVGPathElement;
      const transform = path.getScreenCTM()!;
      for (const fraction of [0.5, 0.25, 0.75, 0.125, 0.875]) {
        const { x, y } = path
          .getPointAtLength(path.getTotalLength() * fraction)
          .matrixTransform(transform);
        if (document.elementFromPoint(x, y) === path) return { x, y };
      }
      throw new Error('The dashed edge has no visible hit area');
    });
    await page.mouse.click(hit.x, hit.y);
  };
  await clickEdge(2);
  await expect(board.getByText('核对权限审查的结论。')).toBeVisible();
  await expect(board.getByText('Added 2 entries')).toBeVisible();
  await clickEdge(1);
  await expect(board.getByText('发布前先核对回归结果。')).toBeVisible();
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
  await board.getByRole('button', { name: '查看 安全审查 的白板' }).click();
  await expect(board.getByText('Added 2 entries')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('fixture-board-detached')));
  await expect(port.locator('.edge-sharing')).toHaveCount(4);
  await expect(board.getByText('核对权限审查的结论。')).toBeVisible();
  await board.getByRole('button', { name: '查看 发布协调 的白板' }).focus();
  await board.getByRole('button', { name: '在主工作面打开' }).click();
  await expect(page.getByRole('status')).toHaveText('main: peer-a');
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
    await page.screenshot({
      path: info.outputPath('collaboration-network-mobile.png'),
      animations: 'disabled'
    });
  });
});
