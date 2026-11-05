import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/session-*.html');
});
test.afterAll(async () => {
  await fixture?.close();
});

test('session tree active indicator stays static with normal motion preferences', async ({
  page
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(`${fixture.url}session-tree.html?locale=en-US&activity=1`);
  const trigger = page.getByRole('button', { name: 'View session tree' });
  const indicator = trigger.locator('.tree-active-indicator');
  await expect(indicator).toBeVisible();
  await expect(indicator).toHaveCSS('animation-name', 'none');
  expect(await indicator.evaluate((element) => element.getAnimations().length)).toBe(0);

  await page.goto(`${fixture.url}session-tree.html?locale=en-US`);
  await expect(trigger).toBeVisible();
  await expect(indicator).toHaveCount(0);
});

for (const width of [390, 1280]) {
  test(`active indicator slightly overlaps the tree icon at ${width}px`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width, height: 850 });
    for (const theme of ['dark', 'daylight']) {
      await page.goto(`${fixture.url}session-tree.html?locale=en-US&activity=1&theme=${theme}`);
      const trigger = page.getByRole('button', { name: 'View session tree' });
      const indicator = trigger.locator('.tree-active-indicator');
      await expect(indicator).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const geometry = await trigger.evaluate((button) => {
        const svg = button.querySelector('svg')!;
        const artwork = svg.getBBox();
        const corner = new DOMPoint(
          artwork.x + artwork.width,
          artwork.y + artwork.height
        ).matrixTransform(svg.getScreenCTM()!);
        const dot = button.querySelector('.tree-active-indicator')!.getBoundingClientRect();
        return {
          artworkRight: corner.x,
          artworkBottom: corner.y,
          dot: {
            left: dot.left,
            right: dot.right,
            top: dot.top,
            bottom: dot.bottom,
            width: dot.width,
            height: dot.height
          }
        };
      });
      expect(geometry.dot.width).toBe(4);
      expect(geometry.dot.height).toBe(4);
      expect(geometry.dot.left).toBeLessThan(geometry.artworkRight);
      expect(geometry.dot.top).toBeLessThan(geometry.artworkBottom);
      expect(geometry.dot.right).toBeGreaterThan(geometry.artworkRight);
      expect(geometry.dot.bottom).toBeGreaterThan(geometry.artworkBottom);
      await page.locator('.conversation-header').screenshot({
        path: testInfo.outputPath(`tree-badge-${theme}.png`),
        animations: 'disabled'
      });
      const dot = (await indicator.boundingBox())!;
      await page.mouse.click(dot.x + dot.width / 2, dot.y + dot.height / 2);
      await expect(page.getByRole('dialog', { name: 'View session tree' })).toBeVisible();
    }
  });
}

test('tree uses the Watch snapshot order and closes on Escape and outside click', async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.goto(`${fixture.url}session-tree.html?locale=en-US&mixed=1`);
  const trigger = page.getByRole('button', { name: 'View session tree' });
  await trigger.click();
  const tree = page.getByRole('dialog', { name: 'View session tree' });
  await expect(tree).toBeVisible();
  await expect(tree).not.toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('.el-overlay')).toHaveCount(0);
  await expect(page.getByTestId('requests')).toHaveText('1');
  await expect(tree.locator('.session-tree-title')).toHaveText([
    'Running branch',
    'Sleeping branch',
    'Idle branch',
    'Active descendant',
    'Idle leaf',
    'Idle leaf two'
  ]);
  await expect(tree.locator('.session-activity.managed_active')).toHaveCount(2);
  await expect(tree.locator('.session-activity.tree-sleeping')).toHaveCount(1);
  await expect(tree.locator('.session-tree-time')).toHaveText(Array(6).fill('—'));
  await expect(tree.getByRole('button', { name: 'Running branch, Running' })).toBeVisible();
  await expect(tree.getByRole('button', { name: 'Sleeping branch, Sleeping' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tree).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.press('Enter');
  await expect(tree).toBeVisible();
  await expect(page.getByTestId('requests')).toHaveText('1');
  await page.mouse.click(900, 700);
  await expect(tree).toHaveCount(0);
});

