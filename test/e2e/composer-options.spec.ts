import { expect, test, type Locator } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

// @test-covers packages/web-core/src/view/composer/ComposerToolbar.vue
let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/composer-options.html');
});
test.afterAll(async () => {
  await fixture?.close();
});

async function expectMenuInsideViewport(menu: Locator) {
  await expect(menu).toBeVisible();
  await menu.evaluate(async (element) => {
    for (let current: Element | null = element; current; current = current.parentElement) {
      await Promise.allSettled(current.getAnimations().map((animation) => animation.finished));
    }
  });
  await expect
    .poll(() =>
      menu.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.left >= 8 &&
          rect.right <= innerWidth - 8 &&
          rect.top >= 8 &&
          rect.bottom <= innerHeight - 8
        );
      })
    )
    .toBe(true);
}

for (const [width, height, theme, top] of [
  [1280, 844, 'daylight', false],
  [390, 844, 'vscode-dark-2026', false],
  [320, 360, 'daylight', true]
] as const) {
  test(`Composer menus keep gutters and local scrolling (${width}x${height}, ${theme})`, async ({
    page
  }, info) => {
    await page.setViewportSize({ width, height });
    await page.goto(
      `${fixture.url}composer-options.html?theme=${theme}${width < 768 ? '&mobile' : ''}${top ? '&top' : ''}`
    );
    for (const kind of ['runner', 'access', 'model-effort']) {
      await page.locator(`.composer-${kind}-select`).click();
      const menu = page.locator(`.el-select-dropdown.composer-${kind}-popper:visible`);
      await expectMenuInsideViewport(menu);
      if (kind === 'model-effort') {
        const modelGroup = menu.locator('.el-select-group__wrap').filter({ hasText: /^Model/ });
        const effortGroup = menu
          .locator('.el-select-group__wrap')
          .filter({ hasText: /^Reasoning/ });
        const modelBounds = (await modelGroup.boundingBox())!;
        const effortBounds = (await effortGroup.boundingBox())!;
        expect(modelBounds.x + modelBounds.width).toBeLessThanOrEqual(effortBounds.x + 1);
        expect(Math.abs(modelBounds.y - effortBounds.y)).toBeLessThan(1);
        if (height > 400) expect((await menu.boundingBox())!.height).toBeGreaterThan(400);
        const scroll = modelGroup.locator('.el-scrollbar__wrap');
        expect(
          await scroll.evaluate((element) => element.scrollHeight > element.clientHeight)
        ).toBe(true);
        await expect(modelGroup.locator('.el-scrollbar__bar.is-vertical')).toBeVisible();
        await page.mouse.move(0, 0);
        await expect(modelGroup.locator('.el-scrollbar__thumb').last()).toBeVisible();
        await page.screenshot({ path: info.outputPath('model-menu.png'), animations: 'disabled' });
        if (height < 400) {
          await page.setViewportSize({ width, height: 240 });
          await expectMenuInsideViewport(menu);
        }
        const last = menu.getByRole('option', {
          name: 'Engineering model 32 with a descriptive configuration name',
          exact: true
        });
        const effortTop = (await effortGroup.boundingBox())!.y;
        await last.scrollIntoViewIfNeeded();
        expect((await effortGroup.boundingBox())!.y).toBe(effortTop);
        await expectMenuInsideViewport(menu);
        expect(await scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        await last.click();
        await expect(page.getByTestId('selected-model')).toHaveText('model-31');
        await page.locator('.composer-model-effort-select').click();
        await expect(last).toBeInViewport();
        await page.keyboard.press('ArrowDown');
        await expect(
          menu.getByRole('option').filter({ hasText: /^Engineering model 1 with/ })
        ).toHaveClass(/is-hovering/);
        await page.keyboard.press('ArrowUp');
        await expect(last).toHaveClass(/is-hovering/);
        await expect(last).toBeInViewport();
        await page.keyboard.press('ArrowRight');
        await expect(menu.getByRole('option', { name: 'medium', exact: true })).toHaveClass(
          /is-hovering/
        );
        await page.keyboard.press('ArrowLeft');
        await expect(last).toHaveClass(/is-hovering/);
        await page.keyboard.press('Tab');
        await expect(menu.getByRole('option', { name: 'medium', exact: true })).toBeInViewport();
        await page.keyboard.press('Tab');
        await expect(last).toBeInViewport();
        await page.keyboard.press('Home');
        await expect(modelGroup.getByRole('option').first()).toHaveClass(/is-hovering/);
        await page.keyboard.press('End');
        await expect(last).toHaveClass(/is-hovering/);
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();
        expect(
          await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)
        ).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true
        );
      } else {
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();
      }
    }
  });
}

