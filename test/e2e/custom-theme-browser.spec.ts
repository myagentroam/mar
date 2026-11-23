import { grantClipboardPermissions } from './support/clipboard.js';
import { resolvedColorToHex } from '../../packages/web-core/src/util/theme-palette.js';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';
import { CUSTOM_THEME_TOKENS } from '../../packages/web-core/src/model/custom-theme.js';

const componentAliases = {
  '--mar-ui-control-primary-bg': '--mar-control-primary-bg',
  '--mar-ui-control-primary-fg': '--mar-control-primary-fg',
  '--mar-ui-control-focus': '--mar-control-focus',
  '--mar-ui-bg-panel': '--mar-bg-panel',
  '--mar-ui-text-primary': '--mar-text-primary',
  '--mar-ui-text-secondary': '--mar-text-secondary',
  '--mar-ui-border-default': '--mar-border-default',
  '--mar-ui-message-surface': '--mar-control-bg-color-overlay'
};

function colorContrast(color: string, background: string): number {
  const luminance = (value: string): number => {
    const hex = resolvedColorToHex(value);
    const channels = [1, 3, 5].map((offset) => {
      const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  };
  const values = [luminance(color), luminance(background)].sort((a, b) => b - a);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

async function useThemeMenu(page: Page, option: Locator, action: string): Promise<void> {
  await option.getByRole('button', { name: /^More actions for / }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
  await expect(page.getByRole('menuitem', { name: action, exact: true })).toBeHidden();
}

async function expectMessageThemeTokens(message: Locator, iconToken: string): Promise<void> {
  const actual = await message.evaluate((element, statusToken) => {
    const root = getComputedStyle(document.documentElement);
    const surface = getComputedStyle(element);
    const content = element.querySelector('.mar-message-text');
    const icon = element.querySelector('.mar-ui-message__icon');
    if (!content || !icon) throw new Error('Message content or icon is missing');
    const colorForToken = (token: string): string => {
      const probe = document.createElement('span');
      probe.style.cssText = 'position: fixed; visibility: hidden;';
      probe.style.color = `var(${token})`;
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    return {
      background: surface.backgroundColor,
      backgroundToken: colorForToken('--mar-control-bg-color-overlay'),
      border: surface.borderTopColor,
      borderToken: colorForToken('--mar-border-default'),
      radius: surface.borderRadius,
      radiusToken: root.getPropertyValue('--mar-radius-control').trim(),
      text: getComputedStyle(content).color,
      textToken: colorForToken('--mar-text-primary'),
      fontSize: getComputedStyle(content).fontSize,
      bodyToken: root.getPropertyValue('--mar-font-size-body').trim(),
      iconColor: getComputedStyle(icon).color,
      statusColor: colorForToken(statusToken)
    };
  }, iconToken);

  expect(resolvedColorToHex(actual.background)).toBe(resolvedColorToHex(actual.backgroundToken));
  expect(resolvedColorToHex(actual.border)).toBe(resolvedColorToHex(actual.borderToken));
  expect(actual.radius).toBe(actual.radiusToken);
  expect(resolvedColorToHex(actual.text)).toBe(resolvedColorToHex(actual.textToken));
  expect(actual.fontSize).toBe(actual.bodyToken);
  expect(resolvedColorToHex(actual.iconColor)).toBe(resolvedColorToHex(actual.statusColor));
}

async function expectMessageFirstLineAlignment(message: Locator): Promise<void> {
  const offsets = await message.evaluate((element) => {
    const content = element.querySelector('.mar-message-text');
    const statusIcon = element.querySelector('.mar-ui-message__icon');
    const closeIcon = element.querySelector('.mar-message-close .mar-icon');
    if (!content || !statusIcon || !closeIcon)
      throw new Error('Message feedback layout is missing');
    const contentRect = content.getBoundingClientRect();
    const lineHeight = Number.parseFloat(getComputedStyle(content).lineHeight);
    const firstLineCenter = contentRect.y + lineHeight / 2;
    const centerY = (rect: DOMRect) => rect.y + rect.height / 2;
    return {
      status: centerY(statusIcon.getBoundingClientRect()) - firstLineCenter,
      close: centerY(closeIcon.getBoundingClientRect()) - firstLineCenter
    };
  });
  expect(Math.abs(offsets.status)).toBeLessThanOrEqual(1);
  expect(Math.abs(offsets.close)).toBeLessThanOrEqual(1);
}

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/custom-theme.html');
});
test.afterAll(async () => {
  await fixture?.close();
});
test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => console.error(error.message));
  await page.goto(`${fixture.url}custom-theme.html`);
});

for (const width of [1280, 390]) {
  test(`standard single-line controls align at ${width}px`, async ({ page }, testInfo) => {
    const height = 26;
    await page.setViewportSize({ width, height: 900 });
    const fields = page.getByRole('region', { name: 'Standard field boundaries' });
    for (const control of [
      fields
        .locator('.mar-ui-input')
        .filter({ has: page.getByRole('textbox', { name: 'Text field', exact: true }) }),
      fields
        .locator('.mar-ui-input-number')
        .filter({ has: page.getByRole('spinbutton', { name: 'Number field', exact: true }) }),
      fields
        .locator('.mar-ui-select__field')
        .filter({ has: page.getByRole('combobox', { name: 'Select field', exact: true }) }),
      fields
        .locator('.mar-ui-select__field')
        .filter({ has: page.getByRole('combobox', { name: 'Time select field', exact: true }) }),
      fields
        .locator('.mar-ui-cascader__field')
        .filter({ has: page.getByPlaceholder('Cascader field', { exact: true }) }),
      fields
        .locator('.mar-ui-date-picker__field')
        .filter({ has: page.getByPlaceholder('Single date field', { exact: true }) }),
      fields
        .locator('.mar-ui-time-picker__field')
        .filter({ has: page.getByPlaceholder('Single time field', { exact: true }) }),
      page.getByRole('button', { name: 'Sample primary', exact: true })
    ]) {
      await expect(control).toHaveCSS('height', `${height}px`);
    }
    const textarea = fields.getByRole('textbox', { name: 'Textarea field', exact: true });
    expect((await textarea.boundingBox())!.height).toBeGreaterThan(height);
    await fields.screenshot({ path: testInfo.outputPath('compact-fields.png') });
  });
}

test('MAR input keeps its label and icons across focused and disabled states', async ({
  page
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const sample = page.getByRole('region', { name: 'MAR field and menu states' });
  const field = page.getByRole('textbox', { name: 'MAR sample', exact: true });
  const wrapper = sample.locator('.mar-ui-input__body');
  await expect(field).toHaveAttribute('autocomplete', 'off');
  for (const name of ['search', 'lock'])
    await expect(wrapper.locator(`[data-mar-icon="${name}"]`)).toBeVisible();
  await page.getByText('MAR sample', { exact: true }).click();
  await expect(field).toBeFocused();
  await field.fill('search value');
  await expect(field).toHaveValue('search value');
  await sample.screenshot({ path: testInfo.outputPath('mar-input-dark-focus.png') });

  await page
    .locator('.theme-option')
    .nth(1)
    .getByRole('button', { name: 'Apply theme', exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  await sample.getByRole('checkbox', { name: 'Disable sample inputs' }).check();
  await expect(field).toBeDisabled();
  await sample.screenshot({ path: testInfo.outputPath('mar-input-light-mobile-disabled.png') });
});

test('MAR choice and command menus keep selection and actions separate', async ({
  page
}, testInfo) => {
  const section = page.getByRole('region', { name: 'MAR field and menu states' });
  const choice = section.getByRole('combobox', { name: 'MAR choice' });
  const selected = section.getByRole('status', { name: 'Selected value' });
  await expect(selected).toHaveText('false');
  await choice.press('Enter');
  await expect(section.getByRole('listbox', { name: 'MAR choice' })).toBeVisible();
  await expect(page.getByRole('option', { name: 'First choice' })).toBeVisible();
  await choice.press('ArrowDown');
  const nextOption = page.getByRole('option', { name: 'Second choice' });
  await expect(choice).toHaveAttribute(
    'aria-activedescendant',
    (await nextOption.getAttribute('id'))!
  );
  await expect(nextOption).toHaveCSS('outline-style', 'solid');
  await section.getByRole('option', { name: 'Unavailable choice' }).hover();
  await expect(choice).toHaveAttribute(
    'aria-activedescendant',
    (await nextOption.getAttribute('id'))!
  );
  await expect(nextOption).toHaveCSS('outline-style', 'solid');
  await choice.press('Escape');
  await expect(page.getByRole('listbox')).toBeHidden();
  await expect(selected).toHaveText('false');
  await choice.press('Enter');
  await expect(page.getByRole('listbox')).toBeVisible();
  await choice.press('ArrowDown');
  await choice.press('Tab');
  await expect(page.getByRole('listbox')).toBeHidden();
  await expect(selected).toHaveText('false');
  const outside = section.getByRole('textbox', { name: 'MAR sample' });
  await choice.press('Enter');
  await expect(page.getByRole('listbox')).toBeVisible();
  await choice.press('ArrowDown');
  await outside.click();
  await expect(page.getByRole('listbox')).toBeHidden();
  await expect(outside).toBeFocused();
  await expect(selected).toHaveText('false');
  await choice.click();
  await page.getByRole('option', { name: 'Second choice' }).click();
  await expect(selected).toHaveText('true');

  const trigger = section.getByRole('button', { name: 'MAR commands' });
  await expect(trigger).toHaveAttribute('id', 'mar-command-trigger');
  const command = section.getByRole('status', { name: 'Last command' });
  const menu = page.getByRole('menu', { name: 'MAR commands' });
  const apply = menu.getByRole('menuitem', { name: 'Apply command' });
  const disabled = menu.getByRole('menuitem', { name: 'Unavailable command' });
  await trigger.press('Enter');
  await expect(menu).toBeVisible();
  await expect(disabled).toHaveAttribute('aria-disabled', 'true');
  await expect(apply).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-controls', (await menu.getAttribute('id'))!);
  const reset = menu.getByRole('menuitem', { name: 'Reset command' });
  const layout = await reset.evaluate((item) => {
    const menu = item.closest('[role="menu"]')!;
    const menuStyle = getComputedStyle(menu);
    const menuRect = menu.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const divider = getComputedStyle(item, '::before');
    const dividerTop = itemRect.top + parseFloat(divider.insetBlockStart);
    return {
      leftInset: itemRect.left - menuRect.left - parseFloat(menuStyle.borderLeftWidth),
      rightInset: menuRect.right - itemRect.right - parseFloat(menuStyle.borderRightWidth),
      before: dividerTop - item.previousElementSibling!.getBoundingClientRect().bottom,
      after: itemRect.top - (dividerTop + parseFloat(divider.height))
    };
  });
  expect(layout.leftInset).toBeCloseTo(0, 0);
  expect(layout.rightInset).toBeCloseTo(0, 0);
  expect(layout.before).toBeGreaterThan(0);
  expect(layout.after).toBeCloseTo(layout.before, 1);
  await menu.screenshot({
    path: testInfo.outputPath('mar-dropdown-dark.png'),
    animations: 'disabled'
  });
  await disabled.dispatchEvent('click');
  await expect(command).toBeEmpty();
  await page.keyboard.press('ArrowDown');
  await expect(reset).toBeFocused();
  await page.keyboard.press('Home');
  await expect(apply).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.press('Space');
  await expect(apply).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(command).toHaveText('apply');
  await expect(menu).toBeHidden();
  await trigger.click();
  await expect(menu).toBeVisible();
  await trigger.click();
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.press('Enter');
  await expect(menu).toBeVisible();
  await menu.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished))
  );
  const dividerPoint = await reset.evaluate((item) => {
    const divider = getComputedStyle(item, '::before');
    const bounds = item.getBoundingClientRect();
    const x = bounds.left + bounds.width / 2;
    const y = bounds.top + parseFloat(divider.insetBlockStart) + 0.5;
    return { x, y };
  });
  await page.mouse.click(dividerPoint.x, dividerPoint.y);
  await expect(command).toHaveText('apply');
  await expect(menu).toBeVisible();
  await outside.click();
  await expect(menu).toBeHidden();
  await expect(outside).toBeFocused();
  const remove = section.getByRole('button', { name: 'Remove MAR menu' });
  await trigger.press('Enter');
  await page.keyboard.press('Tab');
  await expect(menu).toBeHidden();
  await expect(remove).toBeFocused();
  await trigger.press('Enter');
  await expect(apply).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.press('Enter');
  await expect(menu).toBeVisible();
  await remove.evaluate((button: HTMLButtonElement) => button.click());
  await expect(trigger).toHaveCount(0);
  await expect(menu).toHaveCount(0);
});

for (const motion of ['no-preference', 'reduce'] as const) {
  test(`MAR anchored menus provide an arrow and entrance with motion ${motion}`, async ({
    page
  }, testInfo) => {
    await page.emulateMedia({ reducedMotion: motion });
    const sample = page.getByRole('region', { name: 'MAR field and menu states' });
    for (const [trigger, popup, name] of [
      [sample.getByRole('combobox', { name: 'MAR choice' }), sample.getByRole('listbox'), 'select'],
      [sample.getByRole('button', { name: 'MAR commands' }), sample.getByRole('menu'), 'dropdown']
    ] as const) {
      await trigger.evaluate((element) => element.scrollIntoView({ block: 'center' }));
      const entered = popup.and(page.locator('.mar-ui-popup'));
      // Observe the actual CSS transition, even when Playwright waits for the popup to settle.
      if (motion === 'no-preference') {
        await page.evaluate(() => {
          document.documentElement.removeAttribute('data-popup-entered');
          document.addEventListener('transitionrun', function onEnter(event) {
            if (event.propertyName !== 'opacity' || !(event.target instanceof HTMLElement)) return;
            if (!event.target.matches('.mar-ui-popup')) return;
            document.documentElement.setAttribute('data-popup-entered', '');
            document.removeEventListener('transitionrun', onEnter);
          });
        });
      }
      await trigger.press('Enter');
      await expect(entered).toBeVisible();
      await expect(entered).toHaveAttribute('data-arrow', '');
      await expect(entered).toHaveAttribute('data-side', 'bottom');
      await expect(entered).toHaveCSS('overflow', 'visible');
      const arrow = await entered.evaluate((el) => {
        const style = getComputedStyle(el, '::before');
        return {
          top: style.top,
          fill: style.backgroundColor,
          surface: getComputedStyle(el).backgroundColor
        };
      });
      expect(arrow.top).toBe('-5px');
      expect(arrow.fill).toBe(arrow.surface);
      if (motion === 'no-preference') {
        await expect(page.locator('html')).toHaveAttribute('data-popup-entered', '');
        await expect(entered).toHaveCSS('opacity', '1');
        const bounds = (await entered.boundingBox())!;
        await page.screenshot({
          clip: { ...bounds, y: bounds.y - 16, height: bounds.height + 16 },
          path: testInfo.outputPath(`${name}-arrow.png`)
        });
      } else {
        await expect(entered).toHaveCSS('transition-duration', '0s');
      }
      await page.keyboard.press('Escape');
      await expect(entered).toBeHidden();
      await expect(trigger).toBeFocused();
    }
  });
}

test('MAR commands keep keyboard focus visible in a scrolling menu', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 640 });
  const section = page.getByRole('region', { name: 'MAR scrolling commands' });
  const trigger = section.getByRole('button', { name: 'Long command menu' });
  const menu = section.getByRole('menu', { name: 'Long command menu' });
  const first = menu.getByRole('menuitem', { name: 'Command 1', exact: true });
  const last = menu.getByRole('menuitem', { name: 'Command 36', exact: true });
  await trigger.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await trigger.press('ArrowDown');
  await expect(first).toBeFocused();
  const anchorTop = (await trigger.boundingBox())!.y;

  await page.keyboard.press('End');
  await expect(last).toBeFocused();
  await expect(last).toBeInViewport({ ratio: 0.95 });
  await menu.screenshot({ path: testInfo.outputPath('mar-menu-focused-item.png') });
  await page.keyboard.press('Home');
  await expect(first).toBeFocused();
  await expect(first).toBeInViewport({ ratio: 0.95 });
  expect((await trigger.boundingBox())!.y).toBeCloseTo(anchorTop, 0);

  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.press('ArrowUp');
  await expect(last).toBeFocused();
  await expect(last).toBeInViewport({ ratio: 0.95 });
});