for (const width of [390, 1280]) {
  test(`session tree remains visible next to a long session ID at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    await page.goto(`${fixture.url}session-tree.html?locale=en-US&long-id=1`);
    const id = page.locator('.conversation-session-id-copy code');
    const trigger = page.getByRole('button', { name: 'View session tree' });
    await expect(trigger).toBeVisible();
    await expect(id).toHaveCSS('text-overflow', 'ellipsis');
    expect(await id.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    const [idBox, triggerBox, headerBox] = await Promise.all([
      id.boundingBox(),
      trigger.boundingBox(),
      page.locator('.conversation-header').boundingBox()
    ]);
    expect(triggerBox!.x).toBeGreaterThanOrEqual(idBox!.x + idBox!.width);
    expect(triggerBox!.x + triggerBox!.width).toBeLessThanOrEqual(headerBox!.x + headerBox!.width);
    await trigger.click();
    await expect(page.getByRole('dialog', { name: 'View session tree' })).toBeVisible();
  });

  test(`session tree closes cleanly and can reopen at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    await page.goto(`${fixture.url}session-tree.html?locale=en-US`);
    const trigger = page.getByRole('button', { name: 'View session tree' });
    await trigger.click();
    const tree = page.getByRole('dialog', { name: 'View session tree' });
    await expect(tree.locator('.session-tree-node').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(tree).toHaveCount(0);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await trigger.click();
    await expect(tree.locator('.session-tree-node').first()).toBeVisible();
    await expect(page.getByTestId('requests')).toHaveText('1');
  });
}

for (const width of [390, 1280]) {
  for (const action of ['select', 'failure'] as const) {
    test(`${action} closes the non-modal tree safely at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 850 });
      await page.goto(
        `${fixture.url}session-tree.html?locale=en-US${action === 'failure' ? '&failure=1' : ''}`
      );
      const trigger = page.getByRole('button', { name: 'View session tree' });
      await trigger.click();
      const tree = page.getByRole('dialog', { name: 'View session tree' });
      if (action === 'select') {
        await tree.getByRole('button', { name: 'Verify image decoding and cleanup, Idle' }).click();
        await expect(page.getByTestId('selected')).toHaveText('grandchild');
        await expect(page.getByTestId('target')).toHaveText('aside');
      } else {
        await expect(tree.getByRole('status')).toBeVisible();
        await expect(tree.getByRole('status').getByRole('button')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(trigger).toBeFocused();
      }
      await expect(tree).toHaveCount(0);
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    });
  }
}

test('session tree respects reduced motion when opening and closing', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${fixture.url}session-tree.html?locale=en-US`);
  const trigger = page.getByRole('button', { name: 'View session tree' });
  await trigger.click();
  const tree = page.getByRole('dialog', { name: 'View session tree' });
  await expect(tree).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tree).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('standard MessageBox respects reduced motion on desktop and mobile', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 850 });
    await page.goto(`${fixture.url}session-tree.html?locale=en-US&confirmation=1`);
    const durations = await page.getByTestId('show-confirmation').evaluate(async (button) => {
      if (!(button instanceof HTMLElement))
        throw new Error('Confirmation trigger is not an HTML element');
      button.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
      return [dialog, dialog.closest('.el-overlay')!].map((element) => {
        const style = getComputedStyle(element);
        return Math.max(
          Number.parseFloat(style.animationDuration),
          Number.parseFloat(style.transitionDuration)
        );
      });
    });
    expect(durations, `${width}px`).toEqual([0, 0]);
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
});

