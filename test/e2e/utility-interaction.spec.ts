import { expect, test, type Locator, type Page } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

async function palette(page: Page) {
  return page.evaluate(() => {
    const probe = document.createElement('span');
    document.body.append(probe);
    const resolve = (token: string) => {
      probe.style.color = `var(${token})`;
      return getComputedStyle(probe).color;
    };
    const colors = {
      primary: resolve('--mar-text-primary'),
      secondary: resolve('--mar-text-secondary'),
      tertiary: resolve('--mar-text-tertiary'),
      faint: resolve('--mar-text-faint'),
      focus: resolve('--mar-color-brand'),
      hover: resolve('--mar-fill-row-hover'),
      selected: resolve('--mar-fill-selection')
    };
    probe.remove();
    return colors;
  });
}

async function customPalette(page: Page) {
  await page.locator('html').evaluate((element) => {
    for (const [token, value] of Object.entries({
      '--mar-text-primary': '#d6dfc9',
      '--mar-text-secondary': '#8295a4',
      '--mar-text-tertiary': '#68788b',
      '--mar-text-faint': '#53616e',
      '--mar-color-brand': '#9672d1',
      '--mar-color-brand-text': '#af79d0',
      '--mar-fill-row-hover': '#253342',
      '--mar-fill-selection': '#35475a'
    }))
      element.style.setProperty(token, value);
  });
  return palette(page);
}

async function checkUtility(
  page: Page,
  control: Locator,
  colors: Awaited<ReturnType<typeof palette>>
) {
  await control.hover();
  await expect(control).toHaveCSS('color', colors.primary);
  await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(control).toHaveCSS('transform', 'none');
  await control.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(control).toBeFocused();
  await expect(control).toHaveCSS('outline-style', 'solid');
  await expect(control).toHaveCSS('outline-width', '2px');
  await expect(control).toHaveCSS('outline-color', colors.focus);
}

for (const theme of ['daylight', 'vscode-dark-2026']) {
  for (const width of [1280, 390]) {
    test(`actual utility controls use neutral feedback in ${theme} at ${width}px`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${fixture.url}visual-alignment.html?utility-interaction&theme=${theme}`);
      await expect(page.locator('.queue-item-actions').getByRole('button')).toHaveCount(3);
      const controls = [
        page.getByTestId('native'),
        page.getByTestId('element'),
        page.locator('.session-search-button'),
        page.locator('.workspace-more-button'),
        page.locator('.conversation-session-id button'),
        ...(await page.locator('.queue-item-actions').getByRole('button').all())
      ];
      if (width < 768)
        controls.push(...(await page.locator('.mobile-conversation-tools button').all()));
      for (const custom of [false, true]) {
        const colors = custom ? await customPalette(page) : await palette(page);
        for (const control of controls) {
          await page.mouse.move(0, 0);
          await page.getByTestId('disable').focus();
          await expect(control).toHaveCSS('color', colors.secondary);
          await checkUtility(page, control, colors);
          for (const code of await control.locator('code').all()) {
            await expect(code).toHaveCSS('color', colors.primary);
            if (width < 768) await expect(control).toHaveCSS('outline-offset', '-2px');
          }
        }
        await expect(page.locator('.conversation-session-id code')).toHaveCSS(
          'color',
          colors.secondary
        );
        if (!custom) {
          await page.getByTestId('disable').scrollIntoViewIfNeeded();
          await page.screenshot({ path: testInfo.outputPath(`utility-${theme}-${width}.png`) });
        }
      }
      await page.getByTestId('disable').focus();
      await page.keyboard.press('Tab');
      await expect(page.getByTestId('native')).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('events')).toHaveText('native');
      await page
        .locator('.queue-item-actions')
        .getByRole('button', { name: 'Edit', exact: true })
        .press('Enter');
      await expect(page.getByTestId('events')).toHaveText('native|edit');
      if (width < 768) {
        await page.locator('.mobile-conversation-tools button').first().press('Enter');
        await expect(page.getByTestId('events')).toHaveText('native|edit|surface:sessions');
      }
      await page.getByTestId('disable').click();
      for (const control of [
        page.getByTestId('native'),
        page.getByTestId('element'),
        page.locator('.session-search-button'),
        page.locator('.workspace-more-button'),
        page.locator('.queue-item-actions .work-item-primary-action')
      ]) {
        await expect(control).toBeDisabled();
        await control.evaluate((el) =>
          Promise.all(el.getAnimations().map((animation) => animation.finished))
        );
        const normal = await control.evaluate((el) => getComputedStyle(el).color);
        await control.hover({ force: true });
        await expect(control).toHaveCSS('color', normal);
      }
    });
  }

  test(`candidate hover preserves selection and text hierarchy in ${theme}`, async ({ page }) => {
    await page.goto(`${fixture.url}visual-alignment.html?utility-interaction&theme=${theme}`);
    for (const custom of [false, true]) {
      const colors = custom ? await customPalette(page) : await palette(page);
      for (const kind of ['commands', 'files']) {
        const options = page.getByTestId(kind).getByRole('option');
        await page.mouse.move(0, 0);
        await expect(options.first()).toHaveCSS('background-color', colors.selected);
        await options.nth(1).hover();
        await expect(options.nth(1)).toHaveCSS('background-color', colors.hover);
        await expect(options.first()).toHaveCSS('background-color', colors.selected);
        await options.first().hover();
        await expect(options.first()).toHaveCSS('background-color', colors.selected);
        await expect(options.first().locator('strong')).toHaveCSS('color', colors.primary);
        await expect(options.first().locator(kind === 'commands' ? 'span' : 'code')).toHaveCSS(
          'color',
          colors.tertiary
        );
        if (kind === 'files')
          await expect(options.first().locator('.entry-kind')).toHaveCSS('color', colors.faint);
      }
    }
    const commands = page.getByTestId('commands').getByRole('option');
    await commands.nth(1).press('Enter');
    await expect(page.getByTestId('events')).toContainText('command:second');
    await page.getByTestId('files').getByRole('option').nth(1).press('Enter');
    await expect(page.getByTestId('events')).toContainText('file:second.ts');
    await expect(page.getByTestId('events')).toContainText('command-active:1');
    await expect(page.getByTestId('events')).toContainText('file-active:1');
  });
}

test('native utility keeps neutral pressed feedback outside hover', async ({ page }) => {
  await page.goto(`${fixture.url}visual-alignment.html?utility-interaction`);
  const colors = await customPalette(page);
  const control = page.getByTestId('native');
  await control.hover();
  await page.mouse.down();
  try {
    await page.mouse.move(0, 0);
    await expect(control).toHaveJSProperty('disabled', false);
    expect(await control.evaluate((el) => el.matches(':active') && !el.matches(':hover'))).toBe(
      true
    );
    await expect(control).toHaveCSS('color', colors.primary);
    await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  } finally {
    await page.mouse.up();
  }
  await expect(control).toHaveCSS('color', colors.secondary);
});

test.describe('touch utility feedback', () => {
  test.use({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });
  test('touch tap keeps transparent feedback and a single original action', async ({ page }) => {
    await page.goto(`${fixture.url}visual-alignment.html?utility-interaction`);
    const colors = await customPalette(page);
    const control = page.getByTestId('native');
    // Touch pseudo-class timing belongs to the browser; held :active is covered above.
    await control.tap();
    await expect(page.getByTestId('events')).toHaveText('native');
    await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(control).toHaveCSS('transform', 'none');
    await page.touchscreen.tap(1, 1);
    await expect(control).toHaveCSS('color', colors.secondary);
  });
});
