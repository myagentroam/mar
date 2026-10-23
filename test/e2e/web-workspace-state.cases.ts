import { expect, test, type Locator } from '@playwright/test';
import { resolve } from 'node:path';
import {
  fulfillMockSessionWatch,
  fulfillMockWorkspaceWatch,
  mockConsoleApi,
  mockEmptyWorkspaceFiles,
  json
} from './support/web-console-api.js';

function sessionWatchSnapshot(
  session: { readonly id: string; readonly workspaceId: string },
  text: string,
  sequence = 1
) {
  return {
    kind: 'session-watch-snapshot',
    sequence,
    session,
    runs: [],
    queue: { version: 0, paused: false, items: [] },
    context: null,
    conversation: {
      unit: 'SEGMENT',
      source: 'official',
      readAt: sequence,
      latestVisibleAt: sequence,
      nextCursor: null,
      snapshotSequence: sequence,
      segments: [
        {
          id: `turn-${session.id}:segment:0`,
          sessionId: session.id,
          turnId: `turn-${session.id}`,
          runId: null,
          index: 0,
          status: 'SUCCEEDED',
          startedAt: sequence,
          completedAt: sequence,
          items: [
            {
              id: `item-${session.id}`,
              sessionId: session.id,
              turnId: `turn-${session.id}`,
              runId: null,
              parentItemId: null,
              sourceSequence: null,
              revision: 1,
              kind: 'assistant_message',
              status: 'COMPLETED',
              startedAt: sequence,
              completedAt: sequence,
              payload: { text, format: 'markdown', model: null }
            }
          ]
        }
      ]
    }
  };
}

// Workspace tabs, cache, LRU, and read-only fallback

test('Workspace tab direct Link icon preserves hover and compact status layout', async ({
  page
}) => {
  for (const locale of ['en-US', 'zh-CN']) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
      '/@fs/' + resolve('test/e2e/support/workspace-tabs.html') + '?locale=' + locale
    );
    const first = page.locator('.workspace-tab').first();
    const second = page.locator('.workspace-tab').nth(1);
    const node = first.locator('.direct-available-node');
    await expect(first.getByRole('tab')).toHaveAccessibleName('Workspace one');
    await expect(node.locator('.workspace-tab-node-label')).toHaveText(
      'A very long Node name that must truncate before status indicators'
    );
    const icon = node.locator('.workspace-tab-direct-icon');
    await expect(node).toHaveCSS('text-decoration-line', 'none');
    await expect(icon).toBeVisible();
    await expect(icon).toHaveAttribute('aria-hidden', 'true');
    await expect(node).toHaveAttribute(
      'aria-description',
      'Peer-to-peer connection available (Private network IPv4 UDP)'
    );
    await icon.hover();
    await expect(
      page.getByRole('tooltip', {
        name: 'Peer-to-peer connection available (Private network IPv4 UDP)',
        exact: true
      })
    ).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(first.locator('.workspace-tab-running')).toBeVisible();
    await expect(first.locator('.workspace-tab-unread')).toHaveText(
      locale === 'en-US' ? 'Unread' : '未读'
    );
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const theme of ['daylight', 'vscode-dark-2026']) {
        await page.evaluate(
          (value) => document.documentElement.setAttribute('data-theme', value),
          theme
        );
        const badge = first.locator('.workspace-tab-unread');
        await expect(badge).toHaveCSS('font-size', '11px');
        await expect(badge).toHaveCSS('font-weight', '500');
        await expect(badge).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(badge).toHaveCSS('border-radius', '4px');
        await expect(first.locator('.workspace-tab-meta')).toHaveCSS('font-size', '11px');
        await expect(icon).toHaveCSS('font-size', '11px');
        const runningDot = first.locator('.workspace-tab-running i');
        await expect(runningDot).toHaveCSS('width', '5px');
        await expect(runningDot).toHaveCSS('height', '5px');
        await expect(runningDot).toHaveCSS('box-shadow', /0px 0px 0px 1\.5px.*0px 0px 4px 0px/);
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await expect(runningDot).toHaveCSS('animation-name', 'mar-run-glow');
        await expect(runningDot).toHaveCSS('transform', 'none');
        const breathing = await runningDot.evaluate((element) => {
          const animation = element.getAnimations()[0]!;
          animation.pause();
          animation.currentTime = 0;
          const dim = Number(getComputedStyle(element).opacity);
          animation.currentTime = Number(animation.effect!.getTiming().duration) / 2;
          const bright = Number(getComputedStyle(element).opacity);
          animation.play();
          return { dim, bright };
        });
        expect(breathing.bright).toBeGreaterThan(breathing.dim);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await expect(runningDot).toHaveCSS('animation-name', 'none');
        await expect(runningDot).toHaveCSS('opacity', '1');
        await first.screenshot({
          path: test.info().outputPath(`workspace-tab-unread-${locale}-${width}-${theme}.png`)
        });
      }
    }
    expect(
      await node
        .locator('.workspace-tab-node-label')
        .evaluate((element) => element.scrollWidth > element.clientWidth)
    ).toBe(true);
    const labelBox = await node.locator('.workspace-tab-node-label').boundingBox();
    const iconBox = await icon.boundingBox();
    const runningBox = await first.locator('.workspace-tab-running').boundingBox();
    expect(labelBox!.x + labelBox!.width).toBeLessThanOrEqual(iconBox!.x);
    expect(iconBox!.x + iconBox!.width).toBeLessThanOrEqual(runningBox!.x);
    const unread = await first.locator('.workspace-tab-unread').boundingBox();
    const tab = await first.boundingBox();
    expect(unread!.x + unread!.width).toBeLessThanOrEqual(tab!.x + tab!.width);
    await first.screenshot({
      path: test.info().outputPath('workspace-tab-direct-' + locale + '.png')
    });
    await second.getByRole('tab').focus();
    await page.keyboard.press('Enter');
    await expect(second.locator('.direct-available-node')).toHaveCount(1);
    await expect(first.locator('.direct-available-node')).toHaveCount(0);
    await expect(second.locator('.workspace-tab-direct-icon')).toBeVisible();
    await expect(first.locator('.workspace-tab-direct-icon')).toHaveCount(0);
    await expect(first.locator('.workspace-tab-running')).toBeVisible();
    await page.getByRole('button', { name: 'Toggle connection' }).click();
    await expect(page.locator('.direct-available-node')).toHaveCount(0);
    await expect(page.locator('.workspace-tab-direct-icon')).toHaveCount(0);
    await expect(first.locator('.workspace-tab-unread')).toBeVisible();
  }
});

test('Workspace tab status width changes update pinned offsets and overflow controls', async ({
  page
}) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto(
    '/@fs/' + resolve('test/e2e/support/workspace-tabs.html') + '?locale=en-US&layout=dynamic'
  );
  const tabs = page.locator('.workspace-tab');
  const first = tabs.first();
  const second = tabs.nth(1);
  await expect(first).toHaveClass(/sticky-pinned/);
  await expect(second).toHaveClass(/sticky-pinned/);
  await expect(first.locator('.workspace-tab-content > span')).toHaveCSS('font-size', '13px');
  await expect(first.locator('.workspace-tab-content > span')).toHaveCSS('font-weight', '400');
  await expect(first.locator('small')).toHaveCSS('font-size', '11px');
  const initialWidth = (await first.boundingBox())!.width;
  const pinnedGap = () =>
    tabs.evaluateAll(([first, second]) => {
      const expected =
        parseFloat(getComputedStyle(first!).left) +
        first!.getBoundingClientRect().width +
        parseFloat(getComputedStyle(first!.parentElement!).columnGap);
      return Math.abs(parseFloat(getComputedStyle(second!).left) - expected);
    });
  await expect.poll(pinnedGap).toBeLessThan(1);
  await page.getByRole('button', { name: 'Toggle status', exact: true }).click();
  await expect(first.locator('.workspace-tab-running')).toBeVisible();
  expect((await first.boundingBox())!.width).toBeGreaterThan(initialWidth + 4);
  await expect.poll(pinnedGap).toBeLessThan(1);
  await page.getByRole('button', { name: 'Toggle status', exact: true }).click();
  await expect(first.locator('.workspace-tab-running')).toHaveCount(0);
  await expect.poll(pinnedGap).toBeLessThan(1);

  await page.locator('.workspace-tabs').evaluate((element) => {
    const style = getComputedStyle(element);
    const width =
      [...element.children].reduce((sum, child) => sum + child.getBoundingClientRect().width, 0) +
      parseFloat(style.columnGap) * (element.children.length - 1) +
      parseFloat(style.paddingLeft) +
      parseFloat(style.paddingRight) +
      4;
    element.closest('main')!.style.maxWidth = width + 'px';
  });
  const menu = page.getByRole('button', { name: 'All open workspaces', exact: true });
  await expect(menu).toHaveCount(0);
  await page.getByRole('button', { name: 'Toggle status', exact: true }).click();
  await expect(first.locator('.workspace-tab-running')).toBeVisible();
  await expect(menu).toBeVisible();
});

for (const language of [
  {
    locale: 'zh-CN',
    open: '进入控制台',
    work: '工作',
    menu: '全部已打开工作区',
    unread: '未读',
    running: '运行中'
  },
  {
    locale: 'en-US',
    open: 'Open console',
    work: 'Work',
    menu: 'All open workspaces',
    unread: 'Unread',
    running: 'Running'
  }
] as const) {
  test(
    'Workspace tab indicators follow authoritative task and unread refreshes: ' + language.locale,
    async ({ page }) => {
      await mockConsoleApi(
        page,
        'MANAGED',
        ['history.read', 'turn.start'],
        [],
        'GIT_WORKSPACE',
        true,
        'MANAGED_ACTIVE'
      );
      await page.addInitScript(
        (locale) => localStorage.setItem('mar.locale.v2', locale),
        language.locale
      );
      await mockEmptyWorkspaceFiles(
        page,
        Array.from({ length: 7 }, (_, i) => 'workspace-' + (i + 2))
      );
      await page.route('**/api/workspaces?nodeId=node-1', (route) =>
        json(route, {
          workspaces: Array.from({ length: 8 }, (_, i) => ({
            id: 'workspace-' + (i + 1),
            path: '/project-' + (i + 1),
            kind: 'DIRECTORY'
          }))
        })
      );
      await page.route(/\/api\/agent-sessions\?nodeId=node-1(?:&.*)?$/, (route) => {
        if (new URL(route.request().url()).searchParams.get('workspaceId') === 'workspace-1')
          return route.fallback();
        return json(route, { sessions: [], nextCursor: null });
      });
      const now = Date.now();
      const entry = (id: string, sessionId: string) => ({
        id,
        kind: 'run',
        title: 'Task complete',
        message: 'Open the session',
        createdAt: now,
        updatedAt: now,
        expiresAt: now + 3_600_000,
        read: false,
        target: {
          targetType: 'WORKSPACE_SESSION',
          nodeId: 'node-1',
          workspaceId: 'workspace-1',
          sessionId
        }
      });
      const run = (id: string, status: string) => ({
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        runId: id,
        sessionId: id,
        sessionTitle: 'Workspace task',
        runner: 'codex',
        status,
        createdAt: now,
        startedAt: now,
        sortAt: now,
        updatedAt: now,
        completedAt: null,
        version: 1
      });
      let notifications: ReturnType<typeof entry>[] = [];
      let recentRuns: ReturnType<typeof run>[] = [];
      const reads: string[] = [];
      await page.route('**/api/notifications', (route) =>
        json(route, { notifications, recentRuns })
      );
      await page.route('**/api/notifications/session/read', (route) => {
        const target = route.request().postDataJSON() as { sessionId: string };
        reads.push(target.sessionId);
        notifications = notifications.map((value) =>
          value.target.sessionId === target.sessionId ? { ...value, read: true } : value
        );
        return json(route, {});
      });
      const invalidate = async (message: Record<string, unknown>) =>
        page.evaluate((value) => {
          const sockets = (
            window as unknown as {
              __consoleMockWorkbenchWebSocket: {
                instances: { url: string; readyState: number; dispatchEvent(event: Event): void }[];
              };
            }
          ).__consoleMockWorkbenchWebSocket.instances;
          const socket = sockets.find(
            (value) => value.url.includes('/api/workbench/live') && value.readyState === 1
          );
          if (socket === undefined) throw new Error('Mock workbench connection is not ready');
          socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
        }, message);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto('/console');
      await page.getByRole('button', { name: language.open }).click();
      await page.getByRole('button', { name: language.work, exact: true }).click();
      const tree = page.locator('.workspace-tree');
      await tree.getByRole('button', { name: /node-1/ }).click();
      await tree.getByRole('button', { name: 'project-1', exact: true }).click();
      await page.locator('.session-list button').first().click();
      await expect(page.locator('.session-link.selected')).toHaveCount(1);
      await tree.getByRole('button', { name: 'project-2', exact: true }).click();
      const first = page.locator('.workspace-tab[data-tab-id="node-1:workspace-1"]');
      const second = page.locator('.workspace-tab[data-tab-id="node-1:workspace-2"]');
      notifications = [entry('first', 'session-1'), entry('second', 'unloaded-session')];
      recentRuns = [run('first-task', 'RUNNING'), run('second-task', 'CANCELLING')];
      await invalidate({ type: 'recent-run.updated', run: recentRuns[0] });
      await expect(first.getByRole('tab')).toHaveAttribute('aria-selected', 'false');
      await expect(first.locator('.workspace-tab-running')).toBeVisible();
      await expect(first.locator('.workspace-tab-unread')).toHaveText(language.unread);
      await expect(second.locator('.workspace-tab-running, .workspace-tab-unread')).toHaveCount(0);
      const beforeRead = reads.length;
      await first.getByRole('tab').click();
      await page.locator('.session-list button').first().click();
      await expect.poll(() => reads.length).toBeGreaterThan(beforeRead);
      expect(notifications.find((value) => value.id === 'first')?.read).toBe(true);
      expect(notifications.find((value) => value.id === 'second')?.read).toBe(false);
      await expect(first.locator('.workspace-tab-unread')).toBeVisible();
      const runningDots = [
        first.locator('.workspace-tab-running'),
        page.locator('.session-list .session-activity').first(),
        page.locator('.conversation-header .session-activity')
      ];
      const runningColor = await runningDots[0]!
        .locator('i')
        .evaluate((element) => getComputedStyle(element).backgroundColor);
      const expectRunningIndicator = async (dot: Locator) => {
        await expect(dot).toBeVisible();
        await expect(dot).not.toHaveAttribute('tabindex', '0');
        await expect(dot.locator('i')).toHaveCSS('animation-name', 'mar-run-glow');
        await expect(dot.locator('i')).toHaveCSS('animation-duration', '1.8s');
        await expect(dot.locator('i')).toHaveCSS('animation-timing-function', 'ease-in-out');
        await expect(dot.locator('i')).toHaveCSS('animation-iteration-count', 'infinite');
        await expect(dot.locator('i')).toHaveCSS('background-color', runningColor);
        await expect(dot).toHaveAttribute('title', language.running);
        await dot.hover();
        const tooltip = page
          .getByRole('tooltip')
          .filter({ hasText: new RegExp('^' + language.running + '$') });
        await expect(tooltip).toHaveCount(0);
        await page.mouse.move(0, 0);
      };
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      for (const dot of runningDots) await expectRunningIndicator(dot);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      for (const dot of runningDots)
        await expect(dot.locator('i')).toHaveCSS('animation-name', 'none');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      notifications = notifications.map((value) => ({ ...value, read: true }));
      await invalidate({
        type: 'notification.session-read',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        sessionId: 'unloaded-session'
      });
      await expect(first.locator('.workspace-tab-unread')).toHaveCount(0);
      await expect(first.locator('.workspace-tab-running')).toBeVisible();
      await second.getByRole('tab').click();
      notifications = [entry('last-unread', 'session-1')];
      await invalidate({ type: 'recent-run.updated', run: recentRuns[0] });
      await expect(first.locator('.workspace-tab-unread')).toBeVisible();
      await first.getByRole('tab').click();
      await page.locator('.session-list button').first().click();
      await expect(first.locator('.workspace-tab-unread')).toHaveCount(0);
      await expect(first.locator('.workspace-tab-running')).toBeVisible();
      recentRuns = [run('first-task', 'SUCCEEDED'), run('second-task', 'CANCELLING')];
      await invalidate({ type: 'recent-run.updated', run: recentRuns[0] });
      await expect(first.locator('.workspace-tab-running')).toBeVisible();
      recentRuns = [];
      await invalidate({ type: 'recent-run.removed', nodeId: 'node-1', runId: 'second-task' });
      await expect(first.locator('.workspace-tab-running')).toHaveCount(0);

      for (let i = 2; i <= 8; i += 1) {
        await tree.getByRole('button', { name: 'project-' + i, exact: true }).click();
      }
      notifications = [entry('menu-unread', 'unloaded-session')];
      recentRuns = [run('menu-task', 'STARTING')];
      await invalidate({ type: 'recent-run.updated', run: recentRuns[0] });
      await expect(first.locator('.workspace-tab-unread')).toBeVisible();
      await page.setViewportSize({ width: 1024, height: 900 });
      await page.getByRole('button', { name: language.menu, exact: true }).click();
      const menuItem = page
        .locator('.workspace-tab-menu-list .el-dropdown-menu__item')
        .filter({ hasText: 'project-1' });
      await expect(menuItem.locator('.workspace-tab-unread')).toHaveText(language.unread);
      await expect(menuItem.locator('.workspace-tab-running')).toBeVisible();
      await expectRunningIndicator(menuItem.locator('.workspace-tab-running'));
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator('.workspace-tab-strip-header')).toHaveCount(0);
      await expect(page.locator('.workspace-tab-strip-body')).toHaveCount(1);
      await first.scrollIntoViewIfNeeded();
      await expect(first.locator('.workspace-tab-unread')).toBeVisible();
      await expect(first.locator('.workspace-tab-running')).toHaveCSS('flex-shrink', '0');
      await expectRunningIndicator(first.locator('.workspace-tab-running'));
      const bounds = await first.locator('.workspace-tab-unread').boundingBox();
      const tabBounds = await first.boundingBox();
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(tabBounds!.x + tabBounds!.width);
      await page.locator('.workspace-tabs').screenshot({
        path: test.info().outputPath('workspace-tab-indicators-' + language.locale + '.png')
      });
    }
  );
}