for (const outcome of ['success', 'failure']) {
  test(`closed popover does not interrupt Watch and shows its late ${outcome} on reopening`, async ({
    page
  }) => {
    await page.goto(`${fixture.url}session-tree.html?locale=en-US&delayed=1`);
    const trigger = page.getByRole('button', { name: 'View session tree' });
    await trigger.click();
    const tree = page.getByRole('dialog', { name: 'View session tree' });
    await expect(tree.locator('.session-tree')).toHaveAttribute('aria-busy', 'true');
    await page.keyboard.press('Escape');
    await expect(tree).toHaveCount(0);
    await page.getByTestId(`${outcome === 'success' ? 'resolve' : 'reject'}-snapshot`).click();
    await trigger.click();
    await expect(page.getByTestId('requests')).toHaveText('1');
    if (outcome === 'success')
      await expect(
        tree.getByRole('button', { name: 'Verify image decoding and cleanup, Idle' })
      ).toBeVisible();
    else await expect(tree.getByRole('status')).toBeVisible();
  });
}

test('failed Watch tree offers retry without closing the popover', async ({ page }) => {
  await page.goto(`${fixture.url}session-tree.html?locale=en-US&failure=1`);
  await page.getByRole('button', { name: 'View session tree' }).click();
  const tree = page.getByRole('dialog', { name: 'View session tree' });
  await expect(tree.getByRole('status')).toBeVisible();
  await tree.getByRole('status').getByRole('button').click();
  await expect(page.getByTestId('requests')).toHaveText('2');
  await expect(
    tree.getByRole('button', { name: 'Verify image decoding and cleanup, Idle' })
  ).toBeVisible();
});

test('keyboard-opened list actions open a non-modal tree without a preceding mouse click', async ({
  page
}) => {
  await page.goto(`${fixture.url}session-groups.html?locale=en-US`);
  const chats = page.locator('.conversation-sidebar');
  await chats.getByRole('tab').nth(1).click();
  await chats.locator('.session-link').focus();
  const trigger = chats.locator('.session-more-button');
  await trigger.focus();
  await trigger.press('ArrowDown');
  const action = page.getByRole('menuitem', { name: 'View session tree', exact: true });
  await expect(action).toBeVisible();
  await action.focus();
  await action.press('Enter');
  const tree = page.getByRole('dialog', { name: 'View session tree' });
  await expect(tree).toBeVisible();
  await expect(tree).not.toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('.el-overlay')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(tree).toHaveCount(0);
  await expect
    .poll(() => chats.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);
  await expect(action).toBeHidden();
  await trigger.focus();
  await trigger.press('ArrowDown');
  await action.focus();
  await action.press('Enter');
  await tree.getByRole('button', { name: 'Child detail, Idle' }).press('Enter');
  await expect(page.getByTestId('opened-tree-session')).toHaveText('child-detail');
});

