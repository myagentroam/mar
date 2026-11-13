import { expect, test, type Locator, type Page } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';
import type { WorkspaceQueueItem } from '../../packages/web-core/src/model/workbench.js';

type UtilityQueue = {
  items: () => WorkspaceQueueItem[];
  replace: (items: WorkspaceQueueItem[]) => void;
};

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
      '--mar-fill-row-hover': '#25334280',
      '--mar-fill-selection': '#35475a'
    }))
      element.style.setProperty(token, value);
  });
  return palette(page);
}

async function checkUtility(
  page: Page,
  control: Locator,
  colors: Awaited<ReturnType<typeof palette>>,
  inline = false
) {
  await control.hover();
  await expect(control).toHaveCSS('color', colors.primary);
  await expect(control).toHaveCSS('background-color', inline ? 'rgba(0, 0, 0, 0)' : colors.hover);
  if (!inline) await expect(control).toHaveCSS('border-radius', '6px');
  await expect(control).toHaveCSS('transform', 'none');
  await control.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(control).toBeFocused();
  await expect(control).toHaveCSS('outline-style', 'solid');
  await expect(control).toHaveCSS('outline-width', '2px');
  await expect(control).toHaveCSS('outline-color', colors.focus);
  await expect(control).toHaveCSS('background-color', inline ? 'rgba(0, 0, 0, 0)' : colors.hover);
}

