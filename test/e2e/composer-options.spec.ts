import { expect, test, type Locator } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';
import { resolvedColorToHex } from '../../packages/web-core/src/util/theme-palette.js';

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

for (const locale of ['en-US', 'zh-CN']) {
  for (const running of [false, true]) {
    test(`Composer keyboard hints use local width (${locale}, ${running ? 'running' : 'idle'})`, async ({
      page
    }, info) => {
      await page.setViewportSize({ width: 1280, height: 844 });
      for (const compact of [true, false]) {
        await page.goto(
          `${fixture.url}composer-options.html?short&locale=${locale}${running ? '&running' : ''}${running && compact ? '&empty' : ''}${compact ? '&compact-names&existing-session' : ''}&theme=${compact ? 'daylight' : 'vscode-dark-2026'}`
        );
        const toolbar = page.locator('.composer-toolbar');
        const hint = toolbar.locator('.composer-keyboard-hint');
        await expect(hint).toContainText(
          locale === 'zh-CN' ? (running ? '排队' : '发送') : running ? 'to queue' : 'to send'
        );
        for (const width of [960, 840, 760, 681, 680, 560]) {
          await toolbar.evaluate((element, width) => {
            element.style.boxSizing = 'content-box';
            element.style.width = `${width}px`;
          }, width);
          if (width > 680) await expect(hint).toBeVisible();
          else await expect(hint).toBeHidden();
          const layout = await toolbar.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const items = Array.from(
              element.querySelectorAll<HTMLElement>(
                '.composer-configuration, .composer-context-button, .composer-hint, .composer-stop-button, .composer-send-control'
              )
            )
              .map((item) => item.getBoundingClientRect())
              .filter((item) => item.width > 0);
            return {
              fits: items.every((item) => item.left >= rect.left && item.right <= rect.right + 1),
              separated: items.every(
                (item, index) => index === 0 || item.left >= items[index - 1]!.right
              ),
              scrollWidth: element.scrollWidth,
              clientWidth: element.clientWidth
            };
          });
          expect(layout.fits).toBe(true);
          expect(layout.separated).toBe(true);
          expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
          await expect(toolbar.locator('.composer-stop-button')).toHaveCount(running ? 1 : 0);
          await expect(toolbar.locator('.composer-send-button')).toHaveCount(
            running && compact ? 0 : 1
          );
          for (const button of await toolbar
            .locator('.composer-send-button, .composer-stop-button')
            .all()) {
            await expect(button).toBeEnabled();
            expect((await button.boundingBox())!.width).toBe(24);
          }
          if (compact && width === 760)
            await toolbar.screenshot({
              path: info.outputPath(`keyboard-hint-${locale}-${running ? 'running' : 'idle'}.png`)
            });
        }
      }
    });
  }

  test(`Composer keeps mobile hints hidden and submission feedback visible (${locale})`, async ({
    page
  }) => {
    await page.setViewportSize({ width: 1280, height: 844 });
    await page.goto(`${fixture.url}composer-options.html?short&submitting&locale=${locale}`);
    const toolbar = page.locator('.composer-toolbar');
    for (const width of [840, 681, 680, 560]) {
      await toolbar.evaluate((element, width) => {
        element.style.boxSizing = 'content-box';
        element.style.width = `${width}px`;
      }, width);
      await expect(toolbar.locator('.composer-keyboard-hint')).toBeHidden();
      await expect(toolbar.locator('.composer-submitting')).toBeVisible();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
      `${fixture.url}composer-options.html?short&compact-names&mobile&running&empty&locale=${locale}`
    );
    await expect(toolbar.locator('.composer-keyboard-hint')).toHaveCount(0);
    await expect(toolbar.locator('.composer-stop-button')).toBeEnabled();
    await expect(toolbar.locator('.composer-send-button')).toHaveCount(0);
  });
}