test('MAR choice keeps the active row visible inside a scrolling list', async ({
  page
}, testInfo) => {
  const section = page.getByRole('region', { name: 'MAR scrolling choices' });
  const trigger = section.getByRole('combobox', { name: 'Long choice' });
  const value = section.getByRole('status', { name: 'Confirmed choice' });
  const list = section.getByRole('listbox');
  await trigger.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await trigger.press('Enter');
  await expect(list).toBeVisible();
  const anchorTop = (await trigger.boundingBox())!.y;
  async function expectActiveRow(number: number) {
    const option = list.getByRole('option', { name: `Choice ${number}`, exact: true });
    await expect(trigger).toHaveAttribute(
      'aria-activedescendant',
      (await option.getAttribute('id'))!
    );
    await expect(option).toBeInViewport({ ratio: 0.95 });
    await expect(option).toHaveCSS('outline-style', 'solid');
  }
  await expectActiveRow(36);
  await expect(list).toHaveAccessibleName('Long choice');
  await list.screenshot({ path: testInfo.outputPath('mar-select-active-row.png') });
  await trigger.press('Home');
  await expectActiveRow(1);
  await trigger.press('End');
  await expectActiveRow(36);
  expect((await trigger.boundingBox())!.y).toBeCloseTo(anchorTop, 0);
  await trigger.press('ArrowUp');
  await expectActiveRow(35);
  const selected = list.getByRole('option', { name: 'Choice 36', exact: true });
  await expect(selected).toHaveAttribute('aria-selected', 'true');
  await expect(selected).toHaveCSS('outline-style', 'none');
  await expect(value).toHaveText('36');
  await trigger.press('Enter');
  await expect(value).toHaveText('35');
  await expect(trigger).toBeFocused();
  await trigger.press('Home');
  await expectActiveRow(1);
  await trigger.press('Escape');
  await trigger.press('End');
  await expectActiveRow(36);
  await trigger.press('Escape');
  await expect(value).toHaveText('35');
});

test.describe('MAR controls on a 390px touch viewport', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('MAR choice flips above its trigger and fits the light mobile viewport', async ({
    page
  }, testInfo) => {
    await page
      .locator('.theme-option')
      .nth(1)
      .getByRole('button', { name: 'Apply theme', exact: true })
      .tap();
    const sample = page.getByRole('region', { name: 'MAR field and menu states' });
    const choice = sample.getByRole('combobox', { name: 'MAR choice' });
    const list = page.getByRole('listbox');
    await choice.evaluate((element) => element.scrollIntoView({ block: 'end' }));
    await choice.tap();
    await expect(list).toBeVisible();
    await expect(list).toHaveAttribute('data-arrow', '');
    await expect(list).toHaveAttribute('data-side', 'top');
    expect(await list.evaluate((el) => getComputedStyle(el, '::before').bottom)).toBe('-5px');
    const bounds = (await list.boundingBox())!;
    const anchor = (await choice.boundingBox())!;
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(anchor.y);
    expect(bounds.x).toBeGreaterThanOrEqual(8);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(382);
    await list.screenshot({ path: testInfo.outputPath('mar-select-light-mobile.png') });
    const disabled = list.getByRole('option', { name: 'Unavailable choice' });
    await expect(disabled).toHaveAttribute('aria-disabled', 'true');
    await disabled.dispatchEvent('click');
    await expect(sample.getByRole('status', { name: 'Selected value' })).toHaveText('false');
    await list.getByRole('option', { name: 'Second choice' }).tap();
    await expect(sample.getByRole('status', { name: 'Selected value' })).toHaveText('true');
  });
});

test('MAR button preserves the icon and label positions during native submit loading', async ({
  page
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const section = page.getByRole('region', { name: 'MAR button states' });
  const submit = section.getByRole('button', { name: 'Submit action' });
  const text = section.getByRole('button', { name: 'Text action' });
  const idleText = section.getByRole('button', { name: 'Idle text reference' });
  const iconOnly = section.getByRole('button', { name: 'Refresh action' });
  const finish = section.getByRole('button', { name: 'Finish action' });
  const input = section.getByRole('textbox', { name: 'Action input' });
  const count = section.getByRole('status', { name: 'Submission count' });
  const layout = async (button: Locator) =>
    (
      await Promise.all([
        button.boundingBox(),
        button.locator('.mar-ui-button__label').boundingBox(),
        button.locator('.mar-ui-button__icon').boundingBox()
      ])
    ).map((box) => {
      if (!box) throw new Error('Button or content not visible');
      return box;
    });

  await submit.scrollIntoViewIfNeeded();
  const originalSubmitLayout = await layout(submit);
  const originalTextBox = await text.boundingBox();
  expect(originalTextBox!.width).toBeCloseTo((await idleText.boundingBox())!.width, 2);
  await expect(text.locator('.mar-ui-button__icon')).toHaveCount(0);
  await expect(submit.locator('[data-mar-icon="check"]')).toBeVisible();
  await section.screenshot({ path: testInfo.outputPath('mar-button-ready.png') });
  await text.click();
  await expect(count).toHaveText('0');
  await input.press('Enter');
  await expect(count).toHaveText('1');

  const busyIcon = submit.locator('[data-mar-icon="loading-action"]');
  await expect(submit).toBeDisabled();
  await expect(submit).toHaveAttribute('aria-busy', 'true');
  await expect(busyIcon).toBeVisible();
  await expect(busyIcon).toHaveCSS('animation-name', 'none');
  await expect(iconOnly).toBeDisabled();
  await expect(iconOnly.locator('[data-mar-icon="loading-action"]')).toBeVisible();
  expect(await layout(submit)).toEqual(originalSubmitLayout);
  expect(await text.boundingBox()).toEqual(originalTextBox);
  await expect(text).toBeDisabled();
  await expect(text).toHaveAttribute('aria-busy', 'true');
  await expect(text).toHaveAccessibleName('Text action');
  await expect(text.locator('.mar-ui-button__label')).toHaveCSS('opacity', '0');
  const textBusyIcon = text.locator('[data-mar-icon="loading-action"]');
  await expect(textBusyIcon).toBeVisible();
  const [buttonBox, , iconBox] = await layout(text);
  if (!buttonBox || !iconBox) throw new Error('Expected button and loading icon bounds');
  expect(iconBox.x + iconBox.width / 2).toBeCloseTo(buttonBox.x + buttonBox.width / 2, 0);
  expect(iconBox.y + iconBox.height / 2).toBeCloseTo(buttonBox.y + buttonBox.height / 2, 0);
  await section.screenshot({ path: testInfo.outputPath('mar-button-loading.png') });
  await submit.click({ force: true });
  await input.press('Enter');
  await expect(count).toHaveText('1');

  const disabled = section.getByRole('checkbox', { name: 'Disable submit action' });
  await disabled.check();
  await finish.click();
  await expect(text.locator('.mar-ui-button__label')).toHaveCSS('opacity', '1');
  await expect(textBusyIcon).toHaveCount(0);
  expect(await text.boundingBox()).toEqual(originalTextBox);
  await expect(submit).toBeDisabled();
  await expect(submit).not.toHaveAttribute('aria-busy');
  await expect(submit.locator('[data-mar-icon="check"]')).toBeVisible();
  await disabled.uncheck();
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(count).toHaveText('2');
});

test('MAR button shaped links preserve navigation and suppress disabled activation', async ({
  page
}) => {
  const section = page.getByRole('region', { name: 'MAR button states' });
  const anchor = section.getByRole('link', { name: 'Open destination' });
  const count = section.getByRole('status', { name: 'Link activation count' });
  await anchor.focus();
  await anchor.press('Enter');
  await expect(page).toHaveURL(/#button-link-target$/u);
  await expect(count).toHaveText('1');

  await section.getByRole('checkbox', { name: 'Disable submit action' }).check();
  await expect(anchor).toBeDisabled();
  await expect(anchor).not.toHaveAttribute('href');
  await anchor.dispatchEvent('click');
  await expect(count).toHaveText('1');
});

test('MAR controls follow the provider locale for their built-in text', async ({ page }) => {
  const section = page.getByRole('region', { name: 'MAR localized controls' });
  const select = section.getByRole('combobox', { name: 'Empty choice' });
  await select.press('Enter');
  await expect(page.getByText('No data', { exact: true })).toBeVisible();
  await select.press('Escape');
  await section.getByRole('button', { name: 'Switch controls to Chinese' }).click();
  await select.press('Enter');
  await expect(page.getByText('无数据', { exact: true })).toBeVisible();
  await select.press('Escape');
  await page.getByTestId('show-info-feedback').click();
  await expect(
    page.locator('.mar-feedback-stack').getByRole('button', { name: '关闭' })
  ).toBeVisible();
});

test('console bootstrap keeps the saved page color and uses custom Primary after initialization', async ({
  page
}) => {
  const consoleHtml = await readFile(
    new URL('../../mar-web-console/index.html', import.meta.url),
    'utf8'
  );
  const consoleUrl = new URL('/theme-bootstrap-test', fixture.url).href;
  await page.route(consoleUrl, (route) =>
    route.fulfill({ contentType: 'text/html', body: consoleHtml })
  );
  let initializeTheme = false;
  await page.route('**/src/main.ts', (route) =>
    initializeTheme
      ? route.fulfill({
          contentType: 'text/javascript',
          body: 'import "/packages/web-core/test/e2e/custom-theme-app.ts";'
        })
      : route.abort()
  );

  // Seed only the preference and source. The theme service must create the startup snapshot.
  await page.evaluate(() => {
    const id = 'custom:light-startup';
    const source = JSON.stringify({
      version: 1,
      name: 'Light startup',
      colors: { '--mar-bg-page': '#f1f5e9', '--mar-control-primary-bg': '#6725af' }
    });
    localStorage.setItem('mar.theme', id);
    localStorage.setItem('mar.customThemes', JSON.stringify([{ id, source }]));
  });
  const active = page
    .locator('.theme-option')
    .filter({ hasText: 'Light startup' })
    .getByRole('button', { name: 'Active', exact: true });
  await page.reload();
  await expect(active).toBeDisabled();

  const root = page.locator('html');
  const bootstrap = page.locator('#mar-bootstrap');
  const ring = bootstrap.locator('.mar-bootstrap__trace');
  const meta = page.locator('meta[name="theme-color"]');
  await page.goto(consoleUrl);
  await expect(root).not.toHaveClass(/\bdark\b/u);
  await expect(bootstrap).toHaveCSS('background-color', 'rgb(241, 245, 233)');
  await expect(ring).toHaveCSS('border-top-color', 'rgb(0, 87, 219)');
  await expect(meta).toHaveAttribute('content', '#f1f5e9');

  initializeTheme = true;
  await page.reload();
  await expect(active).toBeDisabled();
  await expect(root).not.toHaveClass(/\bdark\b/u);
  expect(
    await root.evaluate((element) => element.style.getPropertyValue('--mar-bootstrap-bg'))
  ).toBe('');
  await expect(bootstrap).toHaveCSS('background-color', 'rgb(241, 245, 233)');
  await expect(ring).toHaveCSS('border-top-color', 'rgb(103, 37, 175)');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(241, 245, 233)');
  await expect(meta).toHaveAttribute('content', '#f1f5e9');
});

test('console bootstrap ignores missing, invalid, and mismatched theme snapshots', async ({
  page
}) => {
  const consoleHtml = await readFile(
    new URL('../../mar-web-console/index.html', import.meta.url),
    'utf8'
  );
  const consoleUrl = new URL('/theme-bootstrap-test', fixture.url).href;
  await page.route(consoleUrl, (route) =>
    route.fulfill({ contentType: 'text/html', body: consoleHtml })
  );
  await page.route('**/src/main.ts', (route) => route.abort());
  const light = { themeId: 'custom:light', scheme: 'daylight', background: '#f1f5e9' };
  const dark = { themeId: 'custom:dark', scheme: 'vscode-dark-2026', background: '#242d38' };
  const cases = [
    { themeId: 'custom:light', snapshot: null },
    { themeId: 'custom:light', snapshot: '{' },
    { themeId: 'custom:light', snapshot: JSON.stringify(dark) },
    { themeId: 'custom:light', snapshot: JSON.stringify({ ...light, scheme: 'unknown' }) },
    {
      themeId: 'custom:light',
      snapshot: JSON.stringify({ ...light, background: 'var(--mar-bg-panel)' })
    },
    { themeId: 'custom:dark', snapshot: JSON.stringify(dark), expected: '#242d38' },
    { themeId: 'daylight', snapshot: JSON.stringify(dark), expected: '#f8fbff' },
    { themeId: null, snapshot: JSON.stringify(light) }
  ];
  for (const { themeId, snapshot, expected = '#1a1a1a' } of cases) {
    await page.evaluate(
      ({ themeId, snapshot }) => {
        if (themeId) localStorage.setItem('mar.theme', themeId);
        else localStorage.removeItem('mar.theme');
        if (snapshot) localStorage.setItem('mar.themeBootstrap', snapshot);
        else localStorage.removeItem('mar.themeBootstrap');
      },
      { themeId, snapshot }
    );
    await page.goto(consoleUrl);
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', expected);
    await expect(page.locator('.mar-bootstrap__trace')).toHaveCSS(
      'color',
      themeId === 'daylight' ? 'rgb(0, 87, 219)' : 'rgb(222, 222, 222)'
    );
    expect(await page.locator('html').evaluate((root) => root.classList.contains('dark'))).toBe(
      themeId !== 'daylight'
    );
    expect(
      resolvedColorToHex(
        await page
          .locator('#mar-bootstrap')
          .evaluate((element) => getComputedStyle(element).backgroundColor)
      )
    ).toBe(expected);
  }
});

test('Message, Dialog and MessageBox close controls share the icon action surface', async ({
  page
}, testInfo) => {
  await expect(page.getByTestId('show-info-feedback')).toBeVisible();
  await page.evaluate(() => {
    for (const [token, value] of Object.entries({
      '--mar-action-hover-overlay': 'rgba(52, 86, 120, 0.5)',
      '--mar-text-primary': '#ddeeff',
      '--mar-text-secondary': '#8899aa',
      '--mar-conversation-activity-fg': '#5d97d8',
      '--mar-control-focus': '#a5a5a5'
    }))
      document.documentElement.style.setProperty(token, value);
  });
  for (const [trigger, selector] of [
    ['show-info-feedback', '.mar-message-close'],
    ['open-feedback-dialog', '.mar-ui-dialog__close'],
    ['open-close-confirmation', '.mar-ui-dialog__close']
  ] as const) {
    await page.getByTestId(trigger).click();
    const close = page.locator(selector);
    await expect(close).toBeVisible();
    await expect(close).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(close.locator('svg')).toHaveCSS('color', 'rgb(136, 153, 170)');
    await close.hover();
    await expect(close).toHaveCSS('background-color', 'rgba(52, 86, 120, 0.5)');
    await expect(close).toHaveCSS('border-radius', '6px');
    await expect(close.locator('svg')).toHaveCSS('color', 'rgb(221, 238, 255)');
    await page.mouse.move(0, 0);
    if (trigger === 'show-info-feedback') {
      await page.keyboard.press('Tab');
      await close.focus();
    } else if (trigger === 'open-close-confirmation') {
      // Confirmation opens on its primary action; move backwards past Cancel.
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Shift+Tab');
    } else {
      await page.keyboard.press('Tab');
    }
    await expect(close).toBeFocused();
    await expect(close).toHaveCSS('outline-style', 'solid');
    await expect(close).toHaveCSS('outline-width', '2px');
    await expect(close).toHaveCSS('outline-color', 'rgb(165, 165, 165)');
    await expect(close).toHaveCSS(
      'outline-offset',
      trigger === 'show-info-feedback' ? '2px' : '-2px'
    );
    await expect(close).toHaveCSS('background-color', 'rgba(52, 86, 120, 0.5)');
    await page.screenshot({ path: testInfo.outputPath(`icon-action-${trigger}.png`) });
    await close.press('Enter');
    await expect(close).toHaveCount(0);
  }
});

test('lazy loading directive displays and removes its styled mask', async ({ page }) => {
  const sample = page.getByRole('region', { name: 'Loading directive sample' });
  const panel = sample.locator('.page-loading-panel');
  const mask = panel.locator('.mar-ui-loading');
  await expect(panel).toHaveAttribute('aria-busy', 'true');
  await expect(mask).toBeVisible();
  await expect(mask).toHaveCSS('position', 'absolute');
  await sample.getByRole('button', { name: 'Toggle sample loading' }).click();
  await expect(panel).toHaveAttribute('aria-busy', 'false');
  await expect(mask).toBeHidden();
});

for (const scheme of ['Dark', 'Light']) {
  for (const custom of [false, true]) {
    test(`semantic MAR link actions remain legible and distinguish disabled state in ${scheme} ${custom ? 'custom' : 'built-in'} palette`, async ({
      page
    }, testInfo) => {
      if (scheme === 'Light')
        await page
          .locator('.theme-option')
          .filter({ has: page.getByRole('button', { name: 'Inspect Light', exact: true }) })
          .getByRole('button', { name: 'Apply theme', exact: true })
          .click();
      const controls = page.getByRole('region', { name: 'Real theme controls' });
      await expect(controls).toBeVisible();
      if (custom)
        await page.evaluate((dark) => {
          const root = document.documentElement.style;
          root.setProperty('--mar-control-color-warning', dark ? '#ffeda8' : '#2b1900');
          root.setProperty('--mar-control-color-danger', dark ? '#ffd2dd' : '#300511');
        }, scheme === 'Dark');
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        for (const type of ['warning', 'danger']) {
          const action = controls.getByRole('button', {
            name: `Sample ${type} action`,
            exact: true
          });
          const disabled = controls.getByRole('button', {
            name: `Sample disabled ${type} action`,
            exact: true
          });
          const appearance = (button: Locator) =>
            button.evaluate(async (element, tone) => {
              await Promise.all(element.getAnimations().map((animation) => animation.finished));
              const probe = document.createElement('span');
              probe.style.color = 'var(--mar-bg-page)';
              element.append(probe);
              const background = getComputedStyle(probe).color;
              probe.style.color = `var(--mar-ui-control-color-${tone})`;
              const semanticColor = getComputedStyle(probe).color;
              probe.remove();
              return { color: getComputedStyle(element).color, background, semanticColor };
            }, type);
          await page.mouse.move(0, 0);
          const normal = await appearance(action);
          const inactive = await appearance(disabled);
          expect(normal.color).toBe(normal.semanticColor);
          expect(colorContrast(normal.color, normal.background)).toBeGreaterThanOrEqual(4.5);
          await action.hover();
          const hover = await appearance(action);
          expect(hover.color).toBe(hover.semanticColor);
          expect(colorContrast(hover.color, hover.background)).toBeGreaterThanOrEqual(4.5);
          expect(resolvedColorToHex(hover.color)).not.toBe(resolvedColorToHex(inactive.color));
          await expect(action.locator('svg')).toHaveCSS('color', hover.color);
          await expect(action).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
          await page.mouse.down();
          try {
            const active = await appearance(action);
            expect(colorContrast(active.color, active.background)).toBeGreaterThanOrEqual(4.5);
            await expect(action).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
          } finally {
            await page.mouse.up();
          }
          await disabled.hover({ force: true });
          await expect(disabled).toBeDisabled();
          await expect(disabled).toHaveCSS('color', inactive.color);
          await expect(disabled).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
          await action.focus();
          await page.keyboard.press('Shift+Tab');
          await page.keyboard.press('Tab');
          await expect(action).toBeFocused();
          await expect(action).toHaveCSS('outline-style', 'solid');
          await expect(action).toHaveCSS('outline-width', '2px');
        }
        await controls.getByRole('button', { name: 'Sample danger action', exact: true }).hover();
        await controls.screenshot({ path: testInfo.outputPath(`semantic-actions-${width}.png`) });
      }
    });
  }
}

for (const scheme of ['Light', 'Dark']) {
  test(`lazy dropdown retains ${scheme} and custom hover tokens and commands`, async ({ page }) => {
    if (scheme === 'Light')
      await page
        .locator('.theme-option')
        .filter({
          has: page.getByRole('button', { name: 'Inspect Light', exact: true })
        })
        .getByRole('button', { name: 'Apply theme', exact: true })
        .click();
    const trigger = page.getByRole('button', { name: 'Sample menu', exact: true });
    for (const custom of [false, true]) {
      if (custom)
        await page.locator('html').evaluate((root) => {
          root.style.setProperty('--mar-fill-row-hover', '#345678');
          root.style.setProperty('--mar-text-primary', '#e5d6c7');
        });
      await trigger.click();
      const item = page.getByRole('menuitem', { name: 'Rename', exact: true });
      await item.hover();
      const colors = await item.evaluate((element) => {
        const probe = document.createElement('span');
        element.append(probe);
        const token = (name: string) => {
          probe.style.color = `var(${name})`;
          return getComputedStyle(probe).color;
        };
        const result = {
          background: getComputedStyle(element).backgroundColor,
          color: getComputedStyle(element).color,
          hover: token('--mar-overlay-row-hover, var(--mar-fill-row-hover)'),
          text: token('--mar-text-primary')
        };
        probe.remove();
        return result;
      });
      expect(colors.background).toBe(colors.hover);
      expect(colors.color).toBe(colors.text);
      await item.click();
      await expect(page.getByLabel('Selected menu action')).toHaveText('rename');
    }
  });
}

for (const scheme of ['Light', 'Dark']) {
  test(`Conversation file links retain pointer and keyboard activation in ${scheme}`, async ({
    page
  }) => {
    const theme = page.locator('.theme-option').filter({
      has: page.getByRole('button', { name: 'Inspect ' + scheme, exact: true })
    });
    if (scheme === 'Light')
      await theme.getByRole('button', { name: 'Apply theme', exact: true }).click();
    const section = page.getByRole('region', { name: 'Conversation file links' });
    const output = section.getByLabel('Opened Markdown files');
    const opened: { path: string; line?: number; external: boolean }[] = [];
    for (const [name, path, line] of [
      ['Windows protocol', 'docs/design/BLE_PROTOCOL.md', 7],
      ['README.md:10', 'README.md', 10],
      ['Relative file', 'docs/guide.md', 3],
      ['Temporary file', '/tmp/note.txt', undefined]
    ] as const) {
      const link = section.getByRole('link', { name, exact: true });
      await expect(link).toHaveAttribute('href', '#');
      await expect(link).toHaveCSS('cursor', 'pointer');
      await link.click();
      opened.push({ path, ...(line === undefined ? {} : { line }), external: false });
      await expect(output).toHaveText(JSON.stringify(opened));
      await link.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(link).toBeFocused();
      await page.keyboard.press('Enter');
      opened.push({ path, ...(line === undefined ? {} : { line }), external: false });
      await expect(output).toHaveText(JSON.stringify(opened));
      await expect(page).toHaveURL(/custom-theme\.html$/u);
    }
    await section.getByRole('link', { name: 'Windows protocol', exact: true }).click({
      modifiers: ['Control']
    });
    opened.push({ path: 'docs/design/BLE_PROTOCOL.md', line: 7, external: true });
    await expect(output).toHaveText(JSON.stringify(opened));
    await expect(page).toHaveURL(/custom-theme\.html$/u);
    const external = section.getByRole('link', { name: 'External website', exact: true });
    await expect(external).toHaveAttribute('href', 'https://example.com/help');
    await expect(external).toHaveAttribute('target', '_blank');
    await expect(external).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(external).toHaveCSS('cursor', 'pointer');
    await expect(section.locator('a[href^="javascript:"]')).toHaveCount(0);
  });
}

test('Appearance choices keep file mode, icon theme and language independent on desktop and touch', async ({
  browser
}, testInfo) => {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({
      viewport: { width, height: 840 },
      hasTouch: width === 390
    });
    try {
      await page.goto(`${fixture.url}custom-theme.html?appearance-only`);
      await page.getByRole('button', { name: 'Appearance', exact: true }).click();
      const mode = page.getByRole('combobox', { name: 'Default file mode', exact: true });
      const modeChoices = page.getByRole('listbox', { name: 'Default file mode', exact: true });
      const icon = page.getByRole('combobox', { name: 'Icon theme', exact: true });
      const language = page.getByRole('combobox', { name: 'Language', exact: true });
      await expect(mode).toHaveText('Read only');
      if (width === 390) await mode.tap();
      else await mode.press('Enter');
      await expect(modeChoices.getByRole('option', { name: 'Read only' })).toHaveAttribute(
        'aria-selected',
        'true'
      );
      if (width === 390) {
        await modeChoices.getByRole('option', { name: 'Edit', exact: true }).tap();
      } else {
        await mode.press('ArrowUp');
        await expect(mode).toHaveText('Read only');
        await mode.press('Enter');
      }
      await expect(modeChoices).toBeHidden();
      await expect(mode).toHaveText('Edit');
      await icon.click();
      await expect(
        page.getByRole('listbox', { name: 'Icon theme' }).getByRole('option')
      ).toHaveCount(1);
      await page.getByRole('option', { name: 'MAR File Icons' }).click();
      await expect(icon).toHaveText('MAR File Icons');
      expect(await page.evaluate(() => localStorage.getItem('mar.icon-theme.v2'))).toBeNull();
      await language.click();
      const languageChoices = page.getByRole('listbox', { name: 'Language' });
      await expect(languageChoices).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`appearance-choices-${width}.png`) });
      await languageChoices.getByRole('option', { name: '简体中文' }).click();
      await expect(page.getByRole('heading', { name: '外观' })).toBeVisible();
      await expect(page.getByRole('combobox', { name: '文件默认打开方式' })).toHaveText('编辑');
      await expect(page.getByRole('combobox', { name: '语言' })).toHaveText('简体中文');
      expect(await page.evaluate(() => localStorage.getItem('mar.locale.v2'))).toBe('zh-CN');
      expect(await page.evaluate(() => localStorage.getItem('mar.file-editor.default-mode'))).toBe(
        'edit'
      );
    } finally {
      await page.close();
    }
  }
});

