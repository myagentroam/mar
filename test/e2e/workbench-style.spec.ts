import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';
let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

for (const theme of ['daylight', 'vscode-dark-2026']) {
  test(`Git repository headers keep tags subordinate to file content in ${theme}`, async ({
    page
  }, testInfo) => {
    const change = {
      repositoryPath: '',
      repositoryName: 'project',
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
                  repositoryName: 'project',
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
      await expect(root.locator('.repository-title-row strong')).toHaveCSS('font-weight', '500');
      await expect(root.locator('.repository-title-row strong')).toHaveCSS(
        'font-size',
        width >= 768 ? '14px' : '13px'
      );
      for (const tag of await inspector.locator('.repository-tags-row .el-tag').all()) {
        await expect(tag).toHaveCSS('height', '20px');
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
      await expect(root.locator('.el-tag--warning')).toBeVisible();
      await expect(headings.nth(1).locator('.el-tag--success')).toBeVisible();
      await expect(headings.nth(2).locator('.el-tag--warning')).toBeVisible();
      await expect(inspector.locator('.change-file-name')).toHaveCSS(
        'font-size',
        width >= 768 ? '12px' : '11px'
      );
      for (const heading of await headings.all()) {
        expect(
          await heading.evaluate((element) => element.scrollWidth <= element.clientWidth)
        ).toBe(true);
      }
      await inspector.screenshot({
        path: testInfo.outputPath(`git-headers-${width}.png`),
        animations: 'disabled'
      });
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
