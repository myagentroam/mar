import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

const entry = 'test/e2e/support/mar-table-pagination.html';
let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture(entry);
});
test.afterAll(async () => {
  await fixture?.close();
});
test.beforeEach(async ({ page }) => {
  await page.goto(`${fixture.url}mar-table-pagination.html`);
});

test('Table sorts stable rows locally, delegates custom sorting, and preserves slots', async ({
  page
}) => {
  const table = page.getByRole('table', { name: 'Records' });
  const body = table.locator('tbody');
  const zulu = body.getByRole('row').filter({ hasText: 'Zulu' });
  const original = await zulu.elementHandle();
  const name = table.getByRole('columnheader', { name: 'Name' });
  await expect(body.getByRole('row').first()).toContainText('Zulu');
  await name.getByRole('button').press('Enter');
  await expect(name).toHaveAttribute('aria-sort', 'ascending');
  await expect(body.getByRole('row').first()).toContainText('Alpha');
  expect(await zulu.evaluate((row, previous) => row.isSameNode(previous), original)).toBe(true);
  await expect(name.getByRole('button')).toBeFocused();

  const remote = table.getByRole('columnheader', { name: 'Remote' });
  await remote.getByRole('button').click();
  await expect(page.getByRole('status', { name: 'Sort' })).toHaveText('details.value:ascending');
  await expect(name).not.toHaveAttribute('aria-sort');
  await expect(remote).toHaveAttribute('aria-sort', 'ascending');
  await expect(body.getByRole('row').first()).toContainText('Zulu');
  await page.getByRole('button', { name: 'Toggle column' }).click();
  await expect(table.getByRole('columnheader', { name: 'Extra' })).toBeVisible();
  await zulu.getByRole('button', { name: 'Act 0' }).click();
  await expect(page.getByRole('status', { name: 'Click' })).toHaveText('action:Zulu');
  await zulu.getByRole('cell', { name: 'Zulu' }).click();
  await expect(page.getByRole('status', { name: 'Click' })).toHaveText('Zulu');
});

test('Table uses solid neutral sort indicators and a low-contrast dark header surface', async ({
  page
}) => {
  const table = page.getByRole('table', { name: 'Records' });
  const name = table.getByRole('columnheader', { name: 'Name' });
  const button = name.getByRole('button');
  const ascending = button.locator('[data-sort-order="ascending"]');
  const descending = button.locator('[data-sort-order="descending"]');
  const [muted, primary] = await table.evaluate((element) => {
    const probe = document.createElement('span');
    element.before(probe);
    const colors = ['--mar-text-muted', '--mar-text-primary'].map((token) => {
      probe.style.color = `var(${token})`;
      return getComputedStyle(probe).color;
    });
    probe.remove();
    return colors;
  });

  await expect(name).toHaveCSS('background-color', 'rgb(34, 34, 34)');
  await expect(ascending).toHaveCSS('color', muted!);
  await expect(descending).toHaveCSS('color', muted!);
  expect(
    await ascending.evaluate((node) => getComputedStyle(node, '::before').borderBottomWidth)
  ).toBe('5px');
  expect(
    await descending.evaluate((node) => getComputedStyle(node, '::before').borderTopWidth)
  ).toBe('5px');

  await button.press('Enter');
  await expect(name).toHaveAttribute('aria-sort', 'ascending');
  await expect(ascending).toHaveCSS('color', primary!);
  await expect(descending).toHaveCSS('color', muted!);
  await expect(ascending).toHaveCSS('outline-style', 'none');
  await expect(button).toBeFocused();
  await descending.click();
  await expect(name).toHaveAttribute('aria-sort', 'descending');
  await expect(ascending).toHaveCSS('color', muted!);
  await expect(descending).toHaveCSS('color', primary!);
  await descending.click();
  await expect(name).not.toHaveAttribute('aria-sort');
  await expect(descending).toHaveCSS('color', muted!);

  await page.locator('html').evaluate((root) => root.removeAttribute('data-theme'));
  await expect(name).toHaveCSS('background-color', 'rgb(237, 243, 250)');
  await page.locator('html').evaluate((root) => {
    root.style.setProperty('--mar-table-header-bg', '#324951');
  });
  await expect(name).toHaveCSS('background-color', 'rgb(50, 73, 81)');
});

