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

for (const width of [1280, 390]) {
  test(`Queue and Goal editors cancel only their own draft with Escape at ${width}px`, async ({
    browser
  }) => {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      isMobile: width < 768,
      hasTouch: width < 768
    });
    try {
      const page = await context.newPage();
      await page.goto(`${fixture.url}visual-alignment.html?utility-interaction&work-item-editing`);
      await page.evaluate(() => {
        document.body.dataset.outerEscape = '0';
        document.body.addEventListener('keydown', (event) => {
          if (event.key === 'Escape' && !event.isComposing)
            document.body.dataset.outerEscape = String(
              Number(document.body.dataset.outerEscape) + 1
            );
        });
      });
      const queue = page.locator('.composer-queue');
      const queueEdit = queue
        .locator('.queue-item-actions')
        .getByRole('button', { name: 'Edit', exact: true });
      const goalEdit = queue
        .locator('.goal-actions')
        .getByRole('button', { name: 'Edit', exact: true });
      const queueInput = queue.locator('.composer-queue-input textarea');
      const goalInput = queue.locator('.goal-objective-input textarea');
      await queueEdit.click();
      await goalEdit.click();
      await queueInput.fill('Unsaved queue draft');
      await goalInput.fill('Unsaved goal draft');
      for (const input of [queueInput, goalInput]) {
        const prevented = await input.evaluate((element) => {
          const event = new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
            isComposing: true
          });
          element.dispatchEvent(event);
          return event.defaultPrevented;
        });
        expect(prevented).toBe(false);
        await expect(input).toBeVisible();
      }
      await queueInput.press('Escape');
      await expect(queueInput).toHaveCount(0);
      await expect(queueEdit).toBeFocused();
      await expect(queue.locator('.queue-item-content > p')).toHaveText(
        'Review the pending change'
      );
      await expect(goalInput).toHaveValue('Unsaved goal draft');
      await queueEdit.click();
      await expect(queueInput).toHaveValue('Review the pending change');
      await goalInput.press('Escape');
      await expect(goalInput).toHaveCount(0);
      await expect(goalEdit).toBeFocused();
      await expect(queue.locator('.goal-objective')).toHaveText('Review the pending goal');
      await expect(queueInput).toBeVisible();
      await goalEdit.click();
      await expect(goalInput).toHaveValue('Review the pending goal');

      await page.getByTestId('disable').click();
      for (const input of [queueInput, goalInput]) {
        await input.press('Escape');
        await expect(input).toBeVisible();
      }
      await page.getByTestId('disable').click();
      await queue.locator('.goal-editor-actions').getByRole('button', { name: 'Cancel' }).focus();
      await page.keyboard.press('Escape');
      await expect(goalInput).toHaveCount(0);
      await expect(goalEdit).toBeFocused();
      await queue.locator('.queue-item-actions').getByRole('button', { name: 'Save' }).focus();
      await page.keyboard.press('Escape');
      await expect(queueInput).toHaveCount(0);
      await expect(queueEdit).toBeFocused();
      await expect(page.locator('body')).toHaveAttribute('data-outer-escape', '0');
      await queueEdit.click();
      await queueInput.fill('Saved through Enter');
      await queueInput.press('Enter');
      await expect(queueInput).toHaveCount(0);
      await expect(queue.locator('.queue-item-content > p')).toHaveText('Saved through Enter');
    } finally {
      await context.close();
    }
  });
}

