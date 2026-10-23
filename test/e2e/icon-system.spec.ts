import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

for (const theme of ['dark', 'light']) {
  test(`Process disclosure uses a transparent SVG instead of an unmasked square: ${theme}`, async ({
    page
  }, testInfo) => {
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${fixture.url}icon-system.html?process-icons=1&theme=${theme}`);
      for (const active of [false, true]) {
        const process = page.locator(`[data-process-id="process-${active}"]`);
        const heading = process.locator('.process-heading');
        const icon = heading.locator('.process-chevron');
        await expect(icon).toHaveAttribute('data-mar-icon', 'chevron-right');
        await expect(icon).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(icon).toHaveAttribute('fill', 'none');
        await expect(icon).toHaveAttribute('aria-hidden', 'true');
        await expect(heading).toHaveAttribute('aria-expanded', String(active));
        await icon.click();
        await expect(heading).toHaveAttribute('aria-expanded', String(!active));
        await expect(process.locator('.process-body')).toHaveAttribute(
          'aria-hidden',
          String(active)
        );
        await expect
          .poll(() => icon.evaluate((el) => getComputedStyle(el).transform))
          .toBe(active ? 'none' : 'matrix(0, 1, -1, 0, 0, 0)');
        await heading.focus();
        await heading.press('Enter');
        await expect(heading).toHaveAttribute('aria-expanded', String(active));
        await heading.press('Space');
        await expect(heading).toHaveAttribute('aria-expanded', String(!active));
      }
      if (width === 390)
        await page.screenshot({ path: testInfo.outputPath(`process-icons-${theme}.png`) });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await expect(page.locator('.process-chevron').first()).toHaveCSS('transition-duration', '0s');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
    }
  });
}

for (const theme of ['dark', 'light']) {
  test(`Mobile action icons keep their visual hierarchy without scaling text or status: ${theme}`, async ({
    page
  }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    for (const width of [390, 360, 1280]) {
      const mobile = width < 768;
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${fixture.url}icon-system.html?composer-icons=1&theme=${theme}`);
      const attachment = page.locator('.composer-attachment-button .mar-icon');
      const copy = page.locator('.conversation-message-action .mar-icon').first();
      const edit = page.getByRole('button', { name: 'Edit', exact: true });
      const send = page.locator('.composer-send-button');
      const stop = page.locator('.composer-stop-button');
      const rootFontSize = await page.evaluate(() =>
        parseFloat(getComputedStyle(document.documentElement).fontSize)
      );
      const expectedPrimary = mobile ? 20 : 0.92 * rootFontSize;
      for (const action of [send, stop]) {
        const graphic = action.locator('.mar-icon');
        await expect(graphic).toBeVisible();
        expect((await graphic.boundingBox())!.width).toBeCloseTo(expectedPrimary, 1);
        expect((await action.boundingBox())!.width).toBe(mobile ? 36 : 26);
      }
      if (mobile) {
        for (const graphic of [attachment, copy, edit.locator('.mar-icon')]) {
          await expect(graphic).toHaveCSS('width', '18px');
          await expect(graphic).toHaveCSS('height', '18px');
        }
        await expect(edit.locator('.el-icon')).toHaveCSS('width', '18px');
        await expect(edit).toHaveCSS('font-size', '12px');
        await expect(page.locator('.composer-access-select .mar-icon')).not.toHaveCSS(
          'width',
          '18px'
        );
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width
        );
      }
      await expect(page.getByTestId('status-icon').locator('.mar-icon')).toHaveCSS('width', '11px');
      await expect(
        page.getByRole('button', { name: 'Explicit icon size' }).locator('.mar-icon')
      ).toHaveCSS('width', '24px');
      if (width === 390) {
        await page.screenshot({ path: testInfo.outputPath(`mobile-icons-${theme}.png`) });
      }
      await stop.click();
      await expect(page.getByTestId('stops')).toHaveText('1');
      await send.focus();
      await send.press('Enter');
      await expect(page.getByTestId('sends')).toHaveText('1');
      await expect(send).toBeDisabled();
      expect(
        (await send.locator('[data-mar-icon="loading-action"]').boundingBox())!.width
      ).toBeCloseTo(expectedPrimary, 1);
    }
    expect(errors).toEqual([]);
  });
}

