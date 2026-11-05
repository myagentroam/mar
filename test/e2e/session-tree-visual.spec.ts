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
      await expect(page.getByTestId('selected')).toHaveText('child');
    }
  });
}

test('tree dialog keeps one snapshot, orders active branches and closes by keyboard and backdrop', async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.goto(`${fixture.url}session-tree.html?locale=en-US&mixed=1`);
  const trigger = page.getByRole('button', { name: 'View session tree' });
  await trigger.click();
  const tree = page.getByRole('dialog', { name: 'View session tree' });
  await expect(tree).toBeVisible();
  await expect(tree).toHaveAttribute('aria-modal', 'true');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await expect(page.getByTestId('requests')).toHaveText('1');
  await tree.hover({ position: { x: 2, y: 2 } });
  await expect(tree.locator('.session-tree-title')).toHaveText([
    'Root',
    'Running branch',
    'Sleeping branch',
    'Idle branch',
    'Active descendant',
    'Idle leaf',
    'Idle leaf two'
  ]);
  await expect(tree.locator('.session-tree-status')).toHaveCount(0);
  await expect(tree.locator('.session-activity.managed_active')).toHaveCount(3);
  await expect(tree.locator('.session-tree-time')).toHaveText(Array(7).fill('—'));
  await expect(
    tree.getByRole('button', { name: 'Running branch, Running', exact: true })
  ).toBeVisible();
  await expect(
    tree.getByRole('button', { name: 'Sleeping branch, Sleeping', exact: true })
  ).toBeVisible();
  await expect(page.getByTestId('requests')).toHaveText('1');
  await page.keyboard.press('Escape');
  await expect(tree).toHaveCount(0);
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('requests')).toHaveText('2');
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

  test(`session tree preserves its content through the native leave transition at ${width}px`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 850 });
    for (const entry of ['title', 'list']) {
      await page.goto(
        `${fixture.url}${entry === 'title' ? 'session-tree' : 'session-groups'}.html?locale=en-US`
      );
      if (entry === 'title') {
        await page.getByRole('button', { name: 'View session tree' }).click();
      } else {
        const chats = page.locator('.conversation-sidebar');
        await chats.getByRole('tab').nth(1).click();
        await chats.locator('.session-link').hover();
        await chats.locator('.session-more-button').click();
        await page.getByRole('menuitem', { name: 'View session tree', exact: true }).click();
      }
      const tree = page.getByRole('dialog', { name: 'View session tree' });
      const overlay = page.locator('.el-overlay');
      await expect(tree.locator('.session-tree-node').first()).toBeVisible();
      await overlay.evaluate(async (element) => {
        await Promise.allSettled(
          element.getAnimations({ subtree: true }).map((animation) => animation.finished)
        );
      });
      await expect(overlay).not.toHaveClass(/enter-active/);
      await expect
        .poll(() => tree.evaluate((element) => element.contains(document.activeElement)))
        .toBe(true);
      const leaving = await page.evaluate(async () => {
        const panel = document.querySelector<HTMLElement>('.el-overlay')!;
        const content = panel.textContent;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        return {
          connected: panel.isConnected,
          active: panel.classList.contains('dialog-fade-leave-active'),
          duration: Math.max(
            Number.parseFloat(getComputedStyle(panel).transitionDuration),
            Number.parseFloat(getComputedStyle(panel).animationDuration)
          ),
          contentUnchanged: panel.textContent === content,
          inert: panel.querySelector('.session-tree-content')?.hasAttribute('inert')
        };
      });
      expect(leaving.connected, entry).toBe(true);
      expect(leaving.active, entry).toBe(true);
      expect(leaving.duration, entry).toBeGreaterThan(0);
      expect(leaving.contentUnchanged, entry).toBe(true);
      expect(leaving.inert, entry).toBe(true);
      await expect(overlay).toHaveCount(0);
    }
  });
}

test('reopening the dialog reads a fresh snapshot and stays open', async ({ page }) => {
  await page.goto(`${fixture.url}session-tree.html?locale=en-US`);
  const trigger = page.getByRole('button', { name: 'View session tree' });
  await trigger.click();
  const overlay = page.locator('.el-overlay');
  await expect(page.getByTestId('requests')).toHaveText('1');
  await page.keyboard.press('Escape');
  await expect(overlay).toHaveCount(0);
  await trigger.click();
  await expect(page.getByTestId('requests')).toHaveText('2');
  await expect(overlay).not.toHaveClass(/enter-active/);
  await expect(page.getByRole('dialog', { name: 'View session tree' })).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
});