test('custom theme JSON flows through warnings, save, Appearance, reload, export, import and deletion', async ({
  page,
  context
}, testInfo) => {
  const editor = page.getByRole('textbox', { name: 'Theme JSON', exact: true });
  const apiRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url());
  });
  await useThemeMenu(page, page.locator('.theme-option').first(), 'Duplicate');
  await editor.fill('{');
  await page.getByRole('button', { name: 'Save theme', exact: true }).click();
  await expect(
    page.getByRole('complementary', { name: 'Theme preview and validation' }).getByRole('alert')
  ).toContainText('Invalid JSON');
  expect(await page.evaluate(() => localStorage.getItem('mar.customThemes'))).toBeNull();
  const source = JSON.stringify(
    {
      version: 1,
      name: 'Ocean',
      colors: {
        '--mar-bg-page': '#ffffff',
        '--mar-bg-panel': '#ddeeff',
        '--mar-text-primary': '#112233',
        '--mar-control-fill-color': '#ff66bb',
        '--mar-conversation-activity-fg': '#2155bb',
        '--mar-font-size-body': '100px',
        '--mar-fill-muted': 'url(https://invalid.test/image)'
      },
      extension: { retained: true }
    },
    null,
    2
  );
  await editor.fill(source);
  await editor.blur();
  await expect(page.locator('.validation')).toContainText('saving is allowed');
  await expect(editor).not.toHaveAttribute('aria-invalid', 'true');
  await expect(
    page.locator('.mar-ui-form-item').filter({ has: editor }).locator('.mar-ui-form-item__error')
  ).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('theme-desktop.png'), fullPage: true });
  await expect(page.locator('.mar-theme-preview .preview-toolbar')).toHaveCSS(
    'background-color',
    'rgb(221, 238, 255)'
  );
  expect(
    await page.evaluate(() => document.documentElement.style.getPropertyValue('--mar-bg-panel'))
  ).toBe('');
  await page.getByRole('button', { name: 'Save theme', exact: true }).click();
  await expect(page.locator('.theme-options')).toContainText('Ocean');
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.getByRole('combobox', { name: 'Theme', exact: true }).focus();
  await page.getByRole('combobox', { name: 'Theme', exact: true }).press('ArrowDown');
  await page.getByRole('option', { name: 'Ocean', exact: true }).click();
  await expect(page.locator('.settings-content')).toHaveCSS(
    'background-color',
    'rgb(221, 238, 255)'
  );
  expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(
    false
  );
  await page.reload();
  await expect(page.locator('.settings-content')).toHaveCSS(
    'background-color',
    'rgb(221, 238, 255)'
  );
  await page.getByRole('button', { name: 'Inspect Ocean', exact: true }).click();
  await expect(editor).toHaveValue(source);
  await expect(page.locator('.validation')).toContainText('--mar-control-fill-color');
  expect(
    await page
      .locator('html')
      .evaluate((root) => root.style.getPropertyValue('--mar-control-fill-color'))
  ).toBe('');
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('Ocean.json');
  expect(await readFile((await download.path())!, 'utf8')).toBe(source);
  await grantClipboardPermissions(context);
  await page.getByRole('button', { name: 'Copy JSON', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(source);
  await page.locator('input[type=file]').setInputFiles({
    name: 'Ocean.json',
    mimeType: 'application/json',
    buffer: Buffer.from(source)
  });
  await page.getByRole('button', { name: 'Save theme', exact: true }).click();
  await expect(page.locator('.theme-option')).toHaveCount(4);
  await useThemeMenu(
    page,
    page.locator('.theme-option').filter({ hasText: 'Ocean' }).first(),
    'Delete'
  );
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('.theme-option')).toHaveCount(3);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'vscode-dark-2026');
  expect(
    await page.evaluate(() => document.documentElement.style.getPropertyValue('--mar-bg-panel'))
  ).toBe('');
  expect(apiRequests).toEqual([]);
});

test('duplicate, draft protection and formatting work without changing the active palette', async ({
  page
}) => {
  const editor = page.getByRole('textbox', { name: 'Theme JSON', exact: true });
  await useThemeMenu(page, page.locator('.theme-option').first(), 'Duplicate');
  await editor.fill(JSON.stringify({ name: 'Original', version: 1, colors: {} }));
  await page.getByRole('button', { name: 'Save theme', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Inspect Original', exact: true })).toBeVisible();
  await useThemeMenu(
    page,
    page.locator('.theme-option').filter({ hasText: 'Original' }),
    'Duplicate'
  );
  await expect.poll(async () => JSON.parse(await editor.inputValue()).name).toBe('Original (copy)');
  await page
    .getByRole('button', { name: /^Inspect /u })
    .first()
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(JSON.parse(await editor.inputValue()).name).toBe('Original (copy)');
  await page.getByRole('button', { name: 'Save theme', exact: true }).click();
  await expect(page.locator('.theme-option')).toHaveCount(4);
  await editor.fill('null');
  await page.getByRole('button', { name: 'Format JSON', exact: true }).click();
  await page.getByRole('button', { name: 'Save theme', exact: true }).click();
  await expect(page.locator('.theme-options')).toContainText('Untitled theme');
  await expect(page.locator('.validation')).toContainText('saving is allowed');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'vscode-dark-2026');
});

test('PWA update reloads an unsaved theme without a leave confirmation', async ({ page }) => {
  await page.route('**/web-version.json', (route) =>
    route.fulfill({ json: { version: 'next', hash: 'next-build' } })
  );
  await page.goto(`${fixture.url}custom-theme.html?pwaUpdate`);
  await useThemeMenu(page, page.locator('.theme-option').first(), 'Duplicate');
  await page.getByRole('textbox', { name: 'Theme JSON', exact: true }).fill('unsaved draft');
  expect(
    await page.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true })))
  ).toBe(false);
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.type());
    void dialog.accept();
  });
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    page.getByRole('button', { name: 'Apply PWA update', exact: true }).click()
  ]);
  expect(dialogs).toEqual([]);
  await expect(page.getByRole('textbox', { name: 'Theme JSON', exact: true })).not.toHaveValue(
    'unsaved draft'
  );
});