for (const theme of ['daylight', 'vscode-dark-2026']) {
  test(`Queue and Goal inline edits keep their display typography in ${theme}`, async ({
    browser
  }, testInfo) => {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        isMobile: width < 768,
        hasTouch: width < 768
      });
      try {
        const page = await context.newPage();
        await page.goto(
          `${fixture.url}visual-alignment.html?utility-interaction&work-item-editing&theme=${theme}`
        );
        const queue = page.locator('.composer-queue');
        const heading = queue.locator('.composer-queue-heading strong');
        for (const custom of [false, true]) {
          if (custom) {
            await queue.evaluate((element) => {
              (element as HTMLElement).style.setProperty('--mar-font-size-meta', '14px');
              (element as HTMLElement).style.setProperty('--mar-font-size-input', '18px');
            });
          }
          const colors = custom ? await customPalette(page) : await palette(page);
          await expect(heading).toHaveCSS('color', colors.secondary);
          await expect(heading).toHaveCSS('font-weight', '500');
          await expect(queue.locator('.queue-item-content > p')).toHaveCSS('color', colors.primary);
          if (!custom)
            await queue.screenshot({ path: testInfo.outputPath(`pending-work-${width}.png`) });
          for (const kind of ['queue', 'goal']) {
            const display = queue.locator(
              kind === 'queue' ? '.queue-item-content > p' : '.goal-objective'
            );
            await expect(display).toBeVisible();
            const typography = await display.evaluate((element) => {
              const style = getComputedStyle(element);
              return { size: style.fontSize, family: style.fontFamily, weight: style.fontWeight };
            });
            const edit = queue.locator(
              kind === 'queue'
                ? '.queue-item-actions > button:first-child'
                : '.goal-actions > button:nth-child(2)'
            );
            await edit.click();
            const input = queue.locator(
              kind === 'queue' ? '.composer-queue-input textarea' : '.goal-objective-input textarea'
            );
            await expect(input).toHaveCSS('font-size', typography.size);
            await expect(input).toHaveCSS('font-family', typography.family);
            await expect(input).toHaveCSS('font-weight', typography.weight);
            await input.fill(`Updated ${kind} content`);
            await queue
              .locator(
                kind === 'queue'
                  ? '.queue-item-actions > button:first-child'
                  : '.goal-editor-actions > button:last-child'
              )
              .click();
            await expect(input).toHaveCount(0);
            await expect(display).toHaveText(`Updated ${kind} content`);
            await expect(display).toHaveCSS('font-size', typography.size);
          }
        }
      } finally {
        await context.close();
      }
    }
  });

  for (const width of [1280, 390]) {
    test(`actual utility controls use neutral feedback in ${theme} at ${width}px`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${fixture.url}visual-alignment.html?utility-interaction&theme=${theme}`);
      await expect(page.locator('.queue-item-actions').getByRole('button')).toHaveCount(3);
      const header = page.locator('.conversation-header');
      await expect(header.locator('.session-activity')).toHaveCount(0);
      await expect(header).not.toHaveAttribute('activity');
      await expect(header).not.toHaveAttribute('activity-label');
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
        await expect(options.first().locator('.candidate-name')).toHaveCSS('color', colors.primary);
        await expect(
          options.first().locator(kind === 'commands' ? '.candidate-description' : 'code')
        ).toHaveCSS('color', colors.tertiary);
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

  test(`completion names stay regular and inactive names recede in ${theme}`, async ({ page }) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const candidates of ['commands', 'skills', 'quick-prompts']) {
        await page.goto(
          `${fixture.url}visual-alignment.html?utility-interaction&theme=${theme}&candidates=${candidates}`
        );
        const colors = await palette(page);
        for (const kind of ['commands', 'files']) {
          const options = page.getByTestId(kind).getByRole('option');
          await expect(options).toHaveCount(2);
          const selectedName = options.first().locator('.candidate-name');
          const inactiveName = options.nth(1).locator('.candidate-name');
          await expect(selectedName).toHaveCSS('font-weight', '400');
          await expect(inactiveName).toHaveCSS('font-weight', '400');
          await expect(selectedName).toHaveCSS('color', colors.primary);
          await expect(inactiveName).toHaveCSS('color', colors.secondary);
          await options.nth(1).hover();
          await expect(inactiveName).toHaveCSS('color', colors.secondary);
          await expect(options.first()).toHaveAttribute('aria-selected', 'true');
          await expect(options.nth(1)).toHaveCSS('background-color', colors.hover);
        }
      }
    }
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
