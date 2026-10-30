import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';
let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

test('Manual session dragging immediately takes over activity reorder motion', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    const animate = Element.prototype.animate;
    let moves = 0;
    Element.prototype.animate = function (keyframes, options) {
      const animation = animate.call(this, keyframes, options);
      if (this.classList.contains('mar-session-reorder-item')) {
        animation.pause();
        document.documentElement.dataset.sessionMoves = String(++moves);
      }
      return animation;
    };
  });
  await page.goto(`${fixture.url}workbench-style.html?session-reorder=1`);
  const list = page.getByRole('region', { name: 'Session fixture' });
  const titles = list.locator('.session-link strong');
  await expect(titles).toHaveText(['pinned-one', 'pinned-two', 'pinned-three', 'active', 'idle']);
  await list.getByRole('button', { name: 'Advance session activity' }).click();
  await expect(titles).toHaveText(['pinned-one', 'pinned-two', 'pinned-three', 'idle', 'active']);
  await expect(page.locator('html')).toHaveAttribute('data-session-moves', '2');
  await list.locator('.session-list').evaluate((element) => {
    element.addEventListener('pointerdown', () => {
      element.setAttribute(
        'data-animations-at-pointerdown',
        String(Array.from(element.children).flatMap((row) => row.getAnimations()).length)
      );
    });
  });
  const source = list.locator('li').filter({ hasText: 'pinned-one' });
  const target = list.locator('li').filter({ hasText: 'pinned-two' });
  await source.dragTo(target, {
    targetPosition: { x: 30, y: (await target.boundingBox())!.height - 3 }
  });
  await expect(list.locator('.session-list')).toHaveAttribute(
    'data-animations-at-pointerdown',
    '0'
  );
  await expect(titles).toHaveText(['pinned-two', 'pinned-one', 'pinned-three', 'idle', 'active']);
  await expect(page.locator('html')).toHaveAttribute('data-session-moves', '2');
  expect(
    await list
      .locator('.session-list')
      .evaluate(
        (element) => Array.from(element.children).flatMap((row) => row.getAnimations()).length
      )
  ).toBe(0);

  await list.getByRole('button', { name: 'Advance session activity' }).click();
  await expect(titles).toHaveText(['pinned-two', 'pinned-one', 'pinned-three', 'active', 'idle']);
  await expect(page.locator('html')).toHaveAttribute('data-session-moves', '4');
});