test('custom theme status and hover contrast warnings preserve editable colors and allow saving', async ({
  page
}, testInfo) => {
  const editor = page.getByRole('textbox', { name: 'Theme JSON', exact: true });
  const theme = {
    version: 1,
    name: 'Status contrast review',
    colors: {
      '--mar-color-danger-text': '#777777',
      '--mar-color-danger-bg': '#777777',
      '--mar-control-primary-fg': '#777777',
      '--mar-control-primary-hover': '#777777',
      '--mar-conversation-activity-fg': '#777777',
      '--mar-fill-subtle': '#777777'
    }
  };
  const source = JSON.stringify(theme, null, 2);
  await page.locator('.file-input').setInputFiles({
    name: 'status-contrast.json',
    mimeType: 'application/json',
    buffer: Buffer.from(source)
  });
  await expect(editor).toBeEditable();
  const validation = page.locator('.validation');
  await expect(validation).toContainText('--mar-color-danger-text / --mar-color-danger-bg');
  await expect(validation).toContainText('--mar-control-primary-fg / --mar-control-primary-hover');
  await expect(validation).toContainText('--mar-conversation-activity-fg / --mar-fill-subtle');
  await expect(validation).toContainText('saving is allowed');
  await expect(page.locator('.mar-theme-preview .danger')).toHaveCSS('color', 'rgb(119, 119, 119)');
  await expect(page.locator('.mar-theme-preview .danger')).toHaveCSS(
    'background-color',
    'rgb(119, 119, 119)'
  );
  await page.getByRole('button', { name: 'Save theme', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Inspect Status contrast review', exact: true })
  ).toBeVisible();
  await expect(editor).toHaveValue(source);
  await page
    .locator('.editor-layout')
    .screenshot({ path: testInfo.outputPath('status-contrast-warning.png') });
  theme.colors['--mar-color-danger-text'] = '#ffffff';
  theme.colors['--mar-color-danger-bg'] = '#000000';
  theme.colors['--mar-control-primary-fg'] = '#ffffff';
  theme.colors['--mar-control-primary-hover'] = '#000000';
  theme.colors['--mar-fill-subtle'] = '#ffffff';
  await editor.fill(JSON.stringify(theme));
  await expect(validation).toContainText('No detected warnings.');
});

test('built-ins are read-only, copies include every color, and reset restores saved or copied drafts', async ({
  page
}) => {
  const editor = page.getByRole('textbox', { name: 'Theme JSON', exact: true });
  const rows = page.locator('.theme-option');
  await expect(rows).toHaveCount(2);
  await expect(
    rows.first().getByRole('button', { name: 'Inspect Dark', exact: true })
  ).toBeVisible();
  await expect(
    rows.nth(1).getByRole('button', { name: 'Inspect Light', exact: true })
  ).toBeVisible();
  await expect(editor).toHaveAttribute('readonly', '');
  await expect(page.locator('.validation')).toContainText('No detected warnings.');
  const dark = JSON.parse(await editor.inputValue());
  expect(dark.colors['--mar-control-color-warning']).toBe('#ffc14d');
  expect(dark.colors['--mar-color-warning-accent']).toBe('#ffc14d');
  const validation = await page.locator('.validation').boundingBox();
  const preview = await page.locator('.preview-heading').boundingBox();
  expect(validation!.y + validation!.height).toBeLessThanOrEqual(preview!.y);
  await expect(
    page.getByRole('button', { name: 'Theme color reference', exact: true })
  ).toBeVisible();
  const themeSettings = page.locator('.theme-settings');
  await expect(themeSettings.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
  await expect(themeSettings.getByRole('button', { name: /New (dark|light) theme/ })).toHaveCount(
    0
  );
  await expect(
    themeSettings.getByRole('columnheader', { name: 'Base theme', exact: true })
  ).toHaveCount(0);
  await expect(themeSettings.getByRole('button', { name: 'Save theme', exact: true })).toHaveCount(
    0
  );
  await rows
    .nth(1)
    .getByRole('button', { name: /^Inspect /u })
    .click();
  await expect(page.locator('.validation')).toContainText('No detected warnings.');
  const light = JSON.parse(await editor.inputValue());
  expect(light).not.toHaveProperty('base');
  for (const token of CUSTOM_THEME_TOKENS)
    expect(light.colors[token]).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/u);
  expect(light.colors['--mar-bg-panel']).toBe('#ffffff');
  expect(light.colors['--mar-control-color-warning']).toBe('#a56000');
  expect(light.colors['--mar-color-warning-accent']).toBe('#a56000');
  await useThemeMenu(page, rows.nth(1), 'Duplicate');
  const copied = await editor.inputValue();
  expect(JSON.parse(copied).colors).toEqual(light.colors);
  const lowContrast = JSON.parse(copied);
  lowContrast.colors['--mar-control-primary-fg'] = lowContrast.colors['--mar-control-primary-bg'];
  await editor.fill(JSON.stringify(lowContrast));
  await expect(page.locator('.validation')).toContainText(
    '--mar-control-primary-fg / --mar-control-primary-bg'
  );
  await editor.fill(copied);
  await expect(page.locator('.validation')).toContainText('No detected warnings.');
  await expect(editor).not.toHaveAttribute('readonly', '');
  for (const name of ['Save theme', 'Format JSON', 'Reset']) {
    await expect(page.getByRole('button', { name, exact: true }).locator('svg')).toBeVisible();
  }
  const actions = await page.locator('.editor-layout form .actions').boundingBox();
  const jsonEditor = await editor.boundingBox();
  expect(actions!.y + actions!.height).toBeLessThanOrEqual(jsonEditor!.y);
  const previewPanel = await page.locator('.editor-layout .mar-theme-preview').boundingBox();
  expect(
    Math.abs(jsonEditor!.y + jsonEditor!.height - previewPanel!.y - previewPanel!.height)
  ).toBeLessThanOrEqual(1);
  await expect(
    page.locator('.editor-layout form').getByRole('button', { name: 'Reset', exact: true })
  ).toBeDisabled();
  await editor.fill('null');
  await page
    .locator('.editor-layout form')
    .getByRole('button', { name: 'Reset', exact: true })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(editor).toHaveValue('null');
  await page
    .locator('.editor-layout form')
    .getByRole('button', { name: 'Reset', exact: true })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(editor).toHaveValue(copied);
  expect(await page.evaluate(() => localStorage.getItem('mar.customThemes'))).toBeNull();
  await page.getByRole('button', { name: 'Save theme', exact: true }).click();
  await editor.fill('{}');
  await page
    .locator('.editor-layout form')
    .getByRole('button', { name: 'Reset', exact: true })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(editor).toHaveValue(copied);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('mar.customThemes')!));
  expect(stored).toHaveLength(1);
  expect(stored[0].source).toBe(copied);
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  const select = page.getByRole('combobox', { name: 'Theme', exact: true });
  await select.focus();
  await select.press('ArrowDown');
  await page.getByRole('option', { name: 'Light (copy)', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(
    false
  );
  for (const token of [
    '--mar-bg-page',
    '--mar-bg-panel',
    '--mar-control-primary-bg',
    '--mar-border-subtle'
  ]) {
    expect(
      await page.evaluate((key) => document.documentElement.style.getPropertyValue(key), token)
    ).toBe(light.colors[token]);
  }
});

for (const scheme of ['Light', 'Dark']) {
  test(`Select options separate neutral selection from keyboard focus in ${scheme}`, async ({
    page
  }, testInfo) => {
    if (scheme === 'Light')
      await page
        .locator('.theme-option')
        .filter({ has: page.getByRole('button', { name: 'Inspect Light', exact: true }) })
        .getByRole('button', { name: 'Apply theme', exact: true })
        .click();
    const samples = page.getByRole('region', { name: 'Select state samples' });
    for (const custom of [false, true]) {
      if (custom)
        await page.locator('html').evaluate((element) => {
          for (const [token, value] of Object.entries({
            '--mar-conversation-activity-fg': '#bf6ac9',
            '--mar-control-focus': '#9c9c9c',
            '--mar-text-primary': '#dae5cf',
            '--mar-text-disabled': '#8293a4',
            '--mar-border-medium': '#718293',
            '--mar-fill-row-hover': '#334455',
            '--mar-fill-selection': '#445566'
          }))
            element.style.setProperty(token, value);
        });
      const palette = await samples.evaluate((element) => {
        const probe = document.createElement('span');
        element.append(probe);
        const color = (token: string) => {
          probe.style.color = `var(${token})`;
          return getComputedStyle(probe).color;
        };
        const result = {
          text: color('--mar-text-primary'),
          disabled: color('--mar-text-disabled'),
          selected: color('--mar-fill-selection'),
          hover: color('--mar-overlay-row-hover, var(--mar-fill-row-hover)'),
          hoverBorder: color('--mar-input-border-hover'),
          disabledBorder: color('--mar-border-subtle'),
          focus: color('--mar-control-focus')
        };
        probe.remove();
        return result;
      });
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        for (const name of ['Neutral select', 'Multiple select']) {
          const select = samples.getByRole('combobox', { name, exact: true });
          const wrapper = select.locator(
            'xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," mar-ui-select__field ")][1]'
          );
          await page.getByRole('button', { name: 'Sample default', exact: true }).focus();
          await wrapper.hover();
          await expect(wrapper).toHaveCSS(
            'box-shadow',
            `${palette.hoverBorder} 0px 0px 0px 1px inset`
          );
          // Move off the field before opening so the pointer cannot land on the popup.
          await page.mouse.move(0, 0);
          await select.focus();
          await page.keyboard.press('Shift+Tab');
          await page.keyboard.press('Tab');
          await expect(select).toBeFocused();
          await page.keyboard.press('ArrowDown');
          await expect(wrapper).toHaveCSS('box-shadow', `${palette.focus} 0px 0px 0px 1px inset`);
          const dropdown = page.getByRole('listbox', { name, exact: true });
          const selected = dropdown.getByRole('option', { name: 'One', exact: true });
          const other = dropdown.getByRole('option', { name: 'Two', exact: true });
          const disabled = dropdown.getByRole('option', { name: 'Unavailable', exact: true });
          await expect(selected).toHaveAttribute('aria-selected', 'true');
          await expect(selected).toHaveCSS('color', palette.text);
          await expect(selected).toHaveCSS('font-weight', '400');
          await expect(selected).toHaveCSS('background-color', palette.selected);
          await expect(select).toHaveAttribute(
            'aria-activedescendant',
            (await selected.getAttribute('id'))!
          );
          await expect(selected).toHaveCSS('outline-style', 'solid');
          if (!custom) {
            const { outlineColor, backgroundColor } = await selected.evaluate((element) => {
              const style = getComputedStyle(element);
              return { outlineColor: style.outlineColor, backgroundColor: style.backgroundColor };
            });
            expect(colorContrast(outlineColor, backgroundColor)).toBeGreaterThanOrEqual(3);
          }
          await other.hover();
          await expect(other).toHaveCSS('color', palette.text);
          await expect(other).toHaveCSS('background-color', palette.hover);
          if (!custom) {
            const surface = await dropdown.evaluate(
              (element) => getComputedStyle(element).backgroundColor
            );
            expect(resolvedColorToHex(palette.hover)).not.toBe(resolvedColorToHex(surface));
          }
          await selected.hover();
          await expect(selected).toHaveCSS('background-color', palette.selected);
          await disabled.hover({ force: true });
          await expect(disabled).toHaveAttribute('aria-disabled', 'true');
          await expect(disabled).toHaveCSS('color', palette.disabled);
          await expect(disabled).toHaveCSS(
            'background-color',
            name === 'Multiple select' ? palette.selected : 'rgba(0, 0, 0, 0)'
          );
          if (name === 'Multiple select') {
            await expect(selected.locator('[data-mar-icon="check"]')).toHaveCSS(
              'color',
              palette.text
            );
            await expect(disabled.locator('[data-mar-icon="check"]')).toHaveCSS(
              'color',
              palette.disabled
            );
          }
          if (!custom)
            await dropdown.screenshot({ path: testInfo.outputPath(`${name}-${width}.png`) });
          await select.press('Escape');
          await expect(dropdown).toBeHidden();
        }
        const disabledSelect = samples.getByRole('combobox', {
          name: 'Disabled select',
          exact: true
        });
        await expect(disabledSelect).toBeDisabled();
        const disabledWrapper = disabledSelect.locator(
          'xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," mar-ui-select__field ")][1]'
        );
        await disabledWrapper.hover();
        await expect(disabledWrapper).toHaveCSS(
          'box-shadow',
          `${palette.disabledBorder} 0px 0px 0px 1px inset`
        );
      }
    }
  });

  test(`Filled primary, warning and danger actions preserve text contrast in ${scheme}`, async ({
    page
  }) => {
    if (scheme === 'Light')
      await page
        .locator('.theme-option')
        .filter({ has: page.getByRole('button', { name: 'Inspect Light', exact: true }) })
        .getByRole('button', { name: 'Apply theme', exact: true })
        .click();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const controls = page.getByRole('region', { name: 'Real theme controls' });
    for (const [name, tone] of [
      ['Sample primary', 'primary-fg'],
      ['Sample filled warning', 'color-warning'],
      ['Sample filled danger', 'color-danger']
    ] as const) {
      const button = controls.getByRole('button', { name, exact: true });
      const expectedText =
        scheme === 'Light' && tone !== 'primary-fg'
          ? '#ffffff'
          : await button.evaluate(
              (element, token) =>
                getComputedStyle(element).getPropertyValue(`--mar-control-${token}`).trim(),
              tone
            );
      const appearance = () =>
        button.evaluate((element) => {
          const { color, backgroundColor } = getComputedStyle(element);
          return { color, backgroundColor };
        });
      await page.mouse.move(0, 0);
      const normal = await appearance();
      expect(resolvedColorToHex(normal.color)).toBe(expectedText);
      expect(
        colorContrast(normal.color, normal.backgroundColor),
        `${name}, rest`
      ).toBeGreaterThanOrEqual(4.5);
      await button.hover();
      const hover = await appearance();
      expect(resolvedColorToHex(hover.color)).toBe(expectedText);
      expect(hover.backgroundColor).not.toBe(normal.backgroundColor);
      expect(
        colorContrast(hover.color, hover.backgroundColor),
        `${name}, hover`
      ).toBeGreaterThanOrEqual(4.5);
      await page.mouse.down();
      try {
        const active = await appearance();
        expect(resolvedColorToHex(active.color)).toBe(expectedText);
        expect(active.backgroundColor).not.toBe(hover.backgroundColor);
        expect(
          colorContrast(active.color, active.backgroundColor),
          `${name}, press`
        ).toBeGreaterThanOrEqual(4.5);
      } finally {
        await page.mouse.up();
      }
    }
  });

  test(`Ordinary actions preserve neutral states and bordered surfaces in ${scheme}`, async ({
    page
  }, testInfo) => {
    if (scheme === 'Light')
      await page
        .locator('.theme-option')
        .filter({ has: page.getByRole('button', { name: 'Inspect Light', exact: true }) })
        .getByRole('button', { name: 'Apply theme', exact: true })
        .click();
    const controls = page.getByRole('region', { name: 'Real theme controls' });
    const secondary = controls.getByRole('button', { name: 'Sample default', exact: true });
    const neutral = controls.getByRole('button', { name: 'Sample neutral action', exact: true });
    const disabled = controls.getByRole('button', { name: 'Sample disabled default', exact: true });
    const danger = controls.getByRole('button', { name: 'Sample dangerous action', exact: true });
    const navigation = controls.getByRole('link', { name: 'Manage usage', exact: true });
    for (const custom of [false, true]) {
      if (custom)
        await page.locator('html').evaluate((element) => {
          for (const [token, value] of Object.entries({
            '--mar-text-primary': '#dae5cf',
            '--mar-text-secondary': '#a5b6c7',
            '--mar-conversation-activity-fg': '#bf6ac9',
            '--mar-control-focus': '#9c9c9c',
            '--mar-fill-row-hover': '#334455',
            '--mar-fill-selection': '#445566',
            '--mar-border-medium': '#718293'
          }))
            element.style.setProperty(token, value);
        });
      const colors = await controls.evaluate((element) => {
        const probe = document.createElement('span');
        element.append(probe);
        const color = (token: string) => {
          probe.style.color = `var(${token})`;
          return getComputedStyle(probe).color;
        };
        const result = {
          normal: color('--mar-text-secondary'),
          normalSurface: color('--mar-fill-soft'),
          hover: color('--mar-text-primary'),
          surface: color('--mar-fill-row-hover'),
          pressed: color('--mar-fill-selection'),
          border: color('--mar-border-medium'),
          focus: color('--mar-control-focus')
        };
        probe.remove();
        return result;
      });
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await controls.getByRole('textbox', { name: 'Sample input' }).focus();
        await page.mouse.move(0, 0);
        await expect(neutral).toHaveCSS('color', colors.normal);
        await neutral.hover();
        await expect(neutral).toHaveCSS('color', colors.hover);
        await expect(neutral).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await page.mouse.down();
        await expect(neutral).toHaveCSS('color', colors.hover);
        await page.mouse.up();
        await secondary.hover();
        await expect(secondary).toHaveCSS('color', colors.hover);
        await expect(secondary).toHaveCSS('background-color', colors.surface);
        await expect(secondary).toHaveCSS('border-top-color', colors.border);
        await expect(secondary).toHaveCSS('border-top-width', '1px');
        await expect(secondary).toHaveCSS('transform', 'none');
        await page.mouse.down();
        await expect(secondary).toHaveCSS('background-color', colors.pressed);
        await page.mouse.up();
        await page.mouse.move(0, 0);
        await secondary.focus();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Shift+Tab');
        await expect(secondary).toBeFocused();
        await expect(secondary).toHaveCSS('color', colors.normal);
        await expect(secondary).toHaveCSS('background-color', colors.normalSurface);
        const beforeKeyboard = await secondary.evaluate((element) => {
          if (!element.hasAttribute('data-keyboard-clicks')) {
            element.addEventListener('click', () => {
              element.setAttribute(
                'data-keyboard-clicks',
                String(Number(element.getAttribute('data-keyboard-clicks')) + 1)
              );
            });
          }
          element.setAttribute('data-keyboard-clicks', '0');
          const style = getComputedStyle(element);
          return { color: style.color, background: style.backgroundColor };
        });
        await page.keyboard.down('Space');
        try {
          // Gecko activates on keyup without exposing :active while Space is held.
          const active = await secondary.evaluate((element) => element.matches(':active'));
          await expect(secondary).toHaveCSS('color', active ? colors.hover : beforeKeyboard.color);
          await expect(secondary).toHaveCSS(
            'background-color',
            active ? colors.pressed : beforeKeyboard.background
          );
        } finally {
          await page.keyboard.up('Space');
        }
        await expect(secondary).toHaveAttribute('data-keyboard-clicks', '1');
        await neutral.focus();
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Tab');
        await expect(neutral).toBeFocused();
        await expect(neutral).toHaveCSS('outline-color', colors.focus);
        await expect(neutral).toHaveCSS('outline-style', 'solid');
        const disabledColor = await disabled.evaluate((element) => getComputedStyle(element).color);
        await disabled.hover({ force: true });
        await expect(disabled).toBeDisabled();
        await expect(disabled).toHaveCSS('color', disabledColor);
        await danger.hover();
        await expect(danger).not.toHaveCSS('color', colors.hover);
        await expect(danger).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(navigation).toHaveAttribute('href', 'https://chatgpt.com/settings/usage');
        await expect(navigation).toHaveAttribute('target', '_blank');
        await expect(navigation).toHaveAttribute('rel', 'noopener noreferrer');
        await navigation.hover();
        await expect(navigation).toHaveCSS('color', colors.hover);
        await expect(navigation).toHaveCSS('background-color', colors.surface);
        const preview = page.locator('.mar-theme-preview').first();
        const previewColors = await preview.evaluate((element) => {
          const probe = document.createElement('span');
          element.append(probe);
          const color = (token: string) => {
            probe.style.color = `var(${token})`;
            return getComputedStyle(probe).color;
          };
          const palette = {
            text: color('--mar-text-primary'),
            hover: color('--mar-fill-row-hover'),
            pressed: color('--mar-fill-selection'),
            border: color('--mar-border-medium'),
            disabledFill: color('--mar-bg-panel'),
            disabledBorder: color('--mar-border-subtle'),
            foreground: color('--mar-control-primary-fg'),
            primaryHover: color('--mar-control-primary-hover')
          };
          probe.remove();
          return palette;
        });
        const previewDisabled = preview.locator('.preview-button:disabled');
        await expect(previewDisabled).toHaveCSS('background-color', previewColors.disabledFill);
        await expect(previewDisabled).toHaveCSS('border-top-color', previewColors.disabledBorder);
        const previewSecondary = preview.locator('.preview-button.secondary');
        await previewSecondary.hover();
        await expect(previewSecondary).toHaveCSS('color', previewColors.text);
        await expect(previewSecondary).toHaveCSS('background-color', previewColors.hover);
        await expect(previewSecondary).toHaveCSS('border-top-color', previewColors.border);
        await page.mouse.move(0, 0);
        await previewSecondary.focus();
        await previewSecondary.hover();
        await page.mouse.down();
        try {
          await expect(previewSecondary).toHaveCSS('color', previewColors.text);
          await expect(previewSecondary).toHaveCSS('background-color', previewColors.pressed);
        } finally {
          await page.mouse.up();
        }
        const previewPrimary = preview.locator('.preview-button.primary');
        await previewPrimary.hover();
        await expect(previewPrimary).toHaveCSS('color', previewColors.foreground);
        await expect(previewPrimary).toHaveCSS('background-color', previewColors.primaryHover);
        await controls.screenshot({
          path: testInfo.outputPath(`neutral-actions-${custom ? 'custom' : 'builtin'}-${width}.png`)
        });
      }
    }
  });

  test(
    'workspace uses one neutral Git branch tag in the ' + scheme + ' theme',
    async ({ page }, testInfo) => {
      const row = page.locator('.theme-option').filter({
        has: page.getByRole('button', { name: 'Inspect ' + scheme, exact: true })
      });
      if (scheme === 'Light')
        await row.getByRole('button', { name: 'Apply theme', exact: true }).click();
      const workspace = page.getByRole('region', { name: 'Real workspace labels' });
      const branch = workspace.locator('.workspace-branch-tag');
      const branchName = branch.locator('.workspace-branch-name');
      const gitIcon = branch.getByRole('img', { name: 'Git' });
      const input = workspace.getByRole('textbox', { name: 'Workspace branch' });
      const colors = scheme === 'Light' ? ['#43536b', '#b9cadf'] : ['#c2c2c2', '#474747'];
      async function expectColors(expected: string[]): Promise<void> {
        await expect(branch).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(async () => {
          const actual = await branch.evaluate((element) => {
            const style = getComputedStyle(element);
            return [style.color, style.borderTopColor];
          });
          expect(actual.map(resolvedColorToHex)).toEqual(expected);
          const nameColor = await branchName.evaluate((el) => getComputedStyle(el).color);
          expect(resolvedColorToHex(nameColor)).toBe(expected[0]);
        }).toPass({ timeout: 5_000 });
      }
      await expect(branch).toHaveCount(1);
      await expect(branch).toHaveCSS('border-top-width', '1px');
      await expect(branch).toHaveCSS('border-top-style', 'solid');
      await expect(gitIcon).toHaveAttribute('data-mar-icon', 'branch');
      for (const name of [
        'main',
        'master',
        'develop',
        'feature/ui',
        'release/1.0',
        'hotfix/hover',
        'HEAD'
      ]) {
        await input.fill(name);
        await expect(branch).toHaveText(name);
        await expectColors(colors);
      }
      await input.fill('develop');
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await expectColors(colors);
        await workspace.locator('.session-heading').screenshot({
          path: testInfo.outputPath('workspace-labels-' + width + '.png')
        });
      }
      const longBranch = 'feature/a-long-branch-name-that-must-remain-bounded';
      await input.fill(longBranch);
      await expect(branch).toHaveText(longBranch);
      await expect(branchName).toHaveCSS('text-overflow', 'ellipsis');
      await expect
        .poll(async () => (await branch.boundingBox())?.width)
        .toBeLessThanOrEqual(160 + 1 / 64);
      expect(await branchName.evaluate((el) => el.scrollWidth)).toBeGreaterThan(
        await branchName.evaluate((el) => el.clientWidth)
      );
      await branch.hover();
      await expect(page.getByRole('tooltip')).toHaveText(longBranch);
      await expectColors(colors);

      const gitWorkspace = workspace.getByRole('checkbox', { name: 'Git workspace', exact: true });
      const workspaceToggle = workspace.getByText('Git workspace', { exact: true });
      await workspaceToggle.click();
      await expect(gitWorkspace).not.toBeChecked();
      await expect(branch).toHaveCount(0);
      await workspaceToggle.click();
      await expect(gitWorkspace).toBeChecked();
      await expect(gitIcon).toBeVisible();
      await expect(branch).toHaveText(longBranch);
      await expectColors(colors);

      await row.getByRole('button', { name: 'Inspect ' + scheme, exact: true }).click();
      const editor = page.getByRole('textbox', { name: 'Theme JSON', exact: true });
      const theme = JSON.parse(await editor.inputValue());
      theme.name = scheme + ' Git labels';
      Object.assign(theme.colors, {
        '--mar-text-secondary': '#bacac0',
        '--mar-fill-muted': '#26342e',
        '--mar-border-default': '#617469',
        '--mar-border-medium': '#758a7e'
      });
      await page.locator('input[type=file]').setInputFiles({
        name: 'git-labels.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(theme))
      });
      await page.getByRole('button', { name: 'Save theme', exact: true }).click();
      await page
        .locator('.theme-option')
        .filter({ has: page.getByRole('button', { name: 'Inspect ' + theme.name, exact: true }) })
        .getByRole('button', { name: 'Apply theme', exact: true })
        .click();
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await expectColors(['#bacac0', scheme === 'Light' ? '#617469' : '#758a7e']);
        await workspace.locator('.session-heading').screenshot({
          path: testInfo.outputPath('workspace-labels-custom-' + width + '.png')
        });
      }
    }
  );
}

