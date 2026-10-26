import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

test('Node detail actions stay above Close and capability refresh stays within its section', async ({
  page
}) => {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${fixture.url}visual-alignment.html?resource-details=1`);
    const dialog = page.locator('.node-details-dialog');
    await expect(dialog).toBeVisible();
    const usages = dialog.getByRole('button', { name: 'Usage', exact: true });
    await expect(usages).toHaveCount(2);
    for (const action of await usages.all())
      await expect(action.locator('[data-mar-icon="refresh"]')).toBeVisible();
    const usage = usages.first();
    await usage.scrollIntoViewIfNeeded();
    const colors = await usage.evaluate((element) => {
      const probe = document.createElement('span');
      element.append(probe);
      probe.style.color = 'var(--mar-text-secondary)';
      const normal = getComputedStyle(probe).color;
      probe.style.color = 'var(--mar-text-primary)';
      const hover = getComputedStyle(probe).color;
      probe.remove();
      return { normal, hover };
    });
    await page.mouse.move(0, 0);
    await expect(usage).toHaveCSS('color', colors.normal);
    await usage.hover();
    await expect(usage).toHaveCSS('color', colors.hover);
    await expect(usage).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    const refresh = dialog.getByRole('button', { name: 'Refresh capabilities', exact: true });
    await refresh.scrollIntoViewIfNeeded();
    await refresh.hover();
    await expect(refresh).toHaveCSS('color', colors.hover);
    const runtime = dialog.locator('.runtime-environment');
    const section = (await runtime.boundingBox())!;
    const action = (await refresh.boundingBox())!;
    expect(action.x).toBeGreaterThanOrEqual(section.x);
    expect(action.x + action.width).toBeLessThanOrEqual(section.x + section.width + 1);
    expect(action.y).toBeGreaterThanOrEqual(section.y);
    expect(action.y).toBeLessThan(section.y + 32);
    await refresh.click();
    await expect(page.getByTestId('capability-refresh-count')).toHaveText('1');
    const footer = dialog.locator('.el-dialog__footer');
    const close = footer.getByRole('button', { name: 'Close', exact: true });
    const upgrade = footer.locator('.node-detail-actions button');
    await upgrade.click();
    await expect(upgrade).toHaveText('Cancel upgrade');
    await close.scrollIntoViewIfNeeded();
    const upgradeBox = (await upgrade.boundingBox())!;
    const closeBox = (await close.boundingBox())!;
    expect(upgradeBox.y + upgradeBox.height).toBeLessThan(closeBox.y);
    await upgrade.click();
    await expect(upgrade).not.toHaveText('Cancel upgrade');
    await close.click();
    await expect(dialog).toHaveCount(0);
  }
});

test('Shared tooltip keeps one active instance for thousands of targets and preserves ARIA', async ({
  page
}) => {
  const warnings: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'warning' || message.type() === 'error') warnings.push(message.text());
  });
  await page.goto(`${fixture.url}visual-alignment.html?shared-tooltip=1`);
  const first = page.locator('[data-row="1"]');
  const second = page.locator('[data-row="2"]');
  const hint = page.locator('.mar-tooltip:visible');
  await expect(page.locator('[data-row]')).toHaveCount(1000);
  await expect(page.getByTestId('tooltip-created')).toHaveText('0');
  await page.getByTestId('grow').click();
  await expect(page.locator('[data-row]')).toHaveCount(2000);
  await expect(page.getByTestId('tooltip-created')).toHaveText('0');
  await first.locator('span').hover();
  await expect(hint).toHaveText('Original 1');
  await expect(page.getByTestId('tooltip-live')).toHaveText('1');
  await expect(first).toHaveAccessibleDescription('Existing description Original 1');
  await expect(first).toHaveAttribute('aria-haspopup', 'menu');
  await expect(first).toHaveAttribute('aria-expanded', 'false');
  await second.hover();
  await expect(hint).toHaveText('Original 2');
  await expect(hint).toHaveCount(1);
  await expect(first).toHaveAttribute('aria-describedby', 'existing-description');
  await second.focus();
  await second.press('Escape');
  await expect(hint).toHaveCount(0);
  await expect(second).toBeFocused();
  await expect(second).toHaveAttribute('aria-describedby', 'existing-description');
  await expect(page.getByTestId('tooltip-live')).toHaveText('0');
  expect(warnings).toEqual([]);
});

test('Shared tooltip lets Escape reach the target and local bubble handlers without reaching business shortcuts', async ({
  page
}) => {
  await page.goto(`${fixture.url}visual-alignment.html?shared-tooltip=1`);
  const target = page.locator('[data-row="1"]');
  await target.focus();
  await expect(page.locator('.mar-tooltip:visible')).toHaveText('Original 1');
  await target.evaluate((element) => {
    const trace: string[] = [];
    const record = (phase: string) => (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      trace.push(phase);
      document.documentElement.dataset['escapeTrace'] = JSON.stringify(trace);
    };
    document.addEventListener('keydown', record('capture'), true);
    element.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key !== 'Escape') return;
      // The description is removed synchronously, before the control receives the key.
      trace.push(
        element.getAttribute('aria-describedby') === 'existing-description' ? 'target' : 'stale'
      );
    });
    document.body.addEventListener('keydown', record('local bubble'));
    document.addEventListener('keydown', record('business shortcut'));
  });
  await target.press('Escape');
  await expect(page.locator('.mar-tooltip:visible')).toHaveCount(0);
  await expect(target).toBeFocused();
  await expect(page.locator('html')).toHaveAttribute(
    'data-escape-trace',
    JSON.stringify(['capture', 'target', 'local bubble'])
  );
});

test('Shared tooltip dismisses an unrelated hovered hint without stopping the focused run', async ({
  page
}) => {
  await page.goto(`${fixture.url}visual-alignment.html?shared-tooltip=1`);
  const composer = page.getByRole('textbox', { name: 'Running composer', exact: true });
  await composer.focus();
  await page.getByRole('button', { name: 'Run action hint', exact: true }).hover();
  await expect(page.locator('.mar-tooltip:visible')).toHaveText('Run action details');
  await composer.press('Escape');
  await expect(page.locator('.mar-tooltip:visible')).toHaveCount(0);
  await expect(composer).toBeFocused();
  await expect(page.getByTestId('run-stops')).toHaveText('0');
  await composer.press('Escape');
  await expect(page.getByTestId('run-stops')).toHaveText('1');
});

test('Shared tooltip preserves inline cancellation and native select Escape inside a dialog', async ({
  page
}) => {
  await page.goto(`${fixture.url}visual-alignment.html?shared-tooltip=1`);
  await page.getByTestId('open-escape-dialog').click();
  const dialog = page.getByRole('dialog', { name: 'Escape ownership', exact: true });
  const input = dialog.getByRole('textbox', { name: 'Inline edit', exact: true });
  const hint = page.locator('.mar-tooltip:visible');
  await input.focus();
  await expect(hint).toHaveText('Cancel editing with Escape');
  await input.press('Escape');
  await expect(dialog.getByTestId('edit-cancelled')).toBeVisible();
  await expect(hint).toHaveCount(0);
  await expect(dialog).toBeVisible();

  const select = dialog.getByRole('combobox', { name: 'Escape select', exact: true });
  await select.click();
  await expect(page.getByRole('listbox')).toBeVisible();
  await expect(hint).toHaveText('Select details');
  await select.press('Escape');
  await expect(page.getByRole('listbox')).not.toBeVisible();
  await expect(hint).toHaveCount(0);
  await expect(select).toBeFocused();
  await expect(dialog).toBeVisible();
});

test('Shared tooltip leaves nested native menu dismissal with its current overlay owner', async ({
  page
}) => {
  await page.goto(`${fixture.url}visual-alignment.html?shared-tooltip=1`);
  await page.getByTestId('open-escape-dialog').click();
  const dialog = page.getByRole('dialog', { name: 'Escape ownership', exact: true });
  const trigger = dialog.getByRole('button', { name: 'Escape menu', exact: true });
  await trigger.click();
  const item = page.getByRole('menuitem', { name: 'Menu action', exact: true });
  await item.focus();
  await expect(page.locator('.mar-tooltip:visible')).toHaveText('Menu action details');
  await item.press('Escape');
  await expect(page.getByRole('menu')).not.toBeVisible();
  await expect(page.locator('.mar-tooltip:visible')).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(page.getByTestId('menu-actions')).toHaveText('0');
  await trigger.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('Shared tooltip closes a mobile sidebar menu before the sidebar itself', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${fixture.url}visual-alignment.html?shared-tooltip=1`);
  const openSidebar = page.getByTestId('open-mobile-sidebar');
  await openSidebar.click();
  const sidebar = page.getByRole('complementary', { name: 'Mobile sidebar', exact: true });
  const trigger = sidebar.getByRole('button', { name: 'Mobile sidebar menu', exact: true });
  await trigger.click();
  const item = page.getByRole('menuitem', { name: 'Mobile menu action', exact: true });
  await item.focus();
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.locator('.mar-tooltip:visible')).toHaveText('Mobile menu action details');
  // Unlike a Dialog, this surface uses the product's window-level nonmodal closer.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await item.press('Escape');
  await expect(page.getByRole('menu')).not.toBeVisible();
  await expect(page.locator('.mar-tooltip:visible')).toHaveCount(0);
  await expect(sidebar).toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(page.getByTestId('menu-actions')).toHaveText('0');
  await expect(page.getByTestId('run-stops')).toHaveText('0');
  await trigger.press('Escape');
  await expect(sidebar).toHaveCount(0);
  await expect(openSidebar).toBeFocused();
  await expect(page.getByTestId('run-stops')).toHaveText('0');
});