for (const [width, theme] of [
  [1280, 'daylight'],
  [1280, 'vscode-dark-2026'],
  [390, 'daylight']
] as const) {
  test(`Short model names keep the two-column menu content-sized (${width}, ${theme})`, async ({
    page
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(
      `${fixture.url}composer-options.html?compact-names&short&theme=${theme}${width < 768 ? '&mobile' : ''}`
    );
    await page.locator('.composer-model-effort-select').click();
    const menu = page.locator('.el-select-dropdown.composer-model-effort-popper:visible');
    await expectMenuInsideViewport(menu);
    const models = menu.locator('.el-select-group__wrap').first();
    const sizes = await models.evaluate((element) => {
      const options = Array.from(element.querySelectorAll('.el-select-dropdown__item'));
      const contentWidths = options.map((option) => {
        const label = option.querySelector('span')!;
        const range = document.createRange();
        range.selectNodeContents(label);
        const style = getComputedStyle(option);
        return {
          label: range.getBoundingClientRect().width,
          padded:
            range.getBoundingClientRect().width +
            parseFloat(style.paddingLeft) +
            parseFloat(style.paddingRight)
        };
      });
      return {
        column: element.getBoundingClientRect().width,
        widestLabel: Math.max(...contentWidths.map((width) => width.label)),
        widestOption: Math.max(...contentWidths.map((width) => width.padded))
      };
    });
    expect(sizes.widestLabel).toBeGreaterThan(0);
    expect(sizes.column).toBeGreaterThan(sizes.widestLabel);
    expect(sizes.column).toBeLessThanOrEqual(sizes.widestOption + 1);
    await page.screenshot({
      path: info.outputPath('compact-model-menu.png'),
      animations: 'disabled'
    });
    await menu.getByRole('option', { name: 'GPT-6.1-Sol Fast', exact: true }).click();
    await expect(page.getByTestId('selected-model')).toHaveText('model-2');
    await expect(page.getByTestId('selected-effort')).toHaveText('medium');
  });
}

for (const kind of ['model', 'effort']) {
  test(`Composer keeps a single column when only ${kind} is available`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 600 });
    await page.goto(`${fixture.url}composer-options.html?single=${kind}&mobile`);
    await page.locator('.composer-model-effort-select').click();
    const menu = page.locator('.el-select-dropdown.composer-model-effort-popper:visible');
    await expectMenuInsideViewport(menu);
    await expect(menu.locator('.el-select-group__wrap')).toHaveCount(1);
    await page.keyboard.press('End');
    await expect(menu.getByRole('option').last()).toBeInViewport();
    await page.keyboard.press('Enter');
    await expect(menu).toBeHidden();
    await expect(
      page.getByTestId(kind === 'model' ? 'selected-model' : 'selected-effort')
    ).toHaveText(kind === 'model' ? 'model-31' : 'ultra');
  });
}

for (const open of [false, true]) {
  test(`Keyboard selection follows refreshed model order (${open ? 'open' : 'closed'} menu)`, async ({
    page
  }) => {
    await page.goto(`${fixture.url}composer-options.html?dynamic`);
    const trigger = page.locator('.composer-model-effort-select');
    if (open) await trigger.click();
    // The fixture button simulates a background profile refresh without moving input focus.
    await page.getByRole('button', { name: 'Reverse models' }).dispatchEvent('click');
    if (!open) await trigger.click();
    const menu = page.locator('.el-select-dropdown.composer-model-effort-popper:visible');
    const models = menu.locator('.el-select-group__wrap').filter({ hasText: /^Model/ });
    await expect(models.getByRole('option').first()).toHaveText(
      'Engineering model 32 with a descriptive configuration name'
    );
    await page.keyboard.press('ArrowRight');
    await expect(menu.getByRole('option', { name: 'medium', exact: true })).toHaveClass(
      /is-hovering/
    );
    await page.keyboard.press('ArrowLeft');
    await expect(models.getByRole('option').last()).toHaveClass(/is-hovering/);
    await page.keyboard.press('Home');
    await expect(models.getByRole('option').first()).toHaveClass(/is-hovering/);
    await page.keyboard.press('End');
    await expect(models.getByRole('option').last()).toHaveClass(/is-hovering/);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('selected-model')).toHaveText('model-0');
    await expect(page.getByTestId('selected-effort')).toHaveText('medium');
  });
}

test('Touch selection keeps the other column value and short menus stay compact', async ({
  browser
}, info) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 720 },
    hasTouch: true,
    isMobile: true
  });
  try {
    const page = await context.newPage();
    await page.goto(`${fixture.url}composer-options.html?mobile&short&theme=vscode-dark-2026`);
    const trigger = page.locator('.composer-model-effort-select');
    await trigger.tap();
    const menu = page.locator('.el-select-dropdown.composer-model-effort-popper:visible');
    await expectMenuInsideViewport(menu);
    expect((await menu.boundingBox())!.height).toBeLessThan(250);
    const columns = menu.locator('.el-select-group .el-scrollbar__wrap');
    for (const column of await columns.all())
      expect(await column.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(
        true
      );
    await menu.getByRole('option', { name: 'high', exact: true }).tap();
    await expect(page.getByTestId('selected-effort')).toHaveText('high');
    await expect(page.getByTestId('selected-model')).toHaveText('model-0');
    await trigger.tap();
    await menu
      .getByRole('option', {
        name: 'Engineering model 3 with a descriptive configuration name',
        exact: true
      })
      .tap();
    await expect(page.getByTestId('selected-effort')).toHaveText('high');
    await expect(page.getByTestId('selected-model')).toHaveText('model-2');
    await trigger.tap();
    await expectMenuInsideViewport(menu);
    await expect(menu.locator('.composer-model-effort-option-selected')).toHaveCount(2);
    await page.screenshot({
      path: info.outputPath('short-model-menu.png'),
      animations: 'disabled'
    });
  } finally {
    await context.close();
  }
});