for (const scheme of ['Light', 'Dark']) {
  test(
    'theme helper and action controls share standard hover states in ' + scheme,
    async ({ page }, testInfo) => {
      const options = page.locator('.theme-option');
      if (scheme === 'Light')
        await options.nth(1).getByRole('button', { name: 'Apply theme', exact: true }).click();
      const palette = await page.locator('html').evaluate((element) => {
        const style = getComputedStyle(element);
        const probe = document.createElement('span');
        probe.style.backgroundColor = 'var(--mar-action-hover-overlay)';
        element.append(probe);
        const hover = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return { utility: style.getPropertyValue('--mar-text-primary').trim(), hover };
      });
      const help = page.getByRole('button', { name: 'Theme color reference', exact: true });
      const more = options.first().getByRole('button', { name: /^More actions for / });
      await page.mouse.move(0, 0);
      for (const control of [help, more]) {
        const label = (await control.getAttribute('aria-label')) ?? '';
        expect(label).not.toBe('');
        await expect(control).not.toHaveAttribute('title');
        await control.hover();
        await expect(page.getByRole('tooltip', { name: label, exact: true })).toBeVisible();
        await expect(control).toHaveCSS('background-color', palette.hover);
        await expect(control).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
        await expect
          .poll(async () =>
            resolvedColorToHex(await control.evaluate((element) => getComputedStyle(element).color))
          )
          .toBe(palette.utility);
      }
      const apply = options
        .nth(scheme === 'Light' ? 0 : 1)
        .getByRole('button', { name: 'Apply theme', exact: true });
      await apply.hover();
      await expect(apply).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect
        .poll(async () =>
          resolvedColorToHex(await apply.evaluate((element) => getComputedStyle(element).color))
        )
        .toBe(palette.utility);
      await help.focus();
      await help.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Theme color reference', exact: true });
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await more.focus();
      await more.press('Enter');
      await expect(page.getByRole('menuitem', { name: 'Duplicate', exact: true })).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath('theme-actions-' + scheme + '.png'),
        animations: 'disabled'
      });
      await page.keyboard.press('Escape');
      await page.locator('html').evaluate((element) => {
        element.style.setProperty('--mar-text-primary', '#d9e2d0');
        element.style.setProperty('--mar-conversation-activity-fg', '#8a4fc7');
        element.style.setProperty('--mar-action-hover-overlay', 'rgba(52, 86, 120, 0.5)');
      });
      for (const control of [help, more]) {
        await control.hover();
        await expect(control).toHaveCSS('color', 'rgb(217, 226, 208)');
        await expect(control).toHaveCSS('background-color', 'rgba(52, 86, 120, 0.5)');
        await page.mouse.move(0, 0);
        await page.keyboard.press('Tab');
        await control.focus();
        await expect(control).toHaveCSS('color', 'rgb(217, 226, 208)');
        await expect(control).toHaveCSS('background-color', 'rgba(52, 86, 120, 0.5)');
      }
    }
  );
}

test('theme choices apply immediately without replacing an unsaved draft', async ({
  page
}, testInfo) => {
  const options = page.locator('.theme-option');
  const editor = page.getByRole('textbox', { name: 'Theme JSON', exact: true });
  const expectChromeOnPage = async () => {
    const background = await page
      .locator('body')
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
      'content',
      resolvedColorToHex(background)
    );
  };
  await expect(page.locator('.theme-settings').getByRole('table')).toHaveCount(0);
  await expect(options.first().getByRole('button', { name: 'Active', exact: true })).toBeDisabled();
  await expectChromeOnPage();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const option of [options.nth(1), options.first()]) {
      const choice = option.getByRole('button', { name: /^Inspect /u });
      await choice.click();
      await expect(choice).toHaveAttribute('aria-pressed', 'true');
      const reference = await option.evaluate((element) => {
        const probe = document.createElement('span');
        probe.style.backgroundColor = 'var(--mar-fill-selection)';
        probe.style.borderColor = 'var(--mar-border-default)';
        element.append(probe);
        const style = getComputedStyle(probe);
        const result = { background: style.backgroundColor, border: style.borderColor };
        probe.remove();
        return result;
      });
      await expect(option).toHaveCSS('background-color', reference.background);
      await expect(option).toHaveCSS('border-color', reference.border);
      await choice.hover();
      await expect(choice).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(option).toHaveCSS('background-color', reference.background);
    }
  }
  await options
    .nth(1)
    .getByRole('button', { name: /^Inspect /u })
    .click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'vscode-dark-2026');
  await expectChromeOnPage();
  await options.nth(1).getByRole('button', { name: 'Apply theme', exact: true }).click();
  await expect(page.locator('html')).not.toHaveClass(/dark/u);
  expect(await page.evaluate(() => localStorage.getItem('mar.theme'))).toBe('daylight');
  await expectChromeOnPage();
  await useThemeMenu(page, options.first(), 'Duplicate');
  const saved = JSON.stringify({
    version: 1,
    name: 'Violet',
    colors: { '--mar-conversation-activity-fg': '#c792ea', '--mar-bg-page': '#302435' }
  });
  await editor.fill(saved);
  await page.getByRole('button', { name: 'Save theme', exact: true }).click();
  await expectChromeOnPage();
  const violet = options.filter({ hasText: 'Violet' });
  await violet.getByRole('button', { name: 'Apply theme', exact: true }).click();
  await expect(violet.getByRole('button', { name: 'Active', exact: true })).toBeDisabled();
  await expectChromeOnPage();
  await page.reload();
  await expect(violet.getByRole('button', { name: 'Active', exact: true })).toBeDisabled();
  await expectChromeOnPage();
  expect(
    await page.evaluate(() =>
      document.documentElement.style.getPropertyValue('--mar-conversation-activity-fg')
    )
  ).toBe('#c792ea');
  await violet.getByRole('button', { name: /^Inspect /u }).click();
  await editor.fill(saved + ' ');
  await options.first().getByRole('button', { name: 'Apply theme', exact: true }).click();
  await expect(editor).toHaveValue(saved + ' ');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('mar.theme'))).toBe('vscode-dark-2026');
  await expectChromeOnPage();
  await page.screenshot({
    path: testInfo.outputPath('theme-selector.png'),
    fullPage: true,
    animations: 'disabled'
  });
});