for (const locale of ['zh-CN', 'en-US'] as const) {
  test(`Workspace sidebar resizing respects boundaries and restores after reload: ${locale}`, async ({
    page
  }) => {
    await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
    await page.addInitScript((value) => localStorage.setItem('mar.locale.v2', value), locale);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('/console');
    await page
      .getByRole('button', { name: locale === 'zh-CN' ? '进入控制台' : 'Open console' })
      .click();
    const tree = page.locator('aside.workspace-tree');
    await tree.getByRole('button', { name: /node-1/ }).click();
    await tree.getByRole('button', { name: 'project', exact: true }).click();
    const treeHandle = page.getByRole('separator', {
      name: locale === 'zh-CN' ? '调整工作区树宽度' : 'Resize workspace tree'
    });
    const filesHandle = page.getByRole('separator', {
      name: locale === 'zh-CN' ? '调整文件区宽度' : 'Resize files panel'
    });
    const inspector = page.locator('.inspector-column');
    await expect(filesHandle).toBeVisible();
    const initialTree = (await tree.boundingBox())!.width;
    const initialFiles = (await inspector.boundingBox())!.width;
    await treeHandle.evaluate((element) => {
      element.addEventListener('pointermove', () => {
        requestAnimationFrame(() => {
          const right = (selector: string) =>
            document.querySelector(selector)!.getBoundingClientRect().right;
          const treeRight = right('aside.workspace-tree');
          const box = element.getBoundingClientRect();
          const line = box.left + parseFloat(getComputedStyle(element, '::before').left);
          const sample = {
            headerGap: right('[data-testid="workbench-brand"]') - treeRight,
            surfaceGap:
              document.querySelector('.workbench')!.getBoundingClientRect().left - treeRight,
            lineGap: line - (treeRight - 1),
            top: box.top,
            bottom: box.bottom
          };
          const samples = JSON.parse(
            element.getAttribute('data-test-alignment') ?? '[]'
          ) as (typeof sample)[];
          element.setAttribute(
            'data-test-alignment',
            JSON.stringify([...samples, sample].slice(-32))
          );
        });
      });
    });
    for (const [handle, delta] of [
      [treeHandle, 65],
      [filesHandle, -100]
    ] as const) {
      const box = (await handle.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + 100);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + delta, box.y + 100, { steps: 8 });
      if (handle === treeHandle) {
        const x = box.x + box.width / 2 + delta;
        await page.mouse.move(x, 20, { steps: 4 });
        await page.mouse.move(x, 1040, { steps: 4 });
        const samples = await handle.evaluate(async (element) => {
          await new Promise(requestAnimationFrame);
          return JSON.parse(element.getAttribute('data-test-alignment') ?? '[]') as {
            headerGap: number;
            surfaceGap: number;
            lineGap: number;
            top: number;
            bottom: number;
          }[];
        });
        expect(samples.length).toBeGreaterThan(0);
        expect(
          Math.max(...samples.map((sample) => Math.abs(sample.headerGap)))
        ).toBeLessThanOrEqual(0.5);
        for (const sample of samples) {
          expect(Math.abs(sample.headerGap)).toBeLessThanOrEqual(0.5);
          expect(Math.abs(sample.surfaceGap)).toBeLessThanOrEqual(0.5);
          expect(Math.abs(sample.lineGap)).toBeLessThanOrEqual(0.5);
          expect(sample.top).toBe(0);
          expect(sample.bottom).toBe(1080);
        }
        if (locale === 'zh-CN') {
          await page.screenshot({ path: test.info().outputPath('sidebar-divider.png') });
        }
      }
      await page.mouse.up();
    }
    await expect
      .poll(async () => (await tree.boundingBox())!.width)
      .toBeCloseTo(initialTree + 65, 0);
    await expect
      .poll(async () => (await inspector.boundingBox())!.width)
      .toBeCloseTo(initialFiles + 100, 0);
    const saved = await page.evaluate(() => localStorage.getItem('mar.workbench.panel-widths.v1'));
    await page.reload();
    await expect(filesHandle).toBeVisible();
    await expect
      .poll(async () => (await tree.boundingBox())!.width)
      .toBeCloseTo(initialTree + 65, 0);
    await expect
      .poll(async () => (await inspector.boundingBox())!.width)
      .toBeCloseTo(initialFiles + 100, 0);
    for (const [handle, target, initial] of [
      [treeHandle, tree, initialTree + 65],
      [filesHandle, inspector, initialFiles + 100]
    ] as const) {
      await expect(handle).not.toHaveAttribute('tabindex');
      await handle.evaluate((element) => {
        element.addEventListener(
          'pointerdown',
          (event) => {
            element.setAttribute('data-test-pointer', String((event as PointerEvent).pointerId));
          },
          { once: true }
        );
      });
      const box = (await handle.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + 100);
      await page.mouse.down();
      await expect(handle).toHaveClass(/dragging/);
      await page.mouse.move(box.x + box.width / 2, box.y + 101);
      await handle.evaluate((element) => {
        element.releasePointerCapture(Number(element.getAttribute('data-test-pointer')));
        element.removeAttribute('data-test-pointer');
      });
      await page.mouse.move(box.x + 70, box.y + 100);
      await expect(handle).not.toHaveClass(/dragging/);
      await page.mouse.up();
      await expect.poll(async () => (await target.boundingBox())!.width).toBeCloseTo(initial, 0);
    }
    for (const [handle, target, min, max, direction] of [
      [treeHandle, tree, 220, 420, 1],
      [filesHandle, inspector, 275, 600, -1]
    ] as const) {
      const dragTo = async (x: number) => {
        const box = (await handle.boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + 100);
        await page.mouse.down();
        await page.mouse.move(x, box.y + 100, { steps: 8 });
        await page.mouse.up();
      };
      await dragTo(direction === 1 ? 0 : 1919);
      await expect.poll(async () => (await target.boundingBox())!.width).toBe(min);
      await dragTo(direction === 1 ? 1919 : 0);
      await expect.poll(async () => (await target.boundingBox())!.width).toBe(max);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect
      .poll(async () => (await page.locator('.conversation-panel').boundingBox())!.width)
      .toBeGreaterThanOrEqual(359);
    await page.setViewportSize({ width: 1000, height: 900 });
    await expect(filesHandle).toBeHidden();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(treeHandle).toBeHidden();
    await expect(page.locator('.workbench')).toHaveClass(/compact/);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page
      .getByRole('button', { name: locale === 'zh-CN' ? '展开侧栏' : 'Expand sidebar' })
      .click();
    await expect.poll(async () => (await tree.boundingBox())!.width).toBe(420);
    await expect.poll(async () => (await inspector.boundingBox())!.width).toBe(600);
    expect(saved).not.toBeNull();
    await page.evaluate(() => localStorage.setItem('mar.workbench.panel-widths.v1', '{'));
    await page.reload();
    await expect(filesHandle).toBeVisible();
    await expect.poll(async () => (await tree.boundingBox())!.width).toBe(initialTree);
    await expect.poll(async () => (await inspector.boundingBox())!.width).toBe(initialFiles);
  });
}

