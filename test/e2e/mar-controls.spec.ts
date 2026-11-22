import { expect, test } from '@playwright/test';
import { resolvedColorToHex } from '../../packages/web-core/src/util/theme-palette.js';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

// @test-covers packages/mar-ui/components/button/MarButton.vue
// @test-covers packages/mar-ui/components/checkbox/MarCheckbox.vue
let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/mar-controls.html');
});
test.afterAll(async () => {
  await fixture?.close();
});

test('Button-shaped links match native button geometry without a global box-sizing reset', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 720 });
  await page.goto(`${fixture.url}mar-controls.html?theme=dark&button-row=1`);
  // Restore the browser defaults only for the action roots to exercise MAR UI in isolation.
  await page.addStyleTag({
    content: `:where([aria-label="Standard actions"] .mar-ui-button) { box-sizing: revert; }`
  });
  const row = page.getByRole('region', { name: 'Standard actions' });
  const button = row.getByRole('button', { name: 'Create', exact: true });
  const link = row.getByRole('link', { name: 'Open', exact: true });
  await expect(link).toBeVisible();
  const action = (await button.boundingBox())!;
  const navigation = (await link.boundingBox())!;
  expect(navigation.height).toBeCloseTo(action.height, 0);
  expect(navigation.y).toBeCloseTo(action.y, 0);
  await link.press('Enter');
  await expect(page).toHaveURL(/#action-destination$/u);
});

test('Standard actions with and without icons align outside a dialog, including while busy', async ({
  page
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const [width, theme] of [
    [1280, 'light'],
    [390, 'dark']
  ] as const) {
    await page.setViewportSize({ width, height: 720 });
    await page.goto(`${fixture.url}mar-controls.html?theme=${theme}&button-row=1`);
    const row = page.getByRole('region', { name: 'Standard actions' });
    const cancel = row.getByRole('button', { name: 'Cancel' });
    const create = row.getByRole('button', { name: 'Create' });
    const open = row.getByRole('link', { name: 'Open', exact: true });
    const refresh = row.getByRole('button', { name: 'Refresh' });
    const iconLink = row.getByRole('link', { name: 'Open destination' });
    await expect(create).toBeVisible();
    // Exercise both the default density and larger root-relative button padding.
    for (const rootFontSize of ['', '20px']) {
      await page.evaluate((size) => (document.documentElement.style.fontSize = size), rootFontSize);
      const initial = (await cancel.boundingBox())!;
      const labelSize = await create.evaluate((button) =>
        parseFloat(getComputedStyle(button).fontSize)
      );
      expect((await open.locator('[data-mar-icon]').boundingBox())!.height).toBeCloseTo(
        labelSize,
        1
      );
      for (const busy of [false, true]) {
        if (busy) {
          await row.getByRole('button', { name: 'Toggle busy' }).click();
          await expect(create).toHaveAttribute('aria-busy', 'true');
          await expect(iconLink).not.toHaveAttribute('href');
        }
        for (const action of [refresh, iconLink]) {
          await expect(action.locator('[data-mar-icon]')).toHaveCSS(
            'height',
            `${width < 768 ? 18 : labelSize}px`
          );
        }
        const iconButton = (await create.boundingBox())!;
        const textButton = (await cancel.boundingBox())!;
        const icon = (await create.locator('[data-mar-icon]').boundingBox())!;
        expect(icon.height, `${width}px viewport, busy: ${busy}`).toBeCloseTo(labelSize, 1);
        expect(icon.width).toBeCloseTo(labelSize, 1);
        if (busy) {
          const spinner = (await cancel.locator('[data-mar-icon="loading-action"]').boundingBox())!;
          expect(spinner.height).toBeCloseTo(labelSize, 1);
          expect(spinner.y + spinner.height / 2).toBeCloseTo(
            textButton.y + textButton.height / 2,
            0
          );
        }
        expect(iconButton.height).toBeCloseTo(initial.height, 0);
        expect(iconButton.height).toBeCloseTo(textButton.height, 0);
        expect(iconButton.y).toBeCloseTo(textButton.y, 0);
        expect(textButton.height).toBeCloseTo(initial.height, 0);
        expect(icon.y + icon.height / 2).toBeCloseTo(iconButton.y + iconButton.height / 2, 0);
      }
      await row.getByRole('button', { name: 'Toggle busy' }).click();
      await expect(create).not.toHaveAttribute('aria-busy');
    }
    await row.screenshot({ path: testInfo.outputPath(`standard-actions-${width}.png`) });
  }
});

