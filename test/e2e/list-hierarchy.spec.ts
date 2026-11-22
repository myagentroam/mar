import { expect, test, type Page } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

// @test-covers packages/mar-ui/components/check-tag/MarCheckTag.vue
// @test-covers packages/mar-ui/components/segmented/MarSegmented.vue
// @test-covers packages/web-core/src/view/composer/ComposerToolbar.vue
let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

async function colors(page: Page) {
  return page.evaluate(() => {
    const probe = document.createElement('span');
    document.body.append(probe);
    const color = (name: string) => {
      probe.style.color = `var(${name})`;
      return getComputedStyle(probe).color;
    };
    const result = {
      primary: color('--mar-text-primary'),
      secondary: color('--mar-text-secondary'),
      success: color('--mar-color-success-text'),
      link: color('--mar-control-link-text'),
      selected: color('--mar-fill-selection'),
      hover: color('--mar-fill-row-hover'),
      actionHover: color('--mar-action-hover-overlay'),
      overlayHover: color('--mar-overlay-row-hover, var(--mar-fill-row-hover)'),
      match: color('--mar-text-primary')
    };
    probe.remove();
    return result;
  });
}

test('Catalog category tags distinguish selection in forced colors', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto(`${fixture.url}visual-alignment.html?list-hierarchy=skills&scope-columns`);
  const filters = page.locator('.skill-filter-bar');
  const all = filters.getByRole('button', { name: 'All', exact: true });
  const engineering = filters.getByRole('button', { name: 'Engineering', exact: true });
  await expect(all).toHaveAttribute('aria-pressed', 'true');
  const fill = (tag: typeof all) =>
    tag.evaluate((element) => getComputedStyle(element).backgroundColor);
  const selected = await fill(all);
  const inactive = await fill(engineering);
  expect(selected).not.toBe(inactive);
  await all.focus();
  await page.keyboard.press('Tab');
  await expect(engineering).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(engineering).toHaveAttribute('aria-pressed', 'true');
  await expect(engineering).toHaveCSS('background-color', selected);
  await expect(all).toHaveCSS('background-color', inactive);
  // The catalog replaces its facets when the filter changes. Check focus on the new button.
  await all.focus();
  await page.keyboard.press('Tab');
  await expect(engineering).toBeFocused();
  await expect(engineering).toHaveCSS('outline-style', 'solid');
});

test('MCP source search discards old results when switching sources', async ({ page }) => {
  const old = Promise.withResolvers<void>();
  const oldStarted = Promise.withResolvers<void>();
  const newest = Promise.withResolvers<void>();
  const source = (id: string, name: string) => ({
    id,
    name,
    enabled: true,
    builtIn: false,
    scope: 'PERSONAL',
    locator: 'https://example.com/registry',
    manageable: true
  });
  const candidate = (id: string, displayName: string) => ({
    id,
    displayName,
    serverName: id,
    version: '1.0.0',
    description: '',
    runtime: { transport: 'STDIO' },
    tlsVerified: true
  });
  let firstSearches = 0;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/mcp-sources')
      return route.fulfill({
        json: { sources: [source('old', 'Old source'), source('new', 'New source')] }
      });
    if (path === '/api/mcp-sources/old/servers') {
      if (++firstSearches === 1)
        return route.fulfill({
          json: { servers: [candidate('current', 'Current old candidate')] }
        });
      oldStarted.resolve();
      await old.promise;
      return route.fulfill({ json: { servers: [candidate('stale', 'Stale candidate')] } });
    }
    if (path === '/api/mcp-sources/new/servers') {
      await newest.promise;
      return route.fulfill({ json: { servers: [candidate('fresh', 'Fresh candidate')] } });
    }
    if (path === '/api/mcp-catalog')
      return route.fulfill({
        json: { entries: [], page: 1, pageSize: 20, total: 0, hasMore: false }
      });
    return route.fulfill({ status: 404 });
  });
  try {
    await page.goto(
      `${fixture.url}visual-alignment.html?list-hierarchy=mcp-sources&controlled-reads&locale=en-US`
    );
    const search = page.getByRole('button', { name: 'Search', exact: true });
    const table = page.locator('.source-mcp-table');
    const picker = page.locator('.source-search-bar').getByRole('combobox');
    await search.click();
    await expect(table.getByText('Current old candidate')).toBeVisible();
    await picker.click();
    await page.getByRole('option', { name: 'New source' }).click();
    await expect(page.getByText('Current old candidate')).toHaveCount(0);
    await picker.click();
    await page.getByRole('option', { name: 'Old source' }).click();
    await search.click();
    await oldStarted.promise;
    await expect(table.getByRole('progressbar')).toBeVisible();
    await picker.click();
    await page.getByRole('option', { name: 'New source' }).click();
    await search.click();
    await expect(table.getByRole('progressbar')).toBeVisible();
    await expect(page.locator('.mar-ui-loading')).toHaveCount(0);
    const oldResponse = page.waitForResponse('**/api/mcp-sources/old/servers?*');
    old.resolve();
    await oldResponse;
    await expect(table.getByRole('progressbar')).toBeVisible();
    newest.resolve();
    await expect(table.getByText('Fresh candidate')).toBeVisible();
    await expect(table.getByText('Stale candidate')).toHaveCount(0);
    await expect(table.getByRole('progressbar')).toHaveCount(0);
  } finally {
    old.resolve();
    newest.resolve();
  }
});