for (const width of [390, 1280]) {
  for (const action of ['select', 'failure']) {
    test(`${action} uses the native tree dialog leave transition at ${width}px`, async ({
      page
    }) => {
      await page.setViewportSize({ width, height: 850 });
      await page.goto(
        `${fixture.url}session-tree.html?locale=en-US${action === 'failure' ? '&delayed=1' : ''}`
      );
      const trigger = page.getByRole('button', { name: 'View session tree' });
      await trigger.click();
      const overlay = page.locator('.el-overlay');
      await expect(page.getByTestId('requests')).toHaveText('1');
      await expect(page.getByRole('dialog')).toBeVisible();
      await overlay.evaluate(async (element) => {
        const surfaces = [element, element.querySelector('.el-dialog')!];
        await Promise.allSettled(
          surfaces
            .flatMap((surface) => surface.getAnimations())
            .map((animation) => animation.finished)
        );
      });
      const control =
        action === 'select'
          ? page.getByRole('button', { name: 'Verify image decoding and cleanup, Idle' })
          : page.getByTestId('reject-snapshot');
      const leaving = await control.evaluate(async (button: HTMLButtonElement) => {
        const panel = document.querySelector<HTMLElement>('.el-overlay')!;
        const dialog = panel.querySelector('.el-dialog')!;
        const height = dialog.clientHeight;
        button.click();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        return {
          connected: panel.isConnected,
          active: panel.classList.contains('dialog-fade-leave-active'),
          heightUnchanged: dialog.clientHeight === height,
          inert: panel.querySelector('.session-tree-content')?.hasAttribute('inert')
        };
      });
      expect(leaving).toEqual({
        connected: true,
        active: true,
        heightUnchanged: true,
        inert: true
      });
      if (action === 'select') await expect(page.getByTestId('selected')).toHaveText('grandchild');
      else await expect(page.getByText('tree unavailable')).toBeVisible();
      await expect(overlay).toHaveCount(0);
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    });
  }
}