for (const width of [1280, 390]) {
  for (const theme of ['daylight', 'vscode-dark-2026']) {
    test(`Composer action buttons keep balanced vertical space (${width}, ${theme})`, async ({
      page
    }, info) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(
        `${fixture.url}composer-options.html?short&running&theme=${theme}${width < 768 ? '&mobile' : ''}`
      );
      const toolbar = page.locator('.composer-toolbar');
      await expect(toolbar).toBeVisible();
      const padding = await toolbar.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          top: parseFloat(style.paddingTop),
          bottom: parseFloat(style.paddingBottom),
          rootFont: parseFloat(getComputedStyle(document.documentElement).fontSize)
        };
      });
      const expectedPadding = width >= 768 ? 4 : padding.rootFont * 0.18;
      expect(padding.top).toBeCloseTo(expectedPadding, 1);
      expect(padding.bottom).toBeCloseTo(expectedPadding, 1);
      const toolbarBounds = (await toolbar.boundingBox())!;
      for (const selector of ['.composer-send-button', '.composer-stop-button']) {
        const button = toolbar.locator(selector);
        await expect(button).toBeEnabled();
        const bounds = (await button.boundingBox())!;
        expect(bounds.width).toBe(width >= 768 ? 24 : 28);
        expect(bounds.height).toBe(width >= 768 ? 24 : 28);
        if (width >= 768) {
          expect(bounds.y - toolbarBounds.y).toBeGreaterThanOrEqual(4);
          expect(
            toolbarBounds.y + toolbarBounds.height - bounds.y - bounds.height
          ).toBeGreaterThanOrEqual(4);
        }
      }
      await toolbar.screenshot({ path: info.outputPath('composer-action-spacing.png') });
    });
  }
}

for (const theme of ['daylight', 'vscode-dark-2026']) {
  test(`Composer send uses conversation activity blue while feedback stays neutral in ${theme}`, async ({
    page
  }, info) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const url = `${fixture.url}composer-options.html?short&compact-names&theme=${theme}${width < 768 ? '&mobile' : ''}`;
      await page.goto(`${url}&running`);
      const toolbar = page.locator('.composer-toolbar');
      const send = toolbar.locator('.composer-send-button');
      const stop = toolbar.locator('.composer-stop-button');
      const context = toolbar.getByRole('button', { name: '42% used' }).locator('i');
      await expect(send).toBeEnabled();
      const tokens = await page.locator('html').evaluate((root) => {
        const style = getComputedStyle(root);
        return Object.fromEntries(
          [
            'bg-panel',
            'conversation-activity-fg',
            'fill-soft',
            'text-disabled',
            'text-secondary',
            'control-color-danger'
          ].map((token) => [token, style.getPropertyValue(`--mar-${token}`).trim()])
        );
      });
      await toolbar.screenshot({ path: info.outputPath(`composer-${theme}-${width}.png`) });
      const color = (locator: Locator, property: 'color' | 'backgroundColor' | 'borderTopColor') =>
        locator
          .evaluate((element, property) => getComputedStyle(element)[property], property)
          .then(resolvedColorToHex);
      const expectSendColors = async (fill: string) => {
        const expected = await send.evaluate((element, cssColor) => {
          const probe = document.createElement('span');
          probe.style.backgroundColor = cssColor;
          probe.style.color = CSS.supports('color: contrast-color(red)')
            ? `contrast-color(${cssColor})`
            : 'var(--mar-bg-panel)';
          element.append(probe);
          const { backgroundColor, color } = getComputedStyle(probe);
          probe.remove();
          return { backgroundColor, color };
        }, fill);
        await expect
          .poll(() => color(send, 'backgroundColor'))
          .toBe(resolvedColorToHex(expected.backgroundColor));
        await expect
          .poll(() => color(send, 'borderTopColor'))
          .toBe(resolvedColorToHex(expected.backgroundColor));
        await expect.poll(() => color(send, 'color')).toBe(resolvedColorToHex(expected.color));
      };
      await expectSendColors(tokens['conversation-activity-fg']!);
      const customActivityColor = theme === 'daylight' ? '#1565c0' : '#8ac7ff';
      await page.locator('html').evaluate((root, activity) => {
        root.style.setProperty('--mar-conversation-activity-fg', activity);
      }, customActivityColor);
      await expectSendColors(customActivityColor);
      await expect.poll(() => color(stop, 'color')).toBe(tokens['control-color-danger']);
      await expect.poll(() => color(stop, 'borderTopColor')).toBe(tokens['control-color-danger']);
      await expect.poll(() => color(stop, 'backgroundColor')).toBe(tokens['bg-panel']);
      const ring = await context.evaluate((element) => {
        const stop = getComputedStyle(element).backgroundImage.match(/rgb\([^)]+\)(?= 42%)/u);
        return stop?.[0] ?? '';
      });
      expect(resolvedColorToHex(ring)).toBe(tokens['text-secondary']);
      if (width >= 768) {
        await send.hover();
        await expectSendColors(
          `color-mix(in srgb, ${customActivityColor} 92%, var(--mar-text-primary))`
        );
        await page.mouse.down();
        try {
          await expectSendColors(
            `color-mix(in srgb, ${customActivityColor} 84%, var(--mar-text-primary))`
          );
        } finally {
          await page.mouse.move(0, 0);
          await page.mouse.up();
        }
      }
      await page.goto(`${url}&empty`);
      await expect(send).toBeDisabled();
      await expect.poll(() => color(send, 'backgroundColor')).toBe(tokens['fill-soft']);
      await expect.poll(() => color(send, 'color')).toBe(tokens['text-disabled']);
      await page.goto(`${url}&submitting`);
      await page
        .locator('html')
        .evaluate((root) => root.style.setProperty('--mar-conversation-activity-fg', '#ff00ff'));
      await expect(send).toBeDisabled();
      await expect(send).toHaveAttribute('aria-busy', 'true');
      await expect.poll(() => color(send, 'backgroundColor')).toBe(tokens['fill-soft']);
      await expect
        .poll(() => color(send.locator('[data-mar-icon="loading-action"]'), 'color'))
        .toBe(tokens['text-secondary']);
    }
  });
}

