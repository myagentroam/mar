import { expect, test, type Locator } from '@playwright/test';
import { resolvedColorToHex } from '../../packages/web-core/src/util/theme-palette.js';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

// @test-covers packages/web-core/src/view/workbench/WorkbenchNavigation.vue
// @test-covers packages/web-core/src/view/workbench/WorkbenchActivityCenter.vue
// @test-covers packages/web-core/src/view/workspace/WorkspaceTabs.vue

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

for (const theme of ['dark', 'daylight']) {
  for (const width of [1280, 390]) {
    test(`Main navigation keeps the current page highlighted on hover: ${theme}, ${width}px`, async ({
      page
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(`${fixture.url}workbench-mobile-drawer.html?locale=en-US&theme=${theme}`);

      const rail = page.locator('.activity-rail');
      const work = rail.getByRole('button', { name: 'Work', exact: true });
      const chat = rail.getByRole('button', { name: 'Chat', exact: true });
      const colors = (button: Locator) =>
        button.evaluate((element) => {
          const { backgroundColor, color } = getComputedStyle(element);
          return { backgroundColor, color };
        });

      await page.mouse.move(width - 10, 790);
      await expect(work).toHaveAttribute('aria-current', 'page');
      const selected = await colors(work);
      const inactive = await colors(chat);
      const palette = await rail.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          primary: style.getPropertyValue('--mar-text-primary').trim(),
          focus: style.getPropertyValue('--mar-text-muted').trim(),
          selection: style.getPropertyValue('--mar-fill-selection').trim()
        };
      });
      expect(resolvedColorToHex(selected.color)).toBe(palette.primary);
      expect(resolvedColorToHex(selected.backgroundColor)).toBe(palette.selection);
      expect(selected.color).not.toBe(inactive.color);
      await expect(work).toHaveCSS('outline-style', 'none');

      await work.hover();
      expect(await colors(work)).toEqual(selected);

      await chat.hover();
      const hovered = await colors(chat);
      expect(hovered.backgroundColor).not.toBe(inactive.backgroundColor);
      expect(hovered.backgroundColor).not.toBe(selected.backgroundColor);
      expect(await colors(work)).toEqual(selected);

      await work.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      await expect(work).toBeFocused();
      await expect(work).toHaveCSS('outline-style', 'solid');
      const focus = await work.evaluate((element) => getComputedStyle(element).outlineColor);
      expect(resolvedColorToHex(focus)).toBe(palette.focus);
      expect(await colors(work)).toEqual(selected);
    });
  }

  test(`Workspace overflow keeps the current item distinct from focus and hover: ${theme}`, async ({
    page
  }) => {
    await page.setViewportSize({ width: 1280, height: 844 });
    await page.goto(
      `${fixture.url}workspace-tabs.html?locale=en-US&layout=boundary&theme=${theme}`
    );
    const trigger = page.getByRole('button', { name: 'All open workspaces', exact: true });
    await trigger.press('ArrowDown');
    const menu = page.getByRole('menu');
    const current = menu.getByRole('menuitem', { name: /^Workspace one\b/u });
    const next = menu.getByRole('menuitem', { name: /^Workspace two\b/u });
    const palette = await menu.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        selection: style.getPropertyValue('--mar-fill-selection').trim(),
        hover: style.getPropertyValue('--mar-fill-row-hover').trim(),
        surface: style.backgroundColor,
        text: style.getPropertyValue('--mar-text-primary').trim(),
        focus: style.getPropertyValue('--mar-text-muted').trim()
      };
    });
    const background = (item: Locator) =>
      item.evaluate((element) => getComputedStyle(element).backgroundColor);

    await expect(current).toBeFocused();
    expect(resolvedColorToHex(await background(current))).toBe(palette.selection);
    await expect(current).toHaveAttribute('aria-current', 'true');
    await expect(current).toHaveCSS('outline-style', 'solid');
    const style = await current.evaluate((element) => {
      const { color, outlineColor } = getComputedStyle(element);
      return { color, outlineColor };
    });
    expect(resolvedColorToHex(style.color)).toBe(palette.text);
    expect(resolvedColorToHex(style.outlineColor)).toBe(palette.focus);
    await current.hover();
    expect(resolvedColorToHex(await background(current))).toBe(palette.selection);
    await next.hover();
    expect(resolvedColorToHex(await background(next))).toBe(palette.hover);
    expect(palette.hover).not.toBe(resolvedColorToHex(palette.surface));
    expect(resolvedColorToHex(await background(current))).toBe(palette.selection);

    await next.click();
    await expect(menu).toBeHidden();
    await expect(page.getByRole('tab', { name: 'Workspace two', exact: true })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await trigger.press('ArrowDown');
    await expect(next).toHaveAttribute('aria-current', 'true');
    await expect(current).not.toHaveAttribute('aria-current', 'true');
  });

  test(`Expanded diagnostics match the recent sessions rail highlight: ${theme}`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${fixture.url}workbench-mobile-drawer.html?locale=en-US&theme=${theme}`);

    const rail = page.locator('.activity-rail');
    const recent = rail.locator('.activity-center-trigger');
    const diagnostics = rail.getByRole('button', { name: 'Web performance diagnostics' });
    const panel = page.getByRole('region', { name: 'Web performance diagnostics' });
    const highlight = (button: Locator) =>
      button.evaluate((element) => {
        const { backgroundColor, borderRadius, color } = getComputedStyle(element);
        const { x, width, height } = element.getBoundingClientRect();
        return { backgroundColor, borderRadius, color, x, width, height };
      });

    await recent.click();
    await expect(recent).toHaveAttribute('aria-expanded', 'true');
    const expanded = await highlight(recent);
    await recent.click();
    await expect(recent).toHaveAttribute('aria-expanded', 'false');

    const collapsed = await highlight(diagnostics);
    await diagnostics.click();
    await expect(panel).toBeVisible();
    expect(await highlight(diagnostics)).toEqual(expanded);
    await page.mouse.move(1200, 760);
    expect(await highlight(diagnostics)).toEqual(expanded);
    await expect(diagnostics).toHaveCSS('outline-style', 'none');
    await page.screenshot({ path: testInfo.outputPath('diagnostics-rail-expanded.png') });

    await page.mouse.click(1200, 760);
    await expect(diagnostics).toHaveAttribute('aria-expanded', 'false');
    expect(await highlight(diagnostics)).toEqual(collapsed);

    await diagnostics.press('Enter');
    await expect(panel).toBeVisible();
    expect(await highlight(diagnostics)).toEqual(expanded);
    await expect(diagnostics).toHaveCSS('outline-style', 'solid');
    await expect(diagnostics).toHaveCSS('outline-offset', '-2px');
    await diagnostics.press('Escape');
    await expect(panel).toBeHidden();
    await expect(diagnostics).toBeFocused();
    expect(await highlight(diagnostics)).toEqual(collapsed);
  });
}

async function sidebarGeometry(sidebar: Locator) {
  return sidebar.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      left: rect.left,
      top: rect.top,
      bottom: innerHeight - rect.bottom,
      width: rect.width,
      radius: style.borderTopLeftRadius,
      background: style.backgroundColor,
      border: style.borderRightColor
    };
  });
}

test('The diagnostics footer leaves the settings button reachable in a short desktop rail', async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 230 });
  await page.goto(`${fixture.url}workbench-mobile-drawer.html?locale=en-US`);
  const rail = page.locator('.activity-rail');
  const settings = rail.getByRole('button', { name: 'Settings', exact: true });
  const diagnostics = rail.getByRole('button', { name: 'Web performance diagnostics' });
  const nav = rail.getByRole('navigation');
  await expect(diagnostics).toBeInViewport({ ratio: 1 });
  const footer = (await diagnostics.boundingBox())!;
  const railBox = (await rail.boundingBox())!;
  expect(footer.x).toBeGreaterThanOrEqual(railBox.x);
  expect(footer.y).toBeGreaterThan(railBox.y + railBox.height / 2);
  await settings.scrollIntoViewIfNeeded();
  const settingsBox = (await settings.boundingBox())!;
  const navBox = (await nav.boundingBox())!;
  // Scroll offsets can be rounded to whole pixels while the flex gap is fractional.
  expect(settingsBox.y + settingsBox.height).toBeLessThanOrEqual(navBox.y + navBox.height + 1);
  expect(navBox.y + navBox.height).toBeLessThan(footer.y);
  expect(await diagnostics.boundingBox()).toEqual(footer);

  const panel = page.getByRole('region', { name: 'Web performance diagnostics' });
  await diagnostics.click();
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Realtime connection');
  await expect(panel).toContainText('Message throughput');
  await expect(panel).toContainText('Active Run sessions');
  await expect(panel).toContainText('JS heap');
  await expect(panel.getByRole('button', { name: 'Copy detailed diagnostics' })).toBeVisible();
  await settings.click();
  await expect(panel).toBeHidden();
  await expect(settings).toHaveAttribute('aria-current', 'page');
});

for (const layout of ['desktop', 'mobile']) {
  test(`Workbench sidebars retain independent scroll positions on ${layout}`, async ({ page }) => {
    const mobile = layout === 'mobile';
    await page.setViewportSize({ width: mobile ? 390 : 1280, height: 300 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(
      `${fixture.url}workbench-mobile-drawer.html?tree-reveal&sidebar-scroll&locale=en-US`
    );

    const rail = page.locator('.activity-rail');
    const work = rail.getByRole('button', { name: 'Work', exact: true });
    const settings = rail.getByRole('button', { name: 'Settings', exact: true });
    const sidebar = page.locator('.workspace-tree');
    const scrollTop = () => sidebar.evaluate((element) => element.scrollTop);
    const scrollToBottom = () =>
      sidebar.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        return element.scrollTop;
      });

    const plainTab = page.getByRole('tab', { name: 'Plain', exact: true });
    const plainWorkspace = sidebar.getByRole('button', { name: '/plain', exact: true });
    await plainTab.click();
    if (mobile) await work.click();
    await expect(plainWorkspace).toBeInViewport();
    await expect(sidebar.getByRole('button', { name: '/folder-34', exact: true })).toBeVisible();
    const workOffset = await scrollToBottom();
    expect(workOffset).toBeGreaterThan(0);

    await settings.click();
    const settingsMenu = sidebar.getByRole('navigation', { name: 'Settings menu' });
    await expect(settingsMenu).toBeVisible();
    await expect.poll(scrollTop).toBe(0);
    await settingsMenu.getByRole('button', { name: 'About', exact: true }).scrollIntoViewIfNeeded();
    await expect.poll(scrollTop).toBeGreaterThan(0);
    const settingsOffset = await scrollTop();
    expect(settingsOffset).not.toBe(workOffset);

    await work.click();
    await expect.poll(scrollTop).toBe(workOffset);
    if (!mobile) {
      await expect(plainWorkspace).not.toBeInViewport();
      await plainTab.click();
      await expect(plainWorkspace).toBeInViewport();
    }
    await settings.click();
    await expect.poll(scrollTop).toBe(settingsOffset);

    if (mobile) await settings.click();
    else await rail.getByRole('button', { name: 'Chat', exact: true }).click();
    await expect(sidebar).toBeHidden();
    await settings.click();
    await expect(sidebar).toBeVisible();
    await expect.poll(scrollTop).toBe(settingsOffset);

    if (!mobile) {
      const toggle = page.getByRole('button', { name: 'Toggle resource sidebar' });
      await toggle.click();
      await expect(sidebar).toBeHidden();
      await toggle.click();
      await expect(sidebar).toBeVisible();
      await expect.poll(scrollTop).toBe(settingsOffset);
    }
  });
}

for (const theme of ['daylight', 'dark']) {
  test(`Desktop diagnostics shares the rail button geometry and hover in ${theme}`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${fixture.url}workbench-mobile-drawer.html?theme=${theme}&locale=en-US`);
    const rail = page.locator('.activity-rail');
    const railButton = (name: string) =>
      rail.locator('button').filter({ has: page.locator(`svg[data-mar-icon="${name}"]`) });
    const management = railButton('administration');
    const settings = railButton('settings');
    const diagnostics = railButton('info');
    await expect(diagnostics).toBeVisible();

    const geometry = (button: Locator) =>
      button.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const icon = element.querySelector('svg')!.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          x: bounds.x,
          width: bounds.width,
          height: bounds.height,
          padding: style.padding,
          radius: style.borderRadius,
          transition: style.transition,
          iconWidth: icon.width,
          iconHeight: icon.height,
          iconCenterX: icon.x + icon.width / 2 - bounds.x,
          iconCenterY: icon.y + icon.height / 2 - bounds.y
        };
      });
    const settingsGeometry = await geometry(settings);
    expect(await geometry(diagnostics)).toEqual(settingsGeometry);
    expect(await geometry(management)).toEqual(settingsGeometry);
    const settingsBox = (await settings.boundingBox())!;
    const managementBox = (await management.boundingBox())!;
    const diagnosticsBox = (await diagnostics.boundingBox())!;
    expect(diagnosticsBox.y - settingsBox.y).toBeCloseTo(settingsBox.y - managementBox.y, 1);

    const hover = await rail.evaluate((element) => {
      const probe = document.createElement('span');
      probe.style.cssText =
        'position: absolute; background: var(--mar-fill-row-hover); color: var(--mar-text-primary)';
      element.append(probe);
      const style = getComputedStyle(probe);
      const colors = { background: style.backgroundColor, color: style.color };
      probe.remove();
      return colors;
    });
    await settings.hover();
    await expect(settings).toHaveCSS('background-color', hover.background);
    await expect(settings).toHaveCSS('color', hover.color);
    await diagnostics.hover();
    await expect(diagnostics).toHaveCSS('background-color', hover.background);
    await expect(diagnostics).toHaveCSS('color', hover.color);
    await diagnostics.click();
    await expect(page.locator('.web-performance-panel')).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`diagnostics-rail-${theme}.png`),
      animations: 'disabled',
      clip: { x: 0, y: 300, width: 410, height: 600 }
    });

    await page.mouse.move(700, 20);
    await page.keyboard.press('Tab');
    await settings.focus();
    await expect(settings).toHaveCSS('outline-style', 'solid');
    const focusOffset = await settings.evaluate(
      (element) => getComputedStyle(element).outlineOffset
    );
    await diagnostics.focus();
    await expect(diagnostics).toHaveCSS('outline-style', 'solid');
    await expect(diagnostics).toHaveCSS('outline-offset', focusOffset);
  });

  test(`Hosted history shares the desktop resource sidebar shell in ${theme}`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(
      `${fixture.url}workbench-mobile-drawer.html?tree-reveal&theme=${theme}&locale=en-US`
    );
    const tree = page.locator('.workspace-tree');
    await expect(tree).toBeVisible();
    await tree
      .locator('.tree-node-row')
      .filter({ has: page.getByRole('button', { name: 'node', exact: true }) })
      .getByRole('button', { name: 'Expand workspaces' })
      .click();
    await page.mouse.move(700, 20);
    const selectedWorkspace = tree.getByRole('button', { name: '/plain', exact: true });
    const otherWorkspace = tree.getByRole('button', { name: '/folder-0', exact: true });
    await expect(selectedWorkspace).toBeVisible();
    await expect(otherWorkspace).toBeVisible();
    const selectedWorkspaceColor = await selectedWorkspace.evaluate(
      (row) => getComputedStyle(row).color
    );
    const otherWorkspaceColor = await otherWorkspace.evaluate((row) => getComputedStyle(row).color);
    expect(selectedWorkspaceColor).not.toBe(otherWorkspaceColor);
    const selectedRow = selectedWorkspace.locator('..');
    await expect(selectedRow).toHaveClass(/\bselected\b/);
    const background = await selectedRow.evaluate((row) => getComputedStyle(row).backgroundColor);
    await expect(otherWorkspace.locator('..')).not.toHaveCSS('background-color', background);
    const geometry = await sidebarGeometry(tree);
    expect(geometry.top).toBeGreaterThan(0);
    expect(geometry.bottom).toBeCloseTo(geometry.top, 1);
    expect(parseFloat(geometry.radius)).toBeGreaterThan(0);
    const rail = (await page.locator('.activity-rail').boundingBox())!;
    const buttons = page.locator('.activity-rail nav > button');
    for (const button of await buttons.all()) {
      const bounds = (await button.boundingBox())!;
      expect(bounds.width).toBeCloseTo(bounds.height, 1);
      expect(bounds.x - rail.x).toBeCloseTo(rail.x + rail.width - bounds.x - bounds.width, 1);
      expect(bounds.x).toBeGreaterThan(rail.x);
    }
    const diagnosticsIcon = page.locator('.web-performance-indicator svg[data-mar-icon="info"]');
    const settingsIcon = buttons.locator('svg[data-mar-icon="settings"]');
    await expect(settingsIcon).toBeVisible();
    await expect(diagnosticsIcon).toBeVisible();
    const settingsBounds = (await settingsIcon.boundingBox())!;
    const diagnosticsBounds = (await diagnosticsIcon.boundingBox())!;
    expect(diagnosticsBounds.width).toBeCloseTo(settingsBounds.width, 1);
    expect(diagnosticsBounds.height).toBeCloseTo(settingsBounds.height, 1);
    await page.screenshot({
      path: testInfo.outputPath(`resource-sidebar-${theme}.png`),
      clip: { x: 0, y: 0, width: Math.ceil(geometry.left + geometry.width), height: 900 }
    });
    const logo = page.getByTestId('workbench-brand').getByRole('img');
    await expect(logo).toBeVisible();
    const logoBounds = (await logo.boundingBox())!;
    expect(logoBounds.x + logoBounds.width / 2).toBeCloseTo(rail.x + rail.width / 2, 1);
    const toggle = page.getByRole('button', { name: 'Toggle resource sidebar', exact: true });
    await toggle.click();
    await expect(tree).toBeHidden();
    expect(await logo.boundingBox()).toEqual(logoBounds);
    await toggle.click();
    await expect(tree).toBeVisible();
    await expect.poll(() => sidebarGeometry(tree)).toEqual(geometry);
    expect(await logo.boundingBox()).toEqual(logoBounds);

    const timestamp = Date.UTC(2026, 10, 18, 9);
    const template = {
      id: 'template-1',
      nodeId: 'node-1',
      name: 'Assistant',
      description: '',
      status: 'ACTIVE',
      currentVersionId: 'version-1',
      available: true,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const chats = ['Current chat', 'Another chat'].map((title, index) => ({
      id: `chat-${index}`,
      nodeId: template.nodeId,
      sessionId: `session-${index}`,
      templateId: template.id,
      templateName: template.name,
      activeVersionId: template.currentVersionId,
      title,
      titleSource: 'AUTO',
      pinnedAt: timestamp - index,
      status: 'ACTIVE',
      modelId: 'model-1',
      createdAt: timestamp,
      updatedAt: timestamp - index,
      lastActivityAt: timestamp - index
    }));
    await page.route('**/api/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/hosted-conversations')
        return route.fulfill({ json: { items: chats, nextCursor: null } });
      if (path === '/api/conversation-templates')
        return route.fulfill({ json: { templates: [template] } });
      if (path.endsWith('/model-options'))
        return route.fulfill({ json: { models: [], defaultModelId: null } });
      if (path === '/api/hosted-template-fixture/current')
        return route.fulfill({
          json: {
            nodeAppVersion: '0.13.47',
            conversation: {
              ...chats[0],
              activity: { status: 'IDLE', version: 0, updatedAt: timestamp }
            },
            template,
            turns: [],
            historyNextCursor: null,
            files: [
              {
                id: 'file-1',
                conversationId: chats[0]!.id,
                category: 'OUTPUT',
                relativePath: 'assets/reports/summary.txt',
                displayName: 'summary.txt',
                mimeType: 'text/plain',
                size: 10,
                source: 'AGENT',
                createdAt: timestamp,
                updatedAt: timestamp
              }
            ],
            models: [],
            run: null,
            error: null,
            snapshotSequence: 1
          }
        });
      if (path.endsWith('/watch') && route.request().method() === 'POST')
        return route.fulfill({
          json: {
            accepted: true,
            watchId: route.request().postDataJSON().watchId,
            nodeGeneration: 'fixture-generation',
            expiresAt: Date.now() + 30_000
          }
        });
      return route.fulfill({ json: {} });
    });
    await page.goto(`${fixture.url}hosted-entry.html?existing&workspace-page&theme=${theme}`);
    const history = page.locator('.hosted-conversation-history');
    await expect(history).toBeVisible();
    expect(await sidebarGeometry(history)).toEqual(geometry);
    const header = (await history.locator('.history-header').boundingBox())!;
    expect(header.y).toBeCloseTo(geometry.top, 1);
    const expectHistoryTitles = async () => {
      const { primary, secondary, muted, selection, fontSize } = await history.evaluate(
        (element) => {
          const probe = document.createElement('span');
          probe.style.fontSize = 'var(--mar-font-size-body)';
          element.append(probe);
          const resolve = (token: string) => {
            probe.style.color = `var(${token})`;
            return getComputedStyle(probe).color;
          };
          const colors = {
            primary: resolve('--mar-text-primary'),
            secondary: resolve('--mar-text-secondary'),
            muted: resolve('--mar-text-muted'),
            selection: resolve('--mar-fill-selection'),
            fontSize: getComputedStyle(probe).fontSize
          };
          probe.remove();
          return colors;
        }
      );
      expect(primary).toBe(selectedWorkspaceColor);
      expect(secondary).toBe(otherWorkspaceColor);
      const current = history.locator('.history-open[aria-current="page"]');
      await expect(current).toContainText('Current chat');
      await expect(current.locator('time')).toHaveCSS('color', muted);
      for (const title of ['Current chat', 'Another chat']) {
        const selected = title === 'Current chat';
        const row = history.locator('article').filter({ hasText: title });
        const text = row.getByText(title, { exact: true });
        const pin = row.getByRole('img', { name: 'Pinned', exact: true });
        await expect(text).toHaveCSS('color', selected ? primary : secondary);
        await expect(text).toHaveCSS('font-size', fontSize);
        await expect(text).toHaveCSS('font-weight', '400');
        await expect(pin).toBeVisible();
        await expect(pin).toHaveAttribute('data-mar-icon', 'pin');
        await expect(pin).toHaveCSS('color', selected ? primary : secondary);
        if (selected) await expect(row).toHaveCSS('background-color', selection);
        else await expect(row).not.toHaveCSS('background-color', selection);
      }
    };
    await expectHistoryTitles();
    const otherTitle = history.getByText('Another chat', { exact: true });
    const otherColor = await otherTitle.evaluate((element) => getComputedStyle(element).color);
    await otherTitle.hover();
    await expect(otherTitle).toHaveCSS('color', otherColor);
    await page.mouse.move(0, 0);
    const create = history.getByRole('button', { name: 'New chat', exact: true });
    const expectCreateAlignedToSearch = async () => {
      const search = (await history.locator('.history-search-row').boundingBox())!;
      const button = (await create.boundingBox())!;
      expect(button.x).toBeCloseTo(search.x, 0);
      expect(button.width).toBeCloseTo(search.width, 0);
      expect(button.y).toBeGreaterThanOrEqual(search.y + search.height);
    };
    await expect(create).toHaveCSS('border-top-width', '1px');
    const controlHeight = await create.evaluate((button) =>
      getComputedStyle(button).getPropertyValue('--mar-compact-control-size').trim()
    );
    await expect(create).toHaveCSS('height', controlHeight);
    await expectCreateAlignedToSearch();
    const { createFill, createBorder, hoverFill, folderColor, fileNameColor } =
      await create.evaluate((button) => {
        const probe = document.createElement('span');
        button.append(probe);
        const resolveColor = (color: string) => {
          probe.style.color = color;
          return getComputedStyle(probe).color;
        };
        const colors = {
          createFill: resolveColor('var(--mar-session-create-fill)'),
          createBorder: resolveColor('var(--mar-input-border)'),
          hoverFill: resolveColor('var(--mar-fill-row-hover)'),
          folderColor: resolveColor('var(--mar-text-secondary)'),
          fileNameColor: resolveColor('var(--mar-text-primary)')
        };
        probe.remove();
        return colors;
      });
    await expect(create).toHaveCSS('background-color', createFill);
    await expect(create).toHaveCSS('border-top-color', createBorder);
    const searchControl = history.locator('.history-search-row .mar-ui-input');
    await expect(searchControl).not.toHaveCSS('background-color', hoverFill);
    const upload = page.locator('.files-drop-target');
    await expect(upload).toBeVisible();
    await expect(upload).toBeEnabled();
    const restingBorder = await upload.evaluate(
      (element) => getComputedStyle(element).borderTopColor
    );
    const draggedFiles = await page.evaluateHandle(() => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File(['attachment'], 'notes.txt'));
      return dataTransfer;
    });
    const draggedText = await page.evaluateHandle(() => {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/plain', 'not a file');
      return dataTransfer;
    });
    await upload.dispatchEvent('dragenter', { dataTransfer: draggedText });
    await expect(upload).toHaveCSS('border-top-color', restingBorder);
    await upload.dispatchEvent('dragenter', { dataTransfer: draggedFiles });
    await expect(upload).toHaveCSS('border-top-style', 'dashed');
    await expect(upload).toHaveCSS(
      'border-top-color',
      theme === 'daylight' ? 'rgb(23, 78, 158)' : 'rgb(117, 183, 255)'
    );
    await upload.dispatchEvent('dragleave', {
      dataTransfer: draggedFiles,
      relatedTarget: await upload.locator('span').elementHandle()
    });
    await expect(upload).toHaveClass(/\bactive\b/u);
    await upload.dispatchEvent('dragleave', { dataTransfer: draggedFiles });
    await expect(upload).toHaveCSS('border-top-color', restingBorder);
    await Promise.all([draggedFiles.dispose(), draggedText.dispose()]);
    const uploadTextColor = await upload
      .locator('span')
      .evaluate((span) => getComputedStyle(span).color);
    await expect(upload.locator('svg[data-mar-icon="upload"]')).toHaveCSS('color', uploadTextColor);
    await page.screenshot({ path: testInfo.outputPath(`hosted-create-and-upload-${theme}.png`) });
    await history.screenshot({ path: testInfo.outputPath(`hosted-history-${theme}.png`) });

    const searchInput = history.getByRole('textbox', { name: 'Search chat titles' });
    const refresh = history.locator('.history-refresh-button');
    await expect(refresh).toBeEnabled();
    await searchInput.focus();
    await page.keyboard.press('Tab');
    await expect(refresh).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(create).toBeFocused();

    const files = page.locator('.hosted-conversation-files');
    const assets = files.getByRole('button', { name: /folder “assets”$/u });
    const reports = files.getByRole('button', { name: /folder “assets\/reports”$/u });
    const summary = files.getByRole('button', { name: 'assets/reports/summary.txt', exact: true });
    await expect(assets).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(assets).toHaveCSS('color', fileNameColor);
    await expect(assets.locator('svg[data-mar-icon="folder"]')).toHaveCSS('color', folderColor);
    await expect(assets).toHaveAttribute('aria-expanded', 'false');
    await expect(reports).toHaveCount(0);
    await assets.hover();
    await expect(assets).toHaveCSS('background-color', hoverFill);
    await expect(assets).toHaveCSS('color', fileNameColor);
    await page.addStyleTag({ content: ':root { --mar-motion-duration-collapse: 600ms; }' });
    await assets.click();
    await expect(files.locator('.file-branch-enter-active')).toHaveCSS(
      'transition-property',
      'grid-template-rows'
    );
    await expect(assets.locator('svg[data-mar-icon="folder-open"]')).toBeVisible();
    await expect(reports).toHaveAttribute('aria-expanded', 'false');
    await reports.click();
    await expect(summary).toBeVisible();
    await expect(summary).toHaveCSS('color', fileNameColor);
    await expect(assets.locator('.file-directory-chevron')).toHaveCSS(
      'transform',
      'matrix(0, 1, -1, 0, 0, 0)'
    );
    await page.mouse.move(1, 1);
    await files.screenshot({ path: testInfo.outputPath(`hosted-file-tree-${theme}.png`) });
    await assets.click();
    await expect(files.locator('.file-branch-leave-active')).toHaveAttribute('inert', '');
    await expect(summary).toHaveCount(0);

    await page.goto(
      `${fixture.url}hosted-entry.html?workspace-page&sidebar-collapsed&theme=${theme}`
    );
    await expect(history).toBeHidden();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${fixture.url}hosted-entry.html?workspace-page&history-open&theme=${theme}`);
    await expect(history).toBeVisible();
    const mobile = await sidebarGeometry(history);
    expect(mobile.left).toBe(0);
    expect(mobile.bottom).toBe(0);
    expect(mobile.width).toBeLessThan(390);
    expect(mobile.radius).toBe('0px');
    await expectHistoryTitles();
    await expect(create).toHaveCSS('background-color', createFill);
    await expect(create).toHaveCSS('border-top-color', createBorder);
    await expect(searchControl).not.toHaveCSS('background-color', hoverFill);
    await expectCreateAlignedToSearch();
    await page.screenshot({ path: testInfo.outputPath(`hosted-history-mobile-${theme}.png`) });

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${fixture.url}hosted-entry.html?existing&workspace-page&theme=${theme}`);
    await page.locator('.hosted-mobile-files-button').click();
    await expect(assets.locator('.file-directory-chevron')).toHaveCSS('transition-duration', '0s');
    await assets.click();
    await reports.click();
    await expect(summary).toBeVisible();
    await files.screenshot({ path: testInfo.outputPath(`hosted-file-tree-mobile-${theme}.png`) });
    await assets.click();
    await expect(summary).toHaveCount(0);
  });

  for (const placement of ['header', 'body']) {
    test(`Inactive Workspace Tabs blend into the ${placement} strip in ${theme}`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(
        `${fixture.url}workspace-tabs.html?layout=boundary&placement=${placement}&theme=${theme}&locale=en-US`
      );
      const tabs = page.locator('.workspace-tab');
      const pinned = tabs.nth(1);
      const inactive = tabs.nth(2);
      const active = tabs.first();
      const { primary, secondary } = await active.evaluate((element) => {
        const probe = document.createElement('span');
        element.append(probe);
        probe.style.color = 'var(--mar-text-primary)';
        const primary = getComputedStyle(probe).color;
        probe.style.color = 'var(--mar-text-secondary)';
        const secondary = getComputedStyle(probe).color;
        probe.remove();
        return { primary, secondary };
      });
      const title = (tab: Locator) => tab.locator('.workspace-tab-content > span');
      await expect(pinned).toHaveClass(/sticky-pinned/);
      await page.mouse.move(1200, 800);
      for (const tab of [pinned, inactive]) {
        await expect(title(tab)).toHaveCSS('color', secondary);
        await expect(tab).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(tab).toHaveCSS('background-image', 'none');
      }
      await expect(title(active)).toHaveCSS('color', primary);
      await expect(active.locator('small')).toHaveCSS('color', secondary);
      await expect(active).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await inactive.hover();
      await expect(inactive).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(title(inactive)).toHaveCSS('color', secondary);
      await inactive.locator('[role="tab"]').focus();
      await expect(inactive.locator('[role="tab"]')).toBeFocused();
      await expect(title(inactive)).toHaveCSS('color', secondary);
      await inactive.locator('[role="tab"]').press('Enter');
      await expect(inactive.locator('[role="tab"]')).toHaveAttribute('aria-selected', 'true');
      await expect(title(inactive)).toHaveCSS('color', primary);
      await page.mouse.move(1200, 800);
      await expect(title(active)).toHaveCSS('color', secondary);
      await expect(active).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      const strip = page.locator('.workspace-tabs');
      await strip.evaluate((element) => {
        element.scrollLeft = 120;
      });
      await expect.poll(() => strip.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
      const pinBounds = (await pinned.boundingBox())!;
      const tabBounds = (await inactive.boundingBox())!;
      const overlap = Math.min(pinBounds.x + pinBounds.width - 1, tabBounds.x + 12);
      expect(
        await page.evaluate(
          ({ x, y }) =>
            document
              .elementFromPoint(x, y)
              ?.closest('.workspace-tab')
              ?.classList.contains('sticky-pinned'),
          { x: overlap, y: pinBounds.y + pinBounds.height / 2 }
        )
      ).toBe(true);
      await page.locator('.workspace-tab-strip').screenshot({
        path: testInfo.outputPath(`workspace-tabs-${placement}-${theme}.png`)
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(title(inactive)).toHaveCSS('color', primary);
      await expect(title(pinned)).toHaveCSS('color', secondary);
      await expect(title(active)).toHaveCSS('color', secondary);
    });
  }
}
