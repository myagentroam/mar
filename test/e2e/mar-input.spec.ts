import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/mar-input.html');
});
test.afterAll(async () => {
  await fixture?.close();
});

test('MAR input preserves composition through a parent render and emits a single committed value', async ({
  page
}) => {
  await page.goto(`${fixture.url}mar-input.html`);
  const field = page.getByRole('textbox', { name: 'Query' });
  const events = page.getByRole('status', { name: 'Input events' });
  await field.fill('Search');
  await expect(events).toHaveText('model:Search|input:Search');
  await field.press('Tab');
  await expect(events).toHaveText('model:Search|input:Search|change:Search');
  await page.getByRole('button', { name: 'Clear' }).focus();
  await page.keyboard.press('Space');
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('');
  const cleared = 'model:Search|input:Search|change:Search|model:|change:|clear|input:';
  await expect(events).toHaveText(cleared);

  const phase = Number(await field.getAttribute('data-phase'));
  await field.evaluate((element: HTMLInputElement) => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    element.value = '文件';
    element.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
  });
  await expect(field).toHaveAttribute('data-phase', String(phase + 1));
  await expect(field).toHaveValue('文件');
  await expect(events).toHaveText(cleared);
  await field.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    element.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
  await expect(events).toHaveText(`${cleared}|model:文件|input:文件`);
});

test('MAR textarea grows and shrinks within autosize bounds and counts native maxlength units', async ({
  page
}) => {
  await page.goto(`${fixture.url}mar-input.html`);
  const field = page.getByRole('textbox', { name: 'Notes' });
  await expect(field).toHaveValue('First line');
  await expect(field).toHaveCSS('overflow-y', 'hidden');
  const initialHeight = await field.evaluate((element) => element.clientHeight);
  await field.fill('😀\nsecond');
  await expect(page.getByText('9 / 60', { exact: true })).toBeVisible();
  await expect
    .poll(() => field.evaluate((element) => element.clientHeight))
    .toBeGreaterThan(initialHeight);
  await field.fill('One\nTwo\nThree\nFour');
  await expect(field).toHaveCSS('overflow-y', 'auto');
  const cappedHeight = await field.evaluate((element) => element.clientHeight);
  await field.fill('One\nTwo\nThree\nFour\nFive');
  await expect(field).toHaveValue('One\nTwo\nThree\nFour\nFive');
  await expect.poll(() => field.evaluate((element) => element.clientHeight)).toBe(cappedHeight);
  await field.fill('First line');
  await expect.poll(() => field.evaluate((element) => element.clientHeight)).toBe(initialHeight);
});

test('MAR input and appended action have a shared frame and independent hover and focus', async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 480 });
  await page.goto(`${fixture.url}mar-input.html`);
  const group = page.locator('.search-group');
  const field = group.getByRole('textbox', { name: 'Search terms' });
  const button = group.getByRole('button', { name: 'Search' });
  const idleFrame = await group.evaluate((element) => getComputedStyle(element).boxShadow);
  const idleBackground = await button.evaluate(
    (element) => getComputedStyle(element).backgroundColor
  );
  await field.hover();
  await expect(group).not.toHaveCSS('box-shadow', idleFrame);
  await button.hover();
  await expect(group).toHaveCSS('box-shadow', idleFrame);
  await expect(button).not.toHaveCSS('background-color', idleBackground);
  await expect(button).toHaveCSS('border-top-width', '0px');
  const bounds = await group.evaluate((element) => {
    const frame = element.getBoundingClientRect();
    const action = element.querySelector('button')!.getBoundingClientRect();
    return { top: action.top - frame.top, right: frame.right - action.right };
  });
  expect(bounds).toEqual({ top: 1, right: 1 });
  await group.screenshot({ path: testInfo.outputPath('append-hover.png') });
  await field.focus();
  await page.mouse.move(0, 0);
  await expect(group).not.toHaveCSS('box-shadow', idleFrame);
  await page.keyboard.press('Tab');
  await expect(button).toBeFocused();
  await expect(group).toHaveCSS('box-shadow', idleFrame);
  await expect(button).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status', { name: 'Search actions' })).toHaveText('1');
});

test('MAR field text does not inherit the weight of its filter label', async ({ page }) => {
  await page.goto(`${fixture.url}mar-input.html`);
  const field = page.getByRole('textbox', { name: 'Workspace' });
  await expect(page.locator('label[for="resource"]')).toHaveCSS('font-weight', '600');
  expect(await field.evaluate((el) => getComputedStyle(el, '::placeholder').fontWeight)).toBe(
    '400'
  );
  await field.fill('My workspace');
  await expect(field).toHaveCSS('font-weight', '400');
  await expect(page.getByText('Owner type', { exact: true })).toHaveCSS('font-weight', '400');
});