test('Resource-tree whitespace and Node context menus refresh Workspaces added by other users', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  let nodesRequestCount = 0;
  let workspacesRequestCount = 0;
  await page.route('**/api/nodes', (route) => {
    nodesRequestCount += 1;
    return json(route, {
      nodes: [
        {
          id: 'node-1',
          displayName: '共享节点',
          platform: 'linux',
          architecture: 'x64',
          nodeAppVersion: '0.9.6',
          nodeVersion: 'v24.15.0',
          connected: true,
          disabled: false,
          capabilities: {}
        }
      ]
    });
  });
  await page.route('**/api/workspaces?nodeId=node-1', (route) => {
    workspacesRequestCount += 1;
    return json(route, {
      workspaces: [
        { id: 'workspace-1', displayName: '原有工作区', path: '/project', kind: 'DIRECTORY' },
        ...(workspacesRequestCount > 1
          ? [{ id: 'workspace-2', displayName: '新增工作区', path: '/new', kind: 'DIRECTORY' }]
          : [])
      ]
    });
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  const tree = page.locator('aside.workspace-tree');
  await tree.getByRole('button', { name: '共享节点', exact: true }).click();
  await expect(tree.getByRole('button', { name: '原有工作区', exact: true })).toBeVisible();

  await tree.getByRole('button', { name: '共享节点', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '刷新工作区' }).click();
  await expect(tree.getByRole('button', { name: '新增工作区', exact: true })).toBeVisible();
  expect(nodesRequestCount).toBe(1);

  await tree.click({ button: 'right', position: { x: 10, y: 400 } });
  await page.getByRole('menuitem', { name: '刷新工作区' }).click();
  await expect.poll(() => nodesRequestCount).toBe(2);
  await expect.poll(() => workspacesRequestCount).toBe(3);
});

test('Work resource trees support local filtering and desktop and mobile sidebar scrolling', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.route(/\/api\/nodes$/, (route) =>
    json(route, {
      nodes: [
        {
          id: 'node-1',
          displayName: '前端节点',
          platform: 'linux',
          architecture: 'x64',
          nodeAppVersion: '0.9.6',
          nodeVersion: 'v24.15.0',
          connected: true,
          disabled: false,
          capabilities: { codex: { available: true, version: '0.146' } }
        },
        {
          id: 'node-2',
          displayName: '运维节点',
          platform: 'linux',
          architecture: 'x64',
          nodeAppVersion: '0.9.6',
          nodeVersion: 'v24.15.0',
          connected: true,
          disabled: false,
          capabilities: { codex: { available: true, version: '0.146' } }
        },
        {
          id: 'node-3',
          displayName: '127.0.0.1',
          platform: 'linux',
          architecture: 'x64',
          nodeAppVersion: '0.9.6',
          nodeVersion: 'v24.15.0',
          connected: true,
          disabled: false,
          capabilities: { codex: { available: true, version: '0.146' } }
        }
      ]
    })
  );
  await page.route('**/api/nodes/node-2/workbench-capabilities', (route) =>
    json(route, {
      manifest: {
        manifestVersion: 1,
        observedAt: 1_900_000_000_000,
        conversation: { available: true, reasonCode: null },
        files: { available: true, reasonCode: null },
        git: { available: true, reasonCode: null, supportsHistory: true },
        terminal: {
          available: true,
          reasonCode: null,
          supportsReplay: true,
          supportsTakeover: true,
          profiles: [{ id: 'default', label: 'Default shell', isDefault: true }]
        }
      }
    })
  );
  await page.route(/\/api\/runner-profiles\?.*\bnodeId=node-2(?:&|$)/, (route) =>
    json(route, { profiles: [] })
  );
  let workspaceRequests = 0;
  await page.route('**/api/workspaces?nodeId=node-1', (route) => {
    workspaceRequests += 1;
    return json(route, {
      workspaces: [
        {
          id: 'workspace-console',
          displayName: '控制台',
          path: '/srv/frontend/console',
          kind: 'DIRECTORY',
          groupName: '产品'
        },
        {
          id: 'workspace-assets',
          displayName: '素材',
          path: '/srv/frontend/assets',
          kind: 'DIRECTORY',
          groupName: null
        }
      ]
    });
  });
  await page.route('**/api/workspaces?nodeId=node-2', (route) => {
    workspaceRequests += 1;
    return json(route, {
      workspaces: [
        {
          id: 'workspace-runbooks',
          displayName: '运行手册',
          path: '/srv/operations/runbooks',
          kind: 'DIRECTORY',
          groupName: '运维'
        }
      ]
    });
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  const tree = page.locator('.workspace-tree');
  await expect(tree.getByRole('button', { name: '127.0.0.1', exact: true })).toBeVisible();
  await tree.getByRole('button', { name: '前端节点', exact: true }).click();
  await expect(tree.getByRole('button', { name: '素材', exact: true })).toBeVisible();
  await expect(
    tree.getByRole('button', { name: '展开工作区分组 产品', exact: true })
  ).toBeVisible();
  await expect(tree.getByRole('button', { name: '控制台', exact: true })).toHaveCount(0);
  const frontendTreeItem = tree.locator('.node-tree > li:has(.tree-node[title="前端节点"])');
  const firstLevelEntries = frontendTreeItem.locator(':scope > .workspace-branches > li');
  await expect(firstLevelEntries).toHaveCount(2);
  await expect(firstLevelEntries.nth(0)).toHaveClass(/workspace-group/);
  await expect(
    firstLevelEntries.nth(1).getByRole('button', { name: '素材', exact: true })
  ).toBeVisible();
  const productGroup = firstLevelEntries.nth(0);
  await expect(productGroup).toHaveCSS('display', 'block');
  await productGroup.getByRole('button', { name: '展开工作区分组 产品', exact: true }).click();
  const consoleWorkspace = productGroup.getByRole('button', { name: '控制台', exact: true });
  await expect(consoleWorkspace).toBeVisible();
  const [groupBox, workspaceBox, workspaceRowBox, groupIconBox, workspaceLabelBox, assetsBox] =
    await Promise.all([
      productGroup.getByRole('button', { name: /工作区分组 产品$/ }).boundingBox(),
      consoleWorkspace.boundingBox(),
      productGroup.locator('.workspace-group-branches > li').boundingBox(),
      productGroup.locator('.workspace-group-toggle .tree-type-icon').boundingBox(),
      consoleWorkspace.locator('.workspace-branch-content > span').boundingBox(),
      firstLevelEntries.nth(1).locator('.workspace-branch-content > span').boundingBox()
    ]);
  if (
    groupBox === null ||
    workspaceBox === null ||
    workspaceRowBox === null ||
    groupIconBox === null ||
    workspaceLabelBox === null ||
    assetsBox === null
  )
    throw new Error('WORKSPACE_GROUP_LAYOUT_MISSING');
  expect(workspaceBox.y).toBeGreaterThan(groupBox.y);
  expect(workspaceRowBox.x).toBe(groupBox.x + 6);
  expect(workspaceRowBox.width).toBe(groupBox.width - 12);
  expect(workspaceBox.x).toBe(workspaceRowBox.x + 36);
  expect(Math.abs(assetsBox.x - groupIconBox.x - 6)).toBeLessThanOrEqual(1);
  expect(workspaceLabelBox.x - assetsBox.x).toBe(16);
  await expect(frontendTreeItem.locator('.tree-node-icon .tree-type-icon')).toBeVisible();
  await expect(productGroup.locator('.workspace-group-toggle .tree-type-icon')).toBeVisible();
  await expect(tree.locator('.workspace-branch-button .tree-type-icon')).toHaveCount(0);
  await expect(productGroup.locator('.workspace-group-toggle')).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  await page.mouse.move(800, 500);
  for (const theme of ['daylight', 'vscode-dark-2026']) {
    await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
    await tree.screenshot({ path: test.info().outputPath(`workspace-tree-${theme}.png`) });
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = 'daylight'));
  await tree.getByRole('button', { name: '运维节点', exact: true }).click();
  await expect(
    tree.getByRole('button', { name: '展开工作区分组 运维', exact: true })
  ).toBeVisible();
  await tree.getByRole('button', { name: '展开工作区分组 运维', exact: true }).click();
  await expect(tree.getByRole('button', { name: '运行手册', exact: true })).toBeVisible();
  expect(workspaceRequests).toBe(2);

  const filter = tree.getByRole('textbox', { name: '筛选节点和工作区' });
  await filter.fill('console');
  await expect(tree.getByRole('button', { name: '控制台', exact: true })).toBeVisible();
  await expect(tree.getByRole('button', { name: '运维节点', exact: true })).toHaveCount(0);

  await filter.fill('运维');
  await expect(tree.getByRole('button', { name: '运维节点', exact: true })).toBeVisible();
  await expect(tree.getByRole('button', { name: '运行手册', exact: true })).toBeVisible();

  await filter.fill('前端');
  await expect(tree.getByRole('button', { name: '前端节点', exact: true })).toBeVisible();
  await expect(tree.getByRole('button', { name: '控制台', exact: true })).toHaveCount(0);
  await expect(tree.getByRole('button', { name: '素材', exact: true })).toHaveCount(0);

  await filter.fill('127');
  await expect(tree.getByRole('button', { name: '127.0.0.1', exact: true })).toBeVisible();
  await expect(tree.getByRole('button', { name: '控制台', exact: true })).toHaveCount(0);
  await expect(tree.getByRole('button', { name: '运行手册', exact: true })).toHaveCount(0);

  await filter.fill('/srv/frontend');
  await expect(tree.getByRole('button', { name: '前端节点', exact: true })).toBeVisible();
  await expect(tree.getByRole('button', { name: '控制台', exact: true })).toBeVisible();

  await filter.fill('not-found');
  await expect(tree.getByText('没有匹配的节点或工作区。', { exact: true })).toBeVisible();
  await filter.fill('');
  await expect(tree.getByRole('button', { name: '前端节点', exact: true })).toBeVisible();
  await expect(tree.getByRole('button', { name: '运维节点', exact: true })).toBeVisible();
  expect(workspaceRequests).toBe(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await expect(tree).toBeVisible();
  const mobileGroupToggle = productGroup.locator('.workspace-group-toggle');
  if ((await mobileGroupToggle.getAttribute('aria-expanded')) === 'false')
    await mobileGroupToggle.click();
  for (const control of [
    frontendTreeItem.locator('.node-expand-button'),
    mobileGroupToggle,
    consoleWorkspace
  ]) {
    await expect(control).toBeVisible();
    const bounds = await control.boundingBox();
    expect(bounds?.height).toBeGreaterThanOrEqual(36);
  }
  const mobileOffsets = await frontendTreeItem.evaluate((element) => {
    const left = element.getBoundingClientRect().left;
    const offset = (selector: string) => {
      const target = element.querySelector(selector);
      if (!target) throw new Error(`WORKSPACE_TREE_LAYOUT_MISSING: ${selector}`);
      return target.getBoundingClientRect().left - left;
    };
    return {
      nodeIcon: offset('.tree-node-icon'),
      groupIcon: offset('.workspace-group-toggle .tree-type-icon'),
      workspace: offset(
        ':scope > .workspace-branches > li:not(.workspace-group) .workspace-branch-content'
      ),
      groupedWorkspace: offset('.workspace-group-branches .workspace-branch-content')
    };
  });
  expect(mobileOffsets).toEqual({
    nodeIcon: 26,
    groupIcon: 36,
    workspace: 42,
    groupedWorkspace: 58
  });
  await expect
    .poll(() =>
      frontendTreeItem.evaluate((element) => {
        const gap = (arrowSelector: string, iconSelector: string) => {
          const arrow = element.querySelector(arrowSelector)?.getBoundingClientRect();
          const icon = element.querySelector(iconSelector)?.getBoundingClientRect();
          if (!arrow || !icon) throw new Error('WORKSPACE_TREE_ICON_LAYOUT_MISSING');
          return icon.left - arrow.right;
        };
        return {
          node: gap('.node-expand-button .tree-chevron', '.tree-node-icon'),
          group: gap(
            '.workspace-group-toggle .tree-chevron',
            '.workspace-group-toggle .tree-type-icon'
          )
        };
      })
    )
    .toEqual({ node: 4, group: 4 });
  await tree.screenshot({ path: test.info().outputPath('workspace-tree-mobile.png') });

  for (const viewport of [
    { width: 390, height: 240 },
    { width: 1280, height: 240 }
  ]) {
    await page.setViewportSize(viewport);
    if (viewport.width > 767) {
      await page.getByRole('button', { name: '展开侧栏' }).click();
    }
    await expect(tree).toHaveCSS('overflow-y', 'auto');
    await expect
      .poll(() => tree.evaluate((element) => element.getBoundingClientRect().width))
      .toBeGreaterThan(200);
    expect(
      await tree.evaluate((element) => element.scrollHeight - element.clientHeight)
    ).toBeGreaterThan(0);
    await tree.evaluate((element) => (element.scrollTop = 0));
    const bounds = await tree.boundingBox();
    if (!bounds) throw new Error('WORKSPACE_TREE_SCROLL_TARGET_MISSING');
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, 300);
    await expect.poll(() => tree.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    if (viewport.width <= 767 && page.context().browser()?.browserType().name() === 'chromium') {
      await tree.evaluate((element) => (element.scrollTop = 0));
      const client = await page.context().newCDPSession(page);
      try {
        await client.send('Emulation.setTouchEmulationEnabled', { enabled: true });
        const x = Math.round(bounds.x + bounds.width / 2);
        const y = Math.round(bounds.y + bounds.height * 0.75);
        await client.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x, y }]
        });
        for (let step = 1; step <= 5; step++) {
          await client.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x, y: y - step * 18 }]
          });
          await page.evaluate(
            () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          );
        }
        await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await expect.poll(() => tree.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      } finally {
        await client.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        await client.detach();
      }
    }
  }
});

test('Workspace group moves and drags use Workspace-registration permission', async ({ page }) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.route(/\/api\/nodes$/, (route) =>
    json(route, {
      nodes: [
        {
          id: 'node-1',
          displayName: '可分组节点',
          platform: 'linux',
          architecture: 'x64',
          nodeAppVersion: '0.9.6',
          nodeVersion: 'v24.15.0',
          connected: true,
          disabled: false,
          manageable: false,
          workspaceCreatable: true,
          capabilities: { codex: { available: true, version: '0.146' } }
        }
      ]
    })
  );
  const groupNames = new Map<string, string | null>([
    ['workspace-new', null],
    ['workspace-ungrouped', null],
    ['workspace-ungrouped-target', null],
    ['workspace-existing', '已有分组']
  ]);
  const updates: Array<{ readonly workspaceId: string; readonly groupName: string | null }> = [];
  await page.route('**/api/workspaces?nodeId=node-1', (route) =>
    json(route, {
      workspaces: [
        {
          id: 'workspace-new',
          displayName: '待分组工作区',
          path: '/srv/new',
          kind: 'DIRECTORY',
          groupName: groupNames.get('workspace-new')
        },
        {
          id: 'workspace-ungrouped',
          displayName: '未分组工作区',
          path: '/srv/ungrouped',
          kind: 'DIRECTORY',
          groupName: groupNames.get('workspace-ungrouped')
        },
        {
          id: 'workspace-ungrouped-target',
          displayName: '未分组目标工作区',
          path: '/srv/ungrouped-target',
          kind: 'DIRECTORY',
          manageable: false,
          groupName: groupNames.get('workspace-ungrouped-target')
        },
        {
          id: 'workspace-existing',
          displayName: '已有分组工作区',
          path: '/srv/existing',
          kind: 'DIRECTORY',
          groupName: groupNames.get('workspace-existing')
        }
      ]
    })
  );
  const removals: string[] = [];
  await page.route(
    /\/api\/workspaces\/(workspace-new|workspace-ungrouped|workspace-ungrouped-target|workspace-existing)\?nodeId=node-1$/,
    (route) => {
      const workspaceId = new URL(route.request().url()).pathname.split('/').at(-1)!;
      if (route.request().method() === 'DELETE') {
        removals.push(workspaceId);
        return json(route, {});
      }
      if (route.request().method() !== 'PATCH') return route.fulfill({ status: 405 });
      const body = JSON.parse(route.request().postData() ?? '{}') as {
        readonly groupName?: string | null;
      };
      if (!('groupName' in body)) return route.fulfill({ status: 400 });
      const groupName = body.groupName ?? null;
      groupNames.set(workspaceId, groupName);
      updates.push({ workspaceId, groupName });
      return json(route, { groupName });
    }
  );

  const drag = async (source: Locator, target: Locator) => {
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    await source.dispatchEvent('dragstart', { dataTransfer });
    await target.dispatchEvent('drop', { dataTransfer });
    await source.dispatchEvent('dragend', { dataTransfer });
  };

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  const tree = page.locator('.workspace-tree');
  await tree.getByRole('button', { name: '可分组节点', exact: true }).click();
  const newWorkspaceRow = tree
    .getByRole('button', { name: '待分组工作区', exact: true })
    .locator('xpath=ancestor::li[1]');
  await newWorkspaceRow.hover();
  await newWorkspaceRow.getByRole('button', { name: '工作区操作' }).click();
  await page.getByRole('menuitem', { name: '移动到分组' }).click();
  const moveGroupDialog = page.getByRole('dialog', { name: '移动到分组' });
  await moveGroupDialog.getByRole('combobox', { name: '工作区分组' }).click();
  await page.locator('.el-select-dropdown:visible').getByText('已有分组', { exact: true }).click();
  await moveGroupDialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect
    .poll(() => updates)
    .toEqual([{ workspaceId: 'workspace-new', groupName: '已有分组' }]);

  const ungroupedWorkspaceRow = tree
    .getByRole('button', { name: '未分组工作区', exact: true })
    .locator('xpath=ancestor::li[1]');
  await ungroupedWorkspaceRow.hover();
  await ungroupedWorkspaceRow.getByRole('button', { name: '工作区操作' }).click();
  await page.getByRole('menuitem', { name: '移动到分组' }).click();
  await moveGroupDialog.getByRole('combobox', { name: '工作区分组' }).fill('新分组');
  await moveGroupDialog.getByRole('combobox', { name: '工作区分组' }).press('Enter');
  await moveGroupDialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect
    .poll(() => updates)
    .toContainEqual({
      workspaceId: 'workspace-ungrouped',
      groupName: '新分组'
    });
  await expect(
    tree.getByRole('button', { name: '展开工作区分组 新分组', exact: true })
  ).toBeVisible();

  await tree.getByRole('button', { name: '展开工作区分组 已有分组', exact: true }).click();
  const existingWorkspaceRow = tree
    .getByRole('button', { name: '已有分组工作区', exact: true })
    .locator('xpath=ancestor::li[1]');
  await existingWorkspaceRow.hover();
  await existingWorkspaceRow.getByRole('button', { name: '工作区操作' }).click();
  await page.getByRole('menuitem', { name: '移动到分组' }).click();
  await expect(moveGroupDialog.getByRole('button', { name: '清空', exact: true })).toHaveCount(0);
  await moveGroupDialog.getByRole('combobox', { name: '工作区分组' }).locator('..').hover();
  await moveGroupDialog.locator('.el-select__clear').click();
  await moveGroupDialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect
    .poll(() => updates)
    .toContainEqual({
      workspaceId: 'workspace-existing',
      groupName: null
    });

  const existingGroup = tree.getByRole('button', {
    name: '收起工作区分组 已有分组',
    exact: true
  });
  const groupedNewWorkspaceRow = tree
    .getByRole('button', { name: '待分组工作区', exact: true })
    .locator('xpath=ancestor::li[1]');
  await tree.getByRole('button', { name: '展开工作区分组 新分组', exact: true }).click();
  const newlyGroupedWorkspaceRow = tree
    .getByRole('button', { name: '未分组工作区', exact: true })
    .locator('xpath=ancestor::li[1]');
  const ungroupedTargetWorkspaceRow = tree
    .getByRole('button', { name: '未分组目标工作区', exact: true })
    .locator('xpath=ancestor::li[1]');
  await drag(newlyGroupedWorkspaceRow, existingGroup);
  await expect
    .poll(() => updates)
    .toContainEqual({
      workspaceId: 'workspace-ungrouped',
      groupName: '已有分组'
    });

  await drag(groupedNewWorkspaceRow, ungroupedTargetWorkspaceRow);
  await expect
    .poll(() => updates)
    .toContainEqual({
      workspaceId: 'workspace-new',
      groupName: null
    });

  await ungroupedTargetWorkspaceRow.hover();
  await ungroupedTargetWorkspaceRow.getByRole('button', { name: '工作区操作' }).click();
  await expect(page.getByRole('menuitem', { name: '移除工作区' })).not.toHaveClass(/is-disabled/);
  await page.getByRole('menuitem', { name: '移除工作区' }).click();
  const removeDialog = page.getByRole('dialog', { name: '移除工作区' });
  await removeDialog.getByRole('button', { name: '移除工作区', exact: true }).click();
  await expect.poll(() => removals).toEqual(['workspace-ungrouped-target']);
});

