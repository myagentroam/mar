import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/management-page.html');
});
test.afterAll(async () => {
  await fixture?.close();
});

// @test-covers ee/web/src/view/settings/OAuthManagementPage.vue
// @test-covers ee/web/src/view/settings/OrganizationManagementPage.vue
for (const [area, section, endpoint] of [
  ['oauth', '.oauth-management', '/api/oauth-providers'],
  ['organization', '.organization-management', '/api/organizations']
] as const) {
  test(`${area} cold entry loads the shared table spinner styles`, async ({ page }) => {
    await page.goto(`${fixture.url}management-page.html?area=${area}`);
    await expect
      .poll(() => page.evaluate(() => window.managementPageFixture.calls()))
      .toEqual([endpoint]);
    const table = page.locator(section).locator('.mar-ui-table');
    const progress = table.getByRole('progressbar', { name: 'Loading' });
    const ring = progress.locator('.mar-busy-indicator');
    await expect(ring).toHaveCSS('display', 'inline-block');
    await expect(ring).toHaveCSS('border-top-width', '2px');
    await expect(ring).toHaveCSS('animation-duration', '1.2s');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(ring).toHaveCSS('animation-name', 'none');
    await page.evaluate(() => window.managementPageFixture.settle(0, true));
    await expect(progress).toHaveCount(0);
    await expect(table.getByText('No data', { exact: true })).toBeVisible();
  });
}

test('Audit initial failure reports an error and recovers through refresh on mobile', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${fixture.url}management-page.html?area=audit`);
  const section = page.locator('.audit-management');
  await expect.poll(() => page.evaluate(() => window.managementPageFixture.calls().length)).toBe(1);
  const table = section.locator('.mar-ui-table');
  const refresh = section.getByRole('button', { name: 'Refresh', exact: true });
  const indicator = table.getByRole('progressbar', { name: 'Loading' });
  await expect(indicator).toBeVisible();
  await expect(table.getByText('No data', { exact: true })).toHaveCount(0);
  await expect(refresh).toBeDisabled();
  await expect(refresh).not.toHaveAttribute('aria-busy', 'true');
  await page.evaluate(() => window.managementPageFixture.settle(0, false));
  const errors = page.locator('.mar-message--error');
  await expect(errors).toHaveCount(1);
  await expect(errors).toContainText('List request failed');
  await expect(table.getByText('No data', { exact: true })).toBeVisible();
  await expect(indicator).toHaveCount(0);
  await expect(section.locator('.management-mobile-status button')).toHaveCount(0);
  await refresh.click();
  await expect.poll(() => page.evaluate(() => window.managementPageFixture.calls().length)).toBe(2);
  await expect(indicator).toBeVisible();
  await expect(table.getByText('No data', { exact: true })).toHaveCount(0);
  await page.evaluate(() => window.managementPageFixture.settle(1, true));
  await expect(table.getByText('No data', { exact: true })).toBeVisible();
  await expect(indicator).toHaveCount(0);
  await expect(page.locator('.mar-message--success')).toHaveCount(0);
  await expect(section.locator('.management-mobile-status button')).toHaveCount(0);
});

test('Audit desktop page changes show one table loading indicator', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.url}management-page.html?area=audit&pages=1`);
  const section = page.locator('.audit-management');
  await expect.poll(() => page.evaluate(() => window.managementPageFixture.calls().length)).toBe(1);
  await page.evaluate(() => window.managementPageFixture.settle(0, true));
  await section.locator('.mar-ui-pagination__page').filter({ hasText: /^2$/ }).click();
  await expect.poll(() => page.evaluate(() => window.managementPageFixture.calls().length)).toBe(2);
  await expect(section.locator('.mar-ui-table').getByRole('progressbar')).toBeVisible();
  await expect(section.locator(':scope > .mar-ui-loading')).toBeHidden();
  await expect(section.getByRole('button', { name: 'Refresh', exact: true })).not.toHaveAttribute(
    'aria-busy',
    'true'
  );
  await page.evaluate(() => window.managementPageFixture.settle(1, true));
  await expect(section.locator('.mar-ui-table').getByRole('progressbar')).toHaveCount(0);
  await expect(section.locator('[aria-current="page"]')).toHaveText('2');
  await section.locator('.mar-ui-pagination__previous').click();
  await expect.poll(() => page.evaluate(() => window.managementPageFixture.calls().length)).toBe(3);
  await page.evaluate(() => window.managementPageFixture.settle(2, false));
  await expect(page.locator('.mar-message--error')).toContainText('List request failed');
  await expect(section.getByRole('button', { name: 'Failed to load. Retry' })).toHaveCount(0);
  await expect(section.locator('[aria-current="page"]')).toHaveText('2');
  await section.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.managementPageFixture.calls().length)).toBe(4);
  await page.evaluate(() => window.managementPageFixture.settle(3, true));
  await expect(section.locator('[aria-current="page"]')).toHaveText('1');
});