for (const [scheme, width] of [
  ['Dark', 1280],
  ['Light', 390]
] as const) {
  test(`Standard fields share their boundary and preserve states in ${scheme} at ${width}px`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    if (scheme === 'Light')
      await page
        .locator('.theme-option')
        .filter({ has: page.getByRole('button', { name: 'Inspect Light', exact: true }) })
        .getByRole('button', { name: 'Apply theme', exact: true })
        .click();
    const fields = page.getByRole('region', { name: 'Standard field boundaries' });
    const tokenShadow = (token: string) =>
      fields.evaluate((element, name) => {
        const probe = document.createElement('span');
        probe.style.boxShadow = `0 0 0 1px var(${name}) inset`;
        element.append(probe);
        const shadow = getComputedStyle(probe).boxShadow;
        probe.remove();
        return shadow;
      }, token);
    const wrapper = (field: Locator) =>
      field.locator(
        'xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," mar-ui-input ") or contains(@class,"mar-ui-select__field") or contains(@class,"mar-ui-input-number") or contains(@class,"mar-ui-cascader__field") or contains(@class,"mar-ui-date-picker__field") or contains(@class,"mar-ui-time-picker__field")][1]'
      );
    const check = async () => {
      const shadow = await tokenShadow('--mar-border-default');
      const border = await fields.evaluate((element) => {
        const probe = document.createElement('span');
        probe.style.borderTop = '1px solid var(--mar-border-default)';
        element.append(probe);
        const result = getComputedStyle(probe).borderTopColor;
        probe.remove();
        return result;
      });
      for (const field of [
        fields.getByRole('textbox', { name: 'Text field', exact: true }),
        fields.getByRole('textbox', { name: 'Textarea field', exact: true }),
        fields.getByRole('combobox', { name: 'Select field', exact: true }),
        fields.getByRole('combobox', { name: 'Time select field', exact: true })
      ])
        await expect(wrapper(field)).toHaveCSS('box-shadow', shadow);
      for (const field of [
        fields.getByRole('spinbutton', { name: 'Number field', exact: true }),
        ...['Cascader field', 'Single date field', 'Start date', 'Single time field'].map(
          (placeholder) => fields.getByPlaceholder(placeholder, { exact: true })
        )
      ]) {
        await expect(wrapper(field)).toHaveCSS('border-top-width', '1px');
        await expect(wrapper(field)).toHaveCSS('border-top-color', border);
      }
      const disabledColors = await fields.evaluate((element) => {
        const probe = document.createElement('span');
        probe.style.borderTop = '1px solid var(--mar-border-subtle)';
        probe.style.backgroundColor = 'var(--mar-fill-soft)';
        element.append(probe);
        const style = getComputedStyle(probe);
        const colors = { border: style.borderTopColor, fill: style.backgroundColor };
        probe.remove();
        return colors;
      });
      for (const input of [
        fields.getByRole('textbox', { name: 'Disabled text field' }),
        fields.getByRole('textbox', { name: 'Text field in disabled fieldset' }),
        fields.getByRole('textbox', { name: 'Disabled textarea field' }),
        fields.getByRole('combobox', { name: 'Disabled field' }),
        fields.getByRole('combobox', { name: 'Disabled time select field' })
      ]) {
        await expect(input).toBeDisabled();
        const frame = wrapper(input);
        await frame.hover();
        await expect(frame).toHaveCSS('box-shadow', await tokenShadow('--mar-border-subtle'));
        await expect(frame).toHaveCSS('background-color', disabledColors.fill);
      }
      for (const field of [
        ...[
          'Disabled start date',
          'Disabled single date',
          'Disabled time field',
          'Disabled cascader field'
        ].map((placeholder) => fields.getByPlaceholder(placeholder, { exact: true })),
        fields.getByRole('spinbutton', { name: 'Disabled number field' })
      ]) {
        await expect(field).toBeDisabled();
        await expect(wrapper(field)).toHaveCSS('border-top-color', disabledColors.border);
        await expect(wrapper(field)).toHaveCSS('background-color', disabledColors.fill);
        await wrapper(field).hover();
        await expect(wrapper(field)).toHaveCSS('border-top-color', disabledColors.border);
      }
      const enabledInput = fields.getByRole('textbox', { name: 'Text field', exact: true });
      await enabledInput.hover();
      await expect(wrapper(enabledInput)).toHaveCSS(
        'box-shadow',
        await tokenShadow('--mar-input-border-hover')
      );
      await enabledInput.focus();
      await expect(wrapper(enabledInput)).toHaveCSS(
        'box-shadow',
        await tokenShadow('--mar-control-focus')
      );
      await enabledInput.blur();
      const addOn = fields.getByRole('button', { name: 'Field add-on' });
      await addOn.hover();
      await addOn.focus();
      await expect(wrapper(addOn)).toHaveCSS('box-shadow', shadow);
      await addOn.blur();
      const validSelect = fields.getByRole('combobox', { name: 'Select field', exact: true });
      await validSelect.click();
      await expect(wrapper(validSelect)).toHaveCSS(
        'box-shadow',
        await tokenShadow('--mar-control-focus')
      );
      await validSelect.press('Escape');
      for (const input of [
        fields.getByRole('textbox', { name: 'Invalid text field' }),
        fields.getByRole('combobox', { name: 'Invalid field' })
      ]) {
        await expect(input).toHaveAttribute('aria-invalid', 'true');
        await input.focus();
        await expect(wrapper(input)).toHaveCSS(
          'box-shadow',
          await tokenShadow('--mar-control-color-danger')
        );
        await input.blur();
      }
      await expect(fields.getByText('Select a date range', { exact: true })).toBeVisible();
    };
    await check();
    await page.mouse.move(0, 0);
    await fields.screenshot({
      path: testInfo.outputPath(`standard-fields-${scheme.toLowerCase()}.png`)
    });
    await page.locator('html').evaluate((element) => {
      element.style.setProperty('--mar-border-default', '#5c7097');
      element.style.setProperty('--mar-border-subtle', '#4e5e73');
      element.style.setProperty('--mar-border-medium', '#718293');
      element.style.setProperty('--mar-text-secondary', '#93a5b6');
      element.style.setProperty('--mar-conversation-activity-fg', '#bf6ac9');
      element.style.setProperty('--mar-control-focus', '#9c9c9c');
      element.style.setProperty('--mar-overlay-border', '#7689a1');
      element.style.setProperty('--mar-overlay-surface', '#37485e80');
    });
    await check();
    for (const [trigger, selector] of [
      ['Cascader field', '.mar-ui-cascader__popup'],
      ['Single date field', '.mar-ui-date-picker__popup'],
      ['Single time field', '.mar-ui-time-picker__popup']
    ] as const) {
      const input = fields.getByPlaceholder(trigger, { exact: true });
      await input.click();
      const popup = page.locator(`${selector}:visible`);
      await expect(popup).toHaveCSS('border-top-color', 'rgb(118, 137, 161)');
      expect(
        resolvedColorToHex(
          await popup.evaluate((element) => getComputedStyle(element).backgroundColor)
        )
      ).toBe('#37485e80');
      await expect(popup).toHaveCSS('box-shadow', /0px 4px 12px/u);
      await page.keyboard.press('Escape');
      await expect(popup).toBeHidden();
    }
  });
}

test('solid and inset field frames retain invalid and keyboard focus cues', async ({ page }) => {
  const date = page.getByPlaceholder('Invalid start date', { exact: true });
  const frame = page.locator('.mar-ui-date-picker__field').filter({ has: date });
  const invalidInput = page.getByRole('textbox', { name: 'Invalid text field' });
  const invalidSelect = page.getByRole('combobox', { name: 'Invalid field' });
  const addOn = page.getByRole('button', { name: 'Field add-on', exact: true });
  const fields = [
    [invalidInput, page.locator('.mar-ui-input').filter({ has: invalidInput })],
    [invalidSelect, page.locator('.mar-ui-select__field').filter({ has: invalidSelect })],
    [date, frame]
  ] as const;
  await expect(date).toHaveAttribute('aria-invalid', 'true');
  await expect(frame).toHaveCSS('border-top-color', 'rgb(255, 98, 107)');
  await date.click();
  await expect(frame).toHaveAttribute('data-expanded', 'true');
  await expect(frame).toHaveCSS('border-top-color', 'rgb(255, 98, 107)');
  await date.press('Escape');
  await expect(frame).toHaveAttribute('data-expanded', 'false');
  for (const [input, fieldFrame] of fields) {
    // Focusing another control closes the picker; DOM blur alone has no related target.
    await addOn.focus();
    await expect(fieldFrame).toHaveCSS('outline-style', 'none');
    const readEdge = () =>
      fieldFrame.evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.borderTopColor, style.boxShadow];
      });
    const errorEdge = await readEdge();
    if (input === invalidInput) await page.keyboard.press('Tab');
    else if (input === date) {
      await frame.getByRole('button').focus();
      await page.keyboard.press('Tab');
    } else await input.focus();
    await expect(input).toBeFocused();
    await expect(fieldFrame).toHaveCSS('outline-style', 'solid');
    await expect(fieldFrame).toHaveCSS('outline-width', '2px');
    await expect.poll(readEdge).toEqual(errorEdge);
  }
  await addOn.focus();
  await expect(frame).toHaveAttribute('data-expanded', 'false');
  await page.emulateMedia({ forcedColors: 'active' });
  for (const [input, fieldFrame] of fields) {
    await input.focus();
    await expect(fieldFrame).toHaveCSS('border-top-style', 'dashed');
    await expect(fieldFrame).toHaveCSS('border-top-width', '1px');
    await expect(fieldFrame).toHaveCSS('outline-style', 'solid');
    await expect(fieldFrame).toHaveCSS('outline-width', '2px');
  }
  const disabledInput = page.getByRole('textbox', { name: 'Text field in disabled fieldset' });
  const disabledFrame = page.locator('.mar-ui-input').filter({ has: disabledInput });
  const propDisabled = page.locator('.mar-ui-input').filter({
    has: page.getByRole('textbox', { name: 'Disabled text field' })
  });
  await expect(disabledFrame).toHaveCSS('border-top-style', 'solid');
  await expect(disabledFrame).toHaveCSS(
    'border-top-color',
    await propDisabled.evaluate((element) => getComputedStyle(element).borderTopColor)
  );
  await expect(disabledFrame).toHaveCSS('outline-style', 'none');
});

test('theme preview input uses its own palette independently of the active theme', async ({
  page
}) => {
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'vscode-dark-2026');
  const preview = page.locator('.mar-theme-preview');
  const input = preview.locator('.preview-label input');
  await expect(preview).toHaveAttribute('data-theme', 'vscode-dark-2026');
  const realInput = page
    .getByRole('region', { name: 'Real theme controls' })
    .locator('.mar-ui-input')
    .filter({ has: page.getByRole('textbox', { name: 'Sample input', exact: true }) });
  const inputShadow = await realInput.evaluate((element) => getComputedStyle(element).boxShadow);
  const normalBorder = await input.evaluate((element) => getComputedStyle(element).borderTopColor);
  expect(inputShadow).toContain(normalBorder);
  await page.getByRole('button', { name: 'Inspect Light', exact: true }).click();
  await expect(preview).toHaveAttribute('data-theme', 'daylight');
  await expect(input).toHaveCSS('border-top-color', 'rgb(185, 202, 223)');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'vscode-dark-2026');
  await expect(realInput).toHaveCSS('box-shadow', inputShadow);
});

test('filled primary controls use the same foreground as the theme preview', async ({ page }) => {
  const editor = page.getByRole('textbox', { name: 'Theme JSON', exact: true });
  const options = page.locator('.theme-option');
  await useThemeMenu(page, options.first(), 'Duplicate');
  const save = page.getByRole('button', { name: 'Save theme', exact: true });
  const sample = page.locator('.mar-theme-preview .preview-button.primary');
  await expect(sample).toHaveCSS('color', 'rgb(24, 24, 24)');
  await expect(save).toHaveCSS('color', 'rgb(24, 24, 24)');
  const custom = JSON.stringify({
    version: 1,
    name: 'Palenight sample',
    colors: {
      '--mar-conversation-activity-fg': '#c792ea',
      '--mar-control-primary-bg': '#bdd6c8',
      '--mar-control-primary-fg': '#202331',
      '--mar-control-primary-active': '#bbccaa',
      '--mar-control-primary-hover': '#abcdef'
    }
  });
  await editor.fill(custom);
  await save.click();
  await options
    .filter({ hasText: 'Palenight sample' })
    .getByRole('button', { name: 'Apply theme', exact: true })
    .click();
  await expect(sample).toHaveCSS('color', 'rgb(32, 35, 49)');
  await expect(save).toHaveCSS('color', 'rgb(32, 35, 49)');
  await expect(sample).toHaveCSS('background-color', 'rgb(189, 214, 200)');
  await expect(save).toHaveCSS('background-color', 'rgb(189, 214, 200)');
  await expect(page.locator('.mar-theme-preview .process .mar-busy-indicator')).toHaveCSS(
    'color',
    'rgb(199, 146, 234)'
  );
  await sample.hover();
  await expect(sample).toHaveCSS('background-color', 'rgb(171, 205, 239)');
  await expect(sample).toHaveCSS('border-color', 'rgb(171, 205, 239)');
  await page.mouse.down();
  await expect(sample).toHaveCSS('background-color', 'rgb(187, 204, 170)');
  await expect(sample).toHaveCSS('border-color', 'rgb(187, 204, 170)');
  await page.mouse.up();
  await save.hover();
  await expect(save).toHaveCSS('color', 'rgb(32, 35, 49)');
  await expect(save).toHaveCSS('background-color', 'rgb(171, 205, 239)');
  await expect(save).toHaveCSS('border-color', 'rgb(171, 205, 239)');
  await page.mouse.down();
  await expect(save).toHaveCSS('color', 'rgb(32, 35, 49)');
  await expect(save).toHaveCSS('background-color', 'rgb(187, 204, 170)');
  await expect(save).toHaveCSS('border-color', 'rgb(187, 204, 170)');
  await page.mouse.up();
});

test('expanded and compact previews share the applied palette without changing global state', async ({
  page
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const editor = page.getByRole('textbox', { name: 'Theme JSON', exact: true });
  await useThemeMenu(page, page.locator('.theme-option').first(), 'Duplicate');
  const source = JSON.stringify({
    version: 1,
    name: 'Preview',
    colors: {
      '--mar-link-text': '#a6d1ff',
      '--mar-link-hover': '#c1e1ff',
      '--mar-conversation-activity-fg': '#ff00ff',
      '--mar-control-focus': '#e2d4bf',
      '--mar-fill-selection': '#38475a',
      '--mar-fill-row-hover': '#283442',
      '--mar-color-diff-add-text': '#123456',
      '--mar-conversation-surface': '#16324f',
      '--mar-text-primary': '#f8eedd',
      '--mar-text-secondary': '#99aabb',
      '--mar-text-muted': '#aeb8c2',
      '--mar-text-disabled': '#778899'
    }
  });
  await editor.fill(source);
  const preview = page.locator('.mar-theme-preview');
  for (const selector of ['.file.selected', '.tab.active']) {
    await expect(preview.locator(selector)).toHaveCSS('background-color', 'rgb(56, 71, 90)');
    await preview.locator(selector).hover();
    await expect(preview.locator(selector)).toHaveCSS('background-color', 'rgb(56, 71, 90)');
  }
  await expect(preview.locator('.user-message')).toHaveText('This is a sample message.');
  await expect(preview.locator('.assistant-message strong')).toHaveText('Sample heading');
  const expectPreviewText = async (sample: Locator) => {
    for (const selector of ['.user-message', '.assistant-message p', '.process'])
      await expect(sample.locator(selector)).toHaveCSS('color', 'rgb(248, 238, 221)');
    const sampleLink = sample.getByText('Reference link', { exact: true });
    await expect(sampleLink).toHaveCSS('color', 'rgb(166, 209, 255)');
    await expect(sampleLink).toHaveCSS('text-decoration-line', 'underline');
    await sampleLink.hover();
    await expect(sampleLink).toHaveCSS('color', 'rgb(193, 225, 255)');
    const previewRing = sample.locator('.process .mar-busy-indicator');
    await expect(previewRing).toHaveCSS('color', 'rgb(255, 0, 255)');
    await expect(previewRing).toHaveCSS('animation-name', 'none');
    await expect(sample.locator('.preview-sidebar .caption')).toHaveCSS(
      'color',
      'rgb(174, 184, 194)'
    );
    const disabled = sample.getByRole('button', { name: 'Disabled', exact: true });
    await expect(disabled).toBeDisabled();
    await expect(disabled).toHaveCSS('color', 'rgb(119, 136, 153)');
  };
  await expectPreviewText(preview);
  await expect(preview.locator('.assistant-message')).toHaveCSS(
    'background-color',
    'rgb(22, 50, 79)'
  );
  for (const selector of ['.user-message', '.assistant-message', '.process'])
    await expect(preview.locator(selector)).toHaveCSS('border-radius', '12px');
  await expect(preview.locator('.status').first()).toHaveCSS('border-radius', '4px');
  await expect(preview.locator('.preview-button.primary')).toHaveCSS('border-radius', '6px');
  await expect(preview.locator('.preview-toolbar')).toHaveCSS(
    'background-color',
    'rgb(30, 30, 30)'
  );
  await expect(preview.locator('.diff-add')).toHaveCSS('color', 'rgb(18, 52, 86)');
  const compactFont = await preview.evaluate((element) =>
    parseFloat(getComputedStyle(element).fontSize)
  );
  await preview.locator('input').focus();
  await expect(preview.locator('input')).toHaveCSS('outline-color', 'rgb(226, 212, 191)');
  await page.getByRole('button', { name: 'Enlarge preview', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const expanded = dialog.locator('.mar-theme-preview');
  await expect(expanded).toBeVisible();
  await expectPreviewText(expanded);
  await expect(expanded.locator('.file.selected')).toHaveCSS('background-color', 'rgb(56, 71, 90)');
  await expect(expanded.locator('.tab.active')).toHaveCSS('background-color', 'rgb(56, 71, 90)');
  const dialogPanel = dialog.locator('.mar-ui-dialog');
  await expect(dialogPanel).toHaveCSS('border-radius', '12px');
  await dialogPanel.evaluate((element) => element.classList.add('is-fullscreen'));
  await expect(dialogPanel).toHaveCSS('border-radius', '0px');
  await dialogPanel.evaluate((element) => element.classList.remove('is-fullscreen'));
  expect(
    await expanded.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))
  ).toBeGreaterThan(compactFont);
  await expect(expanded.locator('.diff-add')).toHaveCSS('color', 'rgb(18, 52, 86)');
  await expanded.getByRole('textbox', { name: 'Message', exact: true }).fill('Preview only');
  await expect(expanded.locator('input')).toHaveCSS('outline-color', 'rgb(226, 212, 191)');
  await expect(editor).toHaveValue(source);
  expect(await page.evaluate(() => localStorage.getItem('mar.customThemes'))).toBeNull();
  expect(
    await page.evaluate(() =>
      document.documentElement.style.getPropertyValue('--mar-conversation-activity-fg')
    )
  ).toBe('');
  await page.screenshot({
    path: testInfo.outputPath('theme-expanded.png'),
    fullPage: true,
    animations: 'disabled'
  });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

for (const locale of ['en-US', 'zh-CN']) {
  test(`theme editor remains usable on narrow screens in ${locale}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${fixture.url}custom-theme.html?locale=${locale}`);
    await expect(page.locator('.json-editor textarea')).toBeVisible();
    const bounds = await page.locator('.editor-layout').boundingBox();
    expect(bounds!.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390
    );
    const form = await page.locator('.editor-layout form').boundingBox();
    const aside = await page.locator('.editor-layout aside').boundingBox();
    expect(aside!.y).toBeGreaterThan(form!.y);
    await expect(page.locator('.theme-settings h2')).toHaveText(
      locale === 'zh-CN' ? '主题' : 'Themes'
    );
    await expect(
      page.getByRole('button', {
        name: locale === 'zh-CN' ? '查看 暗色' : 'Inspect Dark',
        exact: true
      })
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`theme-${locale}.png`), fullPage: true });
    await page.locator('.editor-layout aside').scrollIntoViewIfNeeded();
    await expect(page.locator('.mar-theme-preview')).toBeInViewport();
    await page.screenshot({
      path: testInfo.outputPath(`theme-${locale}-preview.png`),
      fullPage: true
    });
    await page
      .getByRole('button', {
        name: locale === 'zh-CN' ? '放大预览' : 'Enlarge preview',
        exact: true
      })
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const dialogBounds = await dialog.locator('.mar-ui-dialog').boundingBox();
    expect(dialogBounds!.x).toBeGreaterThanOrEqual(16);
    expect(dialogBounds!.x + dialogBounds!.width).toBeLessThanOrEqual(374);
  });
}

