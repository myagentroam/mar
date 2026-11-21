import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

test('a filterable multiple select creates tags without crossing the selection limit', async ({
  page
}) => {
  await page.goto(`${fixture.url}mar-select.html`);
  const tags = page.getByRole('combobox', { name: 'Catalog tags' });
  const list = page.getByRole('listbox', { name: 'Catalog tags' });
  await tags.click();
  await expect(list).toHaveClass(/test-tags-popup/u);
  await expect(list).toHaveAttribute('aria-multiselectable', 'true');
  await expect(list.getByRole('option', { name: 'Pinned tag' })).toBeDisabled();
  await tags.fill('Alpha');
  await expect(list.getByRole('group', { name: 'Pinned' })).toHaveCount(0);
  await expect(list.getByRole('option')).toHaveCount(1);
  const field = page.locator('.mar-ui-select__field').filter({ has: tags });
  expect((await list.boundingBox())!.width).toBeCloseTo((await field.boundingBox())!.width, 0);
  await tags.press('Enter');
  await expect(page.getByTestId('tags')).toHaveText('["pinned","alpha"]');
  await tags.fill('新标记');
  await tags.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  await expect(page.getByTestId('tags')).toHaveText('["pinned","alpha"]');
  await tags.press('Enter');
  await expect(page.getByTestId('tags')).toHaveText('["pinned","alpha","新标记"]');
  await expect(list.getByRole('option', { name: 'Bravo' })).toBeDisabled();
  await tags.fill('Another tag');
  await tags.press('Enter');
  await expect(page.getByTestId('tags')).toHaveText('["pinned","alpha","新标记"]');
  await tags.press('Escape');
  await expect(list).toBeHidden();
  await expect(tags).toHaveValue('');
  await tags.press('Backspace');
  await expect(page.getByTestId('tags')).toHaveText('["pinned","alpha"]');
  await page
    .locator('.mar-ui-select')
    .filter({ has: tags })
    .getByRole('button', { name: 'Clear', exact: true })
    .click();
  await expect(page.getByTestId('tags')).toHaveText('["pinned"]');
  await expect(tags).toBeFocused();
  await tags.press('ArrowDown');
  await page.screenshot({ path: test.info().outputPath('filterable-tags.png') });
});