for (const [width, height, theme, top] of [
  [1280, 844, 'daylight', false],
  [390, 844, 'vscode-dark-2026', false],
  [320, 360, 'daylight', true]
] as const) {
  test(`Composer menus fill their columns and keep local scrolling (${width}x${height}, ${theme})`, async ({
    page
  }, info) => {
    await page.setViewportSize({ width, height });
    await page.goto(
      `${fixture.url}composer-options.html?theme=${theme}${width < 768 ? '&mobile' : ''}${top ? '&top' : ''}`
    );
    for (const kind of ['runner', 'access', 'model-effort']) {
      await page.locator(`.composer-${kind}-select`).click();
      const menu = page.locator(`[role="listbox"].composer-${kind}-popper:visible`);
      await expectMenuInsideViewport(menu);
      const menuBounds = (await menu.boundingBox())!;
      const edges = await menu.evaluate((element) => {
        const style = getComputedStyle(element);
        return [parseFloat(style.borderLeftWidth), parseFloat(style.borderRightWidth)] as const;
      });
      if (kind === 'model-effort') {
        const modelGroup = menu.getByRole('group', { name: 'Model' });
        const effortGroup = menu.getByRole('group', { name: 'Reasoning' });
        const modelBounds = (await modelGroup.boundingBox())!;
        const effortBounds = (await effortGroup.boundingBox())!;
        expect(modelBounds.x - menuBounds.x).toBeCloseTo(edges[0], 0);
        expect(menuBounds.x + menuBounds.width - effortBounds.x - effortBounds.width).toBeCloseTo(
          edges[1],
          0
        );
        expect(modelBounds.x + modelBounds.width).toBeLessThanOrEqual(effortBounds.x + 1);
        expect(Math.abs(modelBounds.y - effortBounds.y)).toBeLessThan(1);
        if (height > 400) expect((await menu.boundingBox())!.height).toBeGreaterThan(400);
        const scroll = modelGroup.locator('.mar-ui-scrollbar');
        for (const group of [modelGroup, effortGroup]) {
          const insets = await group
            .getByRole('option')
            .first()
            .evaluate((option) => {
              const list = option.parentElement!;
              const listRect = list.getBoundingClientRect();
              const row = option.getBoundingClientRect();
              return [
                row.left - listRect.left,
                listRect.left + list.clientWidth - row.right
              ] as const;
            });
          expect(insets[0]).toBeCloseTo(0, 0);
          expect(Math.abs(insets[1])).toBeLessThan(1); // clientWidth is rounded to whole pixels.
        }
        expect(
          await scroll.evaluate((element) => element.scrollHeight > element.clientHeight)
        ).toBe(true);
        await expect(scroll).toHaveCSS('overflow-y', 'auto');
        expect(
          await scroll.evaluate((element) => {
            element.scrollTop = 16;
            return element.scrollTop;
          })
        ).toBeGreaterThan(0);
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
        ).toHaveClass(/mar-ui-option--active/);
        await page.keyboard.press('ArrowUp');
        await expect(last).toHaveClass(/mar-ui-option--active/);
        await expect(last).toBeInViewport();
        await page.keyboard.press('ArrowRight');
        await expect(menu.getByRole('option', { name: 'medium', exact: true })).toHaveClass(
          /mar-ui-option--active/
        );
        await page.keyboard.press('ArrowLeft');
        await expect(last).toHaveClass(/mar-ui-option--active/);
        await page.keyboard.press('Tab');
        await expect(menu.getByRole('option', { name: 'medium', exact: true })).toBeInViewport();
        await page.keyboard.press('Tab');
        await expect(last).toBeInViewport();
        await page.keyboard.press('Home');
        await expect(modelGroup.getByRole('option').first()).toHaveClass(/mar-ui-option--active/);
        await page.keyboard.press('End');
        await expect(last).toHaveClass(/mar-ui-option--active/);
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();
        expect(
          await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)
        ).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true
        );
      } else {
        const option = (await menu.getByRole('option').first().boundingBox())!;
        expect(option.x - menuBounds.x).toBeCloseTo(edges[0], 0);
        expect(menuBounds.x + menuBounds.width - option.x - option.width).toBeCloseTo(edges[1], 0);
        if (kind === 'access') {
          const field = page.locator('.composer-access-select .mar-ui-select__field');
          expect(menuBounds.width).toBeGreaterThan((await field.boundingBox())!.width);
          const fullAccess = menu.getByText('Full access', { exact: true });
          expect(await fullAccess.evaluate((label) => label.scrollWidth <= label.clientWidth)).toBe(
            true
          );
        }
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
    const menu = page.locator('[role="listbox"].composer-model-effort-popper:visible');
    await expectMenuInsideViewport(menu);
    const surface = menu;
    await expect(surface).toHaveCSS('border-top-width', '1px');
    await expect(surface).toHaveCSS(
      'border-top-color',
      theme === 'daylight' ? 'rgb(201, 201, 201)' : 'rgb(71, 71, 71)'
    );
    await expect(surface).toHaveCSS('box-shadow', /0px 4px 12px/u);
    const models = menu.getByRole('group', { name: 'Model' });
    const sizes = await models.evaluate((element) => {
      const options = Array.from(element.querySelectorAll('[role="option"]'));
      const contentWidths = options.map((option) => {
        const label = option.querySelector('.mar-ui-option__content')!;
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
    const menu = page.locator('[role="listbox"].composer-model-effort-popper:visible');
    await expectMenuInsideViewport(menu);
    await expect(menu.getByRole('group')).toHaveCount(1);
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
    const menu = page.locator('[role="listbox"].composer-model-effort-popper:visible');
    const models = menu.getByRole('group', { name: 'Model' });
    await expect(models.getByRole('option').first()).toHaveText(
      'Engineering model 32 with a descriptive configuration name'
    );
    await page.keyboard.press('ArrowRight');
    await expect(menu.getByRole('option', { name: 'medium', exact: true })).toHaveClass(
      /mar-ui-option--active/
    );
    await page.keyboard.press('ArrowLeft');
    await expect(models.getByRole('option').last()).toHaveClass(/mar-ui-option--active/);
    await page.keyboard.press('Home');
    await expect(models.getByRole('option').first()).toHaveClass(/mar-ui-option--active/);
    await page.keyboard.press('End');
    await expect(models.getByRole('option').last()).toHaveClass(/mar-ui-option--active/);
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
    const menu = page.locator('[role="listbox"].composer-model-effort-popper:visible');
    await expectMenuInsideViewport(menu);
    expect((await menu.boundingBox())!.height).toBeLessThan(250);
    const columns = menu.getByRole('group').locator('.mar-ui-scrollbar');
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