test('Escape returns keyboard focus from the tree to its title trigger', async ({ page }) => {
  await page.goto(`${fixture.url}session-tree.html?locale=en-US`);
  const trigger = page.getByRole('button', { name: 'View session tree' });
  await trigger.focus();
  await trigger.press('Enter');
  const tree = page.getByRole('dialog', { name: 'View session tree' });
  await tree.getByRole('button', { name: 'Verify image decoding and cleanup, Idle' }).focus();
  await page.keyboard.press('Escape');
  await expect(tree).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('the non-modal popover permits keyboard focus outside and Escape returns to its trigger', async ({
  page
}) => {
  await page.goto(`${fixture.url}session-tree.html?locale=en-US`);
  const trigger = page.getByRole('button', { name: 'View session tree' });
  await trigger.focus();
  await trigger.press('Enter');
  const tree = page.getByRole('dialog', { name: 'View session tree' });
  await expect(tree).toBeVisible();
  await trigger.focus();
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(tree).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

for (const width of [390, 1280]) {
  test(`hover never opens the tree or reads a snapshot at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    await page.goto(`${fixture.url}session-tree.html?locale=en-US`);
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    const trigger = page.getByRole('button', { name: 'View session tree' });
    await trigger.focus();
    await trigger.hover();
    await page.clock.runFor(500);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('requests')).toHaveText('0');
    await expect(trigger).toBeFocused();
  });
}

for (const width of [320, 390]) {
  test(`a deep 100-node snapshot remains scrollable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 600 });
    await page.goto(`${fixture.url}session-tree.html?locale=en-US&long=1`);
    await page.getByRole('button', { name: 'View session tree' }).click();
    const tree = page.locator('.session-tree');
    await expect(tree.locator('.session-tree-node')).toHaveCount(100);
    const body = page.locator('.session-tree-scroll');
    expect(
      await body.evaluate(
        (el) => el.scrollHeight > el.clientHeight && el.scrollWidth >= el.clientWidth
      )
    ).toBe(true);
    const last = tree.getByRole('button', { name: 'Node 99, Idle' });
    await last.scrollIntoViewIfNeeded();
    await body.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    const overflow = await last.evaluate((element) => {
      const scroll = element.closest('.session-tree-scroll')!;
      return {
        titleWidth: element.querySelector('.session-tree-title')!.getBoundingClientRect().width,
        rowWidth: element.getBoundingClientRect().width,
        scrollWidth: scroll.scrollWidth,
        clientWidth: scroll.clientWidth,
        scrollLeft: scroll.scrollLeft
      };
    });
    expect(overflow.titleWidth, JSON.stringify(overflow)).toBeGreaterThan(20);
    await expect(last).toBeVisible();
    await expect(last.locator('.session-tree-status')).toHaveCount(0);
    await expect(last.locator('.session-tree-time')).toHaveText('—');
    await expect(last.locator('.session-tree-time')).not.toHaveAttribute('datetime');
    const action = last.locator('..').locator('.session-tree-actions');
    await last.hover();
    await expect(action).toBeVisible();
    const visible = await last.locator('..').evaluate((element) => {
      const scroll = element.closest('.session-tree-scroll')!.getBoundingClientRect();
      return [
        ...element.querySelectorAll(
          '.session-tree-title, .session-tree-time, .session-tree-actions'
        )
      ].every((part) => {
        const rect = part.getBoundingClientRect();
        return rect.width > 0 && rect.left >= scroll.left - 1 && rect.right <= scroll.right + 1;
      });
    });
    expect(visible).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
  });
}

test.describe('touch interaction', () => {
  test.use({ hasTouch: true });
  test('touch opens the popover and mobile back closes it', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 850 });
    await page.goto(`${fixture.url}session-tree.html?locale=en-US&rootOnly=1`);
    const trigger = page.getByRole('button', { name: 'View session tree' });
    await trigger.tap();
    const tree = page.getByRole('dialog', { name: 'View session tree' });
    await expect(tree).toBeVisible();
    await expect(trigger).toHaveAccessibleName('View session tree');
    await page.goBack();
    await expect(tree).toHaveCount(0);
    await expect(trigger).toHaveAccessibleName('View session tree');
  });
});