for (const scheme of ['Light', 'Dark']) {
  test(
    'MAR variables drive shared component colors in ' + scheme + ' palettes',
    async ({ page }) => {
      const aliases = componentAliases;
      const editor = page.getByRole('textbox', { name: 'Theme JSON', exact: true });
      const row = page
        .locator('.theme-option')
        .filter({ has: page.getByRole('button', { name: 'Inspect ' + scheme, exact: true }) });
      await useThemeMenu(page, row, 'Duplicate');
      const source = JSON.parse(await editor.inputValue());
      expect(Object.keys(source.colors).every((key) => key.startsWith('--mar-'))).toBe(true);
      for (const [index, token] of [...new Set(Object.values(aliases))].entries())
        source.colors[token] = '#' + (0x203040 + index * 0x030507).toString(16).padStart(6, '0');
      source.colors['--mar-conversation-activity-fg'] = '#654321';
      source.colors['--mar-control-primary-bg'] = '#abcdef';
      source.colors['--mar-control-bg-color-overlay'] = '#34567880';
      source.colors['--mar-bg-panel'] = '#123456';
      source.colors['--mar-bg-page'] = scheme === 'Light' ? '#ffffff' : '#000000';
      await editor.fill(JSON.stringify(source));
      const inspectAliases = (element: Element, aliases: Record<string, string>) => {
        const style = getComputedStyle(element);
        return Object.entries(aliases).map(([alias, target]) => ({
          alias,
          target,
          actual: style.getPropertyValue(alias).trim(),
          expected: style.getPropertyValue(target).trim()
        }));
      };
      for (const result of await page
        .locator('.mar-theme-preview')
        .evaluate(inspectAliases, aliases)) {
        expect(result.actual, result.alias).toBe(result.expected);
        expect(result.actual, result.alias).toBe(source.colors[result.target]);
        expect(result.actual).not.toBe('');
      }
      await page.getByRole('button', { name: 'Save theme', exact: true }).click();
      await page
        .locator('.theme-option')
        .filter({ has: page.getByRole('button', { name: 'Inspect ' + source.name, exact: true }) })
        .getByRole('button', { name: 'Apply theme', exact: true })
        .click();
      for (const result of await page.locator('html').evaluate(inspectAliases, aliases)) {
        expect(result.actual, result.alias).toBe(result.expected);
        expect(result.actual, result.alias).toBe(source.colors[result.target]);
      }
      await expect(page.getByRole('button', { name: 'Save theme', exact: true })).toHaveCSS(
        'background-color',
        'rgb(171, 205, 239)'
      );
      await page.getByRole('button', { name: 'Theme color reference', exact: true }).click();
      await expect(
        page
          .getByRole('dialog', { name: 'Theme color reference', exact: true })
          .locator('.mar-ui-dialog')
      ).toHaveCSS('background-color', 'rgb(18, 52, 86)');
      await page.keyboard.press('Escape');
      await page
        .locator('.theme-option')
        .first()
        .getByRole('button', { name: /^More actions for / })
        .click();
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      expect(
        resolvedColorToHex(
          await menu.evaluate((element) => getComputedStyle(element).backgroundColor)
        )
      ).toBe('#345678');
    }
  );
}

for (const locale of ['en-US', 'zh-CN']) {
  test(
    'theme color help supports search, copying and narrow layouts in ' + locale,
    async ({ page, context }, testInfo) => {
      await page.goto(fixture.url + 'custom-theme.html?locale=' + locale);
      const title = locale === 'en-US' ? 'Theme color reference' : '主题颜色说明';
      const searchLabel = locale === 'en-US' ? 'Search names or descriptions' : '搜索变量名或用途';
      const trigger = page.getByRole('button', { name: title, exact: true });
      await trigger.focus();
      await trigger.press('Enter');
      const dialog = page.getByRole('dialog', { name: title, exact: true });
      await expect(dialog.locator('.token-row')).toHaveCount(CUSTOM_THEME_TOKENS.length);
      for (const description of await dialog.locator('dd').allTextContents())
        expect(description.trim()).not.toBe('');
      await dialog
        .getByRole('textbox', { name: searchLabel })
        .fill(locale === 'en-US' ? 'Usage distribution bars' : '用量分布横条');
      await expect(dialog.locator('.token-row')).toHaveCount(1);
      await expect(dialog.locator('code')).toHaveText('--mar-conversation-activity-fg');
      await dialog
        .getByRole('textbox', { name: searchLabel })
        .fill(locale === 'en-US' ? 'Page canvas' : '页面底层背景');
      await expect(dialog.locator('.token-row')).toHaveCount(1);
      await expect(dialog.locator('code')).toHaveText('--mar-bg-page');
      await grantClipboardPermissions(context);
      await dialog
        .getByRole('button', {
          name: locale === 'en-US' ? 'Copy --mar-bg-page' : '复制 --mar-bg-page',
          exact: true
        })
        .click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe('--mar-bg-page');
      const search = dialog.getByRole('textbox', { name: searchLabel });
      await search.focus();
      const clear = dialog.getByRole('button', {
        name: locale === 'en-US' ? 'Clear' : '清空',
        exact: true
      });
      await expect(clear).toBeVisible();
      await expect(clear.locator('[data-mar-icon="clear-input"]')).toBeVisible();
      await clear.click();
      await expect(search).toBeEmpty();
      await expect(dialog.locator('.token-row')).toHaveCount(CUSTOM_THEME_TOKENS.length);
      await search.fill(locale === 'en-US' ? 'Page canvas' : '页面底层背景');
      await expect(dialog.locator('.token-row')).toHaveCount(1);
      await page.evaluate(() => {
        Object.defineProperty(navigator.clipboard, 'writeText', {
          configurable: true,
          value: async () => {
            throw new Error('Clipboard unavailable');
          }
        });
      });
      await dialog
        .getByRole('button', {
          name: locale === 'en-US' ? 'Copy --mar-bg-page' : '复制 --mar-bg-page',
          exact: true
        })
        .click();
      await expect(page.locator('.mar-message--error')).toContainText(
        locale === 'en-US'
          ? 'Could not copy the variable name. Select and copy it manually.'
          : '无法复制变量名，请选中变量名手动复制。'
      );
      await page.setViewportSize({ width: 390, height: 844 });
      await dialog.getByRole('textbox', { name: searchLabel }).fill('');
      const bounds = await dialog.locator('.mar-ui-dialog').boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(15);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true
      );
      await page.screenshot({ path: testInfo.outputPath('theme-help-' + locale + '.png') });
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await trigger.click();
      await expect(dialog.getByRole('textbox', { name: searchLabel })).toHaveValue('');
    }
  );
}

for (const scheme of ['Light', 'Dark']) {
  test(
    'real controls preserve the built-in ' + scheme + ' palette and respond to custom states',
    async ({ page }, testInfo) => {
      const controls = page.getByRole('region', { name: 'Real theme controls' });
      const row = page.locator('.theme-option').filter({
        has: page.getByRole('button', { name: 'Inspect ' + scheme, exact: true })
      });
      if (scheme === 'Light')
        await row.getByRole('button', { name: 'Apply theme', exact: true }).click();
      else await expect(row.getByRole('button', { name: 'Active', exact: true })).toBeDisabled();
      const typography = page.getByRole('region', { name: 'Real conversation typography' });
      const conversationText = scheme === 'Dark' ? 'rgb(234, 234, 234)' : 'rgb(23, 36, 58)';
      const conversationSecondary = scheme === 'Dark' ? 'rgb(194, 194, 194)' : 'rgb(67, 83, 107)';
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        for (const selector of ['p', 'strong', 'h3', 'th', 'td', 'code'])
          await expect(typography.locator('.agent-markdown ' + selector).first()).toHaveCSS(
            'color',
            conversationText
          );
        await expect(typography.locator('.agent-markdown')).toHaveCSS(
          'font-size',
          width < 768 ? '13px' : '14px'
        );
        await expect(typography.locator('.conversation-metadata')).toHaveCSS(
          'color',
          conversationSecondary
        );
        await typography.screenshot({
          path: testInfo.outputPath('conversation-typography-' + width + '.png')
        });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      // Resizing and screenshots can leave the pointer over a control; inspect its neutral state.
      await page.mouse.move(-10, -10);
      const panel = scheme === 'Dark' ? 'rgb(30, 30, 30)' : 'rgb(255, 255, 255)';
      await expect(controls.locator('.mar-ui-input')).toHaveCSS('background-color', panel);
      const select = controls.locator('.mar-ui-select__field');
      await expect(select).toHaveCSS('background-color', panel);
      const selectLabel = controls.locator('.mar-ui-select__label');
      const selectCaret = controls.locator('[data-mar-icon="chevron-down"]');
      await expect(selectLabel).toHaveCSS('color', conversationSecondary);
      await expect(selectCaret).toHaveCSS('color', conversationSecondary);
      await select.click();
      await page.getByRole('option', { name: 'One', exact: true }).click();
      await expect(selectLabel).toHaveText('One');
      await expect(selectLabel).toHaveCSS('color', conversationText);
      await expect(selectCaret).toHaveCSS('color', conversationSecondary);
      await expect(controls.locator('.mar-ui-table')).toHaveCSS('background-color', panel);
      await expect(controls.getByRole('button', { name: 'Sample default', exact: true })).toHaveCSS(
        'background-color',
        scheme === 'Dark' ? 'rgb(34, 34, 34)' : 'rgb(248, 251, 255)'
      );
      const primaryForeground = scheme === 'Dark' ? 'rgb(24, 24, 24)' : 'rgb(255, 255, 255)';
      await expect(controls.getByRole('button', { name: 'Sample primary', exact: true })).toHaveCSS(
        'color',
        primaryForeground
      );
      await expect(controls.getByRole('button', { name: 'Sample primary', exact: true })).toHaveCSS(
        'background-color',
        scheme === 'Dark' ? 'rgb(222, 222, 222)' : 'rgb(0, 87, 219)'
      );
      const primary = controls.getByRole('button', { name: 'Sample primary', exact: true });
      await primary.scrollIntoViewIfNeeded();
      const primaryBounds = await primary.boundingBox();
      await primary.screenshot({ path: testInfo.outputPath('primary-default.png') });
      await primary.hover();
      const hoverColor = scheme === 'Dark' ? 'rgb(238, 238, 238)' : 'rgb(0, 76, 195)';
      await expect(primary).toHaveCSS('background-color', hoverColor);
      await expect(primary).toHaveCSS('border-top-color', hoverColor);
      await expect(primary).toHaveCSS('color', primaryForeground);
      await expect(primary).toHaveCSS('transform', 'none');
      expect(await primary.boundingBox()).toEqual(primaryBounds);
      await primary.screenshot({ path: testInfo.outputPath('primary-hover.png') });
      await page.mouse.down();
      try {
        await expect(primary).toHaveCSS(
          'background-color',
          scheme === 'Dark' ? 'rgb(196, 196, 196)' : 'rgb(0, 66, 170)'
        );
        await expect(primary).toHaveCSS('color', primaryForeground);
      } finally {
        await page.mouse.up();
      }
      expect(
        resolvedColorToHex(
          await controls
            .getByRole('button', { name: 'Sample disabled primary', exact: true })
            .evaluate((element) => getComputedStyle(element).color)
        )
      ).toBe(scheme === 'Dark' ? '#777777' : '#707070');
      await expect(controls.getByRole('columnheader')).toHaveCSS(
        'background-color',
        scheme === 'Dark' ? 'rgb(34, 34, 34)' : 'rgb(241, 246, 252)'
      );
      await controls.locator('tbody tr').first().hover();
      await expect(controls.getByRole('cell').first()).toHaveCSS(
        'background-color',
        scheme === 'Dark' ? 'rgb(46, 46, 46)' : 'rgb(232, 241, 255)'
      );
      const link = controls.getByRole('button', { name: 'Sample link', exact: true });
      const linkColor = scheme === 'Dark' ? 'rgb(234, 234, 234)' : 'rgb(23, 78, 158)';
      await expect(link).toHaveCSS('color', linkColor);
      await expect(link).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await link.hover();
      await expect(link).toHaveCSS(
        'color',
        scheme === 'Dark' ? 'rgb(240, 240, 240)' : 'rgb(18, 58, 120)'
      );
      await expect(link).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      const anchor = controls.getByRole('link', { name: 'Sample anchor', exact: true });
      await expect(anchor).toHaveCSS(
        'color',
        scheme === 'Dark' ? 'rgb(117, 183, 255)' : 'rgb(23, 78, 158)'
      );
      await anchor.hover();
      await expect(anchor).toHaveCSS(
        'color',
        scheme === 'Dark' ? 'rgb(162, 206, 255)' : 'rgb(18, 58, 120)'
      );
      const neutral = controls.getByRole('button', { name: 'Sample neutral action', exact: true });
      const disabledNeutral = controls.getByRole('button', {
        name: 'Sample disabled neutral action',
        exact: true
      });
      const danger = controls.getByRole('button', { name: 'Sample dangerous action', exact: true });
      await page.mouse.move(0, 0);
      const neutralColor = await neutral.evaluate((element) => getComputedStyle(element).color);
      const dangerColor = await danger.evaluate((element) => getComputedStyle(element).color);
      const disabledNeutralColor = await disabledNeutral.evaluate(
        (element) => getComputedStyle(element).color
      );
      expect(neutralColor).not.toBe(dangerColor);
      expect(neutralColor).not.toBe(linkColor);
      expect(neutralColor).not.toBe(scheme === 'Dark' ? 'rgb(77, 163, 255)' : 'rgb(0, 95, 214)');
      await expect(disabledNeutral).toBeDisabled();
      for (const action of [neutral, disabledNeutral, danger]) {
        await expect(action).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await action.hover({ force: true });
        await expect(action).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      }
      await disabledNeutral.hover({ force: true });
      await expect(disabledNeutral).toHaveCSS('color', disabledNeutralColor);
      await neutral.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(neutral).toBeFocused();
      await expect(neutral).not.toHaveCSS('outline-style', 'none');
      await controls.screenshot({ path: testInfo.outputPath('action-hierarchy.png') });
      const management = page.getByRole('region', { name: 'Real management actions' });
      const edit = management.locator('.prompt-actions .mar-ui-button').first();
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.mouse.move(0, 0);
        await expect(edit).toHaveCSS('color', neutralColor);
        await expect(edit).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await edit.click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await expect(dialog.locator('.mar-ui-button--primary')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        await management.screenshot({
          path: testInfo.outputPath('management-actions-' + width + '.png')
        });
      }
      await page.setViewportSize({ width: 1440, height: 900 });

      await useThemeMenu(page, row, 'Duplicate');
      const editor = page.getByRole('textbox', { name: 'Theme JSON', exact: true });
      const theme = JSON.parse(await editor.inputValue());
      Object.assign(theme.colors, {
        '--mar-bg-panel': '#123456',
        '--mar-table-header-bg': '#234567',
        '--mar-table-row-hover-bg': '#345678',
        '--mar-control-primary-fg': '#fedcba',
        '--mar-control-primary-hover': '#234567',
        '--mar-text-primary': '#d5c4af',
        '--mar-text-disabled': '#969696',
        '--mar-fill-soft': '#434343',
        '--mar-control-link-text': '#abcdef',
        '--mar-control-link-hover': '#bcdefa',
        '--mar-link-text': '#b4d4ff',
        '--mar-link-hover': '#d2e8ff'
      });
      await editor.fill(JSON.stringify(theme));
      await page.getByRole('button', { name: 'Save theme', exact: true }).click();
      await page
        .locator('.theme-option')
        .filter({ has: page.getByRole('button', { name: 'Inspect ' + theme.name, exact: true }) })
        .getByRole('button', { name: 'Apply theme', exact: true })
        .click();
      await expect(controls.locator('.mar-ui-input')).toHaveCSS(
        'background-color',
        'rgb(18, 52, 86)'
      );
      await expect(controls.locator('.mar-ui-select__field')).toHaveCSS(
        'background-color',
        'rgb(18, 52, 86)'
      );
      await expect(selectLabel).toHaveCSS('color', 'rgb(213, 196, 175)');
      await expect(selectCaret).toHaveCSS('color', conversationSecondary);
      await expect(controls.locator('.mar-ui-table')).toHaveCSS(
        'background-color',
        'rgb(18, 52, 86)'
      );
      await expect(controls.getByRole('columnheader')).toHaveCSS(
        'background-color',
        'rgb(35, 69, 103)'
      );
      for (const selector of ['p', 'strong', 'h3', 'th', 'td', 'code'])
        await expect(typography.locator('.agent-markdown ' + selector).first()).toHaveCSS(
          'color',
          'rgb(213, 196, 175)'
        );
      await expect(typography.locator('.conversation-metadata')).toHaveCSS(
        'color',
        conversationSecondary
      );
      await expect(controls.getByRole('button', { name: 'Sample primary', exact: true })).toHaveCSS(
        'color',
        'rgb(254, 220, 186)'
      );
      await primary.hover();
      await expect(primary).toHaveCSS('background-color', 'rgb(35, 69, 103)');
      await expect(primary).toHaveCSS('border-top-color', 'rgb(35, 69, 103)');
      const disabledPrimary = controls.getByRole('button', {
        name: 'Sample disabled primary',
        exact: true
      });
      const disabledColor = async () =>
        resolvedColorToHex(
          await disabledPrimary.evaluate((element) => getComputedStyle(element).color)
        );
      const disabledForeground = '#969696';
      await expect.poll(disabledColor).toBe(disabledForeground);
      await expect(disabledPrimary).toHaveCSS('background-color', 'rgb(67, 67, 67)');
      await disabledPrimary.hover();
      await expect.poll(disabledColor).toBe(disabledForeground);
      await expect(disabledPrimary).toHaveCSS('background-color', 'rgb(67, 67, 67)');
      await expect(controls.getByRole('button', { name: 'Sample link', exact: true })).toHaveCSS(
        'color',
        'rgb(171, 205, 239)'
      );
      await expect(
        controls.getByRole('button', { name: 'Sample disabled link', exact: true })
      ).toHaveCSS('color', 'rgb(150, 150, 150)');
      await controls.getByRole('button', { name: 'Sample link', exact: true }).hover();
      await expect(controls.getByRole('button', { name: 'Sample link', exact: true })).toHaveCSS(
        'color',
        'rgb(188, 222, 250)'
      );
      await expect(anchor).toHaveCSS('color', 'rgb(180, 212, 255)');
      await anchor.hover();
      await expect(anchor).toHaveCSS('color', 'rgb(210, 232, 255)');
      await controls.locator('tbody tr').first().hover();
      await expect(controls.getByRole('cell').first()).toHaveCSS(
        'background-color',
        'rgb(52, 86, 120)'
      );
    }
  );
}