for (const { sourceId, targetId, after, expected } of [
  { sourceId: 'one', targetId: 'three', after: false, expected: ['two', 'one', 'three'] },
  { sourceId: 'one', targetId: 'three', after: true, expected: ['two', 'three', 'one'] },
  { sourceId: 'three', targetId: 'one', after: false, expected: ['three', 'one', 'two'] },
  { sourceId: 'three', targetId: 'one', after: true, expected: ['one', 'three', 'two'] },
  { sourceId: 'one', targetId: 'two', after: false, expected: ['one', 'two', 'three'] },
  { sourceId: 'two', targetId: 'one', after: true, expected: ['one', 'two', 'three'] }
]) {
  test(`Pinned session drop matches the ${after ? 'bottom' : 'top'} line: ${sourceId} to ${targetId}`, async ({
    page
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${fixture.url}workbench-style.html?session-reorder=1`);
    const list = page.getByRole('region', { name: 'Session fixture' });
    const source = list.locator('li').filter({ hasText: `pinned-${sourceId}` });
    const target = list.locator('li').filter({ hasText: `pinned-${targetId}` });
    const bounds = (await target.boundingBox())!;
    await source.hover();
    await page.mouse.down();
    await page.mouse.move(bounds.x + 30, bounds.y + (after ? bounds.height - 3 : 3), { steps: 5 });
    // Chromium needs a second move to deliver native dragover after dragstart.
    await page.mouse.move(bounds.x + 31, bounds.y + (after ? bounds.height - 3 : 3));
    await expect(target).toHaveClass(/drag-over-pinned/);
    expect(await target.evaluate((row) => row.classList.contains('drag-over-pinned-after'))).toBe(
      after
    );
    await page.mouse.up();
    await expect(list.locator('.session-link strong')).toHaveText([
      ...expected.map((id) => `pinned-${id}`),
      'active',
      'idle'
    ]);
    await expect(list.locator('.drag-over-pinned')).toHaveCount(0);
  });
}

for (const scenario of [
  {
    width: 1280,
    locale: 'en-US',
    copy: 'Copy absolute path',
    relative: 'Copy relative path',
    refresh: 'Refresh files'
  },
  {
    width: 390,
    locale: 'zh-CN',
    copy: '复制绝对路径',
    relative: '复制相对路径',
    refresh: '刷新文件'
  }
]) {
  test(`File tree copies absolute paths for files, folders and the root at ${scenario.width}px`, async ({
    page
  }) => {
    await page.setViewportSize({ width: scenario.width, height: 900 });
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.route('**/api/workspaces/workspace/**', (route) =>
      route.fulfill({
        json: {
          files: {
            entries: [
              { path: 'notes.txt', name: 'notes.txt', kind: 'FILE', size: 24 },
              { path: 'src', name: 'src', kind: 'DIRECTORY', size: null }
            ],
            nextCursor: null
          }
        }
      })
    );
    await page.goto(`${fixture.url}workbench-style.html?file-root=1&locale=${scenario.locale}`);
    const inspector = page.getByRole('region', { name: 'Inspector fixture' });
    const feedback = inspector.getByLabel('File operation feedback');
    await inspector.getByRole('button', { name: scenario.refresh, exact: true }).click();
    const menu = async (path: string) => {
      await expect(page.getByRole('menuitem', { name: scenario.copy, exact: true })).toBeHidden();
      const row = inspector.locator(`[data-file-path="${path}"]`);
      await row.hover();
      await row.locator('..').locator('.file-tree-more').click();
    };
    for (const [path, absolute] of [
      ['.', '/home/example/my-agent-roam'],
      ['src', '/home/example/my-agent-roam/src'],
      ['notes.txt', '/home/example/my-agent-roam/notes.txt']
    ]) {
      await test.step(`Copy ${path}`, async () => {
        await menu(path!);
        await page.getByRole('menuitem', { name: scenario.copy, exact: true }).click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(absolute);
        await expect(feedback).toHaveAttribute('data-type', 'info');
      });
    }
    await menu('notes.txt');
    await page.getByRole('menuitem', { name: scenario.relative, exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('notes.txt');
    await inspector.getByRole('button', { name: 'Switch root path', exact: true }).click();
    await menu('.');
    await page.getByRole('menuitem', { name: scenario.copy, exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('/home/other/my-agent-roam');
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async () => {
            throw new DOMException('Clipboard access denied', 'NotAllowedError');
          }
        }
      });
    });
    await menu('.');
    await page.getByRole('menuitem', { name: scenario.copy, exact: true }).click();
    await expect(feedback).toHaveAttribute('data-type', 'error');
    await inspector.getByRole('button', { name: 'Clear root path', exact: true }).click();
    await menu('notes.txt');
    await expect(page.getByRole('menuitem', { name: scenario.copy, exact: true })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    await expect(
      page.getByRole('menuitem', { name: scenario.relative, exact: true })
    ).not.toHaveAttribute('aria-disabled', 'true');
  });
}

for (const theme of ['daylight', 'vscode-dark-2026']) {
  for (const width of [1280, 390]) {
    test(`List empty and initial loading states are centered in ${theme} at ${width}px`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.route('**/api/terminals**', (route) => route.fulfill({ json: { terminals: [] } }));
      await page.goto(`${fixture.url}workbench-style.html?theme=${theme}&list-state=main`);
      const sessions = page.getByRole('region', { name: 'Session fixture' });
      const state = sessions.getByRole('combobox', { name: 'Set fixture list state' });
      const empty = sessions.locator('.sidebar-empty');
      for (const group of ['main', 'child']) {
        await state.selectOption(group);
        await expect(empty).toBeVisible();
        await expect(empty).toHaveCSS('text-align', 'center');
        await expect(empty).toContainText(group === 'main' ? 'main' : 'child');
      }
      await sessions.getByRole('textbox', { name: 'Set fixture search' }).fill('unmatched');
      await expect(empty).toContainText('No matching');
      await expect(empty).toHaveCSS('text-align', 'center');
      await state.selectOption('loading');
      const loading = sessions.locator('.watch-status:not(.failed)');
      await expect(loading).toBeVisible();
      await expect(loading).toHaveCSS('text-align', 'center');
      await expect(empty).toHaveCount(0);
      await state.selectOption('failed');
      await expect(sessions.locator('.watch-status.failed')).toBeVisible();
      await expect(sessions.locator('.watch-status.failed')).not.toHaveCSS('text-align', 'center');
      await expect(empty).toHaveCount(0);

      const tree = page.getByRole('region', { name: 'Workspace tree fixture' });
      await tree.locator('.workspace-tree-filter input').fill('unmatched');
      await expect(tree.locator('.tree-filter-empty')).toBeVisible();
      await expect(tree.locator('.tree-filter-empty')).toHaveCSS('text-align', 'center');
      await tree.screenshot({ path: testInfo.outputPath('tree-filter-empty.png') });
      await state.selectOption('no-nodes');
      await expect(tree.locator('.tree-empty')).toBeVisible();
      await expect(tree.locator('.tree-empty')).toHaveCSS('text-align', 'center');
      await tree.screenshot({ path: testInfo.outputPath('tree-empty.png') });
      await state.selectOption('unselected');
      await tree.locator('.workspace-tree-filter input').fill('');
      await expect(tree.locator('.tree-foot')).toBeVisible();
      await expect(tree.locator('.tree-foot')).not.toHaveCSS('text-align', 'center');
      await state.selectOption('main');
      await sessions.getByRole('textbox', { name: 'Set fixture search' }).fill('');
      await expect(empty).toBeVisible();
      const alignment = await empty.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const text = range.getBoundingClientRect();
        const panel = element.closest('.conversation-sidebar')!.getBoundingClientRect();
        return Math.abs(text.x + text.width / 2 - (panel.x + panel.width / 2));
      });
      expect(alignment).toBeLessThanOrEqual(1);
      await sessions.screenshot({ path: testInfo.outputPath('session-empty.png') });
    });
  }
}

for (const theme of ['daylight', 'vscode-dark-2026']) {
  test(`Unread labels share typography, color and geometry in ${theme}`, async ({ page }) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${fixture.url}workbench-style.html?theme=${theme}&unread=1`);
      const properties = [
        'color',
        'background-color',
        'border-top-color',
        'border-top-width',
        'border-radius',
        'font-size',
        'font-weight',
        'line-height',
        'padding',
        'height'
      ];
      const reference = page.locator('.session-unread-label').first();
      await expect(reference).toBeVisible();
      const expected = await reference.evaluate(
        (element, properties) =>
          Object.fromEntries(
            properties.map((name) => [name, getComputedStyle(element).getPropertyValue(name)])
          ),
        properties
      );
      for (const selector of ['.workspace-tab-unread', '.session-unread-label']) {
        const badges = page.locator(`${selector}:visible`);
        expect(await badges.count()).toBeGreaterThan(0);
        for (const badge of await badges.all())
          for (const [property, value] of Object.entries(expected))
            await expect(badge).toHaveCSS(property, value);
      }
      const combinedUnread = page.locator('.session-state-unread:visible');
      expect(await combinedUnread.count()).toBeGreaterThan(0);
      for (const badge of await combinedUnread.all())
        for (const property of ['color', 'font-size', 'font-weight'])
          await expect(badge).toHaveCSS(property, expected[property]!);
      await page.goto(`${fixture.url}visual-alignment.html?theme=${theme}`);
      await page.locator('.workbench-notification-center button').first().click();
      const notification = page.locator('.notification-unread-label').first();
      await expect(notification).toBeVisible();
      for (const [property, value] of Object.entries(expected))
        await expect(notification).toHaveCSS(property, value);
    }
  });

  test(`File tree roots use the actual directory instead of the Workspace alias in ${theme}`, async ({
    page
  }) => {
    await page.route('**/api/workspaces/workspace/**', (route) =>
      route.fulfill({ json: { files: { entries: [], nextCursor: null } } })
    );
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${fixture.url}workbench-style.html?theme=${theme}&file-root=1`);
      const inspector = page.getByRole('region', { name: 'Inspector fixture' });
      const root = inspector.locator('[role="treeitem"][data-file-path="."]');
      await expect(root.locator('.tree-name')).toHaveText('my-agent-roam');
      await expect(root).toHaveAccessibleName('/home/example/my-agent-roam');
      if (width >= 768) {
        await root.scrollIntoViewIfNeeded();
        await page.mouse.move(0, 0);
        await root.hover();
        await expect(page.getByRole('tooltip')).toHaveText('/home/example/my-agent-roam');
      }
      await root.click();
      await expect(root).toHaveAttribute('aria-expanded', 'false');
      await root.click();
      await expect(root).toHaveAttribute('aria-expanded', 'true');
      await inspector.getByRole('button', { name: 'Switch root path', exact: true }).click();
      await expect(root.locator('.tree-name')).toHaveText('my-agent-roam');
      await expect(root).toHaveAccessibleName('/home/other/my-agent-roam');
    }
  });

  test(`Git repository headers keep tags subordinate to file content in ${theme}`, async ({
    page
  }, testInfo) => {
    const change = {
      repositoryPath: '',
      repositoryName: 'my-agent-roam',
      source: 'ROOT',
      path: 'src/main.ts',
      state: 'UNSTAGED',
      change: 'MODIFIED',
      diffAvailable: true
    };
    await page.route('**/api/workspaces/workspace/**', (route) =>
      route.fulfill({
        json: new URL(route.request().url()).pathname.endsWith('/changes')
          ? {
              changes: [change],
              repositories: [
                {
                  repositoryPath: '',
                  repositoryName: 'my-agent-roam',
                  physicalPath: '/home/example/project',
                  source: 'ROOT',
                  current: true,
                  branch: 'develop',
                  status: 'DIRTY',
                  tracking: { upstream: 'origin/develop', ahead: 25, behind: 0 },
                  changes: [change]
                },
                {
                  repositoryPath: 'packages/agent',
                  repositoryName: 'agent',
                  source: 'SUBMODULE',
                  current: false,
                  branch: 'develop',
                  status: 'CLEAN',
                  changes: []
                },
                {
                  repositoryPath: '',
                  repositoryName: 'review',
                  worktreePath: '/home/example/project/.worktrees/review',
                  physicalPath: '/home/example/project/.worktrees/review',
                  source: 'WORKTREE',
                  current: false,
                  branch: 'feature/long-branch-name',
                  status: 'UNAVAILABLE',
                  locked: true,
                  changes: []
                }
              ]
            }
          : { files: { entries: [], nextCursor: null } }
      })
    );
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${fixture.url}workbench-style.html?theme=${theme}&git-previews=1`);
      const inspector = page.getByRole('region', { name: 'Inspector fixture' });
      if (width >= 768) {
        await inspector.evaluate((element) => {
          (element as HTMLElement).style.width = '360px';
        });
      }
      await inspector.getByRole('tab', { name: 'Git Changes', exact: true }).click();
      const headings = inspector.locator('.change-repository-heading');
      await expect(headings).toHaveCount(3);
      const root = headings.first();
      const titleRows = headings.locator('.repository-title-row');
      await page.evaluate(() => document.fonts.ready);
      for (const name of await titleRows.locator('strong').all()) {
        const clearance = await name.evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const text = range.getBoundingClientRect();
          const clip = element.getBoundingClientRect();
          return { top: text.top - clip.top, bottom: clip.bottom - text.bottom };
        });
        expect(clearance.top).toBeGreaterThanOrEqual(1);
        expect(clearance.bottom).toBeGreaterThanOrEqual(1);
      }
      const compactSize = await root.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).getPropertyValue('--mar-compact-control-size'))
      );
      for (const row of await titleRows.all()) {
        expect((await row.boundingBox())!.height).toBeCloseTo(compactSize, 1);
      }
      const refresh = root.getByRole('button', { name: 'Refresh Git changes', exact: true });
      const refreshBounds = (await refresh.boundingBox())!;
      expect(refreshBounds.height).toBeCloseTo(compactSize, 1);
      expect(refreshBounds.width).toBeCloseTo(compactSize, 1);
      await expect(root.locator('.repository-title-row strong')).toHaveCSS('font-weight', '500');
      await expect(root.locator('.repository-title-row strong')).toHaveCSS(
        'font-size',
        width >= 768 ? '14px' : '13px'
      );
      for (const tag of await inspector.locator('.repository-tags-row .el-tag').all()) {
        const height = await tag.evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).height)
        );
        expect(height).toBeCloseTo((width >= 768 ? 12 : 11) * 1.65, 1);
        await expect(tag).toHaveCSS('font-weight', '400');
        await expect(tag).toHaveCSS('font-size', width >= 768 ? '12px' : '11px');
      }
      const colors = await root.evaluate((element) => {
        const probe = document.createElement('span');
        element.append(probe);
        probe.style.color = 'var(--mar-border-default)';
        const border = getComputedStyle(probe).color;
        probe.style.color = 'var(--mar-text-secondary)';
        const secondary = getComputedStyle(probe).color;
        probe.remove();
        return { border, secondary };
      });
      await expect(root.locator('.repository-current')).toHaveCSS('color', colors.secondary);
      for (const selector of ['.repository-kind', '.repository-current', '.repository-sync-tag']) {
        await expect(root.locator(selector)).toHaveCSS('border-color', colors.border);
      }
      await expect(root.locator('.repository-sync-tag')).toHaveText('↓ 0 ↑ 25');
      const syncTag = root.locator('.repository-sync-tag');
      await expect(syncTag).not.toHaveAttribute('title');
      const description = await syncTag.getAttribute('aria-label');
      expect(description).toContain('origin/develop');
      expect(description).toContain('25');
      if (width >= 768) {
        await syncTag.scrollIntoViewIfNeeded();
        // Flush the queued scroll event before hover; scrolling intentionally closes hints.
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        );
        await syncTag.hover();
        const hint = page.locator('.mar-tooltip:visible');
        await expect(hint).toHaveText(description!);
        await expect(hint.locator('.el-popper__arrow')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('git-sync-tooltip.png') });
        await page.mouse.move(0, 0);
        await expect(hint).toHaveCount(0);
      }
      await expect(root.locator('.el-tag--warning')).toBeVisible();
      await expect(headings.nth(1).locator('.el-tag--success')).toBeVisible();
      await expect(headings.nth(2).locator('.el-tag--warning')).toBeVisible();
      await expect(inspector.locator('.change-file-name')).toHaveCSS(
        'font-size',
        width >= 768 ? '12px' : '11px'
      );
      const pathToFileGap = await root.evaluate((heading) => {
        const path = heading.querySelector('.repository-physical-path')!.getBoundingClientRect();
        const file = heading
          .nextElementSibling!.querySelector('.change-file-name')!
          .getBoundingClientRect();
        return file.top - path.bottom;
      });
      expect(pathToFileGap).toBeGreaterThanOrEqual(4);
      expect(pathToFileGap).toBeLessThanOrEqual(6);
      expect(
        await headings.nth(1).evaluate((heading) => parseFloat(getComputedStyle(heading).marginTop))
      ).toBeGreaterThan(6);
      for (const heading of await headings.all()) {
        expect(
          await heading.evaluate((element) => element.scrollWidth <= element.clientWidth)
        ).toBe(true);
      }
      await inspector.screenshot({
        path: testInfo.outputPath(`git-headers-${width}.png`),
        animations: 'disabled'
      });
      for (const row of await titleRows.all()) {
        await row.evaluate((element) => {
          (element as HTMLElement).style.fontSize = '2em';
        });
        const rowHeight = (await row.boundingBox())!.height;
        expect(rowHeight).toBeGreaterThan(compactSize);
        expect(rowHeight).toBeGreaterThanOrEqual(
          (await row.locator('strong').boundingBox())!.height
        );
      }
    }
  });

  test(`Content search uses neutral row feedback without losing match emphasis in ${theme}`, async ({
    page
  }, testInfo) => {
    await page.route('**/api/workspaces/workspace/**', (route) =>
      route.fulfill({
        json: route.request().url().includes('/content/search')
          ? {
              search: {
                matches: [
                  { path: 'src/main.ts', line: 2, column: 7, preview: 'const needle = true;' }
                ],
                truncated: false
              }
            }
          : { files: { entries: [], nextCursor: null } }
      })
    );
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${fixture.url}workbench-style.html?theme=${theme}&content-search=1`);
      const inspector = page.getByRole('region', { name: 'Inspector fixture' });
      await inspector
        .locator('.inspector-tabs button')
        .filter({ hasText: /^Search$/ })
        .click();
      const input = inspector.getByRole('textbox', { name: 'Search file contents', exact: true });
      await input.fill('needle');
      await input.press('Enter');
      const result = inspector.locator('.content-search-results button');
      await expect(result).toHaveCount(1);
      await expect(result.locator('mark')).toHaveText('needle');
      const colors = await result.evaluate((element) => {
        const probe = document.createElement('span');
        element.append(probe);
        const color = (token: string) => {
          probe.style.color = `var(${token})`;
          return getComputedStyle(probe).color;
        };
        const resolved = {
          primary: color('--mar-text-primary'),
          hover: color('--mar-fill-row-hover'),
          focus: color('--mar-color-brand'),
          match: getComputedStyle(element.querySelector('mark')!).backgroundColor
        };
        probe.remove();
        return resolved;
      });
      await result.hover();
      await expect(result).toHaveCSS('background-color', colors.hover);
      await expect(result).toHaveCSS('color', colors.primary);
      await expect(result.locator('mark')).toHaveCSS('background-color', colors.match);
      await result.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(result).toBeFocused();
      await expect(result).toHaveCSS('outline-color', colors.focus);
      await expect(result).toHaveCSS('outline-style', 'solid');
      await page.screenshot({ path: testInfo.outputPath(`content-search-${width}.png`) });
    }
  });

  for (const locale of ['en-US', 'zh-CN']) {
    for (const viewportWidth of [1280, 390]) {
      test(`Inspector tabs fit panel widths in ${theme} (${locale}) at ${viewportWidth}px`, async ({
        page
      }, testInfo) => {
        await page.setViewportSize({ width: viewportWidth, height: 900 });
        await page.route('**/api/terminals**', (route) =>
          route.fulfill({ json: { terminals: [] } })
        );
        await page.goto(`${fixture.url}workbench-style.html?theme=${theme}&locale=${locale}`);
        const inspector = page.getByRole('region', { name: 'Inspector fixture' });
        const strip = inspector.getByRole('tablist');
        const tabs = strip.getByRole('tab');
        await expect(tabs).toHaveCount(4);
        await expect(tabs.first()).toHaveCSS('font-size', '12px');
        for (const width of viewportWidth >= 768 ? [341, 275] : [366, 320]) {
          await inspector.evaluate((element, width) => {
            (element as HTMLElement).style.width = `${width}px`;
          }, width);
          expect(
            await strip.evaluate((element) => element.scrollWidth <= element.clientWidth)
          ).toBe(true);
          const bounds = (await strip.boundingBox())!;
          for (const tab of await tabs.all()) {
            const tabBounds = (await tab.boundingBox())!;
            expect(tabBounds.x).toBeGreaterThanOrEqual(bounds.x);
            expect(tabBounds.x + tabBounds.width).toBeLessThanOrEqual(bounds.x + bounds.width);
          }
        }
        await inspector.screenshot({ path: testInfo.outputPath('inspector-tabs.png') });
        await inspector.evaluate((element) => {
          (element as HTMLElement).style.width = '200px';
        });
        await expect(strip).toHaveCSS('overflow-x', 'auto');
        expect(await strip.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
          true
        );
        await tabs.last().scrollIntoViewIfNeeded();
        await tabs.last().click();
        await expect(tabs.last()).toHaveAttribute('aria-selected', 'true');
      });
    }
  }
}

for (const theme of ['daylight', 'vscode-dark-2026']) {
  for (const width of [1280, 390]) {
    test(`Offline Workspace uses a static disconnected icon in ${theme} at ${width}px`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.route('**/api/terminals**', (route) => route.fulfill({ json: { terminals: [] } }));
      await page.goto(`${fixture.url}workbench-style.html?theme=${theme}&offline=1`);
      const offline = page.locator('.workspace-offline-placeholder');
      await expect(offline).toBeVisible();
      await expect(offline).toHaveAttribute('role', 'status');
      const offlineIcon = offline.locator('[data-mar-icon="connection-off"]');
      await expect(offlineIcon).toBeVisible();
      await expect(offlineIcon).toBeInViewport({ ratio: 1 });
      await expect(offline.locator('svg')).toHaveCount(1);
      await expect(offlineIcon).toHaveAttribute('aria-hidden', 'true');
      await expect(offlineIcon).toHaveCSS('animation-name', 'none');
      const geometry = await offlineIcon.evaluate((element) => {
        const bounds = (element as SVGSVGElement).getBBox();
        const viewportBounds = element.getBoundingClientRect();
        const hitTarget = document.elementFromPoint(
          viewportBounds.x + viewportBounds.width / 2,
          viewportBounds.y + viewportBounds.height / 2
        );
        const style = getComputedStyle(element);
        const stroke = parseFloat(style.strokeWidth);
        return {
          color: style.color,
          stroke: style.stroke,
          width: parseFloat(style.width),
          height: parseFloat(style.height),
          rootFontSize: parseFloat(getComputedStyle(document.documentElement).fontSize),
          min: Math.min(bounds.x, bounds.y) - stroke / 2,
          max: Math.max(bounds.x + bounds.width, bounds.y + bounds.height) + stroke / 2,
          unobscured: hitTarget === element || element.contains(hitTarget),
          pseudoContent: getComputedStyle(element, '::after').content
        };
      });
      const expectedSize = geometry.rootFontSize * (width < 768 ? 1.5 : 1.75);
      expect(geometry.width).toBeCloseTo(expectedSize, 1);
      expect(geometry.height).toBeCloseTo(expectedSize, 1);
      expect(geometry.stroke).toBe(geometry.color);
      expect(geometry.min).toBeGreaterThan(0);
      expect(geometry.max).toBeLessThan(24);
      expect(geometry.unobscured).toBe(true);
      expect(['none', 'normal']).toContain(geometry.pseudoContent);
      await offline.screenshot({ path: testInfo.outputPath('offline-connection-icon.png') });
    });

    test(`Session row feedback stays immediate in ${theme} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.route('**/api/terminals**', (route) => route.fulfill({ json: { terminals: [] } }));
      await page.goto(`${fixture.url}workbench-style.html?theme=${theme}`);
      const sessions = page.getByRole('region', { name: 'Session fixture' });
      const selected = sessions.locator('.session-row.selected');
      const idle = sessions.locator('.session-row').filter({ hasText: 'idle' });
      await expect(selected).toHaveCSS('transition-duration', '0s');
      await expect(idle).toHaveCSS('transition-duration', '0s');
      const selectionColor = await selected.evaluate(
        (element) => getComputedStyle(element).backgroundColor
      );
      expect(selectionColor).not.toBe('rgba(0, 0, 0, 0)');
      await selected.hover();
      await expect(selected).toHaveCSS('background-color', selectionColor);
      await page.mouse.move(0, 0);
      await expect(idle).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await idle.hover();
      const hoverColor = await idle.evaluate(
        (element) => getComputedStyle(element).backgroundColor
      );
      expect(hoverColor).not.toBe('rgba(0, 0, 0, 0)');
      expect(hoverColor).not.toBe(selectionColor);
      await page.mouse.move(0, 0);
      const link = idle.locator('.session-link');
      await page.keyboard.press('Tab');
      await link.focus();
      await expect(link).toBeFocused();
      expect(await link.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
      await expect(link).not.toHaveCSS('outline-style', 'none');
      expect(
        await link.evaluate((element) => parseFloat(getComputedStyle(element).outlineWidth))
      ).toBeGreaterThan(0);
      await expect(idle).toHaveCSS('background-color', hoverColor);
      await link.click();
      await expect(idle).toHaveClass(/selected/u);
      await expect(idle).toHaveCSS('background-color', selectionColor);
      await expect(sessions.locator('.session-activity')).toHaveCount(1);
    });
  }
  for (const width of [768, 1280, 1440, 390]) {
    test(`Workbench controls preserve selection, spacing and scrolling in ${theme} at ${width}px`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      let terminalCount = 0;
      await page.route('**/api/terminals**', (route) =>
        route.fulfill({
          json:
            route.request().method() === 'POST'
              ? {
                  terminal: {
                    id: `terminal-${++terminalCount}`,
                    nodeId: 'node',
                    workspaceId: 'workspace',
                    profileId: 'bash',
                    state: 'RUNNING',
                    latestSequence: 0
                  }
                }
              : { terminals: [] }
        })
      );
      await page.goto(
        `${fixture.url}workbench-style.html?theme=${theme}${width === 768 ? '&multipleProfiles=1' : ''}`
      );
      const offline = page.locator('.workspace-offline-placeholder');
      await expect(offline).toBeVisible();
      const message = page.locator('.workspace-offline-message');
      expect((await message.boundingBox())!.width).toBeLessThanOrEqual(380);
      const outer = (await offline.boundingBox())!;
      const inner = (await message.boundingBox())!;
      expect(Math.abs(inner.y + inner.height / 2 - outer.y - outer.height / 2)).toBeLessThan(2);
      const tabs = page.getByRole('region', { name: 'Workspace tab fixture' }).getByRole('tab');
      await tabs.nth(1).click();
      await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
      const activeTab = page
        .getByRole('region', { name: 'Workspace tab fixture' })
        .locator('.workspace-tab.active');
      await expect(activeTab).toHaveCSS('border-radius', '6px');
      await expect(activeTab).toHaveCSS('box-shadow', 'none');
      const selected = await activeTab.evaluate(
        (element) => getComputedStyle(element).backgroundColor
      );
      expect(selected).not.toBe('rgba(0, 0, 0, 0)');
      await page.locator('.workspace-group-toggle').click();
      const plain = page.getByRole('button', { name: 'plain', exact: true });
      const grouped = page.getByRole('button', { name: 'grouped', exact: true });
      const indent = (await grouped.boundingBox())!.x - (await plain.boundingBox())!.x;
      expect(indent).toBeCloseTo(16, 0);
      const sessions = page.locator('.session-list');
      await expect(sessions.locator('.session-activity')).toHaveCount(1);
      await expect(sessions.locator('.session-row.selected')).toHaveCSS('border-radius', '6px');
      await expect(sessions.locator('.session-row.selected')).toHaveCSS('box-shadow', 'none');
      const search = page.locator('.session-search-button');
      await search.click();
      await expect(page.getByLabel('Session action')).toHaveText('refresh');
      await page.getByLabel('Set fixture search').fill('review');
      await search.click();
      await expect(page.getByLabel('Session action')).toHaveText('search:review');
      await expect(search).toHaveAccessibleName(/search/iu);
      const picker = page.getByRole('region', { name: 'Workspace picker fixture' });
      await expect(picker.locator('.workspace-picker-toolbar-actions button')).toHaveCount(3);
      for (const button of await picker.locator('.workspace-picker-toolbar-actions button').all()) {
        const bounds = (await button.boundingBox())!;
        expect(bounds.width).toBeGreaterThanOrEqual(28);
        expect(bounds.height).toBeGreaterThanOrEqual(28);
        await expect(button.locator('svg')).toHaveCount(1);
      }
      const strip = page.locator('.inspector-tabs');
      await expect(strip.getByRole('tab')).toHaveCount(4);
      expect(await strip.evaluate((element) => element.scrollWidth >= element.clientWidth)).toBe(
        true
      );
      expect((await strip.boundingBox())!.height).toBeGreaterThan(24);
      await expect(strip).toHaveCSS('overflow-x', 'auto');
      const terminal = page.getByRole('region', { name: 'Terminal fixture' });
      await terminal.getByRole('button', { name: 'Expand terminal', exact: true }).click();
      await terminal.locator('.terminal-tab-add').click();
      await expect(terminal.getByRole('tab', { name: 'Terminal 1', exact: true })).toHaveAttribute(
        'aria-selected',
        'true'
      );
      await expect(terminal.locator('.terminal-tab.active')).toHaveCSS('border-radius', '6px');
      await expect(terminal.locator('.terminal-tab.active')).toHaveCSS('box-shadow', 'none');
      await expect(terminal.locator('.admin-terminal-body')).toBeVisible();
      if (width >= 768) {
        const chrome = await terminal.evaluate((element) => {
          const bounds = (selector: string) =>
            element.querySelector(selector)!.getBoundingClientRect();
          const header = bounds('.admin-terminal-header');
          const tab = bounds('.terminal-tab.active');
          const title = bounds('h2');
          const actions = bounds('.admin-terminal-actions');
          return {
            height: bounds('.admin-terminal-body').top - header.top,
            tabHeight: tab.height,
            titleCenter: title.y + title.height / 2,
            tabCenter: tab.y + tab.height / 2,
            actionsCenter: actions.y + actions.height / 2,
            titleGap: tab.left - title.right,
            actionsGap: actions.left - bounds('.terminal-tabs').right
          };
        });
        expect(chrome.height).toBeLessThanOrEqual(36);
        expect(chrome.tabHeight).toBeGreaterThanOrEqual(26);
        expect(chrome.tabHeight).toBeLessThanOrEqual(28);
        expect(Math.abs(chrome.titleCenter - chrome.tabCenter)).toBeLessThan(1);
        expect(Math.abs(chrome.actionsCenter - chrome.tabCenter)).toBeLessThan(1);
        expect(chrome.titleGap).toBeGreaterThanOrEqual(6);
        expect(chrome.actionsGap).toBeGreaterThanOrEqual(6);
      }
      const background = await page.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--mar-terminal-background)';
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });
      await expect(terminal.locator('.admin-terminal-body')).toHaveCSS(
        'background-color',
        background
      );
      await expect(terminal.locator('.xterm-host')).toHaveCSS('background-color', background);
      await terminal.screenshot({ path: testInfo.outputPath('terminal.png') });
      await terminal.locator('.terminal-tab-add').click();
      await expect(terminal.getByRole('tab', { name: 'Terminal 2', exact: true })).toHaveAttribute(
        'aria-selected',
        'true'
      );
      const firstTerminal = terminal.getByRole('tab', { name: 'Terminal 1', exact: true });
      await firstTerminal.focus();
      await page.keyboard.press('Enter');
      await expect(firstTerminal).toHaveAttribute('aria-selected', 'true');
      await terminal.getByRole('button', { name: 'Close terminal 2', exact: true }).click();
      await expect(terminal.getByRole('tab')).toHaveCount(1);
      if (width === 768) {
        for (let index = 0; index < 8; index += 1) {
          await terminal.locator('.terminal-tab-add').click();
        }
        const terminalTabs = terminal.locator('.terminal-tabs');
        expect(
          await terminalTabs.evaluate((element) => element.scrollWidth > element.clientWidth)
        ).toBe(true);
        await terminal.getByRole('tab').last().scrollIntoViewIfNeeded();
        const bounds = (await terminalTabs.boundingBox())!;
        const actions = (await terminal.locator('.admin-terminal-actions').boundingBox())!;
        expect(bounds.x + bounds.width).toBeLessThan(actions.x);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true
        );
        await terminal.evaluate((element: HTMLElement) => {
          element.style.width = 'calc(100vw - var(--mar-workbench-sidebar-total-width))';
        });
        const narrowTabs = (await terminalTabs.boundingBox())!;
        expect(narrowTabs.width).toBeGreaterThanOrEqual(120);
        const narrowTerminal = (await terminal.boundingBox())!;
        const narrowActions = (await terminal.locator('.admin-terminal-actions').boundingBox())!;
        expect(narrowActions.x + narrowActions.width).toBeLessThanOrEqual(
          narrowTerminal.x + narrowTerminal.width
        );
        const title = (await terminal.locator('h2').boundingBox())!;
        expect(narrowTabs.y).toBeGreaterThanOrEqual(title.y + title.height);
        expect(
          (await terminal.locator('.admin-terminal-header').boundingBox())!.height
        ).toBeLessThanOrEqual(76);
        await terminal.getByRole('tab').last().scrollIntoViewIfNeeded();
        await terminal.getByRole('tab').last().click();
        await expect(terminal.getByRole('tab').last()).toHaveAttribute('aria-selected', 'true');
        await terminal.locator('.terminal-tab.active .terminal-tab-close').click();
        await expect(terminal.getByRole('tab')).toHaveCount(8);
        await terminal.locator('.terminal-tab-add').click();
        await expect(terminal.getByRole('tab')).toHaveCount(9);
        await terminal.screenshot({ path: testInfo.outputPath('terminal-narrow.png') });
      }
      await terminal.getByRole('button', { name: 'Collapse terminal', exact: true }).click();
      await expect(terminal.getByRole('tab').first()).toBeHidden();
    });
  }
}