test('MCP removal keeps its confirmed target and blocks duplicate writes without a mask', async ({
  page
}) => {
  const removed = Promise.withResolvers<void>();
  const removeStarted = Promise.withResolvers<void>();
  let removals = 0;
  const installation = {
    catalogEntryId: 'local-mcp',
    serverName: 'local-mcp',
    displayName: 'Local MCP',
    version: '1.0.0',
    origin: 'NODE',
    enabled: true,
    status: 'CURRENT',
    installedAt: 1
  };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/resources')
      return route.fulfill({ json: { nodes: [{ id: 'node' }], workspaces: [] } });
    if (path === '/api/nodes/node/mcps')
      return route.fulfill({ json: { targetKind: 'NODE', installations: [installation] } });
    if (path === '/api/nodes/node/mcps/local-mcp' && request.method() === 'DELETE') {
      removals++;
      removeStarted.resolve();
      await removed.promise;
      return route.fulfill({ json: { targetKind: 'NODE', installations: [] } });
    }
    if (path === '/api/mcp-catalog')
      return route.fulfill({
        json: { entries: [], page: 1, pageSize: 20, total: 0, hasMore: false }
      });
    return route.fulfill({ status: 404 });
  });
  try {
    await page.goto(
      `${fixture.url}visual-alignment.html?list-hierarchy=mcp&controlled-reads&inspect-target&locale=en-US`
    );
    await page.getByRole('tab', { name: 'Installed MCP Servers' }).click();
    const table = page.locator('.mcp-config-table');
    const remove = table.getByRole('button', { name: 'Delete', exact: true });
    await remove.click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(removals).toBe(0);
    await remove.click();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await removeStarted.promise;
    await expect(remove).toBeDisabled();
    await expect(table.getByText('Local MCP', { exact: true })).toBeVisible();
    await expect(page.locator('.mar-ui-loading')).toHaveCount(0);
    removed.resolve();
    await expect(table.getByText('No data', { exact: true })).toBeVisible();
    expect(removals).toBe(1);
  } finally {
    removed.resolve();
  }
});

test('Workspace Git retries in the same status slot without a mask', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const retryRead = Promise.withResolvers<void>();
  let requests = 0;
  await page.route('**/api/workspaces/workspace/git-policy?*', async (route) => {
    if (++requests === 1) return route.fulfill({ status: 503 });
    if (requests === 2) {
      await retryRead.promise;
      return route.fulfill({ status: 503 });
    }
    return route.fulfill({ json: { preserveGitConfig: true, includeParentRepository: false } });
  });
  try {
    await page.goto(
      `${fixture.url}visual-alignment.html?list-hierarchy=workspace-git&controlled-reads&locale=en-US`
    );
    const panel = page.locator('.workspace-git-settings');
    const retry = panel.getByRole('button', { name: 'Failed to load. Retry' });
    const status = panel.locator('.mar-region-status');
    await expect(retry).toBeVisible();
    const previous = await status.boundingBox();
    await retry.focus();
    await retry.click();
    const busyRetry = status.getByRole('button', { name: /^Loading…?$/ });
    await expect(busyRetry).toBeFocused();
    await expect(busyRetry).toHaveAttribute('aria-busy', 'true');
    await expect(busyRetry.locator('.mar-read-loading-indicator')).toBeVisible();
    await page.keyboard.press('Enter');
    expect(requests).toBe(2);
    expect((await status.boundingBox())?.y).toBe(previous?.y);
    await expect(panel.locator('.mar-ui-loading')).toHaveCount(0);
    retryRead.resolve();
    await expect(retry).toBeFocused();
    await retry.click();
    await expect(panel.getByRole('checkbox').first()).toBeChecked();
    await expect(status).toHaveCount(0);
  } finally {
    retryRead.resolve();
  }
});