test('Work resource trees do not substitute Workspace-management permission for grouping permission', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.route(/\/api\/nodes$/, (route) =>
    json(route, {
      nodes: [
        {
          id: 'node-1',
          displayName: '只可管理节点',
          platform: 'linux',
          architecture: 'x64',
          nodeAppVersion: '0.9.6',
          nodeVersion: 'v24.15.0',
          connected: true,
          disabled: false,
          manageable: true,
          workspaceCreatable: false,
          capabilities: { codex: { available: true, version: '0.146' } }
        }
      ]
    })
  );
  await page.route('**/api/workspaces?nodeId=node-1', (route) =>
    json(route, {
      workspaces: [
        {
          id: 'workspace-1',
          displayName: '受限工作区',
          path: '/srv/restricted',
          kind: 'DIRECTORY'
        }
      ]
    })
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  const tree = page.locator('.workspace-tree');
  await tree.getByRole('button', { name: '只可管理节点', exact: true }).click();
  const workspaceRow = tree
    .getByRole('button', { name: '受限工作区', exact: true })
    .locator('xpath=ancestor::li[1]');
  await expect(workspaceRow).toHaveAttribute('draggable', 'false');
  await workspaceRow.hover();
  await workspaceRow.getByRole('button', { name: '工作区操作' }).click();
  await expect(page.getByRole('menuitem', { name: '移动到分组' })).toHaveClass(/is-disabled/);
  await expect(page.getByRole('menuitem', { name: '移除工作区' })).toHaveClass(/is-disabled/);
});

test('Reload restores Workspace Tabs and sessions, falls back to the first valid item, and creates only for empty lists', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  const sessions = [1, 2].map((index) => ({
    id: `session-${index}`,
    workspaceId: `workspace-${index}`,
    runner: 'codex',
    externalSessionId: `native-${index}`,
    customTitle: `持久化会话 ${index}`,
    activity: 'IDLE',
    control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
  }));
  let empty = false;
  let holdSessionOne = false;
  let heldRequests = 0;
  let releaseSessionOne!: () => void;
  const delayedSessionOne = new Promise<void>((resolve) => {
    releaseSessionOne = resolve;
  });
  await page.route('**/api/workspaces?nodeId=node-1', (route) =>
    json(route, {
      workspaces: [
        { id: 'workspace-1', path: '/project', kind: 'DIRECTORY' },
        { id: 'workspace-2', path: '/another-project', kind: 'DIRECTORY' }
      ]
    })
  );
  await page.route(/\/api\/agent-sessions\?nodeId=node-1(?:&.*)?$/, (route) => {
    const workspaceId = new URL(route.request().url()).searchParams.get('workspaceId');
    return json(route, {
      sessions: empty ? [] : sessions.filter((session) => session.workspaceId === workspaceId),
      nextCursor: null
    });
  });
  await page.route(/\/api\/workspaces\/workspace-[12]\/watch$/, (route) => {
    const workspaceId = route
      .request()
      .url()
      .match(/workspaces\/(workspace-\d+)\/watch$/)?.[1];
    return fulfillMockWorkspaceWatch(
      page,
      route,
      empty ? undefined : sessions.find((session) => session.workspaceId === workspaceId),
      'DIRECTORY'
    );
  });
  await page.route(/\/api\/agent-sessions\/[^/?]+\?nodeId=node-1$/, async (route) => {
    const sessionId = new URL(route.request().url()).pathname.split('/').at(-1);
    if (holdSessionOne && sessionId === 'session-1') {
      heldRequests += 1;
      await delayedSessionOne;
    }
    const session = empty ? undefined : sessions.find((session) => session.id === sessionId);
    return session === undefined
      ? route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'SESSION_NOT_FOUND' })
        })
      : json(route, { session });
  });
  await page.route(/\/api\/agent-sessions\/session-[12]\/watch(?:\?.*)?$/, (route) => {
    const sessionId = new URL(route.request().url()).pathname.split('/').at(-2);
    const session = sessions.find((session) => session.id === sessionId)!;
    return fulfillMockSessionWatch(
      page,
      route,
      session,
      sessionWatchSnapshot(session, `恢复内容 ${session.id}`)
    );
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: 'project', exact: true })
    .click();
  await page.locator('.session-link').filter({ hasText: '持久化会话 1' }).click();
  await expect(page.getByText('恢复内容 session-1', { exact: true })).toBeVisible();
  await page.locator('.workspace-tree').getByRole('button', { name: 'another-project' }).click();
  await page.locator('.session-link').filter({ hasText: '持久化会话 2' }).click();
  await expect(page.getByText('恢复内容 session-2', { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.parse(localStorage.getItem('mar.workbench.tabs.v1') ?? '[]').map(
          (tab: { selectedSessionId?: string }) => tab.selectedSessionId
        )
      )
    )
    .toEqual(['session-1', 'session-2']);

  await page.reload();
  await expect(page.locator('.workspace-tab')).toHaveCount(2);
  await expect(page.getByText('恢复内容 session-2', { exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: /^another-project\b/ })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  holdSessionOne = true;
  try {
    await page.getByRole('tab', { name: /^project\b/ }).click();
    await expect.poll(() => heldRequests).toBe(1);
    await page.getByRole('tab', { name: /^another-project\b/ }).click();
    await expect(page.getByText('恢复内容 session-2', { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => JSON.parse(localStorage.getItem('mar.workbench.selection.v1') ?? '{}').sessionId
        )
      )
      .toBe('session-2');
    await page.getByRole('tab', { name: /^project\b/ }).click();
    await expect.poll(() => heldRequests).toBe(2);
  } finally {
    holdSessionOne = false;
    releaseSessionOne();
  }
  await expect(page.getByText('恢复内容 session-1', { exact: true })).toBeVisible();

  await page.evaluate(() =>
    localStorage.setItem(
      'mar.workbench.selection.v1',
      JSON.stringify({ nodeId: 'node-1', workspaceId: 'workspace-1', sessionId: 'missing' })
    )
  );
  await page.reload();
  await expect(page.getByText('恢复内容 session-1', { exact: true })).toBeVisible();
  await expect(page.locator('.session-link.selected')).toContainText('持久化会话 1');

  empty = true;
  await page.reload();
  await expect(page.locator('.workspace-tab')).toHaveCount(2);
  await expect(page.locator('.session-link')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem('mar.workbench.selection.v1') ?? '{}').sessionId
      )
    )
    .toBeUndefined();
});

test('Offline Nodes preserve their offline state and consistently degrade to read-only', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(
    page,
    'MANAGED',
    ['history.read', 'turn.start'],
    writes,
    'GIT_WORKSPACE',
    false
  );

  await page.addInitScript(() => {
    localStorage.setItem(
      'mar.workbench.selection.v1',
      JSON.stringify({ workspace: { nodeId: 'node-1', workspaceId: 'workspace-1' } })
    );
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await expect(page.locator('.workspace-tree .state-dot.offline')).toBeVisible();
  const placeholder = page.locator('.workspace-offline-placeholder');
  await expect(placeholder).toBeVisible();
  await expect(placeholder).toHaveText('节点离线，等待重新连接。');
  await expect(page.locator('.readonly-banner')).toHaveCount(0);
  await expect(page.locator('.workspace-selection-panel')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '登记工作区', exact: true })).toHaveCount(0);
  await expect(page.locator('.el-message')).toHaveCount(0);

  await page.addInitScript(() => localStorage.setItem('mar.locale.v2', 'en-US'));
  await page.reload();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await expect(placeholder).toHaveText('Node offline. Waiting for reconnection.');
  await expect(page.locator('.el-message')).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath('offline-node-desktop.png'),
    animations: 'disabled'
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(placeholder).toBeVisible();
  await expect(page.locator('.readonly-banner')).toHaveCount(0);
  const bounds = await placeholder.boundingBox();
  const messageBounds = await placeholder.locator('.workspace-offline-message').boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(390);
  expect(
    Math.abs(messageBounds!.x + messageBounds!.width / 2 - bounds!.x - bounds!.width / 2)
  ).toBeLessThan(2);
  expect(
    Math.abs(messageBounds!.y + messageBounds!.height / 2 - bounds!.y - bounds!.height / 2)
  ).toBeLessThan(2);
  await page.screenshot({
    path: test.info().outputPath('offline-node-mobile.png'),
    animations: 'disabled'
  });
  expect(writes).toHaveLength(0);
});

test('Refreshing online Node capabilities does not briefly show unknown-capability degradation', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  let releaseCapability!: () => void;
  const capabilityReady = new Promise<void>((resolve) => {
    releaseCapability = resolve;
  });
  await page.route('**/api/nodes/node-1/workbench-capabilities', async (route) => {
    await capabilityReady;
    await json(route, {
      manifest: {
        manifestVersion: 1,
        observedAt: 1_900_000_000_000,
        conversation: { available: true, reasonCode: null },
        files: { available: true, reasonCode: null },
        terminal: {
          available: true,
          reasonCode: null,
          supportsReplay: true,
          supportsTakeover: true,
          profiles: []
        }
      }
    });
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();

  await expect(page.locator('.readonly-banner')).toHaveCount(0);
  releaseCapability();
  await expect(page.locator('.readonly-banner')).toHaveCount(0);
});

test('Node reconnection and page realtime recovery resynchronize Node facts and Workbench capabilities', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  let capabilityRequests = 0;
  await page.route('**/api/nodes/node-1/workbench-capabilities', (route) => {
    capabilityRequests += 1;
    return json(route, {
      manifest: {
        manifestVersion: 1,
        observedAt: 1_900_000_000_000,
        conversation: { available: true, reasonCode: null },
        files: { available: true, reasonCode: null },
        terminal: {
          available: true,
          reasonCode: null,
          supportsReplay: true,
          supportsTakeover: true,
          profiles: []
        }
      }
    });
  });
  let nodeConnected = true;
  await page.route('**/api/nodes', (route) =>
    json(route, {
      nodes: [
        {
          id: 'node-1',
          platform: 'linux',
          architecture: 'x64',
          nodeAppVersion: '0.9.6',
          nodeVersion: 'v24.15.0',
          connected: nodeConnected,
          disabled: false,
          capabilities: {
            codex: { available: true, version: '0.146' },
            claudeCode: { available: true, version: '2.1' }
          }
        }
      ]
    })
  );
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: 'project', exact: true })
    .click();
  await expect.poll(() => capabilityRequests).toBeGreaterThan(0);
  const initialCapabilityRequests = capabilityRequests;
  await expect(page.locator('.readonly-banner')).toHaveCount(0);
  const terminalDock = page.locator('.terminal-dock');
  await expect(terminalDock).toHaveCount(1);
  await expect(terminalDock).toBeVisible();

  await page.evaluate(() => {
    const mock = (
      window as unknown as {
        __consoleMockWorkbenchWebSocket: {
          emitNodeConnection(nodeId: string, connected: boolean): void;
        };
      }
    ).__consoleMockWorkbenchWebSocket;
    mock.emitNodeConnection('node-1', false);
  });
  const placeholder = page.locator('.workspace-offline-placeholder');
  await expect(placeholder).toBeVisible();
  await expect(placeholder).toHaveText('节点离线，等待重新连接。');
  await expect(page.locator('.readonly-banner')).toHaveCount(0);
  await expect(page.locator('.workspace-grid')).toHaveCount(1);
  await expect(page.locator('.workspace-grid')).toBeHidden();
  await expect(terminalDock).toHaveCount(1);
  await expect(terminalDock).toBeHidden();

  await page.evaluate(() => {
    const mock = (
      window as unknown as {
        __consoleMockWorkbenchWebSocket: {
          emitNodeConnection(nodeId: string, connected: boolean): void;
        };
      }
    ).__consoleMockWorkbenchWebSocket;
    mock.emitNodeConnection('node-1', true);
  });
  await expect.poll(() => capabilityRequests).toBeGreaterThan(initialCapabilityRequests);
  await expect(page.locator('.readonly-banner')).toHaveCount(0);
  await expect(placeholder).toHaveCount(0);
  await expect(page.locator('.workspace-grid')).toBeVisible();
  await expect(terminalDock).toBeVisible();

  nodeConnected = false;
  await page.evaluate(() => {
    const mock = (
      window as unknown as {
        __consoleMockWorkbenchWebSocket: {
          resumeAsResumed: boolean;
          closeActive(): void;
        };
      }
    ).__consoleMockWorkbenchWebSocket;
    mock.resumeAsResumed = true;
    mock.closeActive();
  });
  await expect(placeholder).toBeVisible();
  await expect(page.locator('.readonly-banner')).toHaveCount(0);
  await expect(terminalDock).toHaveCount(1);
  await expect(terminalDock).toBeHidden();
  await expect(page.locator('.workspace-grid')).toHaveCount(1);
  await expect(page.locator('.workspace-grid')).toBeHidden();

  // Simulate an offline tab whose Workspace metadata is no longer loaded.
  await page.route('**/api/workspaces?nodeId=node-1', (route) =>
    nodeConnected ? route.fallback() : json(route, { workspaces: [] })
  );
  await page.reload();
  await page.getByRole('tab', { name: /project node-1/ }).click();
  await expect(placeholder).toBeVisible();
  await expect(placeholder).toHaveText('节点离线，等待重新连接。');
  await expect(page.locator('.readonly-banner')).toHaveCount(0);
  await expect(terminalDock).toBeHidden();
  await expect(page.locator('.workspace-selection-panel')).toHaveCount(0);

  await page.addInitScript(() => localStorage.setItem('mar.locale.v2', 'en-US'));
  await page.reload();
  await page.getByRole('tab', { name: /project node-1/ }).click();
  await expect(placeholder).toHaveText('Node offline. Waiting for reconnection.');
  await expect(page.locator('.readonly-banner')).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath('offline-workspace-desktop.png'),
    animations: 'disabled'
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(placeholder).toBeVisible();
  const placeholderBounds = await placeholder.boundingBox();
  expect(placeholderBounds!.width).toBeLessThanOrEqual(390);
  const messageBounds = await placeholder.locator('p').boundingBox();
  expect(messageBounds!.width).toBeLessThanOrEqual(placeholderBounds!.width);
  await page.screenshot({
    path: test.info().outputPath('offline-workspace-mobile.png'),
    animations: 'disabled'
  });

  nodeConnected = true;
  await page.evaluate(() => {
    const mock = (
      window as unknown as {
        __consoleMockWorkbenchWebSocket: {
          emitNodeConnection(nodeId: string, connected: boolean): void;
        };
      }
    ).__consoleMockWorkbenchWebSocket;
    mock.emitNodeConnection('node-1', true);
  });
  await expect(placeholder).toHaveCount(0);
  await expect(page.locator('.workspace-grid')).toBeVisible();
});