for (const scheme of ['Light', 'Dark']) {
  test(
    'responsive layout tokens remain independent of the ' + scheme + ' color mapping',
    async ({ page }) => {
      const option = page.locator('.theme-option').filter({
        has: page.getByRole('button', { name: `Inspect ${scheme}`, exact: true })
      });
      await expect(option).toBeVisible();
      if (scheme === 'Light')
        await option.getByRole('button', { name: 'Apply theme', exact: true }).click();
      else await expect(page.locator('html')).toHaveAttribute('data-theme', 'vscode-dark-2026');
      const aliases = componentAliases;
      // Include both breakpoint edges and resize back to mobile to catch stale overrides.
      for (const width of [390, 767, 768, 860, 861, 1440, 420]) {
        await page.setViewportSize({ width, height: 900 });
        const mobile = width < 768;
        const expected = {
          '--mar-sidebar-header-height': mobile ? '46px' : '44px',
          '--mar-brand-logo-size': mobile ? '32px' : '35px',
          '--mar-font-size-body': mobile ? '13px' : '14px',
          '--mar-font-size-control': '12px',
          '--mar-compact-control-size': '26px',
          '--mar-utility-control-size': mobile ? '28px' : '24px',
          '--mar-session-row-min-height': '32px',
          '--mar-workbench-sidebar-width': mobile ? '222px' : width <= 860 ? '220px' : '244px'
        };
        const actual = await page.locator('html').evaluate((element, names) => {
          const style = getComputedStyle(element);
          return Object.fromEntries(
            names.map((name) => [name, style.getPropertyValue(name).trim()])
          );
        }, Object.keys(expected));
        expect(actual, scheme + ' at ' + width).toEqual(expected);
        const resolvedAliases = await page.locator('html').evaluate((element, mapping) => {
          const style = getComputedStyle(element);
          return Object.entries(mapping).map(([alias, token]) => ({
            alias,
            actual: style.getPropertyValue(alias).trim(),
            expected: style.getPropertyValue(token).trim()
          }));
        }, aliases);
        for (const alias of resolvedAliases)
          expect(alias.actual, alias.alias + ' at ' + width).toBe(alias.expected);
      }
    }
  );
}

test('real message feedback follows light, dark, and custom theme tokens and keeps duplicates separate', async ({
  page
}) => {
  for (const scheme of ['Light', 'Dark']) {
    const row = page.locator('.theme-option').filter({
      has: page.getByRole('button', { name: 'Inspect ' + scheme, exact: true })
    });
    await row.getByRole('button', { name: 'Apply theme', exact: true }).click();
    await page.getByTestId('show-info-feedback').click();
    const message = page
      .locator('.mar-message--info')
      .filter({ hasText: 'Theme-aware info feedback' });
    await expect(message).toContainText('Theme-aware info feedback');
    await expectMessageThemeTokens(message, '--mar-text-secondary');
    await expectMessageFirstLineAlignment(message);
    await message.locator('.mar-message-close').click();
    await expect(message).toHaveCount(0);
  }

  const options = page.locator('.theme-option');
  await useThemeMenu(page, options.first(), 'Duplicate');
  const editor = page.getByRole('textbox', { name: 'Theme JSON', exact: true });
  await editor.fill(
    JSON.stringify({
      version: 1,
      name: 'Message feedback palette',
      colors: {
        '--mar-control-bg-color-overlay': '#263547',
        '--mar-text-primary': '#f4f6fa',
        '--mar-text-secondary': '#c3d0df',
        '--mar-border-default': '#718096',
        '--mar-conversation-activity-fg': '#72a9ff',
        '--mar-control-color-success': '#39a879',
        '--mar-control-color-warning': '#e2a83b',
        '--mar-control-color-danger': '#f06a65'
      }
    })
  );
  await page.getByRole('button', { name: 'Save theme', exact: true }).click();
  const customTheme = options.filter({ hasText: 'Message feedback palette' });
  await customTheme.getByRole('button', { name: 'Apply theme', exact: true }).click();

  for (const [testId, type, token] of [
    ['show-info-feedback', 'info', '--mar-text-secondary'],
    ['show-success-feedback', 'success', '--mar-control-color-success'],
    ['show-warning-feedback', 'warning', '--mar-control-color-warning'],
    ['show-error-feedback', 'error', '--mar-control-color-danger']
  ] as const) {
    await page.getByTestId(testId).click();
    const message = page
      .locator('.mar-message--' + type)
      .filter({ hasText: 'Theme-aware ' + type + ' feedback' });
    await expect(message).toBeVisible();
    await expectMessageThemeTokens(message, token);
    await expectMessageFirstLineAlignment(message);
    await message.locator('.mar-message-close').click();
    await expect(message).toHaveCount(0);
  }

  await page.getByTestId('show-repeated-feedback').click();
  const repeated = page
    .locator('.mar-message--info')
    .filter({ hasText: 'Repeated feedback event' });
  await expect(repeated).toHaveCount(2);
  await expect
    .poll(async () => {
      const tops = await repeated.evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().top)
      );
      return tops.length === 2 && Math.abs(tops[0]! - tops[1]!) > 1;
    })
    .toBe(true);
  await repeated.first().locator('.mar-message-close').click();
  await repeated.last().locator('.mar-message-close').click();
  await expect(repeated).toHaveCount(0);
});

test('short and diagnostic feedback automatically disappear while hover pauses dismissal', async ({
  page
}) => {
  await page.clock.install();
  await page.mouse.move(0, 0);
  await page.getByTestId('show-info-feedback').click();
  const info = page.locator('.mar-message--info');
  await expect(info).toBeVisible();
  await page.clock.runFor(2_000);
  await expect(info).toBeVisible();
  await page.clock.runFor(1_500);
  await expect(info).toHaveCount(0);

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByTestId('show-long-feedback').click();
    const error = page.locator('.mar-message--error');
    await expect(error).toBeVisible();
    await page.clock.runFor(5_000);
    await expect(error).toBeVisible();
    await error.hover();
    await page.clock.runFor(7_000);
    await expect(error).toBeVisible();
    await page.mouse.move(0, 0);
    await page.clock.runFor(6_500);
    await expect(error).toHaveCount(0);
  }
});

test('mobile long feedback scrolls without trapping its accessible close control and dialogs close with Escape', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('show-plain-text-feedback').click();
  const plainTextMessage = page
    .locator('.mar-message--warning')
    .filter({ hasText: 'Plain text <img data-feedback-payload=unsafe src=x>' });
  await expect(plainTextMessage.locator('.mar-message-text')).toHaveText(
    'Plain text <img data-feedback-payload=unsafe src=x>'
  );
  await expect(plainTextMessage.locator('img')).toHaveCount(0);
  await plainTextMessage.locator('.mar-message-close').click();
  await expect(plainTextMessage).toHaveCount(0);

  await page.getByTestId('open-feedback-dialog').click();
  const dialog = page.getByRole('dialog', { name: 'Message feedback dialog', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await page.getByTestId('show-dialog-feedback').click();
  const message = dialog
    .locator('.mar-message--error')
    .filter({ hasText: 'Line 1: long feedback remains readable and can be dismissed.' });
  const content = message.locator('.mar-message-text');
  const close = message.locator('.mar-message-close');
  await expect(content).toContainText(
    'Line 1: long feedback remains readable and can be dismissed.'
  );
  await expectMessageFirstLineAlignment(message);
  expect(await message.evaluate((element) => element.closest('[role="dialog"]') !== null)).toBe(
    true
  );
  await expect(dialog).toBeVisible();

  const layout = await message.evaluate((element) => {
    const content = element.querySelector('.mar-message-text')!;
    const close = element.querySelector('.mar-ui-message__close')!;
    const rect = (target: Element) => {
      const { x, y, width, height } = target.getBoundingClientRect();
      return { x, y, width, height, right: x + width, bottom: y + height };
    };
    return {
      message: rect(element),
      content: rect(content),
      close: rect(close),
      scrollHeight: content.scrollHeight,
      clientHeight: content.clientHeight,
      scrollWidth: content.scrollWidth,
      clientWidth: content.clientWidth,
      closeOutsideContent: !content.contains(close)
    };
  });
  expect(layout.message.x).toBeGreaterThanOrEqual(16);
  expect(layout.message.right).toBeLessThanOrEqual(374);
  expect(layout.content.right).toBeLessThanOrEqual(layout.close.x);
  expect(layout.closeOutsideContent).toBe(true);
  expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);

  await expect(close).toHaveRole('button');
  await expect(close).toHaveAccessibleName(/close/i);
  await content.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(close).toBeVisible();
  await close.focus();
  await expect(close).toBeFocused();
  await close.press('Enter');
  await expect(message).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('dialog-attached feedback leaves no offset after the dialog closes', async ({ page }) => {
  await page.getByTestId('show-info-feedback').click();
  const baselineMessage = page
    .locator('.mar-message--info')
    .filter({ hasText: 'Theme-aware info feedback' });
  await expect(baselineMessage).toBeVisible();
  await expect(baselineMessage).toHaveCSS('opacity', '1');
  const baselineTop = await baselineMessage.evaluate(
    (element) => element.getBoundingClientRect().top
  );
  expect(Number.isFinite(baselineTop)).toBe(true);
  await baselineMessage.locator('.mar-message-close').click();
  await expect(baselineMessage).toHaveCount(0);

  await page.getByTestId('open-feedback-dialog').click();
  const dialog = page.getByRole('dialog', { name: 'Message feedback dialog', exact: true });
  await expect(dialog).toBeVisible();
  await page.getByTestId('show-dialog-feedback').click();
  const dialogMessage = dialog
    .locator('.mar-message--error')
    .filter({ hasText: 'Line 1: long feedback remains readable and can be dismissed.' });
  await expect(dialogMessage).toBeVisible();

  await dialog.locator('.mar-ui-dialog__close').click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page
      .locator('.mar-message--error')
      .filter({ hasText: 'Line 1: long feedback remains readable and can be dismissed.' })
  ).toHaveCount(0);

  await page.getByTestId('show-info-feedback').click();
  const nextMessage = page
    .locator('.mar-message--info')
    .filter({ hasText: 'Theme-aware info feedback' });
  await expect(nextMessage).toBeVisible();
  await expect(nextMessage).toHaveCSS('opacity', '1');
  const nextTop = await nextMessage.evaluate((element) => element.getBoundingClientRect().top);
  expect(nextTop).toBeCloseTo(baselineTop, 1);

  await nextMessage.locator('.mar-message-close').click();
  await expect(nextMessage).toHaveCount(0);
});

test('successful dialog saves keep their feedback after the dialog is destroyed', async ({
  page
}) => {
  await page.getByTestId('open-feedback-dialog').click();
  await page.getByTestId('save-feedback-dialog').click();
  await expect(
    page.getByRole('dialog', { name: 'Message feedback dialog', exact: true })
  ).toHaveCount(0);
  const message = page
    .locator('.mar-message--success')
    .filter({ hasText: 'Dialog settings saved' });
  await expect(message).toBeVisible();
  await expect(message).toHaveJSProperty('isConnected', true);
  await message.locator('.mar-message-close').click();
  await expect(message).toHaveCount(0);
});