test('session tree respects reduced motion when opening and closing', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${fixture.url}session-tree.html?locale=en-US`);
  const trigger = page.getByRole('button', { name: 'View session tree' });
  const duration = await trigger.evaluate(async (button) => {
    if (!(button instanceof HTMLElement))
      throw new Error('Session tree trigger is not an HTML element');
    button.click();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const style = getComputedStyle(document.querySelector('.el-overlay')!);
    return Math.max(
      Number.parseFloat(style.transitionDuration),
      Number.parseFloat(style.animationDuration)
    );
  });
  expect(duration).toBe(0);
  await expect(page.getByRole('dialog', { name: 'View session tree' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'View session tree' })).toHaveCount(0);
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
  test(`closing cancels the snapshot before leave and ignores its late ${outcome}`, async ({
    page
  }) => {
    await page.goto(`${fixture.url}session-tree.html?locale=en-US&delayed=1`);
    const trigger = page.getByRole('button', { name: 'View session tree' });
    await trigger.click();
    await expect(page.getByTestId('requests')).toHaveText('1');
    const overlay = page.locator('.el-overlay');
    await expect(overlay).not.toHaveClass(/enter-active/);
    const closed = await page.evaluate(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return {
        aborted: document.querySelector('[data-testid="aborts"]')!.textContent,
        connected: document.querySelector('.el-overlay') !== null
      };
    });
    expect.soft(closed).toEqual({ aborted: '1', connected: true });
    const retired = await page.evaluate(async (outcome) => {
      const control = document.querySelector<HTMLButtonElement>(
        `[data-testid="${outcome === 'success' ? 'resolve' : 'reject'}-snapshot"]`
      )!;
      control.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return {
        busy: document.querySelector('.session-tree')?.getAttribute('aria-busy'),
        nodes: document.querySelectorAll('.session-tree-node').length,
        errors: document.querySelectorAll('.el-message--error').length
      };
    }, outcome);
    expect(retired).toEqual({ busy: 'true', nodes: 0, errors: 0 });
    await expect(overlay).toHaveCount(0);
  });
}

test('closing an in-flight snapshot aborts it and a failed snapshot can be reopened', async ({
  page
}) => {
  await page.goto(`${fixture.url}session-tree.html?locale=en-US&pending=1`);
  const trigger = page.getByRole('button', { name: 'View session tree' });
  await trigger.click();
  await expect(page.getByTestId('requests')).toHaveText('1');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('aborts')).toHaveText('1');
  await page.goto(`${fixture.url}session-tree.html?locale=en-US&failure=1`);
  await trigger.click();
  await expect(page.getByText('tree unavailable')).toBeVisible();
  await trigger.click();
  await expect(page.getByTestId('requests')).toHaveText('2');
  await expect(
    page
      .getByRole('dialog', { name: 'View session tree' })
      .getByRole('button', { name: 'Verify image decoding and cleanup, Idle' })
  ).toBeVisible();
});

test('keyboard-opened list actions open a modal tree without a preceding mouse click', async ({
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
  await expect(tree).toHaveAttribute('aria-modal', 'true');
  await expect
    .poll(() => tree.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);
  await page.keyboard.press('Escape');
  await expect(tree).toHaveCount(0);
  await expect
    .poll(() => chats.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);
  await trigger.focus();
  await trigger.press('ArrowDown');
  await action.focus();
  await action.press('Enter');
  await tree.getByRole('button', { name: 'Child collaboration, Idle' }).press('Enter');
  await expect(page.getByTestId('opened-tree-session')).toHaveText('child');
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

test('the standard dialog traps keyboard focus and its close button returns it', async ({
  page
}) => {
  await page.goto(`${fixture.url}session-tree.html?locale=en-US`);
  const trigger = page.getByRole('button', { name: 'View session tree' });
  await trigger.focus();
  await trigger.press('Enter');
  const tree = page.getByRole('dialog', { name: 'View session tree' });
  await expect(tree).toBeVisible();
  await expect
    .poll(() => tree.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);
  await page.keyboard.press('Shift+Tab');
  await expect
    .poll(() => tree.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);
  const close = tree.getByRole('button', { name: 'Close this dialog' });
  await expect(close.locator('[data-mar-icon="close"]')).toBeVisible();
  await close.click();
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

test('a deep 100-node snapshot remains scrollable on a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 600 });
  await page.goto(`${fixture.url}session-tree.html?locale=en-US&long=1`);
  await page.getByRole('button', { name: 'View session tree' }).click();
  const tree = page.locator('.session-tree');
  await expect(tree.locator('.session-tree-node')).toHaveCount(100);
  const body = page.locator('.session-tree-dialog .el-dialog__body');
  expect(
    await body.evaluate(
      (el) => el.scrollHeight > el.clientHeight && el.scrollWidth > el.clientWidth
    )
  ).toBe(true);
  const last = tree.getByRole('button', { name: 'Node 99, Idle' });
  await last.scrollIntoViewIfNeeded();
  expect(
    await last.locator('.session-tree-title').evaluate((el) => el.getBoundingClientRect().width)
  ).toBeGreaterThan(20);
  await expect(last).toBeVisible();
  await expect(last.locator('.session-tree-status')).toHaveCount(0);
  await expect(last.locator('.session-tree-time')).toHaveText('—');
  await expect(last.locator('.session-tree-time')).not.toHaveAttribute('datetime');
});

test.describe('touch interaction', () => {
  test.use({ hasTouch: true });
  test('touch opens the standard dialog and mobile back closes it', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 850 });
    await page.goto(`${fixture.url}session-tree.html?locale=en-US&rootOnly=1`);
    const trigger = page.getByRole('button', { name: 'View session tree' });
    await trigger.tap();
    const tree = page.getByRole('dialog', { name: 'View session tree' });
    await expect(tree).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await page.goBack();
    await expect(tree).toHaveCount(0);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
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
      await expect(dialog.locator('.session-activity.managed_active')).toHaveCount(2);
      await expect(rows.locator('.session-tree-time')).toHaveText(['>12m', '<1m', '>5m', '>2h']);
      await expect(rows.first().locator('.session-tree-time')).toHaveAttribute(
        'datetime',
        /^\d{4}-\d{2}-\d{2}T/
      );
      await expect(rows.nth(1)).toHaveAccessibleName(
        `Review BMP compatibility changes and lifecycle edge cases, ${locale === 'en-US' ? 'Running' : '运行中'}`
      );
      await expect(rows.nth(2)).toHaveAccessibleName(
        `Verify image decoding and cleanup, ${locale === 'en-US' ? 'Sleeping' : '休眠中'}`
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
      const childBranch = treeRows.nth(1).locator('.session-tree-branch');
      const ancestorBranch = treeRows.nth(2).locator('.session-tree-branch').first();
      const lastBranch = treeRows.nth(3).locator('.session-tree-branch');
      await expect(childBranch).toHaveCSS('border-inline-start-width', '1px');
      await expect(ancestorBranch).toHaveCSS('border-inline-start-width', '1px');
      await expect(lastBranch).toHaveCSS('border-inline-start-width', '0px');
      // Read both edges in one frame while the dialog entrance transition may be active.
      const [childLine, ancestorLine] = await treeRows.evaluateAll((elements) =>
        [elements[1]!, elements[2]!].map((element) => {
          const box = element.querySelector('.session-tree-branch')!.getBoundingClientRect();
          return { x: box.x, y: box.y, height: box.height };
        })
      );
      expect(ancestorLine!.x).toBe(childLine!.x);
      expect(Math.abs(childLine!.y + childLine!.height - ancestorLine!.y)).toBeLessThan(1);
      const connectorEdges = await treeRows.evaluateAll((elements) => {
        const stem = elements[0]!.querySelector('.session-tree-origin-stem')!;
        const child = elements[1]!.querySelector('.session-tree-branch')!;
        const ancestor = elements[2]!.querySelector('.session-tree-branch')!;
        const grandchild = elements[2]!.querySelectorAll('.session-tree-branch')[1]!;
        const last = elements[3]!.querySelector('.session-tree-branch')!;
        const branchX = (element: Element) => element.getBoundingClientRect().left;
        const elbowX = (element: Element) =>
          branchX(element) +
          parseFloat(getComputedStyle(element).borderLeftWidth) +
          parseFloat(getComputedStyle(element, '::before').left);
        return {
          root: branchX(stem),
          continuing: branchX(child),
          continuingElbow: elbowX(child),
          ancestor: branchX(ancestor),
          grandchild: branchX(grandchild),
          grandchildElbow: elbowX(grandchild),
          lastElbow: elbowX(last)
        };
      });
      expect(connectorEdges.continuing).toBeCloseTo(connectorEdges.root, 1);
      expect(connectorEdges.continuingElbow).toBeCloseTo(connectorEdges.continuing, 1);
      expect(connectorEdges.ancestor).toBeCloseTo(connectorEdges.continuing, 1);
      expect(connectorEdges.grandchildElbow).toBeCloseTo(connectorEdges.grandchild, 1);
      expect(connectorEdges.lastElbow).toBeCloseTo(connectorEdges.continuing, 1);
      const childStem = treeRows.nth(1).locator('.session-tree-child-stem');
      await expect(childStem).toHaveCSS('border-inline-start-width', '1px');
      await expect(treeRows.nth(2).locator('.session-tree-child-stem')).toHaveCount(0);
      const nestedConnector = await treeRows.evaluateAll((elements) => {
        const parent = elements[1]!.getBoundingClientRect();
        const elbow = elements[1]!.querySelector('.session-tree-branch')!.getBoundingClientRect();
        const stem = elements[1]!
          .querySelector('.session-tree-child-stem')!
          .getBoundingClientRect();
        const child = elements[2]!
          .querySelectorAll('.session-tree-branch')[1]!
          .getBoundingClientRect();
        return {
          parentCenter: parent.top + parent.height / 2,
          elbowLeft: elbow.left,
          elbowRight: elbow.right,
          stemLeft: stem.left,
          stemTop: stem.top,
          stemBottom: stem.bottom,
          childLeft: child.left,
          childTop: child.top
        };
      });
      expect(Math.abs(nestedConnector.stemTop - nestedConnector.parentCenter)).toBeLessThan(1);
      expect(nestedConnector.stemLeft).toBeGreaterThanOrEqual(nestedConnector.elbowLeft);
      expect(nestedConnector.stemLeft).toBeLessThanOrEqual(nestedConnector.elbowRight);
      expect(nestedConnector.stemLeft).toBeCloseTo(nestedConnector.childLeft, 1);
      expect(Math.abs(nestedConnector.stemBottom - nestedConnector.childTop)).toBeLessThan(1);
      const ending = await lastBranch.evaluate((element) => {
        const style = getComputedStyle(element, '::before');
        return {
          height: parseFloat(style.height),
          border: style.borderBottomWidth,
          parentHeight: element.clientHeight
        };
      });
      expect(ending.border).toBe('1px');
      expect(Math.abs(ending.height - ending.parentHeight / 2)).toBeLessThan(1);
      const branchStep = await lastBranch.evaluate((element) =>
        parseFloat(getComputedStyle(element).width)
      );
      expect(branchStep).toBeCloseTo(
        await page.evaluate(
          () => parseFloat(getComputedStyle(document.documentElement).fontSize) * 1.25
        ),
        1
      );
      expect(
        await lastBranch.evaluate((element) =>
          parseFloat(getComputedStyle(element, '::before').borderEndStartRadius)
        )
      ).toBeGreaterThan(0);
      const markers = dialog.locator('.session-tree-marker');
      await expect(markers).toHaveCount(4);
      await expect(markers.first()).toHaveAttribute('aria-hidden', 'true');
      const markerGeometry = await treeRows.evaluateAll((elements) =>
        elements.map((element) => {
          const row = element.getBoundingClientRect();
          const marker = element.querySelector('.session-tree-marker')!;
          const dot = marker.getBoundingClientRect();
          const style = getComputedStyle(marker);
          return {
            x: dot.left + dot.width / 2,
            y: dot.top + dot.height / 2,
            center: row.top + row.height / 2,
            size: dot.width,
            height: dot.height,
            color: style.borderTopColor,
            radius: style.borderRadius
          };
        })
      );
      for (const marker of markerGeometry) {
        expect(Math.abs(marker.y - marker.center)).toBeLessThan(1);
        expect(marker.size).toBeCloseTo(8, 1);
        expect(marker.height).toBeCloseTo(marker.size, 1);
        expect(marker.radius).toBe('50%');
      }
      expect(markerGeometry[0]!.x).toBeCloseTo(connectorEdges.root, 1);
      expect(markerGeometry[1]!.x).toBeCloseTo(nestedConnector.stemLeft, 1);
      expect(markerGeometry[2]!.x - markerGeometry[1]!.x).toBeCloseTo(branchStep, 1);
      expect(markerGeometry[3]!.x).toBeCloseTo(markerGeometry[1]!.x, 1);
      expect(markerGeometry[1]!.color).toBe(markerGeometry[0]!.color);
      for (const row of await rows.all()) {
        await expect(row).not.toContainText(/mar-agent|codex/);
        await expect(row).toHaveCSS('border-top-width', '0px');
        expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      }
      const rowBackground = await rows
        .nth(1)
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(rowBackground).not.toBe('rgba(0, 0, 0, 0)');
      await expect(rows.nth(2)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(rows.first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await rows.first().hover();
      const hoverBackground = await rows
        .first()
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(hoverBackground).not.toBe(rowBackground);
      const current = dialog.locator('.session-tree-node[aria-current="true"]');
      await current.focus();
      await expect(current).toHaveCSS('outline-width', '2px');
      await expect(current).toContainText('Review BMP');
      await expect(current).toHaveCSS('background-color', rowBackground);
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
      await expect(page.getByRole('tooltip')).toHaveText(
        'Review upload boundary tests and verify image compatibility. '.repeat(6).trim()
      );
      await current.locator('.session-tree-time').hover();
      await expect(page.getByRole('tooltip')).toHaveText(
        new RegExp(
          `^${locale === 'en-US' ? 'Last activity: ' : '最后活动：'}\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$`
        )
      );
      await current.evaluate((element) => {
        (element as HTMLElement).style.setProperty('--mar-text-primary', '#d7dde5');
        (element as HTMLElement).style.setProperty('--mar-fill-selection', '#313f51');
        (element as HTMLElement).style.setProperty('--el-color-success', '#36805a');
      });
      await current.hover();
      await expect(current.locator('.session-tree-title')).toHaveCSS('color', 'rgb(215, 221, 229)');
      await expect(current).toHaveCSS('background-color', 'rgb(49, 63, 81)');
      await expect(current.locator('.session-activity i')).toHaveCSS(
        'background-color',
        'rgb(54, 128, 90)'
      );
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
    await expect(dialog.locator('.session-tree-node')).toHaveCount(1);
    await expect(dialog.locator('.session-tree-origin')).toBeVisible();
    await expect(dialog.locator('.session-tree-origin-stem')).toHaveCount(0);
    await expect(dialog.locator('.session-tree-child-stem')).toHaveCount(0);
    await expect(dialog.locator('.session-tree-branch')).toHaveCount(0);
    await expect(dialog.locator('.session-tree')).toHaveCSS('min-height', '0px');
    await expect(dialog.locator('.el-loading-mask')).toBeHidden();
    const root = dialog.getByRole('button', { name: 'forge#maintainer, 空闲' });
    await expect(root).toHaveAttribute('aria-current', 'true');
    expect(await root.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
      'rgba(0, 0, 0, 0)'
    );
    await page.mouse.move(0, 0);
    await root.evaluate((element) => (element as HTMLElement).blur());
    await page.screenshot({
      path: testInfo.outputPath(`root-${theme}.png`),
      fullPage: true,
      animations: 'disabled'
    });
    await root.click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('selected')).toHaveText('parent');
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
    await expect(page.getByTestId('opened-tree-session')).toHaveText('child');
    await expect(treeItem).not.toBeVisible();
  });
}