test('Switching Git Workspaces immediately uses the target current branch without manual refresh', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await page.route('**/api/workspaces?nodeId=node-1', (route) =>
    json(route, {
      workspaces: [
        {
          id: 'workspace-master',
          path: '/master-project',
          kind: 'GIT_WORKSPACE',
          gitSummary: { branch: 'master' }
        },
        {
          id: 'workspace-develop',
          path: '/develop-project',
          kind: 'GIT_WORKSPACE',
          gitSummary: { branch: 'master' }
        }
      ]
    })
  );
  await page.route(/\/api\/workspaces\/workspace-master\/changes(?:\?.*)?$/, (route) =>
    json(route, { branch: 'master', changes: [] })
  );
  await page.route(/\/api\/workspaces\/workspace-develop\/changes(?:\?.*)?$/, (route) =>
    json(route, { branch: 'develop', changes: [] })
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  const tree = page.locator('.workspace-tree');
  await tree.getByRole('button', { name: /node-1/ }).click();
  await expect(tree.locator('.tree-node-row.selected')).toHaveCount(0);
  expect(
    await tree
      .locator('.tree-node-row')
      .evaluate((element) => getComputedStyle(element, '::before').content)
  ).toBe('none');
  await tree.getByRole('button', { name: 'master-project' }).click();
  const selectedWorkspace = tree.locator('.workspace-branches > li.selected');
  await expect(selectedWorkspace).toHaveCSS('box-shadow', 'none');
  expect(
    await selectedWorkspace.evaluate((element) => getComputedStyle(element, '::before').content)
  ).toBe('none');
  await expect(page.locator('.workspace-branch-tag')).toHaveText('master');

  await tree.getByRole('button', { name: 'develop-project' }).click();

  await expect(page.locator('.workspace-branch-tag')).toHaveText('develop');
});

test('Workspace Tabs support Alt switching and Alt+W closure while bulk close preserves pinned tabs', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await mockEmptyWorkspaceFiles(page, ['workspace-2', 'workspace-3']);
  await page.route('**/api/workspaces?nodeId=node-1', (route) =>
    json(route, {
      workspaces: [1, 2, 3].map((index) => ({
        id: `workspace-${index}`,
        path: `/project-${index}`,
        kind: 'DIRECTORY'
      }))
    })
  );
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  const tree = page.locator('.workspace-tree');
  await tree.getByRole('button', { name: /node-1/ }).click();
  for (let index = 1; index <= 3; index += 1)
    await tree.getByRole('button', { name: `project-${index}` }).click();

  await page.getByRole('tab', { name: /project-1/ }).click();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(page.getByRole('tab', { name: /project-3/ })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await page.keyboard.press('Alt+ArrowRight');
  await expect(page.getByRole('tab', { name: /project-1/ })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await page.keyboard.press('Control+2');
  await expect(page.getByRole('tab', { name: /project-2/ })).toHaveAttribute(
    'aria-selected',
    'true'
  );

  const composer = page.getByRole('textbox', { name: '输入消息' });
  const dispatchCtrlClose = (shiftKey: boolean) =>
    page.evaluate((shift) => {
      const event = new KeyboardEvent('keydown', {
        key: 'w',
        code: 'KeyW',
        ctrlKey: true,
        shiftKey: shift,
        bubbles: true,
        cancelable: true
      });
      document.activeElement?.dispatchEvent(event);
      return event.defaultPrevented;
    }, shiftKey);
  for (const [key, index] of [
    ['Control+Tab', 3],
    ['Control+Shift+Tab', 2],
    ['Alt+ArrowRight', 3],
    ['Alt+ArrowLeft', 2],
    ['Control+1', 1],
    ['Control+2', 2]
  ] as const) {
    await composer.focus();
    await page.keyboard.press(key);
    await expect(page.getByRole('tab', { name: new RegExp(`project-${index}`) })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  }
  await composer.focus();
  expect(
    await page.evaluate(() => {
      const event = new KeyboardEvent('keydown', {
        key: '2',
        code: 'Digit2',
        ctrlKey: true,
        repeat: true,
        bubbles: true,
        cancelable: true
      });
      document.activeElement?.dispatchEvent(event);
      return event.defaultPrevented;
    })
  ).toBe(true);
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('tab', { name: /project-2/ })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(composer).not.toBeFocused();

  await page.getByRole('tab', { name: /project-1/ }).click();
  const existingSession = page.locator('.session-link').first();
  for (const modifier of ['Alt', 'Control']) {
    await existingSession.click();
    await expect(page.locator('.session-link.selected')).toHaveCount(1);
    await composer.focus();
    await page.keyboard.press(`${modifier}+n`);
    await expect(page.locator('.session-link.selected')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: /project-1/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await expect(composer).toBeFocused();
  }
  await page.getByRole('tab', { name: /project-2/ }).click();

  await page.getByRole('tab', { name: /project-1/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '固定', exact: true }).click();
  await page.getByRole('tab', { name: /project-1/ }).click();
  await composer.focus();
  expect(await dispatchCtrlClose(false)).toBe(true);
  await page.keyboard.press('Alt+w');
  await expect(page.locator('.workspace-tab[data-tab-id]')).toHaveCount(3);
  await page.getByRole('tab', { name: /project-2/ }).click();
  await composer.focus();
  expect(await dispatchCtrlClose(false)).toBe(true);
  await expect(page.getByRole('tab', { name: /project-2/ })).toHaveCount(0);
  await tree.getByRole('button', { name: 'project-2' }).click();
  await page.getByRole('tab', { name: /project-2/ }).focus();
  await page.getByRole('tab', { name: /project-3/ }).click();
  await page.getByRole('tab', { name: /project-2/ }).click();
  await composer.focus();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tab', { name: /project-2/ })).toBeVisible();
  await page.keyboard.press('Alt+w');
  await expect(page.getByRole('tab', { name: /project-2/ })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /project-3/ })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await page.getByRole('tab', { name: /project-1/ }).click();
  await composer.focus();
  expect(await dispatchCtrlClose(false)).toBe(true);
  await page.keyboard.press('Alt+w');
  await expect(page.getByRole('tab', { name: /project-1/ })).toBeVisible();
  await page.keyboard.press('Alt+Shift+w');
  await expect(page.locator('.workspace-tab[data-tab-id]')).toHaveCount(1);
  for (const index of [2, 3]) await tree.getByRole('button', { name: `project-${index}` }).click();
  await composer.focus();
  expect(await dispatchCtrlClose(true)).toBe(true);
  await expect(page.locator('.workspace-tab[data-tab-id]')).toHaveCount(1);
  await composer.focus();
  const singleTabActivity = await page.evaluate(
    () => JSON.parse(localStorage.getItem('mar.workbench.tabs.v1') ?? '[]')[0]?.lastActiveAt
  );
  expect(singleTabActivity).toBeGreaterThan(0);
  for (const key of ['ArrowLeft', 'ArrowRight', 'Tab']) {
    for (const repeat of [false, true]) {
      expect(
        await page.evaluate(
          ({ key, repeat }) => {
            const event = new KeyboardEvent('keydown', {
              key,
              code: key,
              altKey: key !== 'Tab',
              ctrlKey: key === 'Tab',
              repeat,
              bubbles: true,
              cancelable: true
            });
            document.activeElement?.dispatchEvent(event);
            return event.defaultPrevented;
          },
          { key, repeat }
        )
      ).toBe(true);
    }
  }
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('mar.workbench.tabs.v1') ?? '[]')[0]?.lastActiveAt
    )
  ).toBe(singleTabActivity);
  await expect(page.getByRole('tab', { name: /project-1/ })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await page.getByRole('button', { name: '取消固定 project-1', exact: true }).click();
  await composer.focus();
  expect(await dispatchCtrlClose(true)).toBe(true);
  await expect(page.locator('.workspace-tab[data-tab-id]')).toHaveCount(0);

  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByText('快捷键', { exact: true }).last().click();
  await expect(page.getByText('工作区：切换到前一个或后一个标签（首尾循环）')).toBeVisible();
  await expect(page.getByText('工作区：切换到下一个或前一个标签（首尾循环）')).toBeVisible();
  await expect(page.getByText('工作区：按序号切换标签（0 表示第十个）')).toBeVisible();
  await expect(
    page.locator('.shortcut-list > div').filter({ hasText: '工作区：按序号切换标签' }).locator('dt')
  ).toHaveText('Ctrl+1…9/0');
  await expect(page.getByText('工作区：新建会话')).toBeVisible();
  await expect(
    page.locator('.shortcut-list > div').filter({ hasText: '工作区：新建会话' }).locator('dt')
  ).toHaveText('Ctrl/Alt+N');
  await expect(
    page.getByText('工作区：关闭当前非固定标签（Composer 内也生效；其他输入框、终端或弹窗除外）')
  ).toBeVisible();
  await expect(
    page.getByText('工作区：关闭全部非固定标签（Composer 内也生效；其他输入框、终端或弹窗除外）')
  ).toBeVisible();
  await expect(page.getByText('文本文件或 Diff：切换编辑/只读，或打开文本标签')).toBeVisible();
});

for (const locale of ['zh-CN', 'en-US'] as const) {
  test(`Workspace Tab pinning, cross-region drag unpinning, and context menus: ${locale}`, async ({
    page
  }) => {
    const labels =
      locale === 'zh-CN'
        ? {
            enter: '进入控制台',
            work: '工作',
            previous: '前移',
            next: '后移',
            close: '关闭',
            pin: '固定',
            unpin: '取消固定'
          }
        : {
            enter: 'Open console',
            work: 'Work',
            previous: 'Move left',
            next: 'Move right',
            close: 'Close',
            pin: 'Pin',
            unpin: 'Unpin'
          };
    await page.addInitScript((value) => localStorage.setItem('mar.locale.v2', value), locale);
    await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
    await mockEmptyWorkspaceFiles(page, ['workspace-2', 'workspace-3']);
    await page.route('**/api/workspaces?nodeId=node-1', (route) =>
      json(route, {
        workspaces: [1, 2, 3].map((index) => ({
          id: `workspace-${index}`,
          path: `/project-${index}`,
          kind: 'DIRECTORY'
        }))
      })
    );
    await page.goto('/console');
    await page.getByRole('button', { name: labels.enter, exact: true }).click();
    await page.getByRole('button', { name: labels.work, exact: true }).click();
    const tree = page.locator('.workspace-tree');
    await tree.getByRole('button', { name: /node-1/ }).click();
    for (let index = 1; index <= 3; index += 1)
      await tree.getByRole('button', { name: `project-${index}`, exact: true }).click();

    const tab = (index: number) => page.getByRole('tab', { name: new RegExp(`project-${index}`) });
    const order = () => page.locator('.workspace-tab-content > span').allTextContents();
    const previous = page.getByRole('menuitem', { name: labels.previous, exact: true });
    const next = page.getByRole('menuitem', { name: labels.next, exact: true });
    const close = page.getByRole('menuitem', { name: labels.close, exact: true });
    const activity = () =>
      page.evaluate(() => {
        const tabs = JSON.parse(localStorage.getItem('mar.workbench.tabs.v1') ?? '[]') as {
          id: string;
          lastActiveAt: number;
        }[];
        return Object.fromEntries(tabs.map((item) => [item.id, item.lastActiveAt]));
      });
    const originalActivity = await activity();
    await tab(1).click({ button: 'right' });
    await expect(previous).toHaveAttribute('aria-disabled', 'true');
    await expect(next).toHaveAttribute('aria-disabled', 'false');
    await expect(tab(3)).toHaveAttribute('aria-selected', 'true');
    await next.click();
    await expect.poll(order).toEqual(['project-2', 'project-1', 'project-3']);
    expect(await activity()).toEqual(originalActivity);
    await expect(tab(3)).toHaveAttribute('aria-selected', 'true');
    await tab(1).click({ button: 'right' });
    await previous.click();
    await expect.poll(order).toEqual(['project-1', 'project-2', 'project-3']);

    await tab(3).click({ button: 'right' });
    await expect(next).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');
    await expect(close).toBeHidden();
    await expect(tab(3)).toBeVisible();
    await tab(1).click({ button: 'right' });
    await page.locator('.workspace-tree').click({ position: { x: 5, y: 5 } });
    await expect(close).toBeHidden();

    await tab(1).click({ button: 'right' });
    await tab(2).click({ button: 'right' });
    await previous.click();
    await expect.poll(order).toEqual(['project-2', 'project-1', 'project-3']);
    await page.reload();
    await expect.poll(order).toEqual(['project-2', 'project-1', 'project-3']);
    await expect(tab(3)).toHaveAttribute('aria-selected', 'true');

    const dragTab = async (source: number, target: number, after: boolean) => {
      const sourceBox = await tab(source).locator('..').boundingBox();
      const targetBox = await tab(target).locator('..').boundingBox();
      if (sourceBox === null || targetBox === null) throw new Error('Workspace Tab bounds missing');
      await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(
        targetBox.x + (after ? targetBox.width - 2 : 2),
        targetBox.y + targetBox.height / 2,
        { steps: 5 }
      );
      await page.mouse.up();
    };
    const beforePinActivity = await activity();
    await tab(2).click({ button: 'right' });
    const pinMenuIcon = page
      .getByRole('menuitem', { name: labels.pin, exact: true })
      .locator('svg path');
    await expect(pinMenuIcon).toBeVisible();
    const pinIconPath = await pinMenuIcon.evaluate((path) => path.outerHTML);
    await page.getByRole('menuitem', { name: labels.pin, exact: true }).click();
    await tab(3).click({ button: 'right' });
    await page.getByRole('menuitem', { name: labels.pin, exact: true }).click();
    await expect.poll(order).toEqual(['project-2', 'project-3', 'project-1']);
    await expect(tab(2).locator('..').locator('.tab-close')).toHaveCount(0);
    await expect(tab(2).locator('..').locator('.tab-pin')).toBeVisible();
    expect(
      await tab(2)
        .locator('..')
        .locator('.tab-pin svg path')
        .evaluate((path) => path.outerHTML)
    ).toBe(pinIconPath);
    await tab(2).click({ button: 'right' });
    const unpinMenuIcon = page
      .getByRole('menuitem', { name: labels.unpin, exact: true })
      .locator('svg path');
    await expect(unpinMenuIcon).toBeVisible();
    expect(await unpinMenuIcon.evaluate((path) => path.outerHTML)).toBe(pinIconPath);
    await expect(close).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');
    await dragTab(2, 3, true);
    await expect.poll(order).toEqual(['project-3', 'project-2', 'project-1']);
    await expect(tab(2).locator('..')).toHaveClass(/pinned/);
    await dragTab(1, 3, false);
    await expect.poll(order).toEqual(['project-1', 'project-3', 'project-2']);
    await expect(tab(1).locator('..').locator('.tab-pin')).toBeVisible();
    await tab(1).locator('..').locator('.tab-pin').click();
    await expect.poll(order).toEqual(['project-3', 'project-2', 'project-1']);
    await tab(1).click({ button: 'right' });
    await expect(previous).not.toHaveAttribute('aria-disabled', 'true');
    await previous.click();
    await expect.poll(order).toEqual(['project-3', 'project-1', 'project-2']);
    await expect(tab(1).locator('..').locator('.tab-pin')).toBeVisible();
    await tab(1).locator('..').locator('.tab-pin').click();
    await expect.poll(order).toEqual(['project-3', 'project-2', 'project-1']);
    await dragTab(2, 1, true);
    await expect.poll(order).toEqual(['project-3', 'project-1', 'project-2']);
    await expect(tab(2).locator('..').locator('.tab-close')).toBeVisible();
    await expect(tab(2).locator('..').locator('.tab-pin')).toHaveCount(0);
    expect(await activity()).toEqual(beforePinActivity);
    await page.reload();
    await expect.poll(order).toEqual(['project-3', 'project-1', 'project-2']);
    await expect(tab(3).locator('..').locator('.tab-pin')).toBeVisible();
    await tab(3).click({ button: 'right' });
    await page.getByRole('menuitem', { name: labels.unpin, exact: true }).click();
    await tab(2).click({ button: 'right' });
    await page.getByRole('menuitem', { name: labels.pin, exact: true }).click();
    await tab(2).locator('..').locator('.tab-pin').click();
    await expect(tab(2).locator('..').locator('.tab-close')).toBeVisible();
    await expect(tab(3)).toHaveAttribute('aria-selected', 'true');

    await tab(1).click({ button: 'right' });
    await close.click();
    await expect(tab(1)).toHaveCount(0);
    await expect(tab(3)).toHaveAttribute('aria-selected', 'true');
    await tab(3).click({ button: 'right' });
    await close.click();
    await expect(tab(3)).toHaveCount(0);
    await expect(tab(2)).toHaveAttribute('aria-selected', 'true');
    await tab(2).click({ button: 'right' });
    await expect(previous).toHaveAttribute('aria-disabled', 'true');
    await expect(next).toHaveAttribute('aria-disabled', 'true');
    await close.click();
    await expect(page.locator('.workspace-tab[data-tab-id]')).toHaveCount(0);
    await expect(page.locator('.workspace-tab-context-anchor')).toHaveCount(0);
  });
}