for (const [view, field, selector, searchPlaceholder] of [
  ['skills', 'favorites', '.available-skill-table', 'Search skill names or descriptions'],
  ['mcp', 'entries', '.mcp-config-table', 'Search MCP servers']
] as const) {
  test(`${view} catalog keeps its header through loading, failure, and empty results`, async ({
    page
  }, info) => {
    const mobile = view === 'mcp';
    await page.setViewportSize({ width: mobile ? 390 : 1280, height: 844 });
    const first = Promise.withResolvers<void>();
    const filtered = Promise.withResolvers<void>();
    let reads = 0;
    await page.route('**/api/**', async (route) => {
      if (new URL(route.request().url()).pathname === '/api/resources')
        return route.fulfill({ json: { nodes: [], workspaces: [] } });
      if (++reads === 1) {
        await first.promise;
        return route.fulfill({ status: 503 });
      }
      await filtered.promise;
      return route.fulfill({
        json: { [field]: [], page: 1, pageSize: 20, total: 0, hasMore: false }
      });
    });
    const snapshot = (name: string) =>
      page.screenshot({ path: info.outputPath(`${view}-${name}.png`), animations: 'disabled' });
    try {
      await page.goto(
        `${fixture.url}visual-alignment.html?list-hierarchy=${view}&controlled-reads&locale=en-US&theme=${mobile ? 'daylight' : 'vscode-dark-2026'}`
      );
      const table = page.locator(selector);
      const ring = table.getByRole('progressbar');
      const empty = table.getByText('No data', { exact: true });
      const message = page.locator('.mar-message--error');
      const statusRow = table.locator('tbody tr');
      await expect(table.getByRole('columnheader', { name: 'Name', exact: true })).toBeVisible();
      await expect(ring).toBeVisible();
      const loadingHeight = (await statusRow.boundingBox())!.height;
      await expect(empty).toHaveCount(0);
      await expect(page.locator('.mar-ui-loading')).toHaveCount(0);
      await snapshot('loading');
      first.resolve();
      await expect(empty).toBeVisible();
      await expect(message).toHaveCount(1);
      await expect(ring).toHaveCount(0);
      await snapshot('failed');
      await message.locator('.mar-message-close').click();
      await page.getByPlaceholder(searchPlaceholder).fill('no match');
      await expect(ring).toBeVisible();
      await expect(empty).toHaveCount(0);
      filtered.resolve();
      await expect(empty).toBeVisible();
      await expect(empty).toHaveCSS('font-size', mobile ? '11px' : '12px');
      expect((await statusRow.boundingBox())!.height).toBeCloseTo(loadingHeight, 1);
      await expect(message).toHaveCount(0);
      await expect(ring).toHaveCount(0);
      await snapshot('empty');
    } finally {
      first.resolve();
      filtered.resolve();
    }
  });
}

test('Skill and MCP configuration search fields are compact and fit narrow panels', async ({
  page
}, testInfo) => {
  for (const width of [1920, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(
      `${fixture.url}visual-alignment.html?list-hierarchy=skills&scope-columns&theme=vscode-dark-2026`
    );
    for (const [tab, placeholder] of [
      ['Skill', 'Search skill names or descriptions'],
      ['MCP', 'Search MCP servers']
    ]) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      const input = page.getByPlaceholder(placeholder);
      await expect(input).toBeVisible();
      const filters = page.locator('.skill-filter-bar, .mcp-filter-bar').filter({ has: input });
      const field = filters.locator('.mar-ui-input');
      const bounds = (await filters.boundingBox())!;
      const search = (await field.boundingBox())!;
      const target = page.locator('.target-panel:visible, .mcp-target-panel:visible');
      const segmented = target.getByRole('radiogroup');
      const select = target.getByRole('combobox').first();
      const selectBounds = (await select.boundingBox())!;
      expect((await segmented.boundingBox())!.height).toBeCloseTo(selectBounds.height, 0);
      const size = await select.evaluate((element) => getComputedStyle(element).fontSize);
      await expect(segmented).toHaveCSS('font-size', size);
      await expect(input).toHaveCSS('font-size', size);
      expect(
        await input.evaluate((element) => getComputedStyle(element, '::placeholder').fontSize)
      ).toBe(size);
      await expect(input).toHaveCSS('font-weight', '400');
      const selectedRadio = segmented.getByRole('radio', { checked: true });
      await expect(selectedRadio).toHaveCount(1);

      const all = filters.getByRole('button', { name: 'All', exact: true });
      const engineering = filters.getByRole('button', { name: 'Engineering', exact: true });
      await expect(all).toHaveAttribute('aria-pressed', 'true');
      await expect(engineering).toHaveAttribute('aria-pressed', 'false');
      expect((await all.boundingBox())!.height).toBeCloseTo(selectBounds.height, 0);
      await expect(all).toHaveCSS('font-size', size);
      const table = page.locator('table:visible');
      const row = table.locator('tbody tr').first();
      await expect(row).toBeVisible();
      await expect(row.getByRole('cell').first()).toHaveCSS('padding-block-start', '3px');
      await expect(row.getByRole('cell').first()).toHaveCSS('padding-block-end', '3px');
      await expect(table.getByRole('columnheader').first()).toHaveCSS(
        'font-size',
        width >= 768 ? '12px' : '11px'
      );
      await expect(table).toHaveCSS('font-size', width >= 768 ? '13px' : '12px');
      await engineering.press('Enter');
      await expect(engineering).toHaveAttribute('aria-pressed', 'true');
      await expect(all).toHaveAttribute('aria-pressed', 'false');
      await all.click();
      await expect(all).toHaveAttribute('aria-pressed', 'true');
      expect(search.x).toBeCloseTo(bounds.x, 0);
      expect(search.width).toBeCloseTo(Math.min(320, bounds.width), 0);
      expect(search.x + search.width).toBeLessThanOrEqual(width);
      await filters.screenshot({ path: testInfo.outputPath(`${tab}-filters-${width}.png`) });
      await page.screenshot({ path: testInfo.outputPath(`${tab}-configuration-${width}.png`) });
    }
  }
});