for (const width of [390, 1280]) {
  for (const theme of ['dark', 'daylight']) {
    test(`session tree controls at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 850 });
      const locale = theme === 'dark' ? 'en-US' : 'zh-CN';
      await page.goto(`${fixture.url}session-tree.html?theme=${theme}&locale=${locale}&activity=1`);
      const trigger = page.getByRole('button', {
        name: locale === 'en-US' ? 'View session tree' : '查看会话树'
      });
      const treeIcon = trigger.locator('[data-mar-icon="session-tree"]');
      const sessionId = page.locator('.conversation-session-id-copy');
      await expect(
        page
          .locator('.conversation-session-id')
          .getByRole('button', { name: locale === 'en-US' ? 'View session tree' : '查看会话树' })
      ).toBeVisible();
      const [idBox, triggerBox] = await Promise.all([
        sessionId.boundingBox(),
        trigger.boundingBox()
      ]);
      expect(triggerBox!.x).toBeGreaterThanOrEqual(idBox!.x + idBox!.width);
      expect(
        Math.abs(triggerBox!.y + triggerBox!.height / 2 - (idBox!.y + idBox!.height / 2))
      ).toBeLessThan(1);
      await expect(treeIcon).toBeVisible();
      await expect(trigger.locator('svg')).toHaveCount(1);
      await expect(treeIcon).toHaveAttribute('aria-hidden', 'true');
      await expect(treeIcon).toHaveCSS('animation-name', 'none');
      await expect(treeIcon).toHaveCSS(
        'stroke',
        await trigger.evaluate((el) => getComputedStyle(el).color)
      );
      await page
        .locator('.conversation-header')
        .screenshot({ path: testInfo.outputPath(`session-header-${width}-${theme}.png`) });
      await trigger.screenshot({ path: testInfo.outputPath(`tree-trigger-${width}-${theme}.png`) });
      await expect(trigger).toHaveCSS('border-top-width', '0px');
      await trigger.hover();
      await expect(trigger).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await trigger.focus();
      await expect(trigger).toHaveCSS('outline-width', '2px');
      await trigger.press('Enter');
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      const rows = dialog.locator('.session-tree-node');
      await expect(rows).toHaveCount(4);
      await expect(rows.locator('.session-tree-status')).toHaveCount(0);
      await expect(dialog.locator('.session-activity.managed_active')).toHaveCount(1);
      await expect(rows.locator('.session-tree-time')).toHaveText(['>12m', '>5m', '<1m', '>2h']);
      await expect(rows.first().locator('.session-tree-time')).toHaveAttribute(
        'datetime',
        /^\d{4}-\d{2}-\d{2}T/
      );
      await expect(rows.nth(1)).toHaveAccessibleName(
        `Verify image decoding and cleanup, ${locale === 'en-US' ? 'Sleeping' : '休眠中'}`
      );
      await expect(rows.nth(2)).toHaveAccessibleName(
        `Review child compatibility, ${locale === 'en-US' ? 'Running' : '运行中'}`
      );
      const longTitle = rows.last().locator('.session-tree-title');
      await expect(rows.last()).toHaveAccessibleName(
        `${'Review upload boundary tests and verify image compatibility. '.repeat(6).trim()}, ${locale === 'en-US' ? 'Idle' : '空闲'}`
      );
      const titleSize = await longTitle.evaluate((element) => ({
        height: element.clientHeight,
        width: element.clientWidth,
        fullWidth: element.scrollWidth,
        lineHeight: parseFloat(getComputedStyle(element).lineHeight)
      }));
      expect(titleSize.height).toBeLessThanOrEqual(titleSize.lineHeight + 1);
      expect(titleSize.fullWidth).toBeGreaterThan(titleSize.width);
      await expect(rows.locator('[data-mar-icon="collection"]')).toHaveCount(0);
      const treeRows = dialog.locator('.session-tree-row');
      await expect(treeRows).toHaveCount(3);
      await expect(treeRows.nth(0).locator('.session-tree-origin')).toBeVisible();
      await expect(treeRows.nth(1).locator('.session-tree-branch')).toHaveCount(1);
      await expect(treeRows.nth(2).locator('.session-tree-origin')).toBeVisible();
      const geometry = await treeRows.evaluateAll((elements) =>
        elements.map((row) => {
          const box = row.getBoundingClientRect();
          const marker = row.querySelector('.session-tree-marker')!.getBoundingClientRect();
          return {
            rowCenter: box.top + box.height / 2,
            x: marker.left + marker.width / 2,
            center: marker.top + marker.height / 2,
            width: marker.width,
            height: marker.height
          };
        })
      );
      for (const marker of geometry) {
        expect(Math.abs(marker.center - marker.rowCenter)).toBeLessThan(1);
        expect(marker.width).toBeCloseTo(8, 1);
        expect(marker.height).toBeCloseTo(marker.width, 1);
      }
      expect(geometry[1]!.x).toBeGreaterThan(geometry[0]!.x);
      expect(geometry[2]!.x).toBeCloseTo(geometry[0]!.x, 1);
      for (const row of await rows.all()) {
        await expect(row).not.toContainText(/mar-agent|codex/);
        await expect(row).toHaveCSS('border-top-width', '0px');
        expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      }
      const items = dialog.locator('.session-tree-item');
      const rowBackground = await items
        .nth(1)
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(rowBackground).not.toBe('rgba(0, 0, 0, 0)');
      await expect(items.nth(2)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(items.first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await rows.first().hover();
      const hoverBackground = await items
        .first()
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(hoverBackground).not.toBe(rowBackground);
      const current = dialog.locator('.session-tree-node[aria-current="true"]');
      await current.focus();
      await expect(current).toHaveCSS('outline-width', '2px');
      await expect(current).toContainText('Verify image');
      await expect(items.nth(1)).toHaveCSS('background-color', rowBackground);
      await expect(current.locator('.session-tree-title')).toHaveCSS('font-weight', '400');
      await expect(rows.locator('[data-mar-icon]')).toHaveCount(0);
      const box = (await dialog.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      await page.mouse.move(0, 0);
      await current.evaluate((element) => (element as HTMLElement).blur());
      await page.screenshot({
        path: testInfo.outputPath(`tree-${width}-${theme}.png`),
        fullPage: true
      });
      await longTitle.hover();
      await expect(page.locator('.mar-tooltip[role="tooltip"]:visible')).toHaveText(
        'Review upload boundary tests and verify image compatibility. '.repeat(6).trim()
      );
      await current.locator('.session-tree-time').hover();
      await expect(page.locator('.mar-tooltip[role="tooltip"]:visible')).toHaveText(
        new RegExp(
          `^${locale === 'en-US' ? 'Last activity: ' : '最后活动：'}\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$`
        )
      );
      await items.nth(1).evaluate((element) => {
        (element as HTMLElement).style.setProperty('--mar-text-primary', '#d7dde5');
        (element as HTMLElement).style.setProperty('--mar-fill-selection', '#313f51');
        (element as HTMLElement).style.setProperty('--el-color-success', '#36805a');
      });
      await current.evaluate((element) => (element as HTMLElement).blur());
      await page.mouse.move(0, 0);
      await expect(current.locator('.session-tree-title')).toHaveCSS('color', 'rgb(215, 221, 229)');
      await expect(items.nth(1)).toHaveCSS('background-color', 'rgb(49, 63, 81)');
      await expect(current.locator('.session-activity')).toBeVisible();
      await rows.first().press('Enter');
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId('selected')).toHaveText('parent');
    });
  }
}

for (const theme of ['dark', 'daylight']) {
  test(`root-only session tree in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 850 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${fixture.url}session-tree.html?theme=${theme}&locale=zh-CN&rootOnly=1`);
    await page.getByRole('button', { name: '查看会话树' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('.session-tree-node')).toHaveCount(0);
    await expect(dialog.locator('.session-tree-row')).toHaveCount(0);
    await expect(dialog.locator('.session-tree')).toContainText('暂无下级会话');
    await page.screenshot({
      path: testInfo.outputPath(`root-${theme}.png`),
      fullPage: true,
      animations: 'disabled'
    });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });
}

for (const [width, theme] of [
  [390, 'daylight'],
  [1280, 'vscode-dark-2026']
] as const) {
  test(`session tree menu icon at ${width}px in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 850 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${fixture.url}session-groups.html?theme=${theme}&locale=en-US`);
    const chats = page.locator('.conversation-sidebar');
    await chats.getByRole('tab').nth(1).click();
    await chats.locator('.session-link').hover();
    await chats.locator('.session-more-button').click();
    const treeItem = page.getByRole('menuitem', { name: 'View session tree', exact: true });
    await expect(treeItem.locator('[data-mar-icon="session-tree"]')).toBeVisible();
    await expect(treeItem.locator('[data-mar-icon="collection"]')).toHaveCount(0);
    await treeItem.screenshot({ path: testInfo.outputPath('session-tree-menu.png') });
    await treeItem.click();
    await page.locator('.session-tree-node').click();
    await expect(page.getByTestId('opened-tree-session')).toHaveText('child-detail');
    await expect(treeItem).not.toBeVisible();
  });
}