test('Shared tooltip does not pass Escape from an expanded trigger into its containing dialog', async ({
  page
}) => {
  await page.goto(`${fixture.url}visual-alignment.html?shared-tooltip=1`);
  await page.getByTestId('open-escape-dialog').click();
  const dialog = page.getByRole('dialog', { name: 'Escape ownership', exact: true });
  const trigger = dialog.getByRole('button', { name: 'Escape menu', exact: true });
  await trigger.click();
  await page.getByRole('menu').hover();
  await trigger.focus();
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(trigger).toBeFocused();
  await expect(page.locator('.mar-tooltip:visible')).toHaveText('Menu action details');
  await trigger.press('Escape');
  // The focused trigger is outside the menu's native focus layer. ARIA expansion
  // alone must not grant it document-level Escape ownership over the outer dialog.
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.locator('.mar-tooltip:visible')).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(page.getByTestId('menu-actions')).toHaveText('0');
});

test('Shared tooltip cancels stale targets and follows content, hidden, removed and scrolling state', async ({
  page
}) => {
  await page.goto(`${fixture.url}visual-alignment.html?shared-tooltip=1`);
  const first = page.locator('[data-row="1"]');
  const second = page.locator('[data-row="2"]');
  const hint = page.locator('.mar-tooltip:visible');
  await first.hover();
  await second.hover();
  await expect(hint).toHaveText('Original 2');
  await page.getByTestId('rename').evaluate((button: HTMLButtonElement) => button.click());
  await expect(hint).toHaveText('Updated 2');
  await page.getByTestId('disable').evaluate((button: HTMLButtonElement) => button.click());
  await expect(hint).toHaveCount(0);
  await expect(second).toHaveAttribute('aria-describedby', 'existing-description');
  await page.getByTestId('disable').click();
  await first.focus();
  await expect(hint).toHaveText('Updated 1');
  await page.getByTestId('hide').evaluate((button: HTMLButtonElement) => button.click());
  await expect(hint).toHaveCount(0);
  await page.getByTestId('hide').click();
  await first.hover();
  await expect(hint).toHaveText('Updated 1');
  await page.getByTestId('tooltip-list').evaluate((list) => {
    list.scrollTop = 80;
  });
  await expect(hint).toHaveCount(0);
  await page.locator('[data-row="5"]').hover();
  await expect(hint).toHaveText('Updated 5');
  await page.getByTestId('remove').evaluate((button: HTMLButtonElement) => button.click());
  await expect(hint).toHaveCount(0);
  await expect(page.getByTestId('tooltip-live')).toHaveText('0');
});

