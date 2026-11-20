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
  await page
    .locator('.mar-ui-select')
    .filter({ has: state })
    .getByRole('button', { name: 'Clear', exact: true })
    .click();
  await expect(page.getByTestId('events')).toHaveText(
    '["update:0","change:0","update:undefined","change:undefined","clear"]'
  );
  await expect(state).toBeFocused();
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
    await expect(summary).toHaveAccessibleDescription('Release Topic');
    await summary.tap();
    await expect(summary).toHaveAttribute('aria-expanded', 'true');
    const branches = page.getByRole('combobox', { name: 'Git branches' });
    await branches.tap();
    const list = page.getByRole('listbox', { name: 'Git branches' });
    await expect(list).toBeInViewport();
    await expect(list.getByRole('group', { name: 'Remote' })).toBeVisible();
    await page.screenshot({ path: info.outputPath('grouped-branches-touch.png') });
    await list.getByRole('option', { name: 'Release' }).tap();
    await expect(page.getByTestId('branches')).toHaveText('["main","topic"]');
    await expect(list).toBeVisible();
  } finally {
    await context.close();
  }
});