for (const theme of ['dark', 'light']) {
  test(`Navigation hints show themed arrows without capturing adjacent actions: ${theme}`, async ({
    page
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${fixture.url}icon-system.html?navigation=1&count=6&theme=${theme}`);
    await page.getByRole('button', { name: 'Work', exact: true }).hover();
    const hint = page.locator('.mar-tooltip:visible');
    await expect(hint).toHaveText('Work');
    await expect(hint.locator('.el-popper__arrow')).toBeVisible();
    await expect(hint).toHaveCSS('pointer-events', 'none');
    const colors = await hint.evaluate((el) => {
      const surface = getComputedStyle(el);
      const arrow = getComputedStyle(el.querySelector('.el-popper__arrow')!, '::before');
      return {
        surface: surface.backgroundColor,
        arrow: arrow.backgroundColor,
        border: surface.borderTopColor,
        visibleArrowBorders: [
          arrow.borderTopColor,
          arrow.borderRightColor,
          arrow.borderBottomColor,
          arrow.borderLeftColor
        ].filter((color) => color !== 'rgba(0, 0, 0, 0)')
      };
    });
    expect(colors.arrow).toBe(colors.surface);
    expect(colors.visibleArrowBorders).toEqual([colors.border, colors.border]);
    const next = page.getByRole('button', { name: 'Conversations', exact: true });
    const nextBounds = (await next.boundingBox())!;
    const hintBounds = (await hint.boundingBox())!;
    expect(hintBounds.x).toBeGreaterThanOrEqual(nextBounds.x + nextBounds.width);
    await next.click();
    await expect(next).toBeFocused();
    await expect(page.locator('.mar-tooltip:visible')).not.toHaveText('Work');
  });
}

for (const mobile of [false, true]) {
  test(`Navigation icons stay centered with recent-session badges: ${mobile ? 'mobile' : 'desktop'}`, async ({
    page
  }) => {
    await page.setViewportSize({ width: mobile ? 390 : 1280, height: 900 });
    for (const count of [0, 6, 12]) {
      await page.goto(
        `${fixture.url}icon-system.html?navigation=1&count=${count}${mobile ? '&mobile=1' : ''}`
      );
      const trigger = page.locator('.recent-sessions-trigger');
      const icon = trigger.locator('[data-mar-icon="recent-sessions"]');
      await expect(icon).toBeVisible();
      const bounds = await trigger.boundingBox();
      const entry = await page.locator('.recent-sessions-entry').boundingBox();
      const graphic = await icon.boundingBox();
      expect(graphic!.width).toBe(22);
      await expect(page.locator('.nav-menu-button [data-mar-icon="workspace"]')).toHaveCSS(
        'width',
        '22px'
      );
      if (mobile) {
        await expect(page.locator('.workbench-notification-trigger .mar-icon')).toHaveCSS(
          'width',
          '22px'
        );
      }
      expect(bounds!.width).toBeGreaterThanOrEqual(entry!.width - 4);
      expect(
        Math.abs(graphic!.x + graphic!.width / 2 - entry!.x - entry!.width / 2)
      ).toBeLessThanOrEqual(1);
      if (count) {
        const badge = trigger.locator('.recent-sessions-badge');
        await expect(badge).toHaveText(String(count));
        const badgeBounds = await badge.boundingBox();
        expect(badgeBounds!.x + badgeBounds!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
      } else await expect(trigger.locator('.recent-sessions-badge')).toHaveCount(0);
      await trigger.click();
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await trigger.press('Escape');
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      const focusableTags = await page.locator('.recent-sessions-entry').evaluate((el) =>
        Array.from(el.querySelectorAll<HTMLElement>('*'))
          .filter((child) => child.tabIndex >= 0)
          .map((child) => child.tagName)
      );
      expect(focusableTags).toEqual(['BUTTON']);
      for (const key of ['Enter', 'Space']) {
        await trigger.press(key);
        await expect(trigger).toHaveAttribute('aria-expanded', 'true');
        await trigger.press('Escape');
        await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      }
    }
  });
}

test('Conversation disclosure arrows share MAR geometry and retain nested keyboard toggles', async ({
  page
}) => {
  await page.goto(`${fixture.url}icon-system.html?disclosure=1`);
  const details = page.locator('.conversation-record-group').first();
  const summary = details.locator(':scope > summary');
  const icon = summary.locator(':scope > svg[data-mar-icon="chevron-right"]');
  await expect(icon).toBeVisible();
  await expect(icon).toHaveAttribute('aria-hidden', 'true');
  expect(await summary.evaluate((el) => getComputedStyle(el, '::before').content)).toBe('none');
  await icon.click();
  await expect(details).toHaveAttribute('open', '');
  await expect
    .poll(() => icon.evaluate((el) => getComputedStyle(el).transform))
    .toBe('matrix(0, 1, -1, 0, 0, 0)');
  const nested = details.locator(':scope > details').first();
  const nestedSummary = nested.locator(':scope > summary');
  await expect(nestedSummary.locator('svg[data-mar-icon="chevron-right"]')).toBeVisible();
  await nestedSummary.focus();
  await page.keyboard.press('Enter');
  await expect(nested).toHaveAttribute('open', '');
  await summary.focus();
  await page.keyboard.press('Space');
  await expect(details).not.toHaveAttribute('open');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await icon.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0s');
});

test('Usage and quick-open disclosures replace browser markers without losing keyboard access', async ({
  page
}) => {
  for (const mode of ['usage', 'quick-open']) {
    if (mode === 'quick-open') {
      await page.route('**/api/**', (route) =>
        route.fulfill({
          status: 503,
          json: { code: 'FIXTURE_QUERY_FAILED', message: 'Fixture query unavailable' }
        })
      );
    }
    await page.goto(`${fixture.url}icon-system.html?${mode}=1`);
    if (mode === 'quick-open')
      await page.getByRole('textbox', { name: 'Quick Open', exact: true }).fill('missing');
    const details = page.locator('details').first();
    const summary = details.locator(':scope > summary');
    const icon = summary.locator('svg[data-mar-icon="chevron-right"]');
    await expect(icon).toBeVisible();
    expect(await summary.evaluate((el) => getComputedStyle(el).listStyleType)).toBe('none');
    if (mode === 'usage') await expect(details.locator('.el-table')).toBeHidden();
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(details).toHaveAttribute('open', '');
    if (mode === 'usage') await expect(details.locator('.el-table')).toBeVisible();
    await expect
      .poll(() => icon.evaluate((el) => getComputedStyle(el).transform))
      .toBe('matrix(0, 1, -1, 0, 0, 0)');
    await page.keyboard.press('Space');
    await expect(details).not.toHaveAttribute('open');
    if (mode === 'usage') await expect(details.locator('.el-table')).toBeHidden();
  }
});

test('Terminal close icons preserve accessible names and close only the selected terminal', async ({
  page
}) => {
  const closed: string[] = [];
  await page.route('**/api/terminals**', async (route) => {
    if (route.request().method() === 'DELETE') {
      closed.push(new URL(route.request().url()).pathname);
      await route.fulfill({ status: 204 });
    } else if (route.request().method() === 'POST') {
      await route.fulfill({
        json: {
          terminal: {
            id: 'fixture-terminal',
            workspaceId: 'project',
            profileId: 'shell',
            state: 'RUNNING',
            latestSequence: 0
          }
        }
      });
    } else {
      await route.fulfill({ json: { terminals: [] } });
    }
  });
  await page.goto(`${fixture.url}icon-system.html?terminal=1`);
  const close = page.getByRole('button', { name: 'Close terminal 1', exact: true });
  await expect(close).toBeVisible();
  await expect(close.locator('svg[data-mar-icon="close"][aria-hidden="true"]')).toBeVisible();
  await close.focus();
  await page.keyboard.press('Enter');
  await expect(close).toHaveCount(0);
  expect(closed).toEqual(['/api/terminals/fixture-terminal']);
});

test('Usage chart dimensions do not leak into calendar icons', async ({ page }) => {
  await page.goto(`${fixture.url}icon-system.html?usage=1`);
  const chart = page.locator('[data-testid="personal-usage"] svg[role="img"]');
  await expect(chart).toBeVisible();
  const chartSize = await chart.evaluate((svg) => ({
    height: svg.getBoundingClientRect().height,
    expected: 8 * Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
  }));
  expect(chartSize.height).toBeCloseTo(chartSize.expected, 0);
  await expect(page.locator('.mar-page-loading')).toBeHidden();
  await page
    .locator('.el-select')
    .filter({
      has: page.getByRole('combobox', { name: 'Time range', exact: true })
    })
    .click();
  await page.getByRole('option', { name: 'Custom range', exact: true }).click();
  await page.getByPlaceholder('Start time', { exact: true }).click();
  const arrow = page
    .locator('.el-picker-panel:visible [data-mar-icon="chevron-left"]:visible')
    .first();
  await expect(arrow).toBeVisible();
  const height = await arrow.evaluate((svg) => Number.parseFloat(getComputedStyle(svg).height));
  expect(height).toBeGreaterThan(0);
  expect(height).toBeLessThanOrEqual(24);
});

test('Management errors render a MAR service icon outside the component tree', async ({ page }) => {
  await page.goto(`${fixture.url}icon-system.html?failure=1`);
  await page
    .getByTestId('management')
    .getByRole('button', { name: 'View email templates', exact: true })
    .click();
  const message = page.locator('.el-message');
  await expect(message).toContainText('Template request failed');
  await expect(message.locator('[data-mar-icon="error"]')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Email templates', exact: true })).toBeVisible();
});

test('Session search clear and busy guards preserve their behavior', async ({ page }) => {
  await page.goto(`${fixture.url}icon-system.html`);
  const search = page.locator('.session-search input');
  await search.fill('review');
  await search.press('Enter');
  await expect(page.getByTestId('searched')).toHaveText('review');
  await search.hover();
  await page.locator('.session-search [data-mar-icon="clear-input"]').click();
  await expect(search).toHaveValue('');
  await expect(page.getByTestId('searched')).toHaveText('');
  await page.goto(`${fixture.url}icon-system.html?busy=1`);
  await expect(page.locator('.session-search button')).toBeDisabled();
  await expect(page.locator('.session-search [data-mar-icon="loading-action"]')).toBeVisible();
  await search.fill('busy');
  await search.press('Enter');
  await expect(page.getByTestId('searched')).toHaveText('');
  await search.fill('');
  await search.press('Enter');
  await expect(page.getByTestId('searched')).toHaveText('');
});

for (const theme of ['dark', 'light'])
  for (const mobile of [false, true]) {
    test(`Shared SVGs preserve component behavior in ${theme}, ${mobile ? 'mobile' : 'desktop'}`, async ({
      page
    }, testInfo) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.setViewportSize({ width: mobile ? 390 : 1440, height: 1000 });
      await page.goto(`${fixture.url}icon-system.html?theme=${theme}`);
      const tree = page.getByTestId('resource-tree');
      await expect(tree.locator('[data-mar-icon="node"]')).toBeVisible();
      await expect(tree.locator('[data-mar-icon="workspace"]')).toBeVisible();
      await expect(tree.locator('[data-mar-icon="folder"]')).toBeVisible();
      const folder = tree.locator('.workspace-group-toggle');
      await folder.click();
      await expect(folder.locator('[data-mar-icon="folder-open"]')).toBeVisible();
      const create = page.locator('.new-session-button');
      await expect(create.locator('[data-mar-icon="session-add"]')).toBeVisible();
      const buttonGap = await create.evaluate((button) => {
        const icon = button.querySelector('[data-mar-icon="session-add"]')!;
        return (
          icon.nextElementSibling!.getBoundingClientRect().left - icon.getBoundingClientRect().right
        );
      });
      expect(buttonGap).toBeGreaterThanOrEqual(5);
      await create.focus();
      await create.press('Enter');
      await expect(page.getByTestId('created')).toHaveText('1');
      const search = page.locator('.session-search input');
      await search.fill('review');
      await search.press('Enter');
      await expect(page.getByTestId('searched')).toHaveText('review');
      await search.fill('');
      await search.press('Enter');
      await expect(page.getByTestId('searched')).toHaveText('refreshed');
      await expect(page.locator('.agent-markdown-code-copy [data-mar-icon="copy"]')).toHaveCount(1);
      const quantity = page.getByTestId('quantity');
      await page.getByPlaceholder('Review date').click();
      const calendar = page.locator('.el-date-picker:visible');
      await expect(calendar.locator('[data-mar-icon="chevrons-left"]')).toBeVisible();
      await calendar.locator('[data-mar-icon="chevron-right"]').click();
      await expect(calendar.locator('[data-mar-icon="chevrons-right"]')).toBeVisible();
      await page.getByPlaceholder('Review date').press('Escape');
      await expect(quantity.locator('.el-input-number__decrease')).toHaveClass(/is-disabled/);
      await quantity.locator('[data-mar-icon="plus"]').click();
      await expect(quantity.locator('input')).toHaveValue('2');
      await quantity.locator('[data-mar-icon="subtract"]').click();
      await expect(quantity.locator('input')).toHaveValue('1');
      await page
        .getByTestId('management')
        .getByRole('button', { name: 'View email templates', exact: true })
        .click();
      const dialog = page.getByRole('dialog', { name: 'Email templates', exact: true });
      await expect(dialog).toBeVisible();
      const close = dialog.locator('.el-dialog__headerbtn');
      await expect(close.locator('[data-mar-icon="close"]')).toBeVisible();
      await close.click();
      await expect(dialog).toHaveCount(0);
      const icon = tree.locator('[data-mar-icon="node"]');
      const geometry = await icon.evaluate((el) => ({
        width: el.getBoundingClientRect().width,
        stroke: getComputedStyle(el).stroke,
        color: getComputedStyle(el).color
      }));
      expect(geometry.width).toBeGreaterThanOrEqual(14);
      expect(geometry.width).toBeLessThanOrEqual(24);
      expect(geometry.stroke).toEqual(geometry.color);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await expect(page.locator('.icon-review-grid [data-mar-icon="loading-action"]')).toHaveCSS(
        'animation-name',
        'none'
      );
      expect(errors).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath(`icons-${theme}-${mobile ? 'mobile' : 'desktop'}.png`),
        fullPage: true
      });
    });
  }