test('Audit retains rows during a full refresh but clears them after a failed read', async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.url}management-page.html?area=audit&pages=1`);
  const section = page.locator('.audit-management');
  const table = section.locator('.mar-ui-table');
  const rows = table.locator('tbody tr.mar-ui-table__row');
  const refresh = section.getByRole('button', { name: 'Refresh', exact: true });
  const indicator = table.getByRole('progressbar', { name: 'Loading' });
  await expect(indicator).toBeVisible();
  await page.evaluate(() => window.managementPageFixture.settle(0, true));
  await expect(rows).toHaveCount(20);
  await refresh.click();
  await expect(indicator).toBeVisible();
  await expect(rows).toHaveCount(20);
  await expect(refresh).toBeDisabled();
  await page.evaluate(() => window.managementPageFixture.settle(1, false));
  await expect(rows).toHaveCount(0);
  await expect(table.getByText('No data', { exact: true })).toBeVisible();
  await expect(page.locator('.mar-message--error')).toHaveCount(1);
  await expect(indicator).toHaveCount(0);
  await expect(refresh).toBeEnabled();
});

test('Usage details retain rows and retry a failed automatic page in place', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${fixture.url}management-page.html?area=usage`);
  const panel = page.getByTestId('usage-statistics');
  const count = () => page.evaluate(() => window.managementPageFixture.calls().length);
  await expect.poll(count).toBe(2);
  await page.evaluate(() =>
    Promise.all([
      window.managementPageFixture.settle(0, true),
      window.managementPageFixture.settle(1, true)
    ])
  );
  const rows = panel.locator('.records tbody tr.mar-ui-table__row');
  const boundary = panel.locator('.management-mobile-status');
  await expect(rows).toHaveCount(20);
  await boundary.scrollIntoViewIfNeeded();
  await expect.poll(count).toBe(3);
  await page.evaluate(() => window.managementPageFixture.settle(2, false));
  const retry = boundary.locator('button');
  await expect(retry).toBeVisible();
  await expect(retry).toHaveClass(/mar-ui-button--inline/);
  await expect(retry).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await retry.hover();
  await expect(retry).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(retry).toHaveAccessibleName('Failed to load. Retry');
  await expect(rows).toHaveCount(20);
  await retry.focus();
  await retry.press('Enter');
  await expect.poll(count).toBe(4);
  await expect(retry).toBeFocused();
  await expect(retry).toHaveAccessibleName('Loading');
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  await page.evaluate(() => window.managementPageFixture.settle(3, true));
  await expect(rows).toHaveCount(40);
  await expect(boundary.getByRole('button')).toHaveCount(0);
  const calls = await page.evaluate(() => window.managementPageFixture.calls());
  expect(new URL(calls[2]!, 'http://fixture').searchParams.get('page')).toBe('2');
  expect(new URL(calls[3]!, 'http://fixture').searchParams.get('page')).toBe('2');
});

