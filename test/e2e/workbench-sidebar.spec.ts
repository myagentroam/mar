import { expect, test, type Locator } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

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
  await settings.scrollIntoViewIfNeeded();
  const settingsBox = (await settings.boundingBox())!;
  const navBox = (await nav.boundingBox())!;
  // Scroll offsets can be rounded to whole pixels while the flex gap is fractional.
  expect(settingsBox.y + settingsBox.height).toBeLessThanOrEqual(navBox.y + navBox.height + 1);
  expect(navBox.y + navBox.height).toBeLessThan(footer.y);
  expect(await diagnostics.boundingBox()).toEqual(footer);

  await diagnostics.hover();
  await expect(page.locator('.web-performance-panel')).toBeVisible();
  await settings.click();
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

for (const theme of ['daylight', 'vscode-dark-2026']) {
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
      pinnedAt: index === 0 ? timestamp : null,
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
            files: [],
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
    const current = history.getByText('Current chat', { exact: true });
    const other = history.getByText('Another chat', { exact: true });
    await expect(history.locator('[aria-current="page"]')).toContainText('Current chat');
    const pin = history.getByRole('img', { name: 'Pinned', exact: true });
    await expect(pin).toHaveAttribute('data-mar-icon', 'pin');
    const hintColor = await history
      .locator('[aria-current="page"] time')
      .evaluate((element) => getComputedStyle(element).color);
    await expect(pin).toHaveCSS('color', hintColor);
    await expect(current).toHaveCSS('font-size', '12px');
    await expect(other).toHaveCSS('font-size', '12px');
    const create = history.getByRole('button', { name: 'New chat', exact: true });
    const expectCreateAlignedToSearch = async () => {
      const search = (await history.locator('.history-search-row').boundingBox())!;
      const button = (await create.boundingBox())!;
      expect(button.x).toBeCloseTo(search.x, 0);
      expect(button.width).toBeCloseTo(search.width, 0);
      expect(button.y).toBeGreaterThanOrEqual(search.y + search.height);
    };
    await expect(create).toHaveCSS('border-top-width', '1px');
    await expect(create).toHaveCSS('height', '32px');
    await expectCreateAlignedToSearch();
    const { fill, border } = await create.evaluate((button) => {
      const probe = document.createElement('span');
      button.append(probe);
      const resolveColor = (token: string) => {
        probe.style.color = `var(${token})`;
        return getComputedStyle(probe).color;
      };
      const colors = {
        fill: resolveColor('--mar-fill-row-hover'),
        border: resolveColor('--mar-border-default')
      };
      probe.remove();
      return colors;
    });
    await expect(create).toHaveCSS('background-color', fill);
    await expect(create).toHaveCSS('border-top-color', border);
    const searchControl = history.locator('.history-search-row .el-input__wrapper');
    await expect(searchControl).not.toHaveCSS('background-color', fill);
    const upload = page.locator('.files-drop-target');
    await expect(upload).toBeVisible();
    await expect(upload).toBeEnabled();
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
    await expect(history.locator('[aria-current="page"]')).toContainText('Current chat');
    await expect(pin).toBeVisible();
    await expect(current).toHaveCSS('font-size', '12px');
    await expect(other).toHaveCSS('font-size', '12px');
    await expect(create).toHaveCSS('background-color', fill);
    await expect(create).toHaveCSS('border-top-color', border);
    await expect(searchControl).not.toHaveCSS('background-color', fill);
    await expectCreateAlignedToSearch();
    await page.screenshot({ path: testInfo.outputPath(`hosted-history-mobile-${theme}.png`) });
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
      await expect(pinned).toHaveClass(/sticky-pinned/);
      await page.mouse.move(1200, 800);
      for (const tab of [pinned, inactive]) {
        await expect(tab).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(tab).toHaveCSS('background-image', 'none');
      }
      await expect(active).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await inactive.hover();
      await expect(inactive).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await inactive.locator('[role="tab"]').focus();
      await expect(inactive.locator('[role="tab"]')).toBeFocused();
      await inactive.locator('[role="tab"]').press('Enter');
      await expect(inactive.locator('[role="tab"]')).toHaveAttribute('aria-selected', 'true');
      await page.mouse.move(1200, 800);
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
    });
  }
}