test('Markdown copy hints share the tooltip host across content replacement and unmount', async ({
  page
}) => {
  await page.goto(`${fixture.url}visual-alignment.html?shared-tooltip=1&locale=en-US`);
  const copy = page.getByRole('button', { name: 'Copy code', exact: true });
  const hint = page.locator('.mar-tooltip:visible');
  await expect(copy).not.toHaveAttribute('title');
  await copy.hover();
  await expect(hint).toHaveText('Copy code');
  await expect(hint.locator('.el-popper__arrow')).toBeVisible();
  await copy.focus();
  await copy.press('Escape');
  await expect(hint).toHaveCount(0);
  await expect(copy).toBeFocused();
  await copy.blur();
  await page.mouse.move(0, 0);
  await copy.focus();
  await expect(hint).toHaveText('Copy code');
  await page.getByTestId('rename').evaluate((button: HTMLButtonElement) => button.click());
  await expect(hint).toHaveCount(0);
  await expect(page.locator('.agent-markdown pre')).toHaveText('Updated\n');
  await copy.focus();
  await expect(hint).toHaveText('Copy code');
  await expect(copy).not.toHaveAttribute('title');
  await page.getByTestId('remove').evaluate((button: HTMLButtonElement) => button.click());
  await expect(copy).toHaveCount(0);
  await expect(hint).toHaveCount(0);
});