// @test-covers packages/web-core/src/view/settings/UsageStatisticsSettings.vue
test('Usage distribution follows the theme activity color and preserves radio typography', async ({
  page
}, testInfo) => {
  await page.goto(`${fixture.url}management-page.html?area=usage`);
  await expect.poll(() => page.evaluate(() => window.managementPageFixture.calls().length)).toBe(2);
  await page.evaluate(() =>
    Promise.all([
      window.managementPageFixture.settle(0, true),
      window.managementPageFixture.settle(1, true)
    ])
  );
  const labels = page
    .getByTestId('usage-statistics')
    .locator('.section-heading .mar-ui-radio--button');
  const tracks = page.getByTestId('usage-statistics').locator('.distributions .bar-track');
  await expect(labels).toHaveCount(2);
  await expect(tracks).toHaveCount(3);
  await page.evaluate(() => {
    const sentinel = document.createElement('div');
    sentinel.className = 'section-heading';
    sentinel.dataset.testid = 'outside-usage-heading';
    sentinel.innerHTML = '<span>Outside usage</span>';
    document.body.append(sentinel);
  });
  for (const [theme, color] of [
    ['daylight', 'rgb(0, 95, 214)'],
    ['vscode-dark-2026', 'rgb(77, 163, 255)']
  ] as const) {
    await page.locator('html').evaluate((root, value) => (root.dataset.theme = value), theme);
    const outside = await page
      .getByTestId('outside-usage-heading')
      .locator('span')
      .evaluate((span) => {
        const actual = getComputedStyle(span);
        const body = getComputedStyle(document.body);
        return [actual.color, actual.fontSize, body.color, body.fontSize];
      });
    expect(outside.slice(0, 2)).toEqual(outside.slice(2));
    for (const selected of [0, 1]) {
      await labels.nth(selected).locator('label').click();
      await expect(labels.nth(selected).getByRole('radio')).toBeChecked();
      for (const track of await tracks.all()) {
        const fill = track.locator('span');
        await expect(fill).toBeVisible();
        await expect(fill).toHaveCSS('background-color', color);
      }
      const smallerModelShare = await tracks.last().evaluate((track) => {
        const fill = track.querySelector('span')!;
        return fill.getBoundingClientRect().width / track.getBoundingClientRect().width;
      });
      expect(smallerModelShare).toBeCloseTo(selected === 0 ? 1 / 3 : 1 / 2);
      if (selected === 0) {
        await page.locator('.distributions').screenshot({
          path: testInfo.outputPath(`usage-distribution-${theme}.png`)
        });
      }
      for (const label of await labels.all()) {
        await expect
          .poll(() =>
            label.locator('label').evaluate((span) => {
              const style = getComputedStyle(span);
              const probe = document.createElement('span');
              probe.style.color = span.matches('input:checked + label')
                ? 'var(--mar-text-primary)'
                : 'var(--mar-text-secondary)';
              probe.style.fontSize = 'var(--mar-font-size-meta)';
              span.append(probe);
              const expected = getComputedStyle(probe);
              const result = [style.color, style.fontSize, expected.color, expected.fontSize];
              probe.remove();
              return result.slice(0, 2).join('/') === result.slice(2).join('/');
            })
          )
          .toBe(true);
      }
    }
  }
  await page.locator('html').evaluate((root) => {
    root.style.setProperty('--mar-conversation-activity-fg', '#3167cc');
    root.style.setProperty('--mar-control-primary-bg', '#df7820');
  });
  for (const track of await tracks.all()) {
    await expect(track.locator('span')).toHaveCSS('background-color', 'rgb(49, 103, 204)');
  }
});