test('Table distinguishes the active direction in forced colors', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  const header = page.getByRole('table', { name: 'Records' }).getByRole('columnheader', {
    name: 'Name'
  });
  const button = header.getByRole('button');
  const ascending = button.locator('[data-sort-order="ascending"]');
  const descending = button.locator('[data-sort-order="descending"]');

  await expect(ascending).toHaveCSS('outline-style', 'none');
  await expect(descending).toHaveCSS('outline-style', 'none');
  await button.press('Enter');
  await expect(header).toHaveAttribute('aria-sort', 'ascending');
  await expect(ascending).toHaveCSS('outline-style', 'solid');
  await expect(descending).toHaveCSS('outline-style', 'none');
  await button.press('Enter');
  await expect(header).toHaveAttribute('aria-sort', 'descending');
  await expect(ascending).toHaveCSS('outline-style', 'none');
  await expect(descending).toHaveCSS('outline-style', 'solid');
  await button.press('Enter');
  await expect(header).not.toHaveAttribute('aria-sort');
  await expect(descending).toHaveCSS('outline-style', 'none');
  await expect(button).toBeFocused();
});

test('Table expands controlled details and tree branches without opening row actions', async ({
  page
}) => {
  const table = page.getByRole('table', { name: 'Records' });
  const disclosure = table.getByRole('button', { name: 'Expand row' }).first();
  await disclosure.press('Space');
  await expect(table.getByText('Details for Zulu')).toBeVisible();
  await expect(table.getByRole('button', { name: 'Collapse row' })).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  await expect(page.getByRole('status', { name: 'Click' })).toBeEmpty();
  await table.getByRole('button', { name: 'Collapse row' }).click();
  await expect(table.getByText('Details for Zulu')).toHaveCount(0);

  const zulu = table.getByRole('row').filter({ hasText: 'Zulu' });
  const alpha = table.getByRole('row').filter({ hasText: 'Alpha' });
  await alpha.getByRole('button', { name: 'Expand row' }).click();
  await zulu.getByRole('button', { name: 'Expand row' }).click();
  await expect(page.getByRole('status', { name: 'Expanded rows' })).toHaveText('b,a');
  await table.getByRole('columnheader', { name: 'Name' }).getByRole('button').press('Enter');
  await expect(page.getByRole('status', { name: 'Expanded rows' })).toHaveText('b,a');
  await zulu.getByRole('button', { name: 'Collapse row' }).click();
  await expect(page.getByRole('status', { name: 'Expanded rows' })).toHaveText('b');

  const tree = page.getByRole('table', { name: 'Organizations' });
  await expect(tree.getByRole('cell', { name: 'Child' })).toBeVisible();
  await tree.getByRole('button', { name: 'Collapse row' }).click();
  await expect(tree.getByRole('cell', { name: 'Child' })).toHaveCount(0);
  await tree.getByRole('button', { name: 'Expand row' }).click();
  await expect(tree.getByRole('cell', { name: 'Child' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Empty table' })).toContainText('Nothing here');
});

test('Table reapplies default expansion to a filtered tree without resetting on unrelated updates', async ({
  page
}) => {
  const tree = page.getByRole('table', { name: 'Organizations' });
  const match = tree.getByRole('cell', { name: 'Matching organization' });
  await expect(match).toBeVisible();
  await tree.getByRole('button', { name: 'Collapse row' }).click();
  await expect(match).toBeHidden();
  await page.getByRole('button', { name: 'Toggle column' }).click();
  await expect(match).toBeHidden();

  await page.getByRole('button', { name: 'Filter organizations' }).click();
  await expect(match).toBeVisible();
  await expect(tree.getByRole('cell', { name: 'Child', exact: true })).toHaveCount(0);
  await tree.getByRole('button', { name: 'Collapse row' }).click();
  await expect(match).toBeHidden();
});

test('Table keeps narrow overflow local and offers one enterable full-value hint', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 740 });
  const table = page.getByRole('table', { name: 'Records' });
  const viewport = page.getByRole('region', { name: 'Records' });
  expect(await viewport.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  const longCell = table.getByRole('cell', { name: /^Long unbroken/ });
  await longCell.scrollIntoViewIfNeeded();
  expect(
    await longCell
      .locator('[data-mar-table-overflow]')
      .evaluate((el) => el.scrollWidth > el.clientWidth)
  ).toBe(true);
  await longCell.hover();
  const hint = page.getByRole('tooltip');
  await expect(hint).toHaveText(/^Long unbroken value/);
  await hint.hover();
  await expect(hint).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(hint).toHaveCount(0);
});

test('Pagination keeps confirmed page, supports jumps and emits once when the range shrinks', async ({
  page
}) => {
  const pager = page.getByRole('navigation', { name: 'Pagination' });
  const requestLog = page.getByRole('status', { name: 'Requests' });
  const compactSize = await pager.evaluate((element) =>
    parseFloat(getComputedStyle(element).getPropertyValue('--mar-ui-compact-control-size'))
  );
  for (const button of await pager.getByRole('button').all()) {
    const box = (await button.boundingBox())!;
    expect(box.height).toBeCloseTo(compactSize, 0);
    expect(box.width).toBeGreaterThanOrEqual(compactSize);
  }
  await expect(pager.getByRole('button', { name: 'Go to previous page' })).toBeDisabled();
  await pager.getByRole('button', { name: 'Jump forward 3 pages' }).press('Space');
  await expect(requestLog).toHaveText('4');
  await expect(pager.getByRole('button', { name: 'Page 1', exact: true })).toHaveAttribute(
    'aria-current',
    'page'
  );
  await page.getByRole('button', { name: 'Accept page' }).click();
  await expect(pager.getByRole('button', { name: 'Page 4', exact: true })).toHaveAttribute(
    'aria-current',
    'page'
  );
  await page.getByRole('button', { name: 'Toggle disabled' }).click();
  await expect(pager.getByRole('button', { name: 'Go to next page' })).toBeDisabled();
  await page.getByRole('button', { name: 'Shrink total' }).click();
  await expect(requestLog).toHaveText('4,1');
  await expect(pager.getByRole('button', { name: 'Page 1', exact: true })).toHaveAttribute(
    'aria-current',
    'page'
  );
  await expect(pager.getByRole('button', { name: 'Go to next page' })).toBeDisabled();
});

test('Table refreshes the hint for the focused link and removes only its own description', async ({
  page
}) => {
  const note = page.getByRole('link', { name: /^Long unbroken value/ });
  await note.focus();
  const hint = page.getByRole('tooltip');
  await expect(hint).toHaveText(/^Long unbroken value/);
  const hintId = await hint.getAttribute('id');
  await expect(note).toHaveAttribute('aria-describedby', `note-context ${hintId}`);
  await page.getByRole('button', { name: 'Refresh note' }).evaluate((button) => button.click());
  const updated = page.getByRole('link', { name: /^Updated Long unbroken value/ });
  await expect(updated).toBeFocused();
  await expect(hint).toHaveText(/^Updated Long unbroken value/);
  await page.keyboard.press('Escape');
  await expect(updated).toBeFocused();
  await expect(updated).toHaveAttribute('aria-describedby', 'note-context');
  await expect(hint).toHaveCount(0);
});

test('Pagination keeps existing focus during loading but skips disabled controls on Tab', async ({
  page
}) => {
  const pager = page.getByRole('navigation', { name: 'Pagination' });
  const pageTwo = pager.getByRole('button', { name: 'Page 2', exact: true });
  await pageTwo.press('Enter');
  await expect(page.getByRole('status', { name: 'Requests' })).toHaveText('2');
  await page.getByRole('button', { name: 'Toggle disabled' }).evaluate((button) => button.click());
  await expect(pageTwo).toBeFocused();
  await expect(pageTwo).toBeDisabled();
  await page.keyboard.press('Space');
  await expect(page.getByRole('status', { name: 'Requests' })).toHaveText('2');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Accept page' })).toBeFocused();
});

test('Click does not reopen a cell hint from pointer focus, and scrolling dismisses it', async ({
  page
}) => {
  const link = page.getByRole('link', { name: /^Long unbroken value/ });
  const hint = page.getByRole('tooltip');
  await link.hover();
  await expect(hint).toBeVisible();
  await link.click();
  await expect(link).toBeFocused();
  await page.mouse.move(5, 5);
  await expect(hint).toHaveCount(0);
  await link.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(link).toBeFocused();
  await expect(hint).toBeVisible();
  await page.evaluate(() => {
    document.body.style.minHeight = '1500px';
    window.scrollBy(0, 120);
  });
  await expect(hint).toHaveCount(0);
  await expect(link).toBeFocused();
  await expect(link).toHaveAttribute('aria-describedby', 'note-context');
});

for (const moveFocus of [false, true]) {
  test(`Pagination ${moveFocus ? 'does not steal focus after the user moves on' : 'focuses the confirmed page when the focused jump disappears'}`, async ({
    page
  }) => {
    const pager = page.getByRole('navigation', { name: 'Pagination' });
    const confirm = page.getByRole('button', { name: 'Accept page' });
    await page.getByRole('button', { name: 'Use six pages' }).click();
    const jump = pager.getByRole('button', { name: 'Jump forward 3 pages' });
    await jump.press('Enter');
    await expect(jump).toBeFocused();
    if (moveFocus) await confirm.focus();
    await confirm.evaluate((button) => button.click());
    const current = pager.getByRole('button', { name: 'Page 4', exact: true });
    await expect(jump).toHaveCount(0);
    await expect(moveFocus ? confirm : current).toBeFocused();
    await expect(current).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('status', { name: 'Requests' })).toHaveText('4');
  });
}