for (const [view, tab, tableSelector, entry] of [
  ['skills', 'Installed Skills', '.installed-skill-table', 'Local skill'],
  ['mcp', 'Installed MCP Servers', '.mcp-config-table', 'Local MCP']
] as const) {
  test(`${tab} keeps the target snapshot if catalog metadata fails`, async ({ page }) => {
    const inspection = Promise.withResolvers<void>();
    let targetReads = 0;
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/resources')
        return route.fulfill({ json: { nodes: [{ id: 'node' }], workspaces: [] } });
      if (url.pathname.startsWith('/api/nodes/node/')) {
        targetReads++;
        await inspection.promise;
        return route.fulfill({
          json: {
            targetKind: 'NODE',
            compatibilityMode: 'SYMLINK',
            skills: [{ name: 'Local skill', description: '', localStatus: 'VALID' }],
            installations: [
              {
                catalogEntryId: 'local-mcp',
                serverName: 'local-mcp',
                displayName: 'Local MCP',
                version: '1.0.0',
                origin: 'NODE',
                enabled: true,
                status: 'CURRENT',
                installedAt: 1
              }
            ]
          }
        });
      }
      if (url.searchParams.has('ids')) return route.fulfill({ status: 503 });
      return route.fulfill({
        json: { entries: [], favorites: [], page: 1, pageSize: 20, total: 0, hasMore: false }
      });
    });
    try {
      await page.goto(
        `${fixture.url}visual-alignment.html?list-hierarchy=${view}&controlled-reads&inspect-target&locale=en-US`
      );
      await page.getByRole('tab', { name: tab }).click();
      const table = page.locator(tableSelector);
      await expect(table.getByRole('columnheader', { name: 'Name', exact: true })).toBeVisible();
      await expect(table.getByRole('progressbar')).toBeVisible();
      await expect(page.locator('.mar-ui-loading')).toHaveCount(0);
      inspection.resolve();
      await expect(table.getByText(entry, { exact: true })).toBeVisible();
      await expect(table.getByRole('progressbar')).toHaveCount(0);
      await expect(page.locator('.mar-message--error')).toHaveCount(1);
      expect(targetReads).toBe(1);
    } finally {
      inspection.resolve();
    }
  });
}