for (const theme of ['daylight', 'vscode-dark-2026'] as const) {
  test(`Pinned Workspace Tabs use ordinary colors without dividers: ${theme}`, async ({ page }) => {
    await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], [], 'DIRECTORY');
    await mockEmptyWorkspaceFiles(page, ['workspace-2', 'workspace-3']);
    await page.route('**/api/workspaces?nodeId=node-1', (route) =>
      json(route, {
        workspaces: [1, 2, 3].map((index) => ({
          id: `workspace-${index}`,
          path: `/project-${index}`,
          kind: 'DIRECTORY'
        }))
      })
    );
    await page.goto('/console');
    await page.getByRole('button', { name: '进入控制台' }).click();
    await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
    const tree = page.locator('.workspace-tree');
    await tree.getByRole('button', { name: /node-1/ }).click();
    for (let index = 1; index <= 3; index++)
      await tree.getByRole('button', { name: `project-${index}`, exact: true }).click();
    const tab = (index: number) =>
      page.getByRole('tab', { name: `project-${index} node-1`, exact: true });
    const colors = (index: number) =>
      tab(index)
        .locator('..')
        .evaluate((element) => ({
          background: getComputedStyle(element).backgroundColor,
          image: getComputedStyle(element).backgroundImage,
          text: getComputedStyle(element.querySelector('button')!).color
        }));
    await tab(1).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '固定', exact: true }).click();
    const pin = tab(1).locator('..');
    await expect(pin).toHaveClass(/sticky-pinned/);
    await page.mouse.move(0, 0);
    expect(await colors(1)).toEqual(await colors(2));
    expect(await pin.evaluate((element) => getComputedStyle(element, '::after').content)).toBe(
      'none'
    );
    await tab(1).hover();
    const hoverColors = await colors(1);
    await tab(2).hover();
    expect(await colors(2)).toEqual(hoverColors);
    await tab(1).click();
    await page.mouse.move(0, 0);
    const activeColors = await colors(1);
    await pin.locator('.tab-pin').click();
    await page.mouse.move(0, 0);
    expect(await colors(1)).toEqual(activeColors);
    await expect(tab(1)).toHaveAttribute('aria-selected', 'true');
    await tab(1).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '固定', exact: true }).click();
    await page.mouse.move(0, 0);
    const tabList = page.locator('.workspace-tabs');
    await expect(tabList).toHaveCSS('padding-left', '2px');
    await expect(page.locator('.workbench-tree-toggle')).toHaveCSS('width', '26px');
    await tabList.evaluate((element) => {
      element.style.maxWidth = '340px';
      element.scrollLeft = 40;
    });
    await expect.poll(() => tabList.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    await tab(2).hover();
    const mask = await pin.evaluate((element) => {
      const style = getComputedStyle(element, '::before');
      return {
        width: style.borderRightWidth,
        color: style.borderRightColor,
        backdrop: getComputedStyle(document.querySelector('.workbench-header')!).backgroundColor,
        radius: style.borderTopRightRadius,
        pointerEvents: style.pointerEvents
      };
    });
    expect(mask.width).toBe('3px');
    expect(mask.color).toBe(mask.backdrop);
    expect(mask.radius).toBe('9px');
    expect(mask.pointerEvents).toBe('none');
    await page.locator('.workspace-tabs').screenshot({
      path: test.info().outputPath(`uniform-pinned-tabs-${theme}.png`),
      animations: 'disabled'
    });
  });
}

test('Pinned Workspace Tabs do not consume the eight-tab LRU quota and survive reload and bulk closure', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await mockEmptyWorkspaceFiles(
    page,
    Array.from({ length: 9 }, (_, index) => `workspace-${index + 2}`)
  );
  await page.route('**/api/workspaces?nodeId=node-1', (route) =>
    json(route, {
      workspaces: Array.from({ length: 10 }, (_, index) => ({
        id: `workspace-${index + 1}`,
        path: `/project-${index + 1}`,
        kind: 'DIRECTORY'
      }))
    })
  );
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();

  const tree = page.locator('.workspace-tree');
  for (let index = 1; index <= 10; index += 1) {
    await tree.getByRole('button', { name: `project-${index}`, exact: true }).click();
    if (index === 1) {
      await page.getByRole('tab', { name: /^project-1(?:\s|$)/ }).click({ button: 'right' });
      await page.getByRole('menuitem', { name: '固定', exact: true }).click();
    }
  }

  await expect(page.locator('.workspace-tab[data-tab-id]')).toHaveCount(9);
  await expect(page.getByRole('tab', { name: /^project-1(?:\s|$)/ }).locator('..')).toHaveClass(
    /pinned/
  );
  await expect(page.getByRole('tab', { name: /^project-2(?:\s|$)/ })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /^project-10(?:\s|$)/ })).toBeVisible();
  await page.reload();
  await expect(page.locator('.workspace-tab[data-tab-id]')).toHaveCount(9);
  await expect(
    page
      .getByRole('tab', { name: /^project-1(?:\s|$)/ })
      .locator('..')
      .locator('.tab-pin')
  ).toBeVisible();
  await page.setViewportSize({ width: 1200, height: 900 });
  const strip = page.locator('.workspace-tabs');
  const pin = page.getByRole('tab', { name: /^project-1(?:\s|$)/ }).locator('..');
  await expect(pin).toHaveClass(/sticky-pinned/);
  expect(await pin.evaluate((element) => getComputedStyle(element, '::after').content)).toBe(
    'none'
  );
  await page.getByRole('button', { name: '全部已打开工作区', exact: true }).click();
  await page.getByRole('menuitem', { name: /^project-3(?:\s|$)/ }).click();
  await expect.poll(() => strip.evaluate((element) => element.scrollLeft)).toBeLessThan(2);
  const pinnedX = (await pin.boundingBox())!.x;
  await strip.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect.poll(() => strip.evaluate((element) => element.scrollLeft)).toBeGreaterThan(20);
  expect(Math.abs((await pin.boundingBox())!.x - pinnedX)).toBeLessThan(2);
  expect(
    await pin.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return (
        document
          .elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
          ?.closest('.workspace-tab') === element
      );
    })
  ).toBe(true);
  await page.getByRole('button', { name: '全部已打开工作区', exact: true }).click();
  await page.getByRole('menuitem', { name: /^project-10(?:\s|$)/ }).click();
  await expect(page.getByRole('tab', { name: /^project-10(?:\s|$)/ })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect
    .poll(() =>
      page.getByRole('tab', { name: /^project-10(?:\s|$)/ }).evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const pinned = document
          .querySelector('.workspace-tab.sticky-pinned')!
          .getBoundingClientRect();
        const viewport = element.closest('.workspace-tabs')!.getBoundingClientRect();
        return bounds.left >= pinned.right && bounds.right <= viewport.right + 1;
      })
    )
    .toBe(true);
  await page.screenshot({
    path: test.info().outputPath('sticky-workspace-tabs.png'),
    animations: 'disabled'
  });
  await page.evaluate(() => {
    const tabs = JSON.parse(localStorage.getItem('mar.workbench.tabs.v1') ?? '[]');
    localStorage.setItem(
      'mar.workbench.tabs.v1',
      JSON.stringify(
        tabs.map((tab: { label: string }) => ({ ...tab, pinned: tab.label !== 'project-10' }))
      )
    );
  });
  await page.reload();
  await expect(page.locator('.workspace-tab.pinned')).toHaveCount(8);
  await expect(page.locator('.workspace-tab.sticky-pinned')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '全部已打开工作区', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.workspace-tab.sticky-pinned')).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath('mobile-workspace-tabs.png'),
    animations: 'disabled'
  });
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.evaluate(() => {
    const tabs = JSON.parse(localStorage.getItem('mar.workbench.tabs.v1') ?? '[]');
    localStorage.setItem(
      'mar.workbench.tabs.v1',
      JSON.stringify(
        tabs.map((tab: { label: string }) => ({ ...tab, pinned: tab.label === 'project-1' }))
      )
    );
  });
  await page.reload();
  await expect(page.locator('.workspace-tab.pinned')).toHaveCount(1);
  await page.getByRole('tab', { name: /^project-10(?:\s|$)/ }).focus();
  await page.keyboard.press('Alt+Shift+w');
  await expect(page.locator('.workspace-tab[data-tab-id]')).toHaveCount(1);
  await expect(page.getByRole('tab', { name: /^project-1(?:\s|$)/ })).toHaveAttribute(
    'aria-selected',
    'true'
  );
});

test('Admin Workbench retains at most eight ordinary Workspace Tabs with stable positions and LRU eviction', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await mockEmptyWorkspaceFiles(
    page,
    Array.from({ length: 8 }, (_, index) => `workspace-${index + 2}`)
  );
  await page.route('**/api/workspaces?nodeId=node-1', (route) =>
    json(route, {
      workspaces: Array.from({ length: 9 }, (_, index) => ({
        id: `workspace-${index + 1}`,
        path: `/project-${index + 1}`,
        kind: 'DIRECTORY'
      }))
    })
  );
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();

  const tree = page.locator('.workspace-tree');
  for (let index = 1; index <= 8; index += 1) {
    await tree.getByRole('button', { name: `project-${index}` }).click();
  }

  await expect(page.locator('.workspace-tab')).toHaveCount(8);
  const desktopTabSizing = await page
    .locator('.workspace-tab')
    .first()
    .evaluate((element) => {
      const label = element.querySelector<HTMLElement>('.workspace-tab-content > span');
      if (label === null) throw new Error('Workspace tab label is missing');
      const originalLabel = label.textContent ?? '';
      const minimumWidth = element.getBoundingClientRect().width;
      label.textContent = 'adaptive-workspace-label';
      const adaptiveWidth = element.getBoundingClientRect().width;
      label.textContent = 'workspace-'.repeat(40);
      const cappedWidth = element.getBoundingClientRect().width;
      label.textContent = originalLabel;
      return {
        minimumWidth,
        adaptiveWidth,
        cappedWidth,
        maximumWidth: Number.parseFloat(getComputedStyle(element).maxWidth)
      };
    });
  expect(desktopTabSizing.minimumWidth).toBeGreaterThanOrEqual(124);
  expect(desktopTabSizing.adaptiveWidth).toBeGreaterThan(desktopTabSizing.minimumWidth);
  expect(desktopTabSizing.cappedWidth).toBeLessThanOrEqual(desktopTabSizing.maximumWidth + 1);
  const tabLabels = await page.locator('.workspace-tab-content > span').allTextContents();
  const previousLastActiveAt = await page.evaluate(() => {
    const tabs = JSON.parse(localStorage.getItem('mar.workbench.tabs.v1') ?? '[]') as {
      readonly label: string;
      readonly lastActiveAt: number;
    }[];
    return tabs.find((tab) => tab.label === 'project-1')?.lastActiveAt;
  });
  await page.getByRole('tab', { name: /project-1/ }).click();
  await expect(page.getByRole('tab', { name: /project-1/ })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  expect(await page.locator('.workspace-tab-content > span').allTextContents()).toEqual(tabLabels);
  const draggedTab = page.getByRole('tab', { name: /project-6/ }).locator('..');
  const targetTab = page.getByRole('tab', { name: /project-1/ }).locator('..');
  const draggedBox = await draggedTab.boundingBox();
  const targetBox = await targetTab.boundingBox();
  if (draggedBox === null || targetBox === null) throw new Error('Workspace Tab bounds missing');
  await page.mouse.move(draggedBox.x + draggedBox.width / 2, draggedBox.y + draggedBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + 2, targetBox.y + targetBox.height / 2, { steps: 5 });
  await page.mouse.up();
  const expectedTabLabels = [...tabLabels];
  expectedTabLabels.splice(expectedTabLabels.indexOf('project-6'), 1);
  expectedTabLabels.splice(expectedTabLabels.indexOf('project-1'), 0, 'project-6');
  await expect(page.getByRole('tab', { name: /project-1/ })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect
    .poll(() => page.locator('.workspace-tab-content > span').allTextContents())
    .toEqual(expectedTabLabels);
  await page.reload();
  await expect
    .poll(() => page.locator('.workspace-tab-content > span').allTextContents())
    .toEqual(expectedTabLabels);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const tabs = JSON.parse(localStorage.getItem('mar.workbench.tabs.v1') ?? '[]') as {
          readonly label: string;
          readonly lastActiveAt: number;
        }[];
        return tabs.find((tab) => tab.label === 'project-1')?.lastActiveAt;
      })
    )
    .toBeGreaterThan(previousLastActiveAt ?? 0);

  const inactiveTab = page.getByRole('tab', { name: /project-6/ }).locator('..');
  const inactiveTabBackground = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue(
      '--mar-bg-tab-inactive'
    );
    document.body.append(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  });
  await inactiveTab.locator('.tab-close').hover();
  await expect(inactiveTab).toHaveCSS('background-color', inactiveTabBackground);
  expect(
    await inactiveTab
      .locator('.tab-close')
      .evaluate((element) => getComputedStyle(element).backgroundColor)
  ).toBe('rgba(0, 0, 0, 0)');

  await tree.getByRole('button', { name: 'project-9' }).click();
  await expect(page.locator('.workspace-tab')).toHaveCount(8);
  await expect(page.locator('.workspace-tabs')).toContainText('project-1');
  await expect(page.locator('.workspace-tabs')).not.toContainText('project-2');
  await expect(page.locator('.workspace-tabs')).toContainText('project-9');

  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(page.getByRole('button', { name: '向右浏览工作区标签' })).toBeVisible();
  await page.getByRole('button', { name: '全部已打开工作区' }).click();
  await expect(page.locator('.workspace-tab-menu-list')).toContainText('project-9');

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: '向右浏览工作区标签' })).toBeHidden();
  await expect(page.locator('.workspace-tab').first()).toHaveCSS('touch-action', 'pan-x');
  const mobileTabSizing = await page
    .locator('.workspace-tab')
    .first()
    .evaluate((element) => {
      const label = element.querySelector<HTMLElement>('.workspace-tab-content > span');
      if (label === null) throw new Error('Workspace tab label is missing');
      const originalLabel = label.textContent ?? '';
      const minimumWidth = element.getBoundingClientRect().width;
      label.textContent = 'adaptive-workspace-label';
      const adaptiveWidth = element.getBoundingClientRect().width;
      label.textContent = 'workspace-'.repeat(40);
      const cappedWidth = element.getBoundingClientRect().width;
      label.textContent = originalLabel;
      return {
        minimumWidth,
        adaptiveWidth,
        cappedWidth,
        maximumWidth: Number.parseFloat(getComputedStyle(element).maxWidth)
      };
    });
  expect(mobileTabSizing.minimumWidth).toBeGreaterThanOrEqual(104);
  expect(mobileTabSizing.adaptiveWidth).toBeGreaterThan(mobileTabSizing.minimumWidth);
  expect(mobileTabSizing.cappedWidth).toBeLessThanOrEqual(mobileTabSizing.maximumWidth + 1);
  const mobileTabBounds = await page
    .locator('.workspace-tab')
    .first()
    .evaluate((element) => {
      const tab = element.getBoundingClientRect();
      const trigger = element.querySelector('button[role="tab"]')?.getBoundingClientRect();
      if (trigger === undefined) throw new Error('Workspace tab trigger is missing');
      return {
        tabLeft: tab.left,
        tabWidth: tab.width,
        triggerLeft: trigger.left,
        triggerWidth: trigger.width
      };
    });
  expect(Math.abs(mobileTabBounds.tabLeft - mobileTabBounds.triggerLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(mobileTabBounds.tabWidth - mobileTabBounds.triggerWidth)).toBeLessThanOrEqual(1);
});