test('Table overflow hints share the theme without template-ref warnings', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'warning') warnings.push(message.text());
  });
  await page.goto(`${fixture.url}visual-alignment.html`);
  await page.locator('.el-table__body .cell').hover();
  await expect(page.locator('.mar-tooltip:visible')).toContainText(
    'A complete long table cell description'
  );
  const hint = page.locator('.mar-tooltip:visible');
  await expect(hint.locator('.el-popper__arrow')).toBeVisible();
  await expect(hint).toHaveCSS('pointer-events', 'auto');
  await hint.hover();
  await expect(hint).toBeVisible();
  await hint.click({ clickCount: 3, position: { x: 24, y: 12 } });
  expect(await page.evaluate(() => window.getSelection()?.toString())).toContain(
    'A complete long table cell description'
  );
  expect(warnings.filter((message) => /ref owner|Missing ref|unmounted/i.test(message))).toEqual(
    []
  );
});

test('Unified hints preserve keyboard actions, details and disabled semantics', async ({
  page
}) => {
  await page.goto(`${fixture.url}visual-alignment.html`);
  const compact = page.locator('.composer-context-button');
  await page.evaluate(() =>
    document.documentElement.style.setProperty('--mar-radius-control', '7px')
  );
  await expect(compact).toHaveCSS('border-radius', '7px');
  await compact.focus();
  const hint = page.locator('.mar-tooltip:visible');
  await expect(hint).toContainText('42000 of 100000');
  await expect(hint).toContainText(/click to compact/iu);
  await expect(compact).not.toHaveAttribute('title');
  await compact.press('Escape');
  await expect(hint).toHaveCount(0);
  await expect(compact).toBeFocused();
  await compact.press('Enter');
  await expect(page.getByTestId('compact-count')).toHaveText('1');
  await compact.press('Space');
  await expect(page.getByTestId('compact-count')).toHaveText('2');
  await page.getByText('Toggle availability', { exact: true }).click();
  await expect(compact).toHaveAttribute('aria-disabled', 'true');
  await compact.focus();
  await expect(hint).toContainText('currently unavailable');
  await compact.press('Enter');
  await expect(page.getByTestId('compact-count')).toHaveText('2');
});