for (const theme of ['daylight', 'vscode-dark-2026']) {
  test(`Skill and MCP source management search fields stay compact in ${theme}`, async ({
    page
  }, testInfo) => {
    const locale = theme === 'vscode-dark-2026' ? 'zh-CN' : 'en-US';
    for (const width of [1620, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      for (const view of ['sources', 'mcp-sources']) {
        await page.goto(
          `${fixture.url}visual-alignment.html?list-hierarchy=${view}&scope-columns&theme=${theme}&locale=${locale}`
        );
        const toolbar = page.locator('.source-search-bar');
        const group = toolbar.locator('.mar-ui-input');
        const source = toolbar.locator('.mar-ui-select');
        const button = group.getByRole('button', { name: /^(Search|搜索)$/u });
        await expect(button).toBeEnabled();
        const filterSize = await source
          .getByRole('combobox')
          .evaluate((control) => getComputedStyle(control).fontSize);
        await expect(group.getByRole('textbox')).toHaveCSS('font-size', filterSize);
        const frame = (await toolbar.boundingBox())!;
        const search = (await group.boundingBox())!;
        const select = (await source.boundingBox())!;
        expect(search.x + search.width).toBeLessThanOrEqual(width);
        if (width === 1620) {
          expect(search.width).toBeCloseTo(360, 0);
          expect(search.x - (select.x + select.width)).toBeCloseTo(12, 0);
          expect(search.y + search.height / 2).toBeCloseTo(select.y + select.height / 2, 0);
        } else {
          expect(search.width).toBeCloseTo(frame.width, 0);
          expect(search.x).toBeCloseTo(select.x, 0);
          expect(search.y).toBeGreaterThan(select.y + select.height);
        }
        await toolbar.screenshot({ path: testInfo.outputPath(`${view}-search-${width}.png`) });

        await page.getByRole('tab').last().click();
        const filters = page.locator('.catalog-filter-bar, .mcp-toolbar');
        const catalogSearch = filters.locator('.mar-ui-input');
        await expect(catalogSearch.getByRole('textbox')).toBeVisible();
        await expect(catalogSearch.getByRole('textbox')).toHaveCSS('font-size', filterSize);
        if (view === 'mcp-sources') {
          await expect(filters.getByRole('combobox')).toHaveCSS('font-size', filterSize);
        }
        const filtersBounds = (await filters.boundingBox())!;
        const field = (await catalogSearch.boundingBox())!;
        expect(field.width).toBeCloseTo(width === 1620 ? 320 : filtersBounds.width, 0);
        expect(field.x).toBeCloseTo(filtersBounds.x, 0);
        expect(field.x + field.width, `${view} catalog at ${width}px`).toBeLessThanOrEqual(width);
      }
    }
  });

  test(`Source management only lays out the selected tab in ${theme}`, async ({ page }) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const view of ['sources', 'mcp-sources']) {
        await page.goto(
          `${fixture.url}visual-alignment.html?list-hierarchy=${view}&scope-columns&theme=${theme}`
        );
        const tabs = page.getByRole('tab');
        await expect(tabs).toHaveCount(2);
        const sourceTab = tabs.nth(0);
        const catalogTab = tabs.nth(1);
        const panels = page.locator('.mar-ui-tab-pane');
        await expect(sourceTab).toHaveAttribute('aria-selected', 'true');
        await expect(panels.nth(0)).toBeVisible();
        await expect(panels.nth(1)).toHaveCSS('display', 'none');
        await catalogTab.click();
        await expect(panels.nth(0)).toHaveCSS('display', 'none');
        await expect(panels.nth(1)).toBeVisible();
        if (view === 'mcp-sources') {
          const filters = panels.nth(1).locator('.mcp-toolbar');
          const search = await filters.locator('.mar-ui-input').boundingBox();
          const category = await filters.locator('.mar-ui-select').boundingBox();
          expect(search).not.toBeNull();
          expect(category).not.toBeNull();
          if (width === 1280) {
            expect(Math.abs(category!.y - search!.y)).toBeLessThan(2);
            expect(category!.x).toBeGreaterThan(search!.x + search!.width);
          } else {
            expect(category!.y).toBeGreaterThan(search!.y + search!.height);
            expect(Math.abs(category!.x - search!.x)).toBeLessThan(2);
          }
        }
        await sourceTab.click();
        await expect(panels.nth(0)).toBeVisible();
        await expect(panels.nth(1)).toHaveCSS('display', 'none');
      }
    }
  });

  test(`Skills source search has one control frame in ${theme}`, async ({ page }, testInfo) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(
        `${fixture.url}visual-alignment.html?list-hierarchy=sources&scope-columns&theme=${theme}`
      );
      const group = page.locator('.source-search-bar .mar-ui-input');
      const search = group.getByRole('button', { name: 'Search', exact: true });
      await expect(search).toBeEnabled();
      const idleFrame = await group.evaluate((el) => getComputedStyle(el).boxShadow);
      const idleBackground = await search.evaluate((el) => getComputedStyle(el).backgroundColor);
      await search.hover();
      await expect(search).not.toHaveCSS('background-color', idleBackground);
      await expect(search).toHaveCSS('border-top-width', '0px');
      await expect(group).toHaveCSS('box-shadow', idleFrame);
      const bar = page.locator('.source-search-bar');
      const unusedHeight = await bar.evaluate((el) => {
        const frame = el.getBoundingClientRect();
        const input = el.querySelector('.mar-ui-input')!.getBoundingClientRect();
        return frame.bottom - input.bottom;
      });
      expect(unusedHeight).toBeLessThanOrEqual(4);
      await bar.screenshot({
        path: testInfo.outputPath(`source-search-hover-${width}.png`)
      });
    }
  });

  test(`Source and catalog scope labels stay readable on one line in ${theme}`, async ({
    page
  }, testInfo) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const view of ['sources', 'mcp-sources']) {
        await page.goto(
          `${fixture.url}visual-alignment.html?list-hierarchy=${view}&scope-columns&theme=${theme}`
        );
        for (const catalog of [false, true]) {
          if (catalog) await page.getByRole('tab').last().click();
          const table = catalog
            ? '.catalog-skill-table, .catalog-mcp-table'
            : '.skill-source-table, .mcp-source-table';
          const labels = page
            .locator(table)
            .locator('.mar-ui-table__value')
            .filter({ hasText: /^(Enterprise|Organization|Personal)$/u });
          await expect(labels).toHaveCount(3);
          for (const label of await labels.all()) {
            await label.scrollIntoViewIfNeeded();
            await expect(label).toBeInViewport();
            const metrics = await label.evaluate((element) => {
              const textNodes = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
              const range = document.createRange();
              const lines = new Set<number>();
              for (let text = textNodes.nextNode(); text; text = textNodes.nextNode()) {
                if (!text.textContent?.trim()) continue;
                range.selectNodeContents(text);
                for (const rect of range.getClientRects()) {
                  if (rect.width > 0) lines.add(rect.top);
                }
              }
              const bounds = element.getBoundingClientRect();
              return {
                textLines: lines.size,
                fits: element.scrollWidth <= element.clientWidth,
                left: bounds.left,
                right: bounds.right,
                viewportWidth: innerWidth
              };
            });
            expect(metrics.textLines).toBe(1);
            expect(metrics.fits).toBe(true);
            expect(metrics.left).toBeGreaterThanOrEqual(0);
            expect(metrics.right).toBeLessThanOrEqual(metrics.viewportWidth);
          }
          await page.screenshot({
            path: testInfo.outputPath(`${view}-${catalog ? 'catalog' : 'sources'}-${width}.png`)
          });
        }
      }
    }
  });

  test(`Notification titles match recent session typography in ${theme}`, async ({ page }) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${fixture.url}visual-alignment.html?list-hierarchy=recent&theme=${theme}`);
      const recent = page.locator('.recent-session-title').first();
      await expect(recent).toBeVisible();
      const typography = await recent.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          lineHeight: style.lineHeight
        };
      });
      await page.goto(
        `${fixture.url}visual-alignment.html?long-notification=1&theme=${theme}${width < 768 ? '&mobile=1' : ''}`
      );
      await page.locator('.activity-center-trigger').click();
      await page.getByRole('tab', { name: /^Notifications/ }).click();
      const title = page.locator('.workbench-notification-title strong').first();
      await expect(title).toBeVisible();
      await expect(title).toHaveCSS('font-size', typography.fontSize);
      await expect(title).toHaveCSS('font-weight', typography.fontWeight);
      await expect(title).toHaveCSS('line-height', typography.lineHeight);
    }
  });

  test(`Theme apply uses an ordinary link while Active stays green in ${theme}`, async ({
    page
  }) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${fixture.url}visual-alignment.html?menus&theme=${theme}`);
      await page.mouse.move(0, 0);
      const palette = await colors(page);
      const active = page.getByRole('button', { name: 'Active', exact: true });
      await expect(active).toBeDisabled();
      await expect(active).toHaveCSS('color', palette.success);
      const target = page.locator('.theme-option').nth(theme === 'daylight' ? 0 : 1);
      const apply = target.getByRole('button', { name: 'Apply theme', exact: true });
      await expect(apply).toHaveClass(/mar-ui-button--inline/);
      await expect(apply).not.toHaveClass(/mar-ui-button--primary/);
      await expect(apply).toHaveCSS('color', palette.secondary);
      await expect(apply.locator('.mar-ui-button__icon')).toHaveCSS('color', palette.secondary);
      await apply.focus();
      await page.keyboard.press('Enter');
      await expect(target).toHaveClass(/active/);
      await expect(target.getByRole('button', { name: 'Active', exact: true })).toBeDisabled();
      await expect(target.getByRole('button', { name: 'Active', exact: true })).toHaveCSS(
        'color',
        (await colors(page)).success
      );
      await expect(page.locator('.theme-option.active')).toHaveCount(1);
    }
  });

  test(`Quick Open and recent sessions keep regular names and distinct semantics in ${theme}`, async ({
    page
  }, testInfo) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${fixture.url}visual-alignment.html?list-hierarchy=quick&theme=${theme}`);
      const palette = await colors(page);
      const rows = page.locator('.quick-open-results li');
      const filters = page.getByRole('group', { name: 'Result types', exact: true });
      const all = filters.getByRole('button', { name: 'All', exact: true });
      const files = filters.getByRole('button', { name: 'File', exact: true });
      await expect(all).toHaveAttribute('aria-pressed', 'true');
      await expect(all).toHaveCSS('background-color', palette.selected);
      await expect(rows).toHaveCount(2);
      await files.click();
      await expect(files).toHaveAttribute('aria-pressed', 'true');
      await expect(files).toHaveCSS('background-color', palette.selected);
      await expect(all).toHaveAttribute('aria-pressed', 'false');
      await expect(rows).toHaveCount(0);
      await all.click();
      await expect(rows).toHaveCount(2);
      await expect(rows.first().locator('.entry-name')).toHaveCSS('font-weight', '400');
      await expect(rows.first().locator('.entry-name')).toHaveCSS('color', palette.primary);
      await expect(rows.last().locator('.entry-name')).toHaveCSS('color', palette.secondary);
      const input = page.getByRole('textbox', { name: 'Quick Open', exact: true });
      const font = width >= 768 ? '12px' : '11px';
      await expect(input).toHaveCSS('font-size', font);
      expect(await input.evaluate((el) => getComputedStyle(el, '::placeholder').fontSize)).toBe(
        font
      );
      await page.locator('.quick-open-input').screenshot({
        path: testInfo.outputPath(`quick-open-search-${width}.png`)
      });
      await input.fill('Review');
      await expect(rows.first().locator('.quick-open-match').first()).toHaveCSS(
        'color',
        palette.match
      );
      await input.press('ArrowDown');
      await expect(rows.last()).toHaveAttribute('aria-selected', 'true');
      await expect(rows.last().locator('.entry-name')).toHaveCSS('font-weight', '400');
      await expect(rows.last().locator('.entry-name')).toHaveCSS('color', palette.primary);
      await expect(rows.first().locator('.entry-name')).toHaveCSS('color', palette.secondary);
      await input.press('Enter');
      await expect(page.getByTestId('opened')).toHaveText('Review second');

      await page.goto(`${fixture.url}visual-alignment.html?list-hierarchy=recent&theme=${theme}`);
      for (const title of await page.locator('.recent-session-title').all()) {
        await expect(title).toHaveCSS('font-weight', '400');
        await expect(title).toHaveCSS('color', (await colors(page)).primary);
      }
      const statuses = page.locator('.recent-sessions-list .mar-ui-tag');
      await expect(statuses).toHaveCount(2);
      const recentPalette = await colors(page);
      await expect(statuses.first()).toHaveText('Running');
      await expect(statuses.first()).toHaveCSS('color', recentPalette.success);
      await expect(statuses.last()).toHaveAttribute('data-type', 'info');
      await expect(statuses.last()).toHaveCSS('color', recentPalette.secondary);
      await page.locator('.recent-sessions-list button').last().click();
      await expect(page.getByTestId('opened')).toHaveText('Review second');
    }
  });

  test(`Skill and MCP categories select without bold text or brand fill in ${theme}`, async ({
    page
  }) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const view of ['skills', 'mcp', 'sources']) {
        await page.goto(
          `${fixture.url}visual-alignment.html?list-hierarchy=${view}&theme=${theme}`
        );
        if (view === 'sources') await page.getByRole('tab').last().click();
        const strip = page.locator('.skill-category-strip, .mcp-category-strip');
        const engineering = strip.getByRole('button', { name: 'Engineering', exact: true });
        await expect(engineering).toBeVisible();
        const palette = await colors(page);
        const before = await engineering.boundingBox();
        await expect(engineering).toHaveCSS('font-weight', '400');
        await engineering.click();
        await expect(engineering).toHaveAttribute('aria-pressed', 'true');
        await expect(engineering).toHaveCSS('font-weight', '400');
        await expect(engineering).toHaveCSS('color', palette.primary);
        await expect(engineering).toHaveCSS('background-color', palette.selected);
        expect((await engineering.boundingBox())!.width).toBe(before!.width);
        await engineering.hover();
        await expect(engineering).toHaveCSS('background-color', palette.selected);
        const writing = strip.getByRole('button', { name: 'Writing', exact: true });
        await writing.hover();
        await expect(writing).toHaveCSS('background-color', palette.hover);
        await expect(writing).toHaveCSS('font-weight', '400');
        await writing.press('Enter');
        await expect(writing).toHaveAttribute('aria-pressed', 'true');
        await expect(engineering).toHaveAttribute('aria-pressed', 'false');
      }
    }
  });

  for (const width of [1280, 390]) {
    test(`Composer selectors separate neutral hover from keyboard focus in ${theme} at ${width}px`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(
        `${fixture.url}visual-alignment.html?select-states&model-options&theme=${theme}${width < 768 ? '&mobile' : ''}`
      );
      for (const custom of [false, true]) {
        if (custom)
          await page.locator('html').evaluate((element) => {
            for (const [token, value] of Object.entries({
              '--mar-conversation-activity-fg': '#bf6ac9',
              '--mar-control-focus': '#8899aa',
              '--mar-text-primary': '#dae5cf',
              '--mar-action-hover-overlay': 'rgba(91, 112, 120, 0.24)',
              '--mar-fill-row-hover': '#334455',
              '--mar-fill-selection': '#445566',
              '--mar-border-medium': '#718293'
            }))
              element.style.setProperty(token, value);
          });
        const palette = await colors(page);
        const borders = await page.locator('html').evaluate((element) => {
          const probe = document.createElement('span');
          element.append(probe);
          probe.style.color = 'var(--mar-control-focus)';
          const focus = getComputedStyle(probe).color;
          probe.style.color = 'var(--mar-border-medium)';
          const hover = getComputedStyle(probe).color;
          probe.remove();
          return { focus, hover };
        });
        for (const kind of ['runner', 'access', 'model-effort']) {
          const select = page.locator(`.composer-${kind}-select`);
          const input = select.getByRole('combobox');
          const wrapper = select.locator('.mar-ui-select__field');
          await page.getByRole('button', { name: 'Open hint dialog', exact: true }).focus();
          if (kind !== 'runner') {
            await page.mouse.move(0, 0);
            await expect(wrapper).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
            await expect(wrapper).toHaveCSS('box-shadow', 'none');
            await expect(wrapper.locator('.mar-ui-select__label')).toHaveCSS(
              'color',
              palette.primary
            );
            await expect(wrapper.locator('[data-mar-icon="chevron-down"]')).toHaveCSS(
              'color',
              palette.secondary
            );
            await wrapper.hover();
            await expect(wrapper).toHaveCSS('background-color', palette.actionHover);
            await expect(wrapper).toHaveCSS('box-shadow', 'none');
            await input.click();
            await page.mouse.move(0, 0);
            await expect(input).toHaveAttribute('aria-expanded', 'true');
            await expect(wrapper).toHaveCSS('background-color', palette.actionHover);
            await expect(wrapper).toHaveCSS('outline-style', 'none');
            await input.press('Escape');
            await expect(input).toHaveAttribute('aria-expanded', 'false');
            await expect(input).toBeFocused();
            await page.keyboard.press('Shift+Tab');
            await page.keyboard.press('Tab');
            await expect(input).toBeFocused();
            await expect(wrapper).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
            await expect(wrapper).toHaveCSS('outline-style', 'solid');
            await expect(wrapper).toHaveCSS('outline-color', borders.focus);
          } else {
            await wrapper.hover();
            await expect(wrapper).toHaveCSS('box-shadow', `${borders.hover} 0px 0px 0px 1px inset`);
            await input.focus();
            await expect(wrapper).toHaveCSS('box-shadow', `${borders.focus} 0px 0px 0px 1px inset`);
          }
          await input.press('ArrowDown');
          const dropdown = page.locator(`[role="listbox"].composer-${kind}-popper:visible`);
          const selected = dropdown.locator(
            '[role="option"][aria-selected="true"], .composer-model-effort-option-selected'
          );
          await expect(selected).toHaveCount(kind === 'model-effort' ? 2 : 1);
          for (const option of await selected.all()) {
            await expect(option).toHaveCSS('color', palette.primary);
            await expect(option).toHaveCSS('font-weight', '400');
            await option.hover();
            await expect(option).toHaveCSS('background-color', palette.selected);
          }
          const other = dropdown.getByRole('option', {
            name: kind === 'runner' ? 'Codex' : kind === 'access' ? 'Ask' : 'Model Two',
            exact: true
          });
          await other.hover();
          await expect(other).toHaveCSS('background-color', palette.overlayHover);
          if (!custom)
            await dropdown.screenshot({ path: testInfo.outputPath(`${kind}-${width}.png`) });
          await input.press('Escape');
          await expect(dropdown).toBeHidden();
        }
      }
    });
  }

  test(`Disabled Composer model keeps its separate foreground in ${theme}`, async ({ page }) => {
    await page.goto(
      `${fixture.url}visual-alignment.html?model-options&disabled-model&theme=${theme}`
    );
    const select = page.locator('.composer-model-effort-select');
    await expect(select.getByRole('combobox')).toBeDisabled();
    const disabled = await select.evaluate((element) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--mar-text-disabled)';
      element.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    await expect(select.locator('.mar-ui-select__label')).toHaveCSS('color', disabled);
    await expect(select.locator('[data-mar-icon="chevron-down"]')).toHaveCSS('color', disabled);
    const field = select.locator('.mar-ui-select__field');
    await field.hover();
    await expect(field).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(field).toHaveCSS('box-shadow', 'none');
  });

  test(`Settings navigation and model choices keep regular selected text in ${theme}`, async ({
    page
  }) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${fixture.url}workbench-mobile-drawer.html?theme=${theme}`);
      for (const icon of ['settings', 'administration']) {
        await page.locator(`.nav-menu-button:has([data-mar-icon="${icon}"])`).click();
        await expect(page.locator('.settings-nav button.active')).toHaveCSS('font-weight', '400');
      }
      await page.goto(
        `${fixture.url}visual-alignment.html?model-options&theme=${theme}${width < 768 ? '&mobile' : ''}`
      );
      const select = page.locator('.composer-model-effort-select');
      await select.click();
      const dropdown = page.locator('[role="listbox"].composer-model-effort-popper:visible');
      const selected = dropdown.locator('.composer-model-effort-option-selected');
      await expect(selected).toHaveCount(2);
      for (const option of await selected.all()) {
        await expect(option).toHaveCSS('font-weight', '400');
        await expect(option).toHaveCSS('background-color', (await colors(page)).selected);
      }
      await dropdown.getByRole('option', { name: 'high', exact: true }).click();
      await select.click();
      await expect(selected.filter({ hasText: 'high' })).toHaveCount(1);
      await expect(selected.filter({ hasText: 'Model One' })).toHaveCount(1);
      await dropdown.getByRole('option', { name: 'Model Two', exact: true }).click();
      await select.click();
      await expect(selected.filter({ hasText: 'high' })).toHaveCount(1);
      await expect(selected.filter({ hasText: 'Model Two' })).toHaveCount(1);
      await expect(selected.filter({ hasText: 'Model Two' })).toHaveCSS('font-weight', '400');
    }
  });

  test(`Mail and model catalogs use regular readable names in ${theme}`, async ({
    page
  }, testInfo) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${fixture.url}visual-alignment.html?theme=${theme}`);
      await page.getByRole('button', { name: 'View email templates', exact: true }).click();
      const choices = page.locator('.template-choice');
      const palette = await colors(page);
      for (const name of await choices.locator('.template-choice__name').all()) {
        await expect(name).toHaveCSS('font-weight', '400');
      }
      await expect(choices.first().locator('.template-choice__name')).toHaveCSS(
        'color',
        palette.primary
      );
      await expect(choices.last().locator('.template-choice__name')).toHaveCSS(
        'color',
        palette.secondary
      );
      await expect(choices.first().locator('.template-choice__meta')).toHaveCSS(
        'font-weight',
        '400'
      );
      await expect(choices.first().locator('.template-choice__meta')).toHaveCSS(
        'color',
        palette.secondary
      );
      await choices.last().click();
      await expect(choices.last().locator('.template-choice__name')).toHaveCSS(
        'color',
        palette.primary
      );
      await expect(choices.first().locator('.template-choice__name')).toHaveCSS(
        'color',
        palette.secondary
      );

      await page.goto(`${fixture.url}visual-alignment.html?list-hierarchy=models&theme=${theme}`);
      await page.getByRole('tab', { name: 'OAuth credentials', exact: true }).click();
      await page.locator('.mar-ui-table__row').filter({ hasText: 'Catalog credential' }).click();
      await page.getByRole('button', { name: 'Load model catalog', exact: true }).click();
      const name = page.locator('.catalog-model-name');
      await expect(name).toHaveText('Catalog model');
      await expect(name).toHaveCSS('font-weight', '400');
      await expect(name).toHaveCSS('color', (await colors(page)).primary);
      await page.locator('.catalog-table-wrap tbody').getByRole('checkbox').check();
      await expect(name).toHaveCSS('font-weight', '400');
      await page.screenshot({
        path: testInfo.outputPath(`catalog-${width}.png`),
        animations: 'disabled'
      });
    }
  });
}