test('Returning to a Workspace Tab restores its Inspector without leaking another Workspace state', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  let diffStarted = false;
  let releaseDiff!: () => void;
  let workspaceOneChanged = false;
  let workspaceTwoChanged = false;
  let workspaceOneReads = 0;
  let workspaceTwoReads = 0;
  const workspaceChanges = {
    branch: 'main',
    changes: [{ path: 'src/main.ts', state: 'UNSTAGED', change: 'MODIFIED', diffAvailable: true }],
    repositories: [
      {
        repositoryPath: '',
        repositoryName: 'project-1',
        source: 'ROOT',
        branch: 'main',
        changes: [
          { path: 'src/main.ts', state: 'UNSTAGED', change: 'MODIFIED', diffAvailable: true }
        ]
      }
    ]
  };
  await page.route('**/api/workspaces?nodeId=node-1', (route) =>
    json(route, {
      workspaces: [
        { id: 'workspace-1', path: '/project-1', kind: 'GIT_WORKSPACE' },
        { id: 'workspace-2', path: '/project-2', kind: 'DIRECTORY' }
      ]
    })
  );
  await page.route(/\/api\/workspaces\/workspace-2\/files(?:\?.*)?$/, (route) => {
    workspaceTwoReads += 1;
    const name = workspaceTwoChanged ? 'after-switch.txt' : 'README.md';
    return json(route, {
      files: {
        entries: [{ path: name, name, kind: 'FILE', size: 12 }],
        nextCursor: null
      }
    });
  });
  await page.route(/\/api\/workspaces\/workspace-2\/watch$/, (route) =>
    fulfillMockWorkspaceWatch(
      page,
      route,
      {
        id: 'session-2',
        workspaceId: 'workspace-2',
        runner: 'codex',
        externalSessionId: 'thread-2',
        customTitle: '工作区二会话',
        activity: 'IDLE',
        control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
      },
      'DIRECTORY',
      [{ path: 'README.md', name: 'README.md', kind: 'FILE', size: 12 }]
    )
  );
  await page.route(/\/api\/workspaces\/workspace-1\/watch$/, (route) =>
    fulfillMockWorkspaceWatch(
      page,
      route,
      {
        id: 'session-1',
        workspaceId: 'workspace-1',
        runner: 'codex',
        externalSessionId: 'thread-1',
        customTitle: '工作区一会话',
        activity: 'IDLE',
        control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
      },
      'GIT_WORKSPACE',
      undefined,
      workspaceChanges
    )
  );
  await page.route(/\/api\/workspaces\/workspace-1\/changes(?:\?.*)?$/, (route) => {
    workspaceOneReads += 1;
    return json(route, {
      ...workspaceChanges,
      branch: workspaceOneChanged ? 'feature/refreshed' : 'main',
      repositories: workspaceChanges.repositories.map((repository) => ({
        ...repository,
        branch: workspaceOneChanged ? 'feature/refreshed' : 'main'
      }))
    });
  });
  await page.route(/\/api\/workspaces\/workspace-1\/changes\/diff(?:\?.*)?$/, async (route) => {
    diffStarted = true;
    await new Promise<void>((resolve) => (releaseDiff = resolve));
    return json(route, {
      diff: {
        binary: false,
        afterText: 'export const value = 2;\n',
        text: '@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n'
      }
    });
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();

  const tree = page.locator('.workspace-tree');
  await tree.getByRole('button', { name: 'project-1' }).click();
  const gitChangesTab = page.getByRole('tab', { name: /Git (?:Changes|变更)/ });
  await expect(gitChangesTab).toHaveAttribute('aria-selected', 'false');
  await gitChangesTab.click();
  await expect(gitChangesTab).toHaveAttribute('aria-selected', 'true');
  const diffButton = page.getByRole('button', { name: '查看 src/main.ts 的 Diff' });
  await diffButton.click();
  await expect.poll(() => diffStarted).toBe(true);
  await expect(diffButton).toBeEnabled();
  await page.getByRole('textbox', { name: '输入消息' }).fill('工作区一的草稿');
  await page
    .getByRole('tablist', { name: '文件预览标签' })
    .getByRole('button', { name: '关闭预览' })
    .click();

  await tree.getByRole('button', { name: 'project-2' }).click();
  await expect(page.getByText('README.md', { exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: '文件' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('textbox', { name: '输入消息' })).toHaveValue('');

  workspaceOneChanged = true;
  const readsBeforeReturn = workspaceOneReads;
  await page.getByRole('tab', { name: /project-1/ }).click();
  await expect(gitChangesTab).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => workspaceOneReads).toBeGreaterThan(readsBeforeReturn);
  await expect(page.locator('.current-changes .current-branch')).toHaveText('feature/refreshed');
  await expect(page.getByRole('button', { name: '查看 src/main.ts 的 Diff' })).toBeEnabled();
  await expect(page.getByRole('textbox', { name: '输入消息' })).toHaveValue('工作区一的草稿');
  releaseDiff();

  let oldFilesStarted = false;
  let releaseOldFiles!: () => void;
  const oldFilesResponse = new Promise<void>((resolve) => (releaseOldFiles = resolve));
  await page.unroute(/\/api\/workspaces\/workspace-1\/files(?:\?.*)?$/);
  await page.route(/\/api\/workspaces\/workspace-1\/files(?:\?.*)?$/, async (route) => {
    oldFilesStarted = true;
    await oldFilesResponse;
    return json(route, { error: { code: 'CAPABILITY_UNAVAILABLE' } }, 404);
  });
  await page.getByRole('tab', { name: '文件' }).click();
  await page.getByRole('button', { name: '刷新文件', exact: true }).click();
  await expect.poll(() => oldFilesStarted).toBe(true);

  workspaceTwoChanged = true;
  const filesReadsBeforeReturn = workspaceTwoReads;
  await page.getByRole('tab', { name: /project-2/ }).click();
  const staleFailure = page.waitForResponse(
    (response) =>
      /\/api\/workspaces\/workspace-1\/files(?:\?.*)?$/.test(response.url()) &&
      response.status() === 404
  );
  releaseOldFiles();
  await staleFailure;
  await expect.poll(() => workspaceTwoReads).toBeGreaterThan(filesReadsBeforeReturn);
  await expect(page.getByText('after-switch.txt', { exact: true })).toBeVisible();
  await expect(page.getByText('目标节点当前不支持此只读资源。')).toHaveCount(0);
});

test('Workspace registration uses an independent action target and cancellation preserves the active Workspace and draft', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.route('**/api/nodes', (route) =>
    json(route, {
      nodes: ['node-1', 'node-2'].map((id) => ({
        id,
        platform: 'linux',
        architecture: 'x64',
        connected: true,
        disabled: false,
        workspaceCreatable: true,
        capabilities: { codex: { available: true, version: '0.146' } }
      }))
    })
  );
  await page.route('**/api/workspaces?nodeId=node-2', (route) => json(route, { workspaces: [] }));
  let directoryTarget: string | null = null;
  await page.route(/\/api\/workspace-directories(?:\?.*)?$/, (route) => {
    directoryTarget = new URL(route.request().url()).searchParams.get('nodeId');
    return json(route, {
      directory: {
        homePath: '/home/node',
        currentPath: '/home/node',
        parentPath: null,
        browseRoots: ['/home/node'],
        selectable: true,
        entries: [
          { name: 'candidate', path: '/home/node/candidate', selectable: true },
          { name: 'other', path: '/home/node/other', selectable: true }
        ],
        truncated: false
      }
    });
  });
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  const tree = page.locator('.workspace-tree');
  await tree.getByRole('button', { name: /node-1/ }).click();
  await tree.getByRole('button', { name: 'project', exact: true }).click();
  const composer = page.getByRole('textbox', { name: '输入消息' });
  await composer.fill('保留当前草稿');
  await tree.getByRole('button', { name: /node-2/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '添加工作区', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '登记工作区' });
  await expect(dialog).toBeVisible();
  await expect.poll(() => directoryTarget).toBe('node-2');
  const candidate = dialog.getByRole('button', { name: 'candidate', exact: true });
  const other = dialog.getByRole('button', { name: 'other', exact: true });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ['daylight', 'vscode-dark-2026']) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.classList.toggle('dark', theme !== 'daylight');
      }, theme);
      await candidate.click();
      const colors = await candidate.evaluate((element) => {
        const probe = document.createElement('span');
        probe.style.backgroundColor = 'var(--mar-fill-selection)';
        probe.style.color = 'var(--mar-text-primary)';
        element.append(probe);
        const style = getComputedStyle(probe);
        const selected = style.backgroundColor;
        const color = style.color;
        probe.style.backgroundColor = 'var(--mar-fill-row-hover)';
        const hover = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return { selected, color, hover };
      });
      await expect(candidate).toHaveCSS('background-color', colors.selected);
      await expect(candidate).toHaveCSS('color', colors.color);
      await expect(candidate).toHaveCSS('border-radius', '6px');
      await candidate.hover();
      await expect(candidate).toHaveCSS('background-color', colors.selected);
      await other.hover();
      await expect(other).toHaveCSS('background-color', colors.hover);
    }
  }
  const selection = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('mar.workbench.selection.v1') ?? '{}')
  );
  expect(selection.workspace).toEqual({ nodeId: 'node-1', workspaceId: 'workspace-1' });
  await dialog.locator('.el-dialog__headerbtn').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /^project\b/ })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(composer).toHaveValue('保留当前草稿');
});

test('Workspace activation is immediate, Node groups create no independent selection, and stale responses cannot overwrite the new Workspace', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  let releaseMetadata!: () => void;
  const blocked = new Promise<void>((resolve) => {
    releaseMetadata = resolve;
  });
  let slowRequests = 0;
  await page.route('**/api/nodes', (route) =>
    json(route, {
      nodes: ['node-1', 'node-2'].map((id) => ({
        id,
        platform: 'linux',
        architecture: 'x64',
        connected: true,
        disabled: false,
        capabilities: { codex: { available: true, version: '0.146' } }
      }))
    })
  );
  await page.route('**/api/workspaces?nodeId=node-2', async (route) => {
    slowRequests += 1;
    await blocked;
    return json(route, {
      workspaces: [{ id: 'workspace-2', path: '/slow-project', kind: 'DIRECTORY' }]
    });
  });
  await page.route('**/api/nodes/node-2/workbench-capabilities', (route) =>
    json(route, {
      manifest: {
        manifestVersion: 1,
        observedAt: 1_900_000_000_000,
        conversation: { available: true, reasonCode: null },
        files: { available: true, reasonCode: null },
        terminal: { available: false, reasonCode: 'UNAVAILABLE' }
      }
    })
  );
  await page.route(/\/api\/runner-profiles\?.*\bnodeId=node-2(?:&|$)/, (route) =>
    json(route, { profiles: [], defaults: [] })
  );
  await page.route(/\/api\/agent-sessions\?nodeId=node-2(?:&.*)?$/, (route) =>
    json(route, { sessions: [], nextCursor: null })
  );
  await page.addInitScript(() =>
    localStorage.setItem(
      'mar.workbench.tabs.v1',
      JSON.stringify([
        {
          id: 'node-1:workspace-1',
          nodeId: 'node-1',
          workspaceId: 'workspace-1',
          label: 'project',
          lastActiveAt: 1
        },
        {
          id: 'node-2:workspace-2',
          nodeId: 'node-2',
          workspaceId: 'workspace-2',
          label: 'slow-project',
          lastActiveAt: 2
        }
      ])
    )
  );
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  const first = page.getByRole('tab', { name: /^project\b/ });
  const slow = page.getByRole('tab', { name: /slow-project/ });
  await first.click();
  const composer = page.getByRole('textbox', { name: '输入消息' });
  await composer.fill('工作区一草稿');
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-2/ })
    .click();
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await expect(composer).toHaveValue('工作区一草稿');
  await slow.click();
  await expect(slow).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.workspace-selection-panel .el-skeleton')).toBeVisible();
  await expect.poll(() => slowRequests).toBeGreaterThanOrEqual(1);
  const selection = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('mar.workbench.selection.v1') ?? '{}')
  );
  expect(selection).toEqual({ workspace: { nodeId: 'node-2', workspaceId: 'workspace-2' } });
  await first.click();
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await expect(composer).toHaveValue('工作区一草稿');
  releaseMetadata();
  await expect(
    page.locator('.workspace-tree').getByRole('button', { name: 'slow-project', exact: true })
  ).toBeVisible();
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await expect(composer).toHaveValue('工作区一草稿');
  const final = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('mar.workbench.selection.v1') ?? '{}')
  );
  expect(final.workspace).toEqual({ nodeId: 'node-1', workspaceId: 'workspace-1' });
  expect(final).not.toHaveProperty('nodeId');
});