test('Escape dismisses a focused hint before its containing dialog', async ({ page }) => {
  await page.goto(`${fixture.url}visual-alignment.html`);
  await page.getByRole('button', { name: 'Open hint dialog', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Hint dialog', exact: true });
  const action = dialog.getByRole('button', { name: 'Dialog action', exact: true });
  await action.focus();
  await expect(page.locator('.mar-tooltip:visible')).toContainText('Dialog action details');
  await action.press('Escape');
  await expect(page.locator('.mar-tooltip:visible')).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(action).toBeFocused();
  await action.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('Touch Context details stay readable without stealing the compact action', async ({
  browser
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true
  });
  try {
    const page = await context.newPage();
    await page.goto(`${fixture.url}visual-alignment.html?mobile=1&context-confirm=1`);
    const compact = page.locator('.composer-context-button');
    const hint = page.locator('.mar-tooltip:visible');
    await page.getByRole('button', { name: 'Toggle availability', exact: true }).tap();
    // ARIA disables compaction, not detail reading. Check native hit-testing before tapping.
    const point = await compact.evaluate((button: HTMLButtonElement) => {
      const rect = button.getBoundingClientRect();
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      return {
        x,
        y,
        hit: button.contains(document.elementFromPoint(x, y)),
        disabled: button.disabled
      };
    });
    expect(point.hit).toBe(true);
    expect(point.disabled).toBe(false);
    await page.touchscreen.tap(point.x, point.y);
    await expect(hint).toContainText('42000 of 100000');
    await expect(hint).toContainText('currently unavailable');
    await expect(compact).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByRole('dialog', { name: 'Compact Context', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('compact-count')).toHaveText('0');
    await page.getByRole('button', { name: 'Toggle availability', exact: true }).tap();
    await expect(hint).toHaveCount(0);

    await compact.tap();
    const dialog = page.getByRole('dialog', { name: 'Compact Context', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('42000 of 100000');
    await expect(hint).toHaveCount(0);
    await expect(page.getByTestId('compact-count')).toHaveText('0');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).tap();
    await expect(dialog).toHaveCount(0);
    await compact.tap();
    await dialog.getByRole('button', { name: 'Compact', exact: true }).tap();
    await expect(page.getByTestId('compact-count')).toHaveText('1');
    await expect(hint).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('Shared tooltip switches between touch, keyboard and mouse without stale input state', async ({
  browser
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true
  });
  try {
    const page = await context.newPage();
    await page.goto(`${fixture.url}visual-alignment.html?shared-tooltip=1`);
    const first = page.locator('[data-row="1"]');
    const second = page.locator('[data-row="2"]');
    const hint = page.locator('.mar-tooltip:visible');
    await first.tap();
    await expect(hint).toHaveText('Original 1');
    await second.tap();
    await expect(hint).toHaveCount(0);
    await page.keyboard.press('Shift+Tab');
    await expect(first).toBeFocused();
    await expect(hint).toHaveText('Original 1');
    await page.keyboard.press('Escape');
    await expect(hint).toHaveCount(0);
    await second.hover();
    await expect(hint).toHaveText('Original 2');
    await expect(hint).toHaveCount(1);
  } finally {
    await context.close();
  }
});

test('Hosted model labels preserve dropdown semantics and keyboard selection', async ({ page }) => {
  await page.goto(`${fixture.url}visual-alignment.html?hosted=1`);
  const trigger = page.locator('.hosted-model-trigger');
  await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(trigger).toHaveAccessibleDescription('Model One');
  await trigger.locator('span').first().hover();
  // Model selectors expose their visible label and ARIA description without a redundant tooltip.
  await expect(trigger).toContainText('Model One');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await page.mouse.move(0, 0);
  await trigger.focus();
  await trigger.press('Enter');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('menuitem', { name: 'Model Two', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(trigger).toContainText('Model Two');
  await expect(trigger).toHaveAccessibleDescription('Model Two');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test('Theme action hints do not replace dropdown semantics', async ({ page }) => {
  await page.goto(`${fixture.url}visual-alignment.html?menus=1`);
  const trigger = page.locator('.theme-settings .el-dropdown button').first();
  await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.focus();
  await expect(page.locator('.mar-tooltip:visible')).toHaveText(
    (await trigger.getAttribute('aria-label')) ?? ''
  );
  await trigger.press('Enter');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('menuitem', { name: /duplicate/i })).toBeVisible();
  await page.getByRole('menuitem', { name: /duplicate/i }).press('Escape');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test('Shared tooltip follows keyboard focus on real tree rows and workspace tabs', async ({
  page
}) => {
  await page.goto(`${fixture.url}visual-alignment.html?shared-tooltip=1`);
  const row = page.getByRole('treeitem', { name: 'Fixture workspace' });
  await row.focus();
  await expect(page.locator('.mar-tooltip:visible')).toHaveText('Fixture workspace');
  await row.hover();
  await page.mouse.move(0, 0);
  await expect(row).toBeFocused();
  await expect(page.locator('.mar-tooltip:visible')).toHaveText('Fixture workspace');
  await page.goto(`${fixture.url}workspace-tabs.html?locale=en-US`);
  const tab = page.getByRole('tab', { name: 'Workspace one', exact: true });
  await tab.focus();
  await expect(page.locator('.mar-tooltip:visible')).toHaveText('Workspace one');
});

test('Workspace header tabs scroll horizontally without vertical overflow or clipped labels', async ({
  page
}, testInfo) => {
  for (const layout of ['static', 'dynamic']) {
    await page.setViewportSize({ width: 1280, height: 850 });
    await page.goto(
      `${fixture.url}workspace-tabs.html?locale=en-US&placement=header&layout=${layout}`
    );
    const list = page.getByRole('tablist');
    await expect(list).toBeVisible();
    const geometry = await list.evaluate((element) => ({
      height: element.clientHeight,
      contentHeight: element.scrollHeight,
      width: element.clientWidth,
      contentWidth: element.scrollWidth
    }));
    expect(geometry.contentHeight).toBeLessThanOrEqual(geometry.height);
    expect(geometry.contentWidth).toBeGreaterThan(geometry.width);
    await list.hover();
    await page.mouse.wheel(0, 150);
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(0);
    await page.getByRole('button', { name: 'Browse next workspace tabs' }).click();
    await expect.poll(() => list.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    const lastTab = page.getByRole('tab', {
      name: layout === 'dynamic' ? 'Workspace three' : 'Workspace two',
      exact: true
    });
    await lastTab.click();
    await expect(lastTab).toHaveAttribute('aria-selected', 'true');
    const bounds = (await list.boundingBox())!;
    for (const label of await lastTab
      .locator('.workspace-tab-content > span, .workspace-tab-node-label')
      .all()) {
      const box = (await label.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(bounds.y);
      expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height);
    }
    await page.locator('.workbench-header').screenshot({
      path: testInfo.outputPath(`workspace-header-${layout}.png`)
    });
  }
});

for (const theme of ['daylight', 'vscode-dark-2026']) {
  test(`Workspace pinned boundary masks scrolled tabs and preserves keyboard focus: ${theme}`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 850 });
    for (const placement of ['header', 'body']) {
      await page.goto(
        `${fixture.url}workspace-tabs.html?locale=en-US&layout=boundary&placement=${placement}&theme=${theme}`
      );
      if (theme === 'vscode-dark-2026')
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      else await expect(page.locator('html')).not.toHaveAttribute('data-theme');
      const list = page.getByRole('tablist');
      const pinned = list.locator('.sticky-pinned');
      await expect(pinned).toHaveCount(2);
      const lastPinned = pinned.last();
      const normal = list.locator('.workspace-tab:not(.pinned)');
      await normal.evaluateAll((elements) => {
        for (const element of elements)
          (element as HTMLElement).style.background = 'rgb(255, 0, 255)';
      });
      await list.evaluate((element) => {
        element.scrollLeft = 52;
      });
      await expect.poll(() => list.evaluate((element) => element.scrollLeft)).toBe(52);
      await page.mouse.move(1200, 800);
      const bounds = (await list.boundingBox())!;
      const edge = (await lastPinned.boundingBox())!;
      const clip = {
        x: bounds.x,
        y: bounds.y,
        width: edge.x + edge.width + 3 - bounds.x,
        height: bounds.height
      };
      const visible = await page.screenshot({
        clip,
        animations: 'disabled',
        path: testInfo.outputPath(`${placement}-boundary.png`)
      });
      await normal.evaluateAll((elements) => {
        for (const element of elements) (element as HTMLElement).style.visibility = 'hidden';
      });
      const hidden = await page.screenshot({ clip, animations: 'disabled' });
      expect(
        visible.equals(hidden),
        'Ordinary tabs must not bleed through the fixed region or its corners'
      ).toBe(true);
      await normal.evaluateAll((elements) => {
        for (const element of elements) {
          (element as HTMLElement).style.removeProperty('visibility');
          (element as HTMLElement).style.removeProperty('background');
        }
      });
      await list.evaluate((element) => {
        element.scrollLeft = 0;
      });
      const tab = page.getByRole('tab', { name: 'Workspace three', exact: true });
      await tab.focus();
      await tab.press('Tab');
      await page.keyboard.press('Shift+Tab');
      await expect(tab).toBeFocused();
      await tab.press('Enter');
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      const focus = await tab.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          visible: element.matches(':focus-visible'),
          width: parseFloat(style.outlineWidth),
          offset: parseFloat(style.outlineOffset)
        };
      });
      expect(focus.visible).toBe(true);
      expect(focus.width).toBeGreaterThan(0);
      expect(focus.offset + focus.width).toBeLessThanOrEqual(0);
      await list.screenshot({
        path: testInfo.outputPath(`${placement}-focus.png`),
        animations: 'disabled'
      });
    }
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 850 });
      await page.locator('main').evaluate((element) => {
        element.style.maxWidth = '440px';
      });
      const list = page.getByRole('tablist');
      await expect(list.locator('.sticky-pinned')).toHaveCount(0);
      await list.evaluate((element) => {
        element.scrollLeft = 0;
      });
      const first = list.locator('.pinned').first();
      const before = (await first.boundingBox())!;
      await list.evaluate((element) => {
        element.scrollLeft = 52;
      });
      await expect.poll(async () => (await first.boundingBox())!.x).toBeLessThan(before.x - 40);
    }
  });
}

test('Performance hover displays the details panel without a second hint', async ({ page }) => {
  await page.goto(`${fixture.url}visual-alignment.html?performance=1`);
  const trigger = page.locator('.web-performance-indicator');
  await expect(trigger).toBeVisible();
  const box = await trigger.boundingBox();
  await page.clock.install();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.clock.runFor(1000);
  await expect(page.locator('.web-performance-panel')).toBeVisible();
  await expect(page.locator('.mar-tooltip:visible')).toHaveCount(0);
});

for (const theme of ['daylight', 'vscode-dark-2026']) {
  for (const width of [390, 767, 768, 1280]) {
    test(`Session performance clears the final row and keeps compact bottom spacing: ${theme}, ${width}px`, async ({
      browser
    }, testInfo) => {
      const context = await browser.newContext({
        viewport: { width, height: 700 },
        isMobile: width < 768,
        hasTouch: width < 768
      });
      try {
        const page = await context.newPage();
        await page.goto(`${fixture.url}visual-alignment.html?session-performance=1&theme=${theme}`);
        const info = page.locator('.session-performance-info');
        await expect(info).toBeVisible();
        await page.locator('.conversation-scroll').evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        const infoBox = (await info.boundingBox())!;
        const region = (await page.locator('.conversation-scroll-region').boundingBox())!;
        const lastRow = (await page.getByTestId('last-row').boundingBox())!;
        const bottomGap = region.y + region.height - infoBox.y - infoBox.height;
        const rootFontSize = await page
          .locator('html')
          .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
        expect(bottomGap).toBeGreaterThanOrEqual(0);
        expect(bottomGap).toBeCloseTo(rootFontSize * 0.25, 1);
        if (width < 768) expect(lastRow.y + lastRow.height).toBeLessThanOrEqual(infoBox.y);
        if (width < 768) await info.tap();
        else await info.focus();
        await expect(page.locator('.mar-tooltip:visible')).toContainText('420 ms');
        await expect(page.locator('.mar-tooltip:visible')).toContainText('42.0');
        const hintBox = (await page.locator('.mar-tooltip:visible').boundingBox())!;
        expect(hintBox.x).toBeGreaterThanOrEqual(0);
        expect(hintBox.x + hintBox.width).toBeLessThanOrEqual(width);
        expect(hintBox.y).toBeGreaterThanOrEqual(0);
        expect(hintBox.y + hintBox.height).toBeLessThanOrEqual(700);
        await page.screenshot({ path: testInfo.outputPath('session-performance-hint.png') });
        await page.getByTestId('leave-latest').click();
        const latest = page.locator('.conversation-latest');
        await expect(latest).toBeVisible();
        const latestBox = (await latest.boundingBox())!;
        const raisedInfo = (await info.boundingBox())!;
        expect(raisedInfo.y + raisedInfo.height).toBeLessThanOrEqual(latestBox.y);
        await latest.click();
        await expect(latest).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath('session-performance-position.png') });
        await page.getByTestId('hide-performance').click();
        await expect(info).toHaveCount(0);
        const padding = await page.locator('.conversation-scroll').evaluate((element) => ({
          bottom: Number.parseFloat(getComputedStyle(element).paddingBottom),
          root: Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
        }));
        expect(padding.bottom).toBeCloseTo(padding.root * 0.5, 1);
      } finally {
        await context.close();
      }
    });
  }
}

for (const theme of ['daylight', 'vscode-dark-2026']) {
  test(`Notification and template surfaces consume semantic fields without glass or horizontal motion: ${theme}`, async ({
    page
  }, testInfo) => {
    await page.goto(`${fixture.url}visual-alignment.html?theme=${theme}`);
    const trigger = page.locator('.workbench-notification-center button').first();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const panel = page.locator('.workbench-notification-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveCSS('backdrop-filter', 'none');
    await page.evaluate(() => {
      document.documentElement.style.setProperty(
        '--mar-control-bg-color-overlay',
        'rgb(30, 45, 60)'
      );
      document.documentElement.style.setProperty('--mar-radius-surface', '13px');
      document.documentElement.style.setProperty('--mar-radius-marker', '2px');
    });
    await expect(panel).toHaveCSS('background-color', 'rgb(30, 45, 60)');
    await expect(panel).toHaveCSS('border-radius', '13px');
    await expect(page.locator('.notification-unread-label')).toHaveCSS('border-radius', '2px');
    await expect(panel).toHaveCSS('opacity', '1');
    await page.screenshot({
      path: testInfo.outputPath('notification-desktop.png'),
      animations: 'disabled'
    });
    await trigger.click();
    await page.getByRole('button', { name: 'View email templates', exact: true }).click();
    const first = page.locator('.template-choice').first();
    const second = page.locator('.template-choice').nth(1);
    await expect(first).toHaveAttribute('aria-pressed', 'true');
    const before = await second.boundingBox();
    await second.hover();
    await expect(second).toHaveCSS('transform', 'none');
    expect((await second.boundingBox())?.x).toBe(before?.x);
    await page.evaluate(() =>
      document.documentElement.style.setProperty('--mar-fill-selection', 'rgb(61, 66, 71)')
    );
    await second.click();
    await expect(second).toHaveCSS('background-color', 'rgb(61, 66, 71)');
    await second.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(second).toHaveCSS('outline-style', 'solid');
  });
}

for (const mobile of [false, true]) {
  test(`Notification long content wraps completely and remains scrollable: mobile=${mobile}`, async ({
    browser
  }, testInfo) => {
    const viewport = mobile ? { width: 320, height: 480 } : { width: 1280, height: 720 };
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
    try {
      const page = await context.newPage();
      await page.goto(
        `${fixture.url}visual-alignment.html?long-notification=1${mobile ? '&mobile=1&theme=daylight' : ''}`
      );
      await page.locator('.workbench-notification-center button').first().click();
      const panel = page.locator('.workbench-notification-panel');
      const item = panel.locator('.workbench-notification-list > li').first();
      const title = item.locator('strong');
      const message = item.locator('small');
      await expect(message).toContainText('End of notification.');
      for (const text of [title, message]) {
        const metrics = await text.evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const box = element.getBoundingClientRect();
          const lines = [...range.getClientRects()];
          return {
            lines: lines.length,
            width: box.width,
            contentWidth: range.getBoundingClientRect().width,
            allLinesInside: lines.every((line) => {
              const center = line.top + line.height / 2;
              return center >= box.top && center <= box.bottom;
            })
          };
        });
        expect(metrics.lines).toBeGreaterThan(1);
        expect(metrics.contentWidth).toBeLessThanOrEqual(metrics.width + 1);
        expect(metrics.allLinesInside).toBe(true);
      }
      const font = await message.evaluate((element) => ({
        actual: getComputedStyle(element).fontSize,
        expected: getComputedStyle(document.documentElement)
          .getPropertyValue('--mar-font-size-meta')
          .trim()
      }));
      expect(font.actual).toBe(font.expected);
      const messageBox = (await message.boundingBox())!;
      const time = item.locator('time');
      const timeBox = (await time.boundingBox())!;
      expect(timeBox.y).toBeGreaterThanOrEqual(messageBox.y + messageBox.height);
      const section = mobile
        ? page.locator('.notification-fixture-drawer')
        : panel.locator('.workbench-notification-section');
      await section.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(time).toBeInViewport();
      const box = (await (mobile ? section : panel).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
      await page.screenshot({
        path: testInfo.outputPath('notification-long.png'),
        animations: 'disabled'
      });
      const remove = item.locator('.workbench-notification-delete');
      await remove.scrollIntoViewIfNeeded();
      await expect(remove).toBeInViewport({ ratio: 1 });
      if (mobile) await remove.tap();
      else await remove.click();
      await expect(item).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
}

test('Mobile first touch executes the action and the notification stays within the viewport', async ({
  browser
}, testInfo) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 700 },
    isMobile: true,
    hasTouch: true
  });
  try {
    const page = await context.newPage();
    await page.goto(`${fixture.url}visual-alignment.html?mobile=1`);
    await page.locator('.composer-context-button').tap();
    await expect(page.getByTestId('compact-count')).toHaveText('1');
    await page.locator('.workbench-notification-center button').first().tap();
    const panel = page.locator('.workbench-notification-panel');
    await expect(panel).toBeVisible();
    const box = await page.locator('.notification-fixture-drawer').boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(box!.y + box!.height).toBeLessThanOrEqual(700);
    await expect(panel).toHaveCSS('opacity', '1');
    await page.screenshot({
      path: testInfo.outputPath('notification-mobile.png'),
      animations: 'disabled'
    });
  } finally {
    await context.close();
  }
});