for (const theme of ['daylight', 'vscode-dark-2026']) {
  test(`Files Watch and refresh share one visible loading feedback in ${theme}`, async ({
    page
  }) => {
    let reads = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/workspaces/workspace/**', async (route) => {
      if (new URL(route.request().url()).pathname.endsWith('/files') && ++reads === 1) await gate;
      await route.fulfill({ json: { files: { entries: [], nextCursor: null } } });
    });
    await page.goto(`${fixture.url}workbench-style.html?theme=${theme}&overlapping-watch=1`);
    const inspector = page.getByRole('region', { name: 'Inspector fixture' });
    await expect(inspector.locator('.watch-status')).toContainText('Loading…');
    await inspector.getByRole('button', { name: 'Refresh files', exact: true }).click();
    await expect.poll(() => reads).toBe(1);
    await expect(inspector.locator('.watch-status')).toHaveCount(1);
    await expect(inspector.locator('.watch-status [data-mar-icon="loading-action"]')).toHaveCount(
      1
    );
    await expect(
      inspector
        .getByRole('button', { name: 'Refresh files', exact: true })
        .locator('[data-mar-icon="loading-action"]')
    ).toHaveCount(0);
    release?.();
    await expect(inspector.locator('.watch-status')).toHaveCount(1);
  });

  test(`Files retry uses a muted busy state and retains focus in ${theme}`, async ({ page }) => {
    let reads = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/workspaces/workspace/**', async (route) => {
      if (new URL(route.request().url()).pathname.endsWith('/files')) {
        if (++reads === 1)
          return route.fulfill({
            status: 503,
            json: { error: { code: 'NODE_OFFLINE', message: 'Offline' } }
          });
        await gate;
      }
      await route.fulfill({ json: { files: { entries: [], nextCursor: null } } });
    });
    await page.goto(`${fixture.url}workbench-style.html?theme=${theme}&file-root=1`);
    const inspector = page.getByRole('region', { name: 'Inspector fixture' });
    await inspector.getByRole('button', { name: 'Refresh files', exact: true }).click();
    const retry = inspector.locator('button.watch-status');
    await expect(retry).toHaveClass(/failed/);
    await retry.focus();
    await retry.press('Enter');
    await expect(retry).toBeFocused();
    await expect(retry).toHaveAttribute('aria-busy', 'true');
    await expect(retry).not.toHaveClass(/failed/);
    const colors = await retry.evaluate((element) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--mar-text-muted)';
      element.append(probe);
      const value = [getComputedStyle(element).color, getComputedStyle(probe).color];
      probe.remove();
      return value;
    });
    expect(colors[0]).toBe(colors[1]);
    release?.();
    await expect(retry).toHaveCount(0);
  });

  test(`Git History auto-append and in-place failures in ${theme}`, async ({ page }) => {
    let historyReads = 0;
    let fileReads = 0;
    let releaseHistory: (() => void) | undefined;
    let releaseFiles: (() => void) | undefined;
    const historyGate = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    const filesGate = new Promise<void>((resolve) => {
      releaseFiles = resolve;
    });
    const commit = (hash: string) => ({
      hash,
      parents: [],
      subject: `subject ${hash}`,
      authorName: 'Author',
      authorEmail: 'a@example.test',
      committedAt: 1,
      refs: []
    });
    await page.route('**/api/workspaces/workspace/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/git/history')) {
        historyReads += 1;
        if (historyReads === 1 || historyReads === 3)
          await route.fulfill({
            status: 503,
            json: { error: { code: 'NODE_OFFLINE', message: 'Offline' } }
          });
        else {
          if (historyReads === 2) await historyGate;
          await route.fulfill({
            json: {
              commits: [commit(historyReads === 2 ? 'first' : 'second')],
              nextCursor: historyReads === 2 ? 'cursor' : null
            }
          });
        }
      } else if (path.includes('/git/commits/') && path.endsWith('/files')) {
        if (++fileReads === 1)
          await route.fulfill({
            status: 503,
            json: { error: { code: 'NODE_OFFLINE', message: 'Offline' } }
          });
        else {
          await filesGate;
          await route.fulfill({ json: { files: [{ path: 'src/main.ts', change: 'MODIFIED' }] } });
        }
      } else if (path.endsWith('/git/refs')) await route.fulfill({ json: { refs: [] } });
      else if (path.endsWith('/git/fetch')) await route.fulfill({ json: { fetchFailed: false } });
      else if (path.endsWith('/changes')) await route.fulfill({ json: { changes: [] } });
      else await route.fulfill({ json: { files: { entries: [], nextCursor: null } } });
    });
    await page.goto(`${fixture.url}workbench-style.html?theme=${theme}&git-previews=1`);
    const inspector = page.getByRole('region', { name: 'Inspector fixture' });
    await inspector.evaluate((element) => {
      (element as HTMLElement).style.height = '360px';
    });
    await inspector.getByRole('tab', { name: 'Git History', exact: true }).click();
    let retry = inspector.locator('button.history-load-more');
    await expect(retry).toHaveAttribute('aria-description', /NODE_OFFLINE/);
    await retry.click();
    await expect(retry).toBeFocused();
    await expect(retry).toHaveAttribute('aria-busy', 'true');
    releaseHistory?.();
    await expect(inspector.locator('.history-list')).toContainText('subject first');
    await expect(retry).toBeVisible();
    await page.waitForTimeout(150);
    expect(historyReads).toBe(3);
    await retry.click();
    await expect(inspector.locator('.history-list')).toContainText('subject second');
    expect(historyReads).toBe(4);
    await inspector.locator('.history-commit').filter({ hasText: 'subject first' }).click();
    retry = inspector.locator('.history-files button');
    await expect(retry).toHaveAttribute('aria-description', /NODE_OFFLINE/);
    await retry.click();
    await expect(retry).toBeFocused();
    await expect(retry).toHaveAttribute('aria-busy', 'true');
    releaseFiles?.();
    await expect(inspector.locator('.history-files')).toContainText('src');
    await expect(inspector.getByLabel('File operation feedback')).toHaveText('');
    expect(fileReads).toBe(2);
    await inspector
      .locator('.inspector-tabs button')
      .filter({ hasText: /^Search$/ })
      .click();
    await page.waitForTimeout(150);
    expect(historyReads).toBe(4);
    expect(fileReads).toBe(2);
  });

  test(`History refresh failure does not mislabel pending commit files in ${theme}`, async ({
    page
  }) => {
    let historyReads = 0;
    let filesStarted = false;
    let releaseFiles: (() => void) | undefined;
    const filesGate = new Promise<void>((resolve) => {
      releaseFiles = resolve;
    });
    await page.route('**/api/workspaces/workspace/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/git/history')) {
        if (++historyReads === 1)
          await route.fulfill({
            json: {
              commits: [
                {
                  hash: 'old',
                  parents: [],
                  subject: 'old subject',
                  authorName: 'Author',
                  authorEmail: 'a@example.test',
                  committedAt: 1,
                  refs: []
                }
              ],
              nextCursor: null
            }
          });
        else
          await route.fulfill({
            status: 503,
            json: { error: { code: 'NODE_OFFLINE', message: 'Offline' } }
          });
      } else if (path.includes('/git/commits/') && path.endsWith('/files')) {
        filesStarted = true;
        await filesGate;
        await route.fulfill({
          json: { files: [{ path: 'still-readable.txt', change: 'MODIFIED' }] }
        });
      } else if (path.endsWith('/git/refs')) await route.fulfill({ json: { refs: [] } });
      else if (path.endsWith('/git/fetch')) await route.fulfill({ json: { fetchFailed: false } });
      else if (path.endsWith('/changes')) await route.fulfill({ json: { changes: [] } });
      else await route.fulfill({ json: { files: { entries: [], nextCursor: null } } });
    });
    await page.goto(`${fixture.url}workbench-style.html?theme=${theme}&git-previews=1`);
    const inspector = page.getByRole('region', { name: 'Inspector fixture' });
    await inspector.getByRole('tab', { name: 'Git History', exact: true }).click();
    await inspector.locator('.history-commit-row').filter({ hasText: 'old subject' }).click();
    await expect.poll(() => filesStarted).toBe(true);
    const files = inspector.locator('.history-files');
    await expect(files.getByRole('status')).toContainText('Loading…');
    await inspector.getByRole('button', { name: 'Refresh Git history', exact: true }).click();
    await expect(inspector.locator('.history-load-more')).toContainText('Failed to load. Retry');
    await expect(files.getByRole('button', { name: 'Failed to load. Retry' })).toHaveCount(0);
    await expect(files.getByRole('status')).toContainText('Loading…');
    releaseFiles?.();
    await expect(files).toContainText('still-readable.txt');
    await expect(files.getByRole('button', { name: 'Failed to load. Retry' })).toHaveCount(0);
  });

  test(`Content search failures retry without duplicate notices in ${theme}`, async ({ page }) => {
    let searches = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/workspaces/workspace/**', async (route) => {
      if (!route.request().url().includes('/content/search')) {
        await route.fulfill({ json: { files: { entries: [], nextCursor: null } } });
      } else if (++searches === 2) {
        await route.fulfill({
          status: 503,
          json: {
            error: { code: 'NODE_OFFLINE', message: 'Node unavailable', requestId: 'test-request' }
          }
        });
      } else {
        if (searches === 3) await gate;
        await route.fulfill({
          json: {
            search: {
              matches: [
                { path: 'src/main.ts', line: 2, column: 7, preview: 'const needle = true;' }
              ],
              truncated: false
            }
          }
        });
      }
    });
    await page.goto(`${fixture.url}workbench-style.html?theme=${theme}&content-search=1`);
    const inspector = page.getByRole('region', { name: 'Inspector fixture' });
    await inspector
      .locator('.inspector-tabs button')
      .filter({ hasText: /^Search$/ })
      .click();
    const input = inspector.getByRole('textbox', { name: 'Search file contents', exact: true });
    await input.fill('needle');
    await input.press('Enter');
    await expect(inspector.locator('.content-search-results button')).toHaveCount(1);
    await input.press('Enter');
    const retry = inspector.locator('button.watch-status');
    await expect(retry).toBeVisible();
    await expect(retry).toHaveAttribute('aria-description', /NODE_OFFLINE/);
    await expect(inspector.locator('.content-search-results button')).toHaveCount(1);
    await expect(inspector.getByLabel('File operation feedback')).toHaveText('');
    await retry.click();
    await expect(retry).toBeFocused();
    await expect(retry).toHaveAttribute('aria-busy', 'true');
    await expect(retry).not.toHaveClass(/failed/);
    release?.();
    await expect(retry).toHaveCount(0);
    await expect(inspector.locator('.content-search-results button')).toHaveCount(1);
    expect(searches).toBe(3);
  });
}