for (const [theme, width] of [
  ['light', 1280],
  ['dark', 390]
] as const) {
  test(`MAR Input uses compact typography by default at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 930 });
    await page.goto(`${fixture.url}mar-controls.html?theme=${theme}&inputs`);
    await page.evaluate(() => document.documentElement.classList.add('console-ui'));
    const input = page.getByRole('textbox', { name: 'Name', exact: true });
    const inputSize = width >= 768 ? '12px' : '11px';
    await expect(input).toHaveCSS('font-size', inputSize);
    expect(await input.evaluate((field) => getComputedStyle(field, '::placeholder').fontSize)).toBe(
      inputSize
    );
    const notes = page.getByRole('textbox', { name: 'Notes', exact: true });
    const notesSize = await notes.evaluate((field) => {
      const probe = document.createElement('span');
      probe.style.fontSize = 'var(--mar-font-size-input)';
      field.after(probe);
      const size = getComputedStyle(probe).fontSize;
      probe.remove();
      return size;
    });
    await expect(notes).toHaveCSS('font-size', notesSize);
  });

  test(`MAR controls render and keep interactive state at ${width}px in ${theme}`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width, height: 930 });
    await page.goto(`${fixture.url}mar-controls.html?theme=${theme}`);
    await expect(page.getByRole('alert')).toContainText('Changes are saved as a draft.');
    await expect(page.getByText('SomePathWithoutSpaces/Segment/AnotherSegment')).toBeVisible();
    const details = page.locator('dl').filter({ hasText: 'Test fixture' });
    const first = details.locator('.mar-ui-descriptions__item').nth(0);
    const second = details.locator('.mar-ui-descriptions__item').nth(1);
    const third = details.locator('.mar-ui-descriptions__item').nth(2);
    const firstBox = (await first.boundingBox())!;
    const secondBox = (await second.boundingBox())!;
    await expect(first).toHaveCSS('border-block-start-width', '0px');
    await expect(third).toHaveCSS('border-block-start-width', '1px');
    const unruled = page.getByTestId('unruled-details').locator('.mar-ui-descriptions__item');
    await expect(unruled.last()).toHaveCSS('border-block-start-width', '0px');
    for (const item of [first, unruled.first()]) {
      await expect(item).toHaveCSS('padding-block-start', '4px');
      await expect(item).toHaveCSS('padding-block-end', '4px');
      await expect(item.locator('dd')).toHaveCSS('font-size', width >= 768 ? '14px' : '13px');
    }
    if (width === 390) {
      expect(secondBox.x).toBeCloseTo(firstBox.x, 1);
      expect(secondBox.y).toBeGreaterThan(firstBox.y);
      await expect(second).toHaveCSS('border-block-start-width', '1px');
    } else {
      expect(secondBox.x).toBeGreaterThan(firstBox.x);
      expect(secondBox.y).toBeCloseTo(firstBox.y, 1);
      await expect(second).toHaveCSS('border-block-start-width', '0px');
    }
    const checkbox = page.getByRole('checkbox', { name: 'Read' });
    const checkboxContrast = async () => {
      const colors = await checkbox.evaluate((input) => {
        const style = getComputedStyle(input);
        return [style.borderTopColor, style.backgroundColor];
      });
      const luminances = colors.map((color) => {
        const hex = resolvedColorToHex(color);
        return [0.2126, 0.7152, 0.0722].reduce((sum, weight, channel) => {
          const offset = 1 + channel * 2;
          const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
          return (
            sum + weight * (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
          );
        }, 0);
      });
      return (Math.max(...luminances) + 0.05) / (Math.min(...luminances) + 0.05);
    };
    await expect(checkbox).not.toBeChecked();
    await expect(checkbox).toHaveCSS('border-top-width', '1px');
    const restingCheckboxContrast = await checkboxContrast();
    expect(restingCheckboxContrast).toBeGreaterThanOrEqual(3);
    await checkbox.hover();
    expect(await checkboxContrast()).toBeGreaterThan(restingCheckboxContrast);
    await checkbox.check();
    await expect(page.getByRole('checkbox', { name: 'Write' })).toBeDisabled();
    await expect(page.getByLabel('Permissions value')).toHaveText('read');
    await page.getByRole('radio', { name: 'Requests' }).check();
    await expect(page.getByLabel('Metric value')).toHaveText('b');
    const quantity = page.getByRole('spinbutton', { name: 'Quantity' });
    await expect(quantity).toHaveCSS('font-size', width >= 768 ? '12px' : '11px');
    await expect(page.getByRole('textbox', { name: 'Expires at' })).toHaveCSS(
      'font-size',
      width >= 768 ? '12px' : '11px'
    );
    await quantity.press('ArrowUp');
    await expect(quantity).toHaveValue('3');
    await expect(page.getByRole('button', { name: /increase/i })).toBeDisabled();
    await page.getByRole('tab', { name: 'Overview' }).press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Details' })).toBeFocused();
    await expect(page.getByRole('tabpanel')).toHaveText('Details panel');
    const period = page.getByRole('radiogroup', { name: 'Period' });
    const day = period.getByRole('radio', { name: 'Day' });
    const week = period.getByRole('radio', { name: 'Week' });
    await expect(day).toBeChecked();
    await expect(period.locator('.mar-segmented-indicator')).toBeVisible();
    await day.press('ArrowRight');
    await expect(week).toBeFocused();
    await expect(week).toBeChecked();
    await day.click();
    await expect(day).toBeChecked();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}.png`) });
  });
}