test('the open tag menu stays anchored when the selected tags wrap', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${fixture.url}mar-select.html`);
  const tags = page.getByRole('combobox', { name: 'Catalog tags' });
  const select = page.locator('.mar-ui-select').filter({ has: tags });
  const field = select.locator('.mar-ui-select__field');
  await select.evaluate((element) => element.style.setProperty('width', '170px'));
  const list = page.getByRole('listbox', { name: 'Catalog tags' });
  await tags.click();
  const initialField = (await field.boundingBox())!;
  const initialList = (await list.boundingBox())!;
  const gap = initialList.y - initialField.y - initialField.height;
  expect(gap).toBeGreaterThan(0);

  await tags.press('Enter');
  await expect(page.getByTestId('tags')).toHaveText('["pinned","alpha"]');
  const wrappedField = (await field.boundingBox())!;
  expect(wrappedField.height).toBeGreaterThan(initialField.height);
  await expect
    .poll(async () => (await list.boundingBox())!.y)
    .toBeCloseTo(wrappedField.y + wrappedField.height + gap, 0);
  await expect(tags).toBeFocused();
  await page.screenshot({ path: info.outputPath('wrapped-tags-popup.png') });

  await tags.press('Backspace');
  await expect(page.getByTestId('tags')).toHaveText('["pinned"]');
  await expect.poll(async () => (await list.boundingBox())!.y).toBeCloseTo(initialList.y, 0);
  await select.evaluate((element) => element.style.setProperty('width', '230px'));
  await expect.poll(async () => (await list.boundingBox())!.width).toBe(230);
  expect(errors).toEqual([]);
});

test('data options preserve falsy values when loading, choosing and clearing', async ({ page }) => {
  await page.goto(`${fixture.url}mar-select.html`);
  const state = page.getByRole('combobox', { name: 'Record state' });
  const list = page.getByRole('listbox', { name: 'Record state' });
  const select = page.locator('.mar-ui-select').filter({ has: state });
  const clear = select.getByRole('button', { name: 'Clear', exact: true });
  await expect(state).toHaveText('No');
  await state.click();
  await expect(state).toHaveAttribute('aria-busy', 'true');
  await expect(list.getByRole('option')).toHaveCount(0);
  await state.press('Escape');
  await page.getByRole('button', { name: 'Open at zero' }).click();
  await expect(state).toBeFocused();
  await expect(list.getByRole('option', { name: 'No' })).toHaveAttribute('aria-selected', 'true');
  await state.press('Enter');
  await expect(state).toHaveText('0');
  const suffix = select.locator('.mar-ui-select__suffix');
  const beforeClear = (await suffix.boundingBox())!.width;
  expect((await clear.boundingBox())!.width).toBeGreaterThanOrEqual(24);
  await clear.click();
  await expect(clear).toHaveCount(0);
  expect((await suffix.boundingBox())!.width).toBeCloseTo(beforeClear, 1);
  await expect(page.getByTestId('events')).toHaveText(
    '["update:0","change:0","update:undefined","change:undefined","clear"]'
  );
  await expect(state).toBeFocused();
});

test('compact branch tags stay on one line and separate tag removal from clearing', async ({
  page
}, info) => {
  await page.goto(`${fixture.url}mar-select.html`);
  const branches = page.getByRole('combobox', { name: 'Git branches' });
  const select = page.locator('.mar-ui-select').filter({ has: branches });
  const field = select.locator('.mar-ui-select__field');
  const clear = select.getByRole('button', { name: 'Clear', exact: true });
  const list = page.getByRole('listbox', { name: 'Git branches' });
  const caret = field.locator('.mar-ui-select__suffix > .mar-ui-select__icon');

  await expect(clear).toHaveCSS('opacity', '0');
  await expect(caret).toBeVisible();
  await branches.focus();
  await expect(clear).toHaveCSS('opacity', '1');
  await expect(caret).toBeHidden();
  await clear.click();
  const emptyHeight = (await field.boundingBox())!.height;
  await branches.click();
  const long = list.getByRole('option', { name: /^feature\//u });
  await long.click();
  await branches.press('Escape');
  await expect(page.getByTestId('branches')).toHaveText('["long"]');
  await expect(branches).toHaveAccessibleDescription(/^feature\//u);
  const tag = select.locator('.mar-ui-select__tag').filter({ hasText: /^feature\//u });
  await expect(tag).toBeVisible();
  const remove = tag.getByRole('button', { name: /^Clear feature\//u });
  await expect(remove).toBeVisible();
  await expect(tag).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  expect((await field.boundingBox())!.height).toBe(emptyHeight);

  await branches.click();
  await list.getByRole('option', { name: 'Main' }).click();
  await expect(select.getByRole('button', { name: '+1' })).toBeVisible();
  expect((await field.boundingBox())!.height).toBe(emptyHeight);
  await field.screenshot({ path: info.outputPath('compact-branch-tags.png') });
  await remove.click();
  await expect(page.getByTestId('branches')).toHaveText('["main"]');
  await expect(list).toBeVisible();
  await clear.click();
  await expect(page.getByTestId('branches')).toHaveText('[]');
  await expect(branches).toBeFocused();
});

test('Select and Dropdown limit long menus and show hints only for clipped labels', async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.url}mar-select.html`);
  const branches = page.getByRole('combobox', { name: 'Git branches' });
  const list = page.getByRole('listbox', { name: 'Git branches' });
  const tooltip = page.getByRole('tooltip');
  const cap = await page
    .locator('html')
    .evaluate((html) => 24 * parseFloat(getComputedStyle(html).fontSize));
  // The overlaid tag actions have their own hit targets in the center of this field.
  const openBranches = () => branches.click({ position: { x: 1, y: 1 } });
  await openBranches();
  expect((await list.boundingBox())!.width).toBeLessThanOrEqual(cap + 0.5);
  expect((await list.boundingBox())!.width).toBeGreaterThan(220);
  const long = list.getByRole('option', { name: /^feature\//u });
  const short = list.getByRole('option', { name: 'Main' });
  await expect(short).toHaveAttribute('aria-selected', 'true');
  await expect(short).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await long.hover();
  await expect(tooltip).toHaveText((await long.innerText()).trim());
  await branches.press('Escape');
  await expect(tooltip).toBeHidden();
  await expect(list).toBeHidden();
  await expect(branches).toBeFocused();

  await openBranches();
  await long.hover();
  await expect(tooltip).toBeVisible();
  await short.hover();
  await expect(tooltip).toBeHidden();
  await page.mouse.move(0, 0);
  await branches.press('End');
  await branches.press('ArrowUp');
  await expect(branches).toHaveAttribute('aria-activedescendant', (await long.getAttribute('id'))!);
  expect((await long.boundingBox())!.height).toBeGreaterThan((await short.boundingBox())!.height);
  await branches.press('Escape');

  await page.getByRole('button', { name: 'Open commands' }).click();
  const menu = page.getByRole('menu');
  expect((await menu.boundingBox())!.width).toBeLessThanOrEqual(cap + 0.5);
  const command = menu.getByRole('menuitem', { name: /^feature\//u });
  await command.hover();
  await expect(tooltip).toHaveText((await command.innerText()).trim());
  await page.mouse.move(0, 0);
  await expect(tooltip).toBeHidden();
  await page.keyboard.press('ArrowDown');
  await expect(command).toBeFocused();
  await expect(tooltip).toBeVisible();
  await command.press('Enter');
  await expect(page.getByTestId('command')).toHaveText('"long"');
  await expect(tooltip).toBeHidden();
});

test('the collapsed tag preview is readable on hover and dismisses with Escape', async ({
  page
}) => {
  await page.goto(`${fixture.url}mar-select.html`);
  const branches = page.getByRole('combobox', { name: 'Git branches' });
  const summary = page.getByRole('button', { name: '+2' });
  const preview = page.locator('.mar-ui-select__summary-content');
  await branches.focus();
  await summary.hover();
  await expect(preview).toBeVisible();
  await preview.hover();
  await expect(preview).toBeVisible();
  await branches.press('Escape');
  await expect(preview).toBeHidden();
  await expect(branches).toBeFocused();
  await summary.focus();
  await expect(preview).toBeVisible();
  await summary.press('Escape');
  await expect(preview).toBeHidden();
  await expect(summary).toBeFocused();
  await summary.hover();
  await expect(preview).toBeVisible();
  await summary.click();
  await expect(preview).toBeVisible();
});

test('collapsed tags remain readable and the grouped list stays reachable on touch', async ({
  browser
}, info) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true
  });
  try {
    const page = await context.newPage();
    await page.goto(`${fixture.url}mar-select.html`);
    const summary = page.getByRole('button', { name: '+2' });
    const branches = page.getByRole('combobox', { name: 'Git branches' });
    await expect(
      page
        .locator('.mar-ui-select__field')
        .filter({ has: branches })
        .getByRole('button', { name: 'Clear', exact: true })
    ).toHaveCSS('opacity', '1');
    await expect(summary).toHaveAccessibleDescription('Release Topic');
    await branches.evaluate((element) => {
      const field = element.closest<HTMLElement>('.mar-ui-select__field')!;
      field.style.overflow = 'hidden';
    });
    await summary.tap();
    await expect(summary).toHaveAttribute('aria-expanded', 'true');
    const preview = page.locator('.mar-ui-select__summary-content');
    await expect(preview).toBeInViewport({ ratio: 1 });
    await expect(preview).toHaveText(/Release\s+Topic/u);
    await summary.tap();
    await expect(preview).toBeHidden();
    await expect(summary).toHaveAttribute('aria-expanded', 'false');
    await summary.tap();
    await expect(preview).toBeVisible();
    await branches.tap();
    await expect(preview).toBeHidden();
    const list = page.getByRole('listbox', { name: 'Git branches' });
    await expect(list).toBeInViewport();
    const long = list.getByRole('option', { name: /^feature\//u });
    expect((await long.boundingBox())!.height).toBeGreaterThan(
      (await list.getByRole('option', { name: 'Main' }).boundingBox())!.height
    );
    await expect(list.getByRole('group', { name: 'Remote' })).toBeVisible();
    await page.screenshot({ path: info.outputPath('grouped-branches-touch.png') });
    await list.getByRole('option', { name: 'Release' }).tap();
    await expect(page.getByTestId('branches')).toHaveText('["main","topic"]');
    await expect(list).toBeVisible();
    await branches.tap();
    await expect(list).toBeHidden();
    await page.getByRole('button', { name: 'Open commands' }).tap();
    const menu = page.getByRole('menu');
    const shortCommand = menu.getByRole('menuitem', { name: 'Short action' });
    const longCommand = menu.getByRole('menuitem', { name: /^feature\//u });
    await expect(menu).toBeInViewport({ ratio: 1 });
    expect((await longCommand.boundingBox())!.height).toBeGreaterThan(
      (await shortCommand.boundingBox())!.height
    );
    await longCommand.tap();
    await expect(page.getByTestId('command')).toHaveText('"long"');
  } finally {
    await context.close();
  }
});