for (const width of [1280, 390]) {
  test(`New queue items scroll only the pending work list to the end at ${width}px`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${fixture.url}visual-alignment.html?utility-interaction&queue-count=8`);
    const list = page.locator('.composer-work-list');
    const rows = list.locator('.queue-item');
    await expect(rows).toHaveCount(8);
    await page.evaluate(() => document.fonts.ready);
    expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true
    );
    const focused = page.getByTestId('native');
    await focused.focus();
    const outerScroll = await page.evaluate(() => window.scrollY);
    const initial = await page.evaluate(() =>
      (window as unknown as { utilityQueue: UtilityQueue }).utilityQueue.items()
    );
    const replace = (items: WorkspaceQueueItem[]) =>
      page.evaluate(
        (snapshot) =>
          (window as unknown as { utilityQueue: UtilityQueue }).utilityQueue.replace(snapshot),
        items
      );
    const newest = {
      ...initial[0]!,
      queueItemId: 'new-queue-item',
      clientMessageId: 'new-client-message',
      content: 'New pending message'
    };
    await list.evaluate((element) => (element.scrollTop = 0));
    await replace([...initial, newest]);
    await expect(rows).toHaveCount(9);
    await expect(rows.last()).toHaveAttribute('data-queue-item-id', newest.queueItemId);
    await expect
      .poll(() =>
        list.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)
      )
      .toBeLessThanOrEqual(1);
    await expect(focused).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(outerScroll);

    await list.evaluate((element) => (element.scrollTop = 0));
    await replace([...initial.slice(1), newest, { ...newest, queueItemId: 'next-queue-item' }]);
    await expect(rows.last()).toHaveAttribute('data-queue-item-id', 'next-queue-item');
    await expect
      .poll(() =>
        list.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)
      )
      .toBeLessThanOrEqual(1);
    await expect(focused).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(outerScroll);
  });

  test(`Goal stays above the scrolling queue and input tags follow attachments at ${width}px`, async ({
    browser
  }, testInfo) => {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      isMobile: width < 768,
      hasTouch: width < 768
    });
    try {
      const page = await context.newPage();
      for (const theme of ['vscode-dark-2026', 'daylight']) {
        await page.goto(
          `${fixture.url}visual-alignment.html?utility-interaction&composer-layout&work-item-editing&queue-count=8&theme=${theme}`
        );
        const composer = page.locator('.composer-shell');
        const queue = composer.locator('.composer-queue');
        const goal = queue.locator('.goal-card');
        const list = queue.locator('.composer-work-list');
        if (width < 768)
          await expect
            .poll(() => page.locator('.composer-host').evaluate((element) => element.style.height))
            .not.toBe('');
        await expect(list.locator('.queue-item')).toHaveCount(8);
        await expect(list.locator('.goal-card')).toHaveCount(0);
        await expect(queue.locator('.composer-queue-heading')).toHaveCount(0);
        await expect(goal).toHaveCSS('border-top-width', '0px');
        await expect(goal).toHaveCSS('border-bottom-width', '0px');
        await expect(list).toHaveCSS('border-top-width', '0px');
        await expect(list.locator('ol')).toHaveCSS('border-top-width', '0px');
        await expect(list.locator('.queue-item').first()).toHaveCSS('border-top-width', '1px');
        await page.evaluate(() => document.fonts.ready);
        await composer.scrollIntoViewIfNeeded();
        const before = (await goal.boundingBox())!;
        await list.evaluate((element) => (element.scrollTop = element.scrollHeight));
        await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        expect((await goal.boundingBox())!.y).toBeCloseTo(before.y, 2);
        expect((await goal.boundingBox())!.height).toBeCloseTo(before.height, 2);
        const boundaries = await composer.evaluate((element) =>
          ['.composer-queue', '.composer-attachments', '.composer-command-states', 'textarea'].map(
            (selector) => {
              const rect = element.querySelector(selector)!.getBoundingClientRect();
              return { top: rect.top, bottom: rect.bottom };
            }
          )
        );
        for (let index = 1; index < boundaries.length; index++)
          expect(boundaries[index]!.top).toBeGreaterThanOrEqual(boundaries[index - 1]!.bottom);
        const input = composer.locator('textarea');
        await input.fill('Keep this draft');
        const goalBeforeAppend = (await goal.boundingBox())!;
        await page.evaluate(() => {
          const queue = (window as unknown as { utilityQueue: UtilityQueue }).utilityQueue;
          const items = queue.items();
          queue.replace([
            ...items,
            { ...items[0]!, queueItemId: 'latest-item', content: 'Latest queued message' }
          ]);
        });
        await expect(list.locator('.queue-item')).toHaveCount(9);
        await expect
          .poll(() =>
            list.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop
            )
          )
          .toBeLessThanOrEqual(1);
        expect((await goal.boundingBox())!.y).toBeCloseTo(goalBeforeAppend.y, 2);
        await expect(input).toBeFocused();
        await page.locator('.composer').screenshot({
          path: testInfo.outputPath(`composer-work-layout-${theme}-${width}.png`)
        });
        await composer.locator('.composer-skill-state').click();
        await expect(composer.locator('.composer-skill-state')).toHaveCount(0);
        await expect(input).toHaveValue('Keep this draft');
        await expect(goal.locator('.goal-objective')).toHaveText('Review the pending goal');
        await expect(list.locator('.queue-item')).toHaveCount(9);
        await goal.getByRole('button', { name: 'Edit', exact: true }).click();
        await expect(goal.locator('textarea')).toBeVisible();
        await expect(goal.getByRole('button', { name: 'Update', exact: true })).toBeVisible();
        if (width < 768)
          await expect
            .poll(() =>
              page
                .locator('.composer-host')
                .evaluate((element) =>
                  Math.abs(
                    parseFloat(element.style.height) -
                      element.querySelector('.composer')!.getBoundingClientRect().height
                  )
                )
            )
            .toBeLessThan(1);
        await expect(list.locator('.queue-item').last()).toBeInViewport();
        await goal.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(goal.locator('.goal-objective')).toBeVisible();
        await input.focus();
        const firstQueueItem = await page.evaluate(
          () => (window as unknown as { utilityQueue: UtilityQueue }).utilityQueue.items()[0]!
        );
        await page.evaluate(() => {
          const queue = (window as unknown as { utilityQueue: UtilityQueue }).utilityQueue;
          queue.replace([]);
        });
        await expect(list).toHaveCount(0);
        await expect(goal.locator('.goal-objective')).toBeVisible();
        await page.evaluate((item) => {
          const queue = (window as unknown as { utilityQueue: UtilityQueue }).utilityQueue;
          queue.replace([
            {
              ...item,
              queueItemId: 'first-queue-item',
              clientMessageId: 'first-client-message',
              content: 'First queued message'
            }
          ]);
        }, firstQueueItem);
        await expect(list.locator('.queue-item')).toHaveCount(1);
        await expect(input).toBeFocused();
        await expect(input).toHaveValue('Keep this draft');
      }
    } finally {
      await context.close();
    }
  });

  test(`Pending work stays compact and scrolls without shrinking rows at ${width}px`, async ({
    browser
  }, testInfo) => {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      isMobile: width < 768,
      hasTouch: width < 768
    });
    try {
      const page = await context.newPage();
      for (const theme of ['vscode-dark-2026', 'daylight']) {
        for (const count of [3, 8]) {
          await page.goto(
            `${fixture.url}visual-alignment.html?utility-interaction&queue-count=${count}&theme=${theme}`
          );
          const queue = page.locator('.composer-queue');
          const rows = queue.locator('.queue-item');
          await expect(rows).toHaveCount(count);
          await page.evaluate(() => document.fonts.ready);
          const layout = await queue.evaluate((element) => {
            const body = element.querySelector('.work-item-content')!;
            const list = element.querySelector('.composer-work-list')!;
            return {
              height: element.getBoundingClientRect().height,
              maxHeight: Number.parseFloat(getComputedStyle(element).maxHeight),
              bodyFont: getComputedStyle(body).fontSize,
              minRowHeight: Number.parseFloat(
                getComputedStyle(element.querySelector('.queue-item')!).minHeight
              ),
              rowHeights: Array.from(
                element.querySelectorAll('.queue-item'),
                (row) => row.getBoundingClientRect().height
              ),
              scrolls: list.scrollHeight > list.clientHeight
            };
          });
          await expect(queue.locator('.composer-queue-heading')).toHaveCount(0);
          await expect(queue.locator('ol')).toHaveCSS('border-top-width', '0px');
          expect(layout.bodyFont).toBe(width < 768 ? '11px' : '12px');
          const maximumHeight = width < 768 ? 120 : 148;
          const precision = 1 / 64;
          expect(layout.minRowHeight).toBe(28);
          expect(layout.maxHeight).toBe(maximumHeight);
          expect(layout.rowHeights).toHaveLength(count);
          for (const rowHeight of layout.rowHeights)
            expect(Math.abs(rowHeight - 28)).toBeLessThanOrEqual(precision);
          const kindLines = await rows.locator('.work-item-kind').evaluateAll((elements) =>
            elements.map((element) => {
              const range = document.createRange();
              range.selectNodeContents(element);
              return [...range.getClientRects()].filter((rect) => rect.width > 0).length;
            })
          );
          expect(kindLines).toEqual(Array(count).fill(1));
          expect(Math.abs(layout.height - (count === 3 ? 89 : maximumHeight))).toBeLessThanOrEqual(
            precision
          );
          expect(layout.scrolls).toBe(count === 8);
          await queue.screenshot({
            path: testInfo.outputPath(`pending-work-${theme}-${width}-${count}.png`)
          });
          if (count === 8) {
            const list = queue.locator('.composer-work-list');
            await list.evaluate((element) => (element.scrollTop = element.scrollHeight));
            await expect
              .poll(() => list.evaluate((element) => element.scrollTop))
              .toBeGreaterThan(0);
            const last = rows.last();
            const rowHeightBeforeEdit = (await last.boundingBox())!.height;
            await last.getByRole('button', { name: 'Edit', exact: true }).click();
            await expect(last.locator('textarea')).toBeVisible();
            await last.locator('textarea').fill('Updated last queued message');
            await last.getByRole('button', { name: 'Save', exact: true }).click();
            await expect(last.locator('.work-item-content')).toHaveText(
              'Updated last queued message'
            );
            expect((await last.boundingBox())!.height).toBeCloseTo(rowHeightBeforeEdit, 2);
          }
        }
      }
    } finally {
      await context.close();
    }
  });

  test(`Queue text keeps glyphs clear of clipped edges without increasing row height at ${width}px`, async ({
    browser
  }, testInfo) => {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      isMobile: width < 768,
      hasTouch: width < 768
    });
    try {
      const page = await context.newPage();
      await page.goto(`${fixture.url}visual-alignment.html?utility-interaction`);
      await page.evaluate(() => document.fonts.ready);
      const row = page.locator('.queue-item');
      const originalHeight = (await row.boundingBox())!.height;
      const actions = row.locator('.queue-item-actions');
      await actions.getByRole('button', { name: 'Edit', exact: true }).click();
      const text = 'g j p q y · review fix loop again, 有问题额外review一轮 commit';
      await row.locator('textarea').fill(text);
      await actions.getByRole('button', { name: 'Save', exact: true }).click();
      const paragraph = row.locator('.queue-item-content > p');
      await expect(paragraph).toHaveText(text);
      const layout = await paragraph.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const text = range.getBoundingClientRect();
        const paragraph = element.getBoundingClientRect();
        const content = element.parentElement!.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          top: text.top - Math.max(paragraph.top, content.top),
          bottom: Math.min(paragraph.bottom, content.bottom) - text.bottom,
          fontSize: Number.parseFloat(style.fontSize),
          lineHeight: Number.parseFloat(style.lineHeight)
        };
      });
      await testInfo.attach('queue-text-layout', {
        body: JSON.stringify(layout),
        contentType: 'application/json'
      });
      await page.mouse.move(0, 0);
      await row.screenshot({ path: testInfo.outputPath(`queue-descenders-${width}.png`) });
      // Range bounds are line boxes, not painted ink; allow only subpixel rounding at the clip edge.
      expect(layout.lineHeight).toBeCloseTo(layout.fontSize * 1.5, 2);
      expect(layout.top).toBeGreaterThanOrEqual(-0.5);
      expect(layout.bottom).toBeGreaterThanOrEqual(-0.5);
      expect((await row.boundingBox())!.height).toBeCloseTo(originalHeight, 1);
      await expect(paragraph).toHaveCSS('white-space', 'nowrap');
      await expect(paragraph).toHaveCSS('text-overflow', 'ellipsis');
      expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth)).toBe(true);
    } finally {
      await context.close();
    }
  });

  test(`Queue drag label stays compact without crowding content at ${width}px`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${fixture.url}visual-alignment.html?utility-interaction`);
    const row = page.locator('.queue-item');
    await expect(row).toBeVisible();
    const drag = row.locator('.queue-drag');
    if (width < 768) await expect(drag).toBeHidden();
    else await expect(drag).toBeVisible();
    const layout = await row.evaluate((element) => {
      const drag = element.querySelector('.queue-drag')!.getBoundingClientRect();
      const label = element.querySelector('.work-item-kind')!.getBoundingClientRect();
      const content = element.querySelector('.queue-item-content')!.getBoundingClientRect();
      const actions = element.querySelector('.queue-item-actions')!.getBoundingClientRect();
      return {
        dragWidth: drag.width,
        dragGap: label.left - drag.right,
        contentGap: content.left - label.right,
        actionGap: actions.left - content.right,
        right: element.getBoundingClientRect().right,
        actionsRight: actions.right
      };
    });
    if (width >= 768) {
      expect(layout.dragWidth).toBe(12);
      expect(layout.dragGap).toBeCloseTo(4, 0);
    }
    expect(layout.contentGap).toBeCloseTo(width < 768 ? 6 : 8, 0);
    expect(layout.actionGap).toBeCloseTo(width < 768 ? 6 : 8, 0);
    expect(layout.actionsRight).toBeLessThanOrEqual(layout.right);
  });

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
      await queueInput.focus();
      await page.keyboard.press('Tab');
      await expect(
        queue.locator('.queue-item-actions').getByRole('button', { name: 'Save' })
      ).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(queueInput).toBeFocused();
      await queueInput.press('Escape');
      await expect(queueInput).toHaveCount(0);
      await expect(queueEdit).not.toBeFocused();
      await expect(queue.locator('.queue-item-content > p')).toHaveText(
        'Review the pending change'
      );
      await expect(goalInput).toHaveValue('Unsaved goal draft');
      await queueEdit.click();
      await expect(queueInput).toHaveValue('Review the pending change');
      await goalInput.focus();
      await page.keyboard.press('Tab');
      await expect(
        queue.locator('.goal-editor-actions').getByRole('button', { name: 'Cancel' })
      ).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(goalInput).toBeFocused();
      await goalInput.press('Escape');
      await expect(goalInput).toHaveCount(0);
      await expect(goalEdit).not.toBeFocused();
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
      await expect(goalEdit).not.toBeFocused();
      await queue.locator('.queue-item-actions').getByRole('button', { name: 'Save' }).focus();
      await page.keyboard.press('Escape');
      await expect(queueInput).toHaveCount(0);
      await expect(queueEdit).not.toBeFocused();
      await expect(page.locator('body')).toHaveAttribute('data-outer-escape', '0');
      await queueEdit.click();
      await queueInput.fill('Saved through Enter');
      await queueInput.press('Enter');
      await expect(queueInput).toHaveCount(0);
      await expect(queue.locator('.queue-item-content > p')).toHaveText('Saved through Enter');
      await queueEdit.click();
      await queueInput.fill('Execute this edit');
      await queueInput.press('Control+Enter');
      await expect(page.getByTestId('events')).toContainText('execute');
      await expect(queueInput).toHaveValue('Execute this edit');
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
        const kind = queue.locator('.goal-kind');
        for (const custom of [false, true]) {
          if (custom) {
            await queue.evaluate((element) => {
              (element as HTMLElement).style.setProperty('--mar-font-size-meta', '14px');
              (element as HTMLElement).style.setProperty('--mar-font-size-input', '18px');
            });
          }
          const colors = custom ? await customPalette(page) : await palette(page);
          await expect(kind).toHaveCSS('color', colors.tertiary);
          await expect(kind).toHaveCSS('font-weight', '400');
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
      await expect(header.locator('.mar-session-activity')).toHaveCount(0);
      await expect(header).not.toHaveAttribute('activity');
      await expect(header).not.toHaveAttribute('activity-label');
      const performanceInfo = page.getByTestId('performance-icon');
      await expect(performanceInfo).toHaveCSS('width', width >= 768 ? '24px' : '28px');
      await expect(performanceInfo).toHaveCSS('height', width >= 768 ? '24px' : '28px');
      const controls: [Locator, boolean][] = [
        [page.getByTestId('native'), false],
        [page.getByTestId('element'), true],
        [page.getByTestId('element-icon'), false],
        [page.getByTestId('performance-icon'), false],
        [page.locator('.session-search-button'), false],
        [page.locator('.workspace-more-button'), false],
        [page.locator('.conversation-session-id button'), true],
        ...(await page.locator('.queue-item-actions').getByRole('button').all()).map(
          (control): [Locator, boolean] => [control, true]
        )
      ];
      if (width < 768)
        controls.push(
          ...(await page.locator('.mobile-conversation-tools button').all()).map(
            (control): [Locator, boolean] => [control, true]
          )
        );
      for (const custom of [false, true]) {
        const colors = custom ? await customPalette(page) : await palette(page);
        for (const [control, inline] of controls) {
          await page.mouse.move(0, 0);
          await page.getByTestId('disable').focus();
          await expect(control).toHaveCSS('color', colors.secondary);
          await checkUtility(page, control, colors, inline);
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
        page.getByTestId('element-icon'),
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
        await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      }
      const unavailable = page.getByTestId('aria-disabled-icon');
      const normal = await unavailable.evaluate((element) => getComputedStyle(element).color);
      await unavailable.hover();
      await expect(unavailable).toHaveCSS('color', normal);
      await expect(unavailable).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    });
  }

  test(`Attachment removal preserves danger feedback across stylesheet ordering in ${theme}`, async ({
    page
  }) => {
    await page.goto(
      `${fixture.url}icon-system.html?attachment-icons=1&theme=${theme === 'daylight' ? 'light' : 'dark'}`
    );
    const control = page.locator('.composer-attachment-remove');
    const colors = await control.evaluate((element) => {
      const probe = document.createElement('span');
      probe.style.backgroundColor = 'var(--mar-fill-row-hover)';
      probe.style.color = 'var(--mar-color-danger-text)';
      element.append(probe);
      const style = getComputedStyle(probe);
      const colors = { background: style.backgroundColor, danger: style.color };
      probe.remove();
      return colors;
    });
    // Public styles can load after lazy component styles in the application.
    await page.evaluate(() => {
      const style = document.querySelector('style[data-vite-dev-id$="/src/styles.css"]');
      if (!style) throw new Error('Shared action stylesheet is unavailable');
      document.head.append(style);
    });
    await control.hover();
    await expect(control).toHaveCSS('color', colors.danger);
    await expect(control).toHaveCSS('background-color', colors.background);
    await control.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(control).toBeFocused();
    await page.mouse.move(1, 1);
    await expect(control).toHaveCSS('color', colors.danger);
    await expect(control).toHaveCSS('outline-width', '2px');
    await page.keyboard.down('Space');
    await expect(control).toHaveCSS('color', colors.danger);
    await expect(control).toHaveCSS('background-color', colors.background);
    await page.keyboard.up('Space');
    await expect(page.locator('.composer-attachments li')).toHaveCount(0);
  });

  test(`Composer context percentage keeps transparent feedback in ${theme}`, async ({ page }) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(
        `${fixture.url}visual-alignment.html?theme=${theme}${width < 768 ? '&mobile=1' : ''}`
      );
      const control = page.locator('.composer-context-button');
      await expect(control).toHaveText('42%');
      await checkUtility(page, control, await palette(page), true);
      await control.press('Enter');
      await expect(page.getByTestId('compact-count')).toHaveText('1');
      await page.getByRole('button', { name: 'Toggle availability', exact: true }).click();
      await expect(control).toHaveAttribute('aria-disabled', 'true');
      await control.hover();
      await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await control.press('Enter');
      await expect(page.getByTestId('compact-count')).toHaveText('1');
    }
  });

  test(`Native and hosted Composer attachment controls share neutral feedback in ${theme}`, async ({
    page
  }) => {
    for (const [query, selector, width] of [
      ['send-gesture', '.composer-attachment-button', 1280],
      ['hosted-gesture', '.hosted-icon-button', 390]
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${fixture.url}workbench-style.html?${query}&theme=${theme}`);
      const control = page.locator(selector);
      await expect(control).toBeEnabled();
      const colors = await palette(page);
      await control.hover();
      await expect(control).toHaveCSS('background-color', colors.hover);
      await expect(control).toHaveCSS('border-radius', '6px');
      await expect(control).toHaveCSS('color', colors.primary);
      await page.mouse.move(0, 0);
      await page.keyboard.press('Tab');
      await control.focus();
      await expect(control).toHaveCSS('outline-color', colors.focus);
      await expect(control).toHaveCSS('outline-style', 'solid');
      await expect(control).toHaveCSS('background-color', colors.hover);
    }
  });

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
    await expect(control).toHaveCSS('background-color', colors.hover);
  } finally {
    await page.mouse.up();
  }
  await expect(control).toHaveCSS('color', colors.secondary);
});

test.describe('touch utility feedback', () => {
  test.use({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });
  test('touch tap keeps a single original action and clears feedback after leaving', async ({
    page
  }) => {
    await page.goto(`${fixture.url}visual-alignment.html?utility-interaction`);
    const colors = await customPalette(page);
    const control = page.getByTestId('native');
    const supportsTapHighlight = await page.evaluate(() =>
      CSS.supports('-webkit-tap-highlight-color', 'transparent')
    );
    if (supportsTapHighlight)
      await expect(control).toHaveCSS('-webkit-tap-highlight-color', 'rgba(0, 0, 0, 0)');
    // Touch pseudo-class timing belongs to the browser; held :active is covered above.
    await control.tap();
    await expect(page.getByTestId('events')).toHaveText('native');
    await expect(control).toHaveCSS('transform', 'none');
    await page.touchscreen.tap(1, 1);
    await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(control).toHaveCSS('color', colors.secondary);
  });
});