test('Resource append failure stops, refresh uses one indicator, and a new context rearms once', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${fixture.url}management-page.html`);
  const section = page.locator('.resource-management-panel');
  const rows = section.locator('tbody tr.mar-ui-table__row');
  const boundary = section.locator('.management-mobile-status');
  const table = section.locator('.mar-ui-table');
  const indicator = table.getByRole('progressbar', { name: 'Loading' });
  const refresh = section.getByRole('button', { name: 'Refresh', exact: true });
  await expect.poll(() => page.evaluate(() => window.managementPageFixture.calls().length)).toBe(1);
  await page.evaluate(() => window.managementPageFixture.settle(0, true));
  await expect(rows).toHaveCount(20);
  await boundary.scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(() => window.managementPageFixture.calls().length)).toBe(2);
  await page.evaluate(() => window.managementPageFixture.settle(1, false));
  await expect(boundary.getByRole('button', { name: 'Failed to load. Retry' })).toBeVisible();
  await expect(rows).toHaveCount(20);
  await refresh.click();
  await expect.poll(() => page.evaluate(() => window.managementPageFixture.calls().length)).toBe(3);
  await expect(boundary.locator('button')).toHaveCount(0);
  await expect(refresh).toBeDisabled();
  await expect(refresh).not.toHaveAttribute('aria-busy', 'true');
  await expect(indicator).toBeVisible();
  await expect(rows).toHaveCount(20);
  await expect(section.locator('.mar-ui-loading')).toBeHidden();
  await page.evaluate(() => window.managementPageFixture.settle(2, true));
  await expect(rows).toHaveCount(20);
  const input = section.locator('.mar-resource-filters input').first();
  await input.fill('Node');
  await expect.poll(() => page.evaluate(() => window.managementPageFixture.calls().length)).toBe(4);
  await expect(indicator).toBeVisible();
  await expect(rows).toHaveCount(0);
  await expect(table.getByText('No data', { exact: true })).toHaveCount(0);
  await page.evaluate(() => window.managementPageFixture.settle(3, true));
  await boundary.scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(() => window.managementPageFixture.calls().length)).toBe(5);
  const calls = await page.evaluate(() => window.managementPageFixture.calls());
  expect(new URL(calls[4]!, 'http://fixture').searchParams.get('page')).toBe('2');
  await page.evaluate(() => window.managementPageFixture.settle(4, true));
  await expect(rows).toHaveCount(40);
  expect(await page.evaluate(() => window.managementPageFixture.calls().length)).toBe(5);
});

test('Mobile tables preserve the reading position and append every page by continuing downward', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${fixture.url}management-page.html?many=1`);
  const section = page.locator('.resource-management-panel');
  const rows = section.locator('tbody tr.mar-ui-table__row');
  const boundary = section.locator('.management-mobile-status');
  const count = () => page.evaluate(() => window.managementPageFixture.calls().length);
  await expect.poll(count).toBe(1);
  await page.evaluate(() => window.managementPageFixture.settle(0, true));
  await expect(rows).toHaveCount(20);
  const geometry = await section.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight
  }));
  expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
  await section.hover({ position: { x: 150, y: 400 } });
  const scrollDown = async () => {
    for (let step = 0; step < 12; step++) {
      const position = await section.evaluate((element) => ({
        top: element.scrollTop,
        bottom: element.scrollHeight - element.clientHeight
      }));
      if (position.top >= position.bottom - 1) return;
      await page.mouse.wheel(0, 5000);
      await expect
        .poll(() => section.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(position.top);
    }
    throw new Error('The management container did not reach its next page boundary');
  };

  for (let nextPage = 2; nextPage <= 5; nextPage++) {
    await expect(boundary).not.toBeInViewport();
    await scrollDown();
    await expect.poll(count).toBe(nextPage);
    const previousTop = await section.evaluate((element) => element.scrollTop);
    await page.evaluate((index) => window.managementPageFixture.settle(index, true), nextPage - 1);
    await expect(rows).toHaveCount(Math.min(nextPage * 20, 85));
    const currentTop = await section.evaluate((element) => element.scrollTop);
    expect(Math.abs(currentTop - previousTop)).toBeLessThanOrEqual(2);
    await expect(boundary).not.toBeInViewport();
    expect(await count()).toBe(nextPage);
  }

  await scrollDown();
  await expect(boundary).toBeInViewport();
  expect(await count()).toBe(5);
  const calls = await page.evaluate(() => window.managementPageFixture.calls());
  expect(calls.map((path) => new URL(path, 'http://fixture').searchParams.get('page'))).toEqual([
    '1',
    '2',
    '3',
    '4',
    '5'
  ]);
});

test('A continuously visible boundary loads only once per new query context', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 3600 });
  await page.goto(`${fixture.url}management-page.html?tall=1`);
  const section = page.locator('.resource-management-panel');
  const boundary = section.locator('.management-mobile-status');
  const count = () => page.evaluate(() => window.managementPageFixture.calls().length);
  const settle = (index: number) =>
    page.evaluate((value) => window.managementPageFixture.settle(value, true), index);
  const drainObservers = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 250)))
        )
    );
  await expect.poll(count).toBe(1);
  await settle(0);
  await expect(boundary).toBeInViewport();
  await expect.poll(count).toBe(2);
  await settle(1);
  await expect(section.locator('tbody tr.mar-ui-table__row')).toHaveCount(40);
  await expect(boundary).toBeInViewport();
  await drainObservers();
  expect(await count()).toBe(2);

  await section.locator('.mar-resource-filters input').first().fill('Node');
  await expect.poll(count).toBe(3);
  await settle(2);
  await expect(boundary).toBeInViewport();
  await expect.poll(count).toBe(4);
  const calls = await page.evaluate(() => window.managementPageFixture.calls());
  expect(new URL(calls[3]!, 'http://fixture').searchParams.get('page')).toBe('2');
  await settle(3);
  await expect(section.locator('tbody tr.mar-ui-table__row')).toHaveCount(40);
  await expect(boundary).toBeInViewport();
  await drainObservers();
  expect(await count()).toBe(4);
});