test('MAR descriptions stack and wrap inside a narrow container on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 930 });
  await page.goto(`${fixture.url}mar-controls.html?theme=light`);
  const details = page.locator('dl').filter({ hasText: 'Test fixture' });
  await details.evaluate((element) => element.style.setProperty('inline-size', '260px'));
  const rows = details.locator('.mar-ui-descriptions__item');
  const first = await rows.first().boundingBox();
  const second = await rows.nth(1).boundingBox();
  expect(second!.x).toBeCloseTo(first!.x, 1);
  expect(second!.y).toBeGreaterThan(first!.y);
  await expect(rows.nth(1)).toHaveCSS('border-block-start-width', '1px');
  const label = await rows.nth(1).locator('dt').boundingBox();
  const value = rows.nth(1).locator('dd');
  const valueBox = await value.boundingBox();
  expect(valueBox!.y).toBeGreaterThanOrEqual(label!.y + label!.height);
  expect(await value.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test('Dropdown grows toward the free space when a label expands near the right edge', async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 640, height: 600 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${fixture.url}mar-controls.html?command-menu`);
  await page.getByRole('button', { name: 'Commands' }).click();
  const menu = page.getByRole('menu', { name: 'Commands' });
  const rename = menu.getByRole('menuitem').last();
  await expect(rename).toHaveCSS('font-size', '11px');
  const initial = (await menu.boundingBox())!;
  const rowHeight = (await rename.boundingBox())!.height;
  const compact = await rename.evaluate((item) => {
    const label = document.createRange();
    label.selectNodeContents(item);
    const style = getComputedStyle(item);
    return {
      labelAndPadding:
        label.getBoundingClientRect().width +
        parseFloat(style.paddingLeft) +
        parseFloat(style.paddingRight),
      rowWidth: item.getBoundingClientRect().width
    };
  });
  expect(compact.rowWidth).toBeCloseTo(compact.labelAndPadding, 0);
  expect(initial.width - compact.rowWidth).toBeCloseTo(2, 0);
  await menu.screenshot({ path: testInfo.outputPath('compact-dropdown.png') });

  await rename.evaluate((item) => {
    item.textContent = 'Rename this shared workspace and its configuration';
  });
  await expect
    .poll(async () => {
      const { x, width } = (await menu.boundingBox())!;
      return { grew: width > initial.width, shiftedLeft: x < initial.x, inside: x + width <= 632 };
    })
    .toEqual({ grew: true, shiftedLeft: true, inside: true });
  expect((await rename.boundingBox())!.height).toBeCloseTo(rowHeight, 0);

  await page.setViewportSize({ width: 320, height: 600 });
  await rename.evaluate((item) => {
    item.textContent = 'RenameThisSharedWorkspaceAndItsConfiguration'.repeat(3);
  });
  await expect
    .poll(() =>
      menu.evaluate((element) => {
        const { left, right } = element.getBoundingClientRect();
        const content = element.firstElementChild!;
        return left >= 8 && right <= 312 && content.scrollWidth <= content.clientWidth;
      })
    )
    .toBe(true);
  expect((await rename.boundingBox())!.height).toBeGreaterThan(rowHeight);
});

test('Dark Dropdown shows a distinct neutral highlight for pointer and keyboard', async ({
  page
}, testInfo) => {
  await page.goto(`${fixture.url}mar-controls.html?theme=dark&command-menu`);
  const trigger = page.getByRole('button', { name: 'Commands' });
  await trigger.click();
  const menu = page.getByRole('menu', { name: 'Commands' });
  const rename = menu.getByRole('menuitem', { name: 'Rename' });
  const surface = resolvedColorToHex(
    await menu.evaluate((el) => getComputedStyle(el).backgroundColor)
  );
  await expect(rename).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await rename.hover();
  const hover = await rename.evaluate((el) => getComputedStyle(el).backgroundColor);
  const hex = resolvedColorToHex(hover);
  expect(hex).toMatch(/^#([\da-f]{2})\1\1$/u);
  expect(parseInt(hex.slice(1, 3), 16) - parseInt(surface.slice(1, 3), 16)).toBeGreaterThanOrEqual(
    20
  );
  await menu.screenshot({ path: testInfo.outputPath('dropdown-dark-hover.png') });
  await page.mouse.move(0, 0);
  await page.keyboard.press('Escape');
  await trigger.press('ArrowUp');
  await expect(rename).toBeFocused();
  await expect(rename).toHaveCSS('background-color', hover);
  await expect(rename).toHaveCSS('outline-style', 'solid');
});

test('Organization cascader highlights the entire row and shows the confirmed path', async ({
  page
}) => {
  await page.goto(`${fixture.url}mar-controls.html?theme=dark`);
  const owner = page.getByRole('combobox', { name: 'Owner' });
  await owner.click();
  const popup = page.getByRole('dialog', { name: 'Select' });
  const expand = popup.getByRole('button', { name: 'Platform', expanded: false });
  const chooseControl = page
    .getByRole('button', { name: 'Platform', exact: true })
    .and(page.locator('[aria-pressed]'));
  const choose = popup.locator(chooseControl);
  const row = popup.locator('.mar-ui-cascader__row').filter({ has: chooseControl });
  const hoverFill = await row.evaluate((node) => {
    const probe = document.createElement('div');
    probe.style.backgroundColor = 'var(--mar-ui-overlay-row-hover)';
    node.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  });
  await expand.hover();
  await expect(row).toHaveCSS('background-color', hoverFill);
  await expect(expand).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await choose.hover();
  await expect(row).toHaveCSS('background-color', hoverFill);

  await expand.click();
  await popup.getByRole('button', { name: 'Release', exact: true }).click();
  await expect(owner).toHaveValue('Platform / Release');
  await expect(page.getByLabel('Owner value')).toHaveText('2');
  await owner.click();
  const selectedOption = page.getByRole('button', { name: 'Release', pressed: true, exact: true });
  const selectedRow = popup.locator('.mar-ui-cascader__row').filter({ has: selectedOption });
  await expect(selectedRow).toBeVisible();
  const selectedFill = await selectedRow.evaluate(
    (element) => getComputedStyle(element).backgroundColor
  );
  expect(selectedFill).not.toBe('rgba(0, 0, 0, 0)');
  await popup.getByRole('button', { name: 'Operations', expanded: false }).click();
  await expect(popup.getByRole('button', { name: 'Support', exact: true })).toBeVisible();
  await expect(selectedRow).toHaveCSS('background-color', selectedFill);
  await expect(owner).toHaveValue('Platform / Release');
  await choose.click();
  await expect(owner).toHaveValue('Platform');
  await expect(page.getByLabel('Owner value')).toHaveText('1');
});

test('MAR complex fields keep scalar values, explicit commits and localized UI', async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`${fixture.url}mar-controls.html`);
  const owner = page.getByRole('combobox', { name: 'Owner' });
  await owner.click();
  await owner.fill('Release');
  await owner.press('Enter');
  await expect(page.getByLabel('Owner value')).toHaveText('2');
  await page.getByRole('button', { name: 'Clear', exact: true }).first().click();
  await expect(page.getByLabel('Owner value')).toBeEmpty();
  await owner.click();
  await owner.fill('Platform');
  await owner.press('Enter');
  await expect(page.getByLabel('Owner value')).toHaveText('1');
  const rangeButton = page.getByRole('button', { name: 'Calendar', exact: true }).first();
  await rangeButton.click();
  let calendar = page.getByRole('dialog', { name: 'Calendar' });
  await expect(calendar.locator('.mar-ui-calendar-month')).toHaveCount(1);
  const days = calendar.locator('.mar-ui-calendar-month__days button');
  // The calendar grid retains its reading size; only the footer controls are compact.
  await expect(days.nth(3)).toHaveCSS('font-size', '14px');
  await expect(calendar.getByLabel('Start time', { exact: true })).toHaveCSS('font-size', '11px');
  await expect(calendar.getByRole('button', { name: 'Confirm' })).toHaveCSS('font-size', '11px');
  await days.nth(3).click();
  await expect(page.getByLabel('Range changes')).toHaveText('0');
  await days.nth(6).click();
  await expect(page.getByLabel('Range value')).toHaveText('0,0');
  await expect(page.getByLabel('Range changes')).toHaveText('0');
  await page.screenshot({ path: testInfo.outputPath('mobile-calendar.png') });
  await page.getByRole('heading', { name: 'MAR controls' }).click();
  await expect(calendar).toBeHidden();
  await expect(page.getByLabel('Range changes')).toHaveText('1');
  await rangeButton.click();
  calendar = page.getByRole('dialog', { name: 'Calendar' });
  await calendar.locator('.mar-ui-calendar-month__days button').nth(2).click();
  await page.keyboard.press('Escape');
  await expect(calendar).toBeHidden();
  await expect(page.getByLabel('Range changes')).toHaveText('1');
  await page.locator('.mar-ui-date-picker').first().getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByLabel('Range value')).toBeEmpty();
  await expect(page.getByLabel('Range changes')).toHaveText('2');
  const timeInput = page.getByRole('textbox', { name: 'Time', exact: true });
  await expect(timeInput).toHaveCSS('font-size', '11px');
  await timeInput.click();
  const timePanel = page.getByRole('dialog', { name: 'Time' });
  await expect(timePanel.getByRole('button', { name: 'Cancel' })).toHaveCSS('font-size', '11px');
  const ten = timePanel
    .getByRole('group', { name: 'Hours' })
    .getByRole('button', { name: '10', exact: true });
  await expect(ten).toHaveCSS('font-size', '11px');
  await ten.click();
  await timePanel
    .getByRole('group', { name: 'Minutes' })
    .getByRole('button', { name: '15', exact: true })
    .click();
  await expect(page.getByLabel('Time value')).toHaveText('10:15');
  await expect(page.getByLabel('Time changes')).toHaveText('0');
  await timePanel.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByLabel('Time value')).toHaveText('10:15');
  await expect(page.getByLabel('Time changes')).toHaveText('1');
  await timeInput.press('ArrowDown');
  const hours = timePanel.getByRole('group', { name: 'Hours' });
  await expect(hours.getByRole('button', { name: '10', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(hours.getByRole('button', { name: '11', exact: true })).toBeFocused();
  await expect(page.getByLabel('Time value')).toHaveText('11:15');
  await timePanel.getByRole('button', { name: 'Cancel' }).click();
  await expect(timeInput).toBeFocused();
  await expect(page.getByLabel('Time value')).toHaveText('10:15');
  await expect(page.getByLabel('Time changes')).toHaveText('1');
  await timeInput.click();
  await timeInput.fill('13:20');
  await page.getByRole('heading', { name: 'MAR controls' }).click();
  await expect(page.getByLabel('Time value')).toHaveText('13:20');
  await expect(page.getByLabel('Time changes')).toHaveText('2');
  await page.getByRole('combobox', { name: 'Minutes' }).click();
  const minute = page.getByRole('option', { name: '00:15' });
  await expect(minute).toHaveCSS('font-size', '11px');
  await minute.click();
  await expect(page.getByLabel('Minute value')).toHaveText('00:15');
  await page.locator('.mar-ui-time-select').getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByLabel('Minute value')).toHaveText('undefined');
  await page.locator('.mar-ui-time-picker').getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByLabel('Time value')).toHaveText('null');
  await page.getByRole('button', { name: 'Chinese controls' }).click();
  await expect(page.getByRole('button', { name: '日历' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '清空' }).first()).toBeVisible();
});

test('MAR single datetime commits local dates and clears to null', async ({ page }) => {
  await page.goto(`${fixture.url}mar-controls.html`);
  const expiration = page.getByRole('region', { name: 'Expiration field' });
  const input = expiration.getByRole('textbox', { name: 'Expires at' });
  const observed = expiration.getByLabel('Expiration value');
  await input.fill('2026-02-30 12:15:00');
  await input.press('Tab');
  await expect(observed).toBeEmpty();
  await input.fill('2026-02-27 12:15:00');
  await input.press('Enter');
  const expected = await page.evaluate(() => new Date(2026, 1, 27, 12, 15).toISOString());
  await expect(observed).toHaveText(expected);
  await expiration.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(observed).toBeEmpty();
  await expect(input).toBeFocused();
});

test('MAR datetime supports calendar navigation without tabbing through every date', async ({
  page
}) => {
  await page.goto(`${fixture.url}mar-controls.html`);
  const picker = page.getByRole('region', { name: 'Expiration field' });
  const input = picker.getByRole('textbox', { name: 'Expires at' });
  await input.fill('2026-01-31 12:15:00');
  await input.press('Enter');
  await input.press('ArrowDown');
  const calendar = picker.getByRole('dialog', { name: 'Calendar' });
  const active = calendar.getByRole('button', { name: '2026-01-31' });
  await expect(active).toBeFocused();
  await expect(calendar.locator('.mar-ui-calendar-month__days button[tabindex="0"]')).toHaveCount(
    1
  );
  await active.press('ArrowRight');
  const nextMonth = calendar.getByRole('button', { name: '2026-02-01' });
  await expect(nextMonth).toBeFocused();
  await expect(nextMonth).toHaveAttribute('data-outside', 'false');
  await nextMonth.press('Enter');
  await expect(input).toHaveValue('2026-02-01 12:15:00');
  await nextMonth.press('Escape');
  await expect(calendar).toBeHidden();
  await expect(input).toBeFocused();
});

test('MAR time commits keyboard edits without needing to click the picker', async ({ page }) => {
  await page.goto(`${fixture.url}mar-controls.html`);
  const input = page.getByRole('textbox', { name: 'Time', exact: true });
  const panel = page.getByRole('dialog', { name: 'Time' });
  const value = page.getByLabel('Time value');
  const changes = page.getByLabel('Time changes');

  await input.focus();
  await input.fill('14:20');
  await expect(panel).toBeVisible();
  await expect(value).toHaveText('08:00');
  await input.press('Enter');
  await expect(panel).toBeHidden();
  await expect(value).toHaveText('14:20');
  await expect(changes).toHaveText('1');

  await input.fill('16:45');
  await page.getByRole('combobox', { name: 'Minutes' }).focus();
  await expect(panel).toBeHidden();
  await expect(value).toHaveText('16:45');
  await expect(changes).toHaveText('2');
});

test('MAR time Escape restores the time from before opening without emitting change', async ({
  page
}) => {
  await page.goto(`${fixture.url}mar-controls.html`);
  const input = page.getByRole('textbox', { name: 'Time', exact: true });
  const timePanel = page.getByRole('dialog', { name: 'Time' });
  const value = page.getByLabel('Time value');
  const changes = page.getByLabel('Time changes');

  await input.fill('10:15');
  await input.press('Enter');
  await expect(value).toHaveText('10:15');
  await expect(changes).toHaveText('1');

  await input.press('ArrowDown');
  const hours = timePanel.getByRole('group', { name: 'Hours' });
  await expect(hours.getByRole('button', { name: '10', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(hours.getByRole('button', { name: '11', exact: true })).toBeFocused();
  await expect(value).toHaveText('11:15');
  await page.keyboard.press('Escape');

  await expect(timePanel).toBeHidden();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('10:15');
  await expect(value).toHaveText('10:15');
  await expect(changes).toHaveText('1');
});

test('MAR date and time do not commit an IME confirmation key', async ({ page }) => {
  await page.goto(`${fixture.url}mar-controls.html`);
  const now = page.getByRole('textbox', { name: 'Time', exact: true });
  const expiration = page.getByRole('textbox', { name: 'Expires at' });
  for (const [field, draft, model, original, popup] of [
    [now, '14:20', 'Time value', '08:00', 'Time'],
    [expiration, '2026-02-27 12:15:00', 'Expiration value', '', 'Calendar']
  ] as const) {
    await field.click();
    await field.fill(draft);
    const panel = page.getByRole('dialog', { name: popup });
    await expect(panel).toBeVisible();
    await field.dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true });
    await expect(page.getByLabel(model)).toHaveText(original);
    await expect(panel).toBeVisible();
    await field.press('Enter');
    await expect(panel).toBeHidden();
    await expect(page.getByLabel(model)).not.toHaveText(original);
  }
});

test('Audit requests one complete range after keyboard selection and dismissal', async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.url}management-page.html?area=audit`);
  const audit = page.locator('.audit-management');
  await expect(audit.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible();
  const calls = () => page.evaluate(() => window.managementPageFixture.calls());
  await page.waitForFunction(() => window.managementPageFixture?.calls().length === 1);
  await page.evaluate(() => window.managementPageFixture.settle(0, true));
  const input = audit.locator('.audit-range-picker input').first();
  await input.press('ArrowDown');
  const calendar = audit.getByRole('dialog', { name: 'Calendar' });
  await expect(calendar.locator('.mar-ui-calendar-month')).toHaveCount(2);
  const date = calendar.locator('[data-day]:focus');
  const first = await date.getAttribute('data-day');
  await date.press('Enter');
  expect(await calls()).toHaveLength(1);
  await date.press('ArrowRight');
  const second = await date.getAttribute('data-day');
  expect(second).not.toBe(first);
  await date.press('Enter');
  expect(await calls()).toHaveLength(1);
  await date.press('Escape');
  await expect(calendar).toBeHidden();
  await expect(input).toBeFocused();
  await expect.poll(async () => (await calls()).length).toBe(2);
  const query = new URL((await calls())[1]!, 'http://fixture').searchParams;
  const pickedDays = await page.evaluate(
    (epochs) =>
      epochs.map((epoch) => {
        const date = new Date(Number(epoch));
        return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
          .map((part) => String(part).padStart(2, '0'))
          .join('-');
      }),
    [query.get('from'), query.get('to')]
  );
  expect(pickedDays).toEqual([first, second]);
});

test('MAR number reports edits immediately but change only on commit', async ({ page }) => {
  await page.goto(`${fixture.url}mar-controls.html`);
  const quantity = page.getByRole('spinbutton', { name: 'Quantity' });
  const observed = page.getByLabel('Quantity value');
  const changes = page.getByLabel('Quantity changes');
  await expect(
    page.getByRole('button', { name: /decrease/i }).locator('[data-test-icon]')
  ).toBeVisible();
  await quantity.fill('9');
  await expect(quantity).toHaveValue('9');
  await expect(observed).toHaveText('3');
  await expect(changes).toBeEmpty();
  await quantity.press('Tab');
  await expect(quantity).toHaveValue('3');
  await expect(changes).toHaveText('2->3');
  await quantity.clear();
  await expect(observed).toHaveText('null');
  await expect(changes).toHaveText('2->3');
  await quantity.press('Enter');
  await expect(changes).toHaveText('2->3,3->null');
});

for (const [width, theme, font, control] of [
  [1280, 'light', '12px', '26px'],
  [390, 'dark', '11px', '24px']
] as const) {
  test(`Remote select uses a compact status row at ${width}px`, async ({ page }, testInfo) => {
    const response = Promise.withResolvers<void>();
    await page.setViewportSize({ width, height: 850 });
    await page.route('**/fixture-remote-options', async (route) => {
      await response.promise;
      await route.fulfill({ json: [] });
    });
    try {
      await page.goto(`${fixture.url}mar-controls.html?remote-select&theme=${theme}`);
      const search = page.getByRole('combobox', { name: 'Remote options' });
      await expect(search).toHaveCSS('font-size', font);
      await search.click();
      const list = page.getByRole('listbox');
      const status = list.locator('.mar-ui-select__empty');
      await expect(list).toHaveAttribute('aria-busy', 'true');
      await expect(status).toHaveCSS('height', control);
      await expect(status.locator('[data-mar-icon="loading-content"]')).toHaveCSS('height', font);
      await expect(list.getByText('No data', { exact: true })).toHaveCount(0);
      response.resolve();
      await expect(list).not.toHaveAttribute('aria-busy');
      const empty = list.getByText('No data', { exact: true });
      await expect(empty).toHaveCSS('font-size', font);
      await expect(empty).toHaveCSS('height', control);
      await list.screenshot({ path: testInfo.outputPath('remote-select-empty.png') });
    } finally {
      response.resolve();
    }
  });

  test(`Cascader uses a compact no-results row at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 850 });
    await page.goto(`${fixture.url}mar-controls.html?theme=${theme}`);
    const owner = page.getByRole('combobox', { name: 'Owner' });
    await expect(owner).toHaveCSS('font-size', font);
    await owner.fill('Unmatched organization');
    const popup = page.getByRole('dialog', { name: 'Select' });
    const empty = popup.getByText('No data', { exact: true });
    await expect(empty).toHaveCSS('font-size', font);
    await expect(empty).toHaveCSS('height', control);
    const emptyWidth = (await popup.boundingBox())!.width;
    await popup.screenshot({ path: testInfo.outputPath('cascader-empty.png') });
    await owner.fill('Release');
    const result = popup.getByRole('button', { name: 'Platform / Release' });
    await expect(result).toBeVisible();
    await expect(result).toHaveCSS('font-size', font);
    await expect(empty).toHaveCount(0);
    expect((await popup.boundingBox())!.width).toBeCloseTo(emptyWidth, 1);
  });
}