test('Workspaces restore target drafts first and failed background refreshes cannot switch back', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  let node1WorkspaceRequests = 0;
  let failNode1Refresh = false;
  let releaseNode1Refresh!: () => void;
  const node1RefreshBlocked = new Promise<void>((resolve) => {
    releaseNode1Refresh = resolve;
  });
  await page.route('**/api/workspaces?nodeId=node-1', async (route) => {
    node1WorkspaceRequests += 1;
    if (node1WorkspaceRequests > 1 && failNode1Refresh) {
      await node1RefreshBlocked;
      return json(route, { error: { code: 'NODE_REFRESH_FAILED' } }, 503);
    }
    return json(route, {
      workspaces: [{ id: 'workspace-1', path: '/project', kind: 'GIT_WORKSPACE' }]
    });
  });
  await page.route('**/api/nodes', (route) =>
    json(route, {
      nodes: ['node-1', 'node-2'].map((id) => ({
        id,
        platform: 'linux',
        architecture: 'x64',
        connected: true,
        disabled: false,
        capabilities: {
          codex: { available: true, version: '0.146' },
          claudeCode: { available: true, version: '2.1' }
        }
      }))
    })
  );
  await page.route('**/api/workspaces?nodeId=node-2', (route) =>
    json(route, {
      workspaces: [{ id: 'workspace-2', path: '/project-node-2', kind: 'DIRECTORY' }]
    })
  );
  await page.route('**/api/nodes/node-2/workbench-capabilities', (route) =>
    json(route, {
      manifest: {
        manifestVersion: 1,
        observedAt: 1_900_000_000_000,
        conversation: { available: true, reasonCode: null },
        files: { available: true, reasonCode: null },
        terminal: { available: false, reasonCode: 'UNAVAILABLE' }
      }
    })
  );
  await page.route(/\/api\/runner-profiles\?.*\bnodeId=node-2(?:&|$)/, (route) =>
    json(route, { profiles: [], defaults: [] })
  );
  await page.route(/\/api\/agent-sessions\?nodeId=node-2(?:&.*)?$/, (route) =>
    json(route, { sessions: [], nextCursor: null })
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  const tree = page.locator('.workspace-tree');
  await tree.getByRole('button', { name: /node-1/ }).click();
  await tree.getByRole('button', { name: 'project' }).click();
  await page.getByRole('textbox', { name: '输入消息' }).fill('Node 1 的草稿');

  await tree.getByRole('button', { name: /node-2/ }).click();
  await tree.getByRole('button', { name: 'project-node-2' }).click();
  await expect(page.getByRole('tab', { name: /project-node-2/ })).toHaveAttribute(
    'aria-selected',
    'true'
  );

  failNode1Refresh = true;
  const requestsBeforeSwitch = node1WorkspaceRequests;
  await page.getByRole('tab', { name: 'project node-1' }).click();

  await expect.poll(() => node1WorkspaceRequests).toBe(requestsBeforeSwitch + 1);
  await expect(page.getByRole('tab', { name: 'project node-1' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(page.getByRole('textbox', { name: '输入消息' })).toHaveValue('Node 1 的草稿');
  releaseNode1Refresh();
  await expect(page.getByText(/无法读取节点工作区/)).toBeVisible();
  await expect(page.getByRole('tab', { name: 'project node-1' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(page.getByRole('textbox', { name: '输入消息' })).toHaveValue('Node 1 的草稿');
  failNode1Refresh = false;
  await page.getByRole('tab', { name: 'project node-1' }).click();
  await expect(page.getByRole('tab', { name: 'project node-1' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(page.getByRole('textbox', { name: '输入消息' })).toBeEditable();
  await expect(page.getByRole('textbox', { name: '输入消息' })).toHaveValue('Node 1 的草稿');
});

test('Three Workspace Tabs use the same activation flow to restore their session-list caches', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  let blockNextNode1Manifest = false;
  let markNextWorkspace1Snapshot = false;
  let releaseNode1Manifest: (() => void) | undefined;
  const delayedNode1Manifest = new Promise<void>((resolve) => {
    releaseNode1Manifest = resolve;
  });
  await page.route('**/api/nodes', (route) =>
    json(route, {
      nodes: ['node-1', 'node-2'].map((id) => ({
        id,
        platform: 'linux',
        architecture: 'x64',
        connected: true,
        disabled: false,
        capabilities: { codex: { available: true, version: '0.146' } }
      }))
    })
  );
  await page.route('**/api/nodes/node-1/workbench-capabilities', async (route) => {
    if (blockNextNode1Manifest) {
      blockNextNode1Manifest = false;
      await delayedNode1Manifest;
    }
    return json(route, {
      manifest: {
        manifestVersion: 1,
        observedAt: 1_900_000_000_000,
        conversation: { available: true, reasonCode: null },
        files: { available: true, reasonCode: null },
        git: { available: true, reasonCode: null, supportsHistory: true },
        terminal: {
          available: true,
          reasonCode: null,
          supportsReplay: true,
          supportsTakeover: true,
          profiles: [{ id: 'default', label: 'Default shell', isDefault: true }]
        }
      }
    });
  });
  await page.route('**/api/workspaces?nodeId=node-1', (route) =>
    json(route, {
      workspaces: [
        { id: 'workspace-1', path: '/project-1', kind: 'DIRECTORY' },
        { id: 'workspace-3', path: '/project-3', kind: 'DIRECTORY' }
      ]
    })
  );
  await page.route('**/api/workspaces?nodeId=node-2', (route) =>
    json(route, {
      workspaces: [{ id: 'workspace-2', path: '/project-2', kind: 'DIRECTORY' }]
    })
  );
  await page.route('**/api/nodes/node-2/workbench-capabilities', (route) =>
    json(route, {
      manifest: {
        manifestVersion: 1,
        observedAt: 1_900_000_000_000,
        conversation: { available: true, reasonCode: null },
        files: { available: true, reasonCode: null },
        terminal: { available: false, reasonCode: 'UNAVAILABLE' }
      }
    })
  );
  await page.route(/\/api\/runner-profiles\?.*\bnodeId=node-2(?:&|$)/, (route) =>
    json(route, { profiles: [], defaults: [] })
  );
  const initialWatchRequests = new Map<string, number>();
  await page.route(/\/api\/workspaces\/workspace-[123]\/watch$/, (route) => {
    const workspaceId =
      route
        .request()
        .url()
        .match(/workspaces\/(workspace-\d+)\/watch$/)?.[1] ?? '';
    const suffix = workspaceId.slice(-1);
    const request = JSON.parse(route.request().postData() ?? '{}') as { mode?: string };
    const initialRequest =
      request.mode === 'initial' ? (initialWatchRequests.get(workspaceId) ?? 0) + 1 : undefined;
    if (initialRequest !== undefined) initialWatchRequests.set(workspaceId, initialRequest);
    const markedSnapshot =
      request.mode === 'initial' && workspaceId === 'workspace-1' && markNextWorkspace1Snapshot;
    if (markedSnapshot) markNextWorkspace1Snapshot = false;
    return fulfillMockWorkspaceWatch(
      page,
      route,
      {
        id: `session-${suffix}`,
        workspaceId,
        runner: 'codex',
        externalSessionId: `thread-${suffix}`,
        customTitle: markedSnapshot ? '会话 1 回切快照' : `会话 ${suffix}`,
        activity: 'IDLE',
        control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
      },
      'DIRECTORY'
    );
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  const tree = page.locator('.workspace-tree');
  await tree.getByRole('button', { name: /node-1/ }).click();
  await tree.getByRole('button', { name: 'project-1' }).click();
  await expect(page.getByText('会话 1', { exact: true })).toBeVisible();
  await tree.getByRole('button', { name: 'project-3' }).click();
  await expect(page.getByText('会话 3', { exact: true })).toBeVisible();
  await tree.getByRole('button', { name: /node-2/ }).click();
  await tree.getByRole('button', { name: 'project-2' }).click();
  await expect(page.getByText('会话 2', { exact: true })).toBeVisible();

  blockNextNode1Manifest = true;
  markNextWorkspace1Snapshot = true;
  await page.getByRole('tab', { name: /project-1/ }).click();
  await expect(page.getByText('会话 1 回切快照', { exact: true })).toBeVisible();
  await expect(page.locator('.workspace-inspector')).not.toContainText(
    '节点离线或未声明只读 Files 能力'
  );
  await expect(page.locator('.workspace-inspector')).not.toContainText('加载中');
  releaseNode1Manifest?.();
  await expect(page.getByRole('treeitem', { name: 'main.ts', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: /project-3/ }).click();
  await expect(page.getByText('会话 3', { exact: true })).toBeVisible();
  expect(initialWatchRequests.get('workspace-1')).toBe(2);
  expect(initialWatchRequests.get('workspace-3')).toBe(2);
  expect(initialWatchRequests.get('workspace-2')).toBe(1);
});

test('Cached sessions in the same Workspace avoid duplicate list synchronization and Session Watch recreation', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  let sessionListRequests = 0;
  let initialWatchRequests = 0;
  await page.route(/\/api\/agent-sessions\?nodeId=node-1/, (route) => {
    if (route.request().headers()['x-mar-e2e-workspace-watch-snapshot'] !== '1')
      sessionListRequests += 1;
    return route.fallback();
  });
  const cachedSession = {
    id: 'session-1',
    workspaceId: 'workspace-1',
    runner: 'codex' as const,
    externalSessionId: 'vscode-thread-1',
    activity: 'IDLE' as const,
    control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
  };
  await page.route(/\/api\/agent-sessions\/session-1\/watch(?:\?.*)?$/, (route) => {
    const request = JSON.parse(route.request().postData() ?? '{}') as { mode?: string };
    if (request.mode === 'initial') initialWatchRequests += 1;
    return fulfillMockSessionWatch(
      page,
      route,
      cachedSession,
      sessionWatchSnapshot(cachedSession, '缓存的会话内容')
    );
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.locator('.session-list .session-link').first().click();
  await expect(page.getByText('缓存的会话内容')).toBeVisible();
  await page.locator('.session-list .session-link').first().click();

  await expect.poll(() => initialWatchRequests).toBe(1);
  expect(sessionListRequests).toBe(0);
});

test('Tab switching and manual refresh preserve session caches and reconcile new Workspace Watch snapshots', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  let initialWatchRequests = 0;
  let releaseRefresh: (() => void) | undefined;
  const delayedRefresh = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let manualSessionListRequests = 0;
  await page.route('**/api/workspaces?nodeId=node-1', (route) =>
    json(route, {
      workspaces: [
        { id: 'workspace-1', path: '/project', kind: 'DIRECTORY' },
        { id: 'workspace-2', path: '/another-project', kind: 'DIRECTORY' }
      ]
    })
  );
  await page.route(/\/api\/workspaces\/workspace-[12]\/watch$/, async (route) => {
    const workspaceId =
      route
        .request()
        .url()
        .match(/workspaces\/(workspace-\d+)\/watch$/)?.[1] ?? '';
    const request = JSON.parse(route.request().postData() ?? '{}') as { mode?: string };
    if (request.mode === 'initial') {
      initialWatchRequests += 1;
      if (initialWatchRequests === 3) await delayedRefresh;
    }
    const suffix = workspaceId.slice(-1);
    return fulfillMockWorkspaceWatch(
      page,
      route,
      {
        id: `session-${suffix}`,
        workspaceId,
        runner: 'codex',
        externalSessionId: `thread-${suffix}`,
        customTitle: `会话 ${suffix}`,
        activity: 'IDLE',
        control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
      },
      'DIRECTORY'
    );
  });
  await page.route(/\/api\/agent-sessions\?nodeId=node-1(?:&.*)?$/, (route) => {
    manualSessionListRequests += 1;
    return json(route, {
      sessions: [
        {
          id: 'session-1',
          workspaceId: 'workspace-1',
          runner: 'codex',
          externalSessionId: 'thread-1',
          customTitle: '会话 1',
          activity: 'IDLE',
          control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
        }
      ],
      nextCursor: null
    });
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  const tree = page.locator('.workspace-tree');
  await tree.getByRole('button', { name: 'project', exact: true }).click();
  await expect(page.getByText('会话 1', { exact: true })).toBeVisible();
  await tree.getByRole('button', { name: 'another-project' }).click();
  await expect(page.getByText('会话 2', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: /^project\b/ }).click();
  await expect.poll(() => initialWatchRequests).toBe(3);
  await expect(page.getByText('会话 1', { exact: true })).toBeVisible();
  await expect(page.locator('.session-list .session-link')).toHaveCount(1);
  releaseRefresh?.();
  await expect(page.getByText('会话 1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '刷新当前工作区会话' }).click();
  await expect.poll(() => manualSessionListRequests).toBe(1);
  expect(initialWatchRequests).toBe(3);
  await expect(page.getByText('会话 1', { exact: true })).toBeVisible();
  await expect(page.locator('.session-list .session-link')).toHaveCount(1);
});

test('Each Workspace retains only five session details and evicts the oldest by LRU', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  const sessions = Array.from({ length: 6 }, (_, index) => ({
    id: `session-${index + 1}`,
    workspaceId: 'workspace-1',
    runner: 'codex' as const,
    externalSessionId: `thread-${index + 1}`,
    activity: 'IDLE' as const,
    control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
  }));
  const fallbackSession = sessions[0];
  if (!fallbackSession) {
    throw new Error('LRU session fixture must include at least one session');
  }
  const detailRequests = new Map<string, number>();
  await page.route('**/api/agent-sessions?nodeId=node-1*', (route) => json(route, { sessions }));
  await page.route(/\/api\/agent-sessions\/session-\d+\?nodeId=node-1$/, (route) => {
    const id =
      route
        .request()
        .url()
        .match(/agent-sessions\/(session-\d+)/)?.[1] ?? 'session-1';
    return json(route, {
      session: sessions.find((session) => session.id === id) ?? fallbackSession
    });
  });
  await page.route(/\/api\/agent-sessions\/session-\d+\/runs\?nodeId=node-1$/, (route) =>
    json(route, { runs: [] })
  );
  await page.route(/\/api\/agent-sessions\/session-\d+\/watch(?:\?.*)?$/, (route) => {
    const id =
      route
        .request()
        .url()
        .match(/agent-sessions\/(session-\d+)/)?.[1] ?? 'session-1';
    detailRequests.set(id, (detailRequests.get(id) ?? 0) + 1);
    const session = sessions.find((item) => item.id === id) ?? fallbackSession;
    return fulfillMockSessionWatch(
      page,
      route,
      session,
      sessionWatchSnapshot(session, id, Number(id.slice('session-'.length)))
    );
  });
  await page.route(/\/api\/agent-sessions\/session-\d+\/context\?nodeId=node-1$/, (route) =>
    json(route, { context: null })
  );
  await page.route('**/api/workspaces/workspace-1/queue?nodeId=node-1&sessionId=*', (route) =>
    json(route, { queue: { version: 0, paused: false, items: [] } })
  );
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  const rows = page.locator('.session-list .session-link');
  for (let index = 0; index < 6; index += 1) {
    await rows.nth(index).click();
    await expect.poll(() => detailRequests.get(`session-${index + 1}`)).toBe(1);
    await expect(
      page.getByRole('article').filter({ hasText: `session-${index + 1}` })
    ).toBeVisible();
  }
  for (let index = 0; index < 6; index += 1) {
    await rows.nth(index).click();
    if ([...detailRequests.values()].reduce((total, count) => total + count, 0) > 6) break;
  }
  await expect
    .poll(() => [...detailRequests.values()].reduce((total, count) => total + count, 0))
    .toBeGreaterThan(6);
});

test('Unknown or unavailable Workbench Manifests keep session controls read-only', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await page.route('**/api/nodes/node-1/workbench-capabilities', (route) =>
    json(route, {
      manifest: {
        manifestVersion: 1,
        observedAt: 1_900_000_000_000,
        conversation: { available: false, reasonCode: 'STALE' }
      }
    })
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.locator('.session-list .session-link').first().click();

  await expect(page.getByText('节点 Workbench 能力不可用：STALE。', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '输入消息' })).toHaveAttribute('readonly');
  await expect(page.getByRole('button', { name: '新建会话', exact: true })).toBeDisabled();
  expect(writes).toEqual([]);
});

test('Layout and unsent drafts are persisted only in the current browser session storage', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.locator('.session-list .session-link').first().click();
  await page.getByRole('textbox', { name: '输入消息' }).fill('只在当前标签保留');
  await page.getByRole('button', { name: '收起侧栏' }).click();

  await expect
    .poll(() =>
      page.evaluate(() => ({
        layout: sessionStorage.getItem('mar.workbench.layout.v1'),
        draft: sessionStorage.getItem('mar.workbench.draft.node-1.workspace-1')
      }))
    )
    .toEqual({
      layout: JSON.stringify({
        sidebarCollapsed: true,
        expandedNodeIds: ['node-1'],
        nodeOrder: [],
        workspaceOrderByNode: { 'node-1': ['workspace-1'] }
      }),
      draft: JSON.stringify({ input: '只在当前标签保留', skillTokens: [] })
    });
  expect(writes).toEqual([]);
});
