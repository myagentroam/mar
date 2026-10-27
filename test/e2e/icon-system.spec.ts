import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

for (const dpr of [1, 2, 3]) {
  test.describe(`Action stars DPR ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });
    for (const theme of ['dark', 'light']) {
      test(`Action star keeps equal brightness and a single linear rotation: ${theme}`, async ({
        page
      }, testInfo) => {
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 900 });
          for (const consumer of ['composer', 'element-plus']) {
            await page.emulateMedia({ reducedMotion: 'no-preference' });
            const composer = consumer === 'composer';
            await page.goto(
              `${fixture.url}icon-system.html?${composer ? 'composer-icons' : 'information-icons'}=1&theme=${theme}`
            );
            const button = composer
              ? page.locator('.composer-send-button')
              : page.getByRole('button', { name: 'Query usage', exact: true });
            await button.click();
            const graphic = button.locator('[data-mar-icon="loading-action"]');
            const owner = composer ? graphic : button.locator('.el-icon.is-loading');
            await expect(graphic).toBeVisible();
            await expect(button).toBeDisabled();
            await expect(owner).not.toHaveCSS('animation-name', 'none');
            await expect(owner).toHaveCSS('animation-timing-function', 'linear');
            await expect(owner).toHaveCSS('animation-duration', composer ? '1s' : '2s');
            if (!composer) await expect(graphic).toHaveCSS('animation-name', 'none');
            const rotation = await owner.evaluate((element) => {
              const style = getComputedStyle(element);
              return {
                count: element
                  .getAnimations()
                  .filter(
                    (animation) =>
                      animation instanceof CSSAnimation && animation.playState === 'running'
                  ).length,
                origin: style.transformOrigin.split(' ').slice(0, 2).map(Number.parseFloat),
                size: [style.width, style.height].map(Number.parseFloat)
              };
            });
            expect(rotation.count).toBe(1);
            for (const axis of [0, 1]) {
              expect(rotation.origin[axis]).toBeCloseTo(rotation.size[axis] / 2, 1);
            }
            const star = await graphic.evaluate((element) => {
              const svg = element as SVGSVGElement;
              const bounds = svg.getBBox();
              const style = getComputedStyle(svg);
              const stroke = parseFloat(style.strokeWidth);
              return {
                color: style.color,
                min: Math.min(bounds.x, bounds.y) - stroke / 2,
                max: Math.max(bounds.x + bounds.width, bounds.y + bounds.height) + stroke / 2,
                rays: Array.from(svg.querySelectorAll('path'), (path) => {
                  const ray = getComputedStyle(path);
                  return {
                    opacity: ray.opacity,
                    stroke: ray.stroke,
                    cap: ray.strokeLinecap,
                    animation: ray.animationName,
                    length: path.getTotalLength()
                  };
                })
              };
            });
            expect(star.rays).toHaveLength(8);
            expect(star.min).toBeGreaterThan(0);
            expect(star.max).toBeLessThan(24);
            for (const ray of star.rays) {
              expect(ray.opacity).toBe('1');
              expect(ray.stroke).toBe(star.color);
              expect(ray.cap).toBe('round');
              expect(ray.animation).toBe('none');
              expect(ray.length).toBeGreaterThanOrEqual(4);
              expect(ray.length).toBeLessThanOrEqual(5);
            }
            await button.screenshot({
              path: testInfo.outputPath(`action-star-${consumer}-${theme}-${width}.png`)
            });
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await expect(owner).toHaveCSS('animation-name', 'none');
            await expect(graphic).toBeVisible();
            await expect(button).toBeDisabled();
          }
        }
      });
    }
  });
}

for (const theme of ['dark', 'light']) {
  test(`Git change status columns and restore icons stay aligned in ${theme}`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 844 });
    await page.goto(`${fixture.url}icon-system.html?git-change-icons=1&theme=${theme}`);
    const restore = page.locator('.change-restore').first();
    const glyph = restore.locator('[data-mar-icon="undo"]');
    await expect(glyph).toBeVisible();
    await expect(glyph).toHaveCSS('width', '14px');
    await expect(glyph).toHaveCSS('animation-name', 'none');
    const desktopBounds = await glyph.boundingBox();
    await expect(page.locator('.change-status')).toHaveText([
      'M',
      'W',
      'M',
      'W',
      'A',
      '?',
      'D',
      'S'
    ]);

    for (const width of [1280, 320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(glyph).toHaveCSS('width', '14px');
      await expect(glyph).toHaveCSS('height', '14px');
      await expect(restore.locator('.el-icon')).toHaveCSS('width', '14px');
      if (width < 768) {
        await expect(page.locator('.changes-refresh-button svg')).toHaveCSS('width', '18px');
      }
      const bounds = (await restore.boundingBox())!;
      expect(bounds.width).toBe(20);
      expect(bounds.height).toBeGreaterThanOrEqual(18);
      const columns = await page.locator('.change-entry').evaluateAll((rows) =>
        rows.map((row) => {
          const cells = Array.from(row.querySelectorAll<HTMLElement>('.change-status'));
          const status = cells.map((cell) => {
            const box = cell.getBoundingClientRect();
            return { x: box.x, width: box.width, font: getComputedStyle(cell).fontFamily };
          });
          const graphic = row.querySelector('svg[data-mar-icon="undo"]')!.getBoundingClientRect();
          const state = cells[1].getBoundingClientRect();
          return { status, gap: graphic.left - state.right };
        })
      );
      for (const column of columns) {
        expect(column.gap).toBeGreaterThanOrEqual(3);
        expect(column.gap).toBeLessThanOrEqual(6.5);
        for (const [index, cell] of column.status.entries()) {
          expect(cell.font).toMatch(/monospace/);
          expect(cell.width).toBeCloseTo(columns[0].status[0].width, 1);
          expect(cell.x).toBeCloseTo(columns[0].status[index].x, 1);
        }
      }
      await restore.focus();
      await expect(restore).toBeFocused();
      await restore.hover();
      await expect(glyph).toHaveCSS('width', '14px');
      await page.locator('.current-changes').screenshot({
        path: testInfo.outputPath(`git-change-icons-${theme}-${width}.png`)
      });
    }

    const beforeLoading = (await glyph.boundingBox())!;
    const controlBeforeLoading = (await restore.boundingBox())!;
    await page.getByRole('button', { name: 'Show restore loading', exact: true }).click();
    await expect(restore).toBeDisabled();
    await expect(restore.locator('[data-mar-icon="loading-action"]')).toHaveCSS('width', '14px');
    await expect(restore.locator('.el-icon')).toHaveCSS('width', '14px');
    await expect(page.locator('.change-restore').nth(1)).toBeDisabled();
    await expect(page.locator('.change-restore').nth(1).locator('svg')).toHaveCSS('width', '14px');
    const loadingBounds = (await restore.locator('svg').boundingBox())!;
    // Rotation changes the bounding box, but must not move the icon's center or button layout.
    expect(loadingBounds.x + loadingBounds.width / 2).toBeCloseTo(
      beforeLoading.x + beforeLoading.width / 2,
      1
    );
    expect(loadingBounds.y + loadingBounds.height / 2).toBeCloseTo(
      beforeLoading.y + beforeLoading.height / 2,
      1
    );
    const controlDuringLoading = (await restore.boundingBox())!;
    expect(controlDuringLoading.width).toBeCloseTo(controlBeforeLoading.width, 1);
    expect(controlDuringLoading.height).toBeCloseTo(controlBeforeLoading.height, 1);

    await page.setViewportSize({ width: 1280, height: 844 });
    await expect(restore.locator('svg')).toHaveCSS('width', `${desktopBounds!.width}px`);
  });
}

for (const theme of ['dark', 'light']) {
  for (const [name, path, selector] of [
    ['resource tree', 'icon-system.html', '.tree-more-button'],
    ['session rows', 'icon-system.html?session-icons=1', '.session-more-button'],
    ['file tree', 'file-tree.html', 'button.file-tree-more'],
    ['workspace tabs', 'workspace-tabs.html?locale=en-US&layout=dynamic', '.tab-close, .tab-pin'],
    ['file tabs', 'file-tabs.html', '.workspace-file-tab-close'],
    ['attachments', 'icon-system.html?attachment-icons=1', '.composer-attachment-remove'],
    ['notifications', 'visual-alignment.html?mobile=1', '.workbench-notification-delete']
  ] as const) {
    test(`Compact secondary icons in ${name} preserve mobile controls in ${theme}`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${fixture.url}${path}`);
      if (name === 'file tree') {
        await page.getByRole('button', { name: 'Toggle mobile', exact: true }).click();
      }
      if (name === 'session rows') await page.locator('.session-link').focus();
      if (name === 'notifications') await page.locator('.workbench-notification-trigger').click();
      const controls = page.locator(selector);
      await expect(controls.first()).toBeVisible();
      await page.locator('html').evaluate((element, selectedTheme) => {
        element.dataset.theme = selectedTheme === 'light' ? 'daylight' : 'vscode-dark-2026';
        element.classList.toggle('dark', selectedTheme === 'dark');
      }, theme);
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 });
        for (const control of await controls.all()) {
          await expect(control.locator('svg')).toHaveCSS('width', '14px');
          await expect(control.locator('svg')).toHaveCSS('height', '14px');
          const bounds = (await control.boundingBox())!;
          expect(bounds.width).toBeGreaterThanOrEqual(20);
          expect(bounds.height).toBeGreaterThanOrEqual(18);
        }
        await controls.first().focus();
        await expect(controls.first()).toBeFocused();
        await controls.first().hover();
        await expect(controls.first().locator('svg')).toHaveCSS('width', '14px');
      }
      if (name === 'resource tree') {
        await expect(page.locator('.session-search-button svg')).toHaveCSS('width', '18px');
        await expect(page.locator('.node-expand-button svg')).toHaveCSS('width', '12px');
        await expect(page.locator('.tree-node [data-mar-icon="node"]')).toHaveCSS('width', '16px');
      }
      if (name === 'file tabs') {
        await expect(page.locator('.workspace-file-window-close svg')).toHaveCSS('width', '18px');
        await expect(controls.first()).toHaveCSS('width', '36px');
        await expect(controls.first()).toHaveCSS('height', '36px');
      }
      await page.screenshot({ path: testInfo.outputPath(`compact-${name}-${theme}.png`) });
      if (name === 'attachments' || name === 'notifications') {
        await controls.first().click();
        await expect(controls).toHaveCount(0);
      }
    });
  }
}

for (const dpr of [1, 2, 3]) {
  test.describe(`More action dots DPR ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });
    for (const theme of ['dark', 'light']) {
      test(`remain legible without enlarging controls in ${theme}`, async ({ page }, testInfo) => {
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(`${fixture.url}icon-system.html?more-icons=1&theme=${theme}`);
          const trigger = page.locator('.workspace-more-button');
          const graphic = trigger.locator('[data-mar-icon="more"]');
          const sample = page.locator('.icon-review-cell [data-mar-icon="more"]');
          await expect(graphic).toBeVisible();
          await trigger.hover();
          await page.locator('.new-session-form').screenshot({
            path: testInfo.outputPath(`more-${theme}-${width}.png`)
          });
          for (const icon of [graphic, sample]) {
            const dots = await icon.evaluate((element) => {
              const svg = element as SVGSVGElement;
              return Array.from(svg.querySelectorAll('circle'), (circle) => ({
                x: circle.cx.baseVal.value,
                y: circle.cy.baseVal.value,
                diameter: (circle.r.baseVal.value * 2) / svg.viewBox.baseVal.width,
                fill: getComputedStyle(circle).fill,
                color: getComputedStyle(svg).color
              }));
            });
            expect(dots).toHaveLength(3);
            for (const dot of dots) {
              // Preserve visible dot weight at small sizes, rather than scaling the control.
              expect(dot.diameter).toBeGreaterThanOrEqual(0.15);
              expect(dot.diameter).toBeLessThanOrEqual(0.2);
              expect(dot.y).toBe(12);
              expect(dot.fill).toBe(dot.color);
            }
            expect(dots[0].diameter).toBe(dots[1].diameter);
            expect(dots[1].diameter).toBe(dots[2].diameter);
            expect(dots[1].x).toBe(12);
            expect(dots[1].x - dots[0].x).toBe(dots[2].x - dots[1].x);
            expect(dots[1].x - dots[0].x - dots[0].diameter * 24).toBeGreaterThan(2);
          }
          const before = await trigger.boundingBox();
          await trigger.focus();
          await expect(trigger).toBeFocused();
          await trigger.hover();
          expect((await trigger.boundingBox())!.width).toBe(before!.width);
          expect((await trigger.boundingBox())!.height).toBe(before!.height);
          await trigger.press('Enter');
          await expect(page.getByRole('menu')).toBeVisible();
          await expect(page.getByRole('menuitem')).toBeFocused();
          await page.keyboard.press('Escape');
          await expect(page.getByRole('menu')).toBeHidden();
        }
      });
    }
  });
}

for (const dpr of [1, 2, 3]) {
  test.describe(`Information symbols DPR ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });
    for (const theme of ['dark', 'light']) {
      test(`share optically balanced geometry in ${theme}`, async ({ page }, testInfo) => {
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 600 });
          await page.goto(`${fixture.url}icon-system.html?information-icons=1&theme=${theme}`);
          const actions = page.getByTestId('information-actions');
          const query = actions.getByRole('button', { name: 'Query usage', exact: true });
          const help = actions.getByRole('button', { name: 'Help', exact: true });
          const samples = page.getByTestId('information-samples');
          await expect(query.locator('[data-mar-icon="info"]')).toBeVisible();
          await expect(help.locator('[data-mar-icon="help"]')).toBeVisible();
          await page.screenshot({
            path: testInfo.outputPath(`information-${theme}-${width}.png`)
          });
          for (const name of ['info', 'help']) {
            const graphics = samples.locator(`[data-mar-icon="${name}"]`);
            await expect(graphics).toHaveCount(4);
            for (const graphic of await graphics.all()) {
              const geometry = await graphic.evaluate((element) => {
                const svg = element as SVGSVGElement;
                const circle = svg.querySelector('circle')!;
                const stroke = parseFloat(getComputedStyle(circle).strokeWidth);
                const diameter = circle.r.baseVal.value * 2 + stroke;
                const bounds = svg.getBBox();
                return {
                  diameter,
                  cx: circle.cx.baseVal.value,
                  cy: circle.cy.baseVal.value,
                  min: Math.min(bounds.x - stroke / 2, bounds.y - stroke / 2),
                  max: Math.max(bounds.x + bounds.width, bounds.y + bounds.height) + stroke / 2,
                  stroke: getComputedStyle(svg).stroke,
                  color: getComputedStyle(svg).color,
                  markup: svg.innerHTML
                };
              });
              // Sparse circular symbols need optical overshoot, not a larger CSS box.
              expect(geometry.diameter).toBeGreaterThanOrEqual(20);
              expect(geometry.diameter).toBeLessThanOrEqual(21.5);
              expect(geometry.cx).toBe(12);
              expect(geometry.cy).toBe(12);
              expect(geometry.min).toBeGreaterThan(0);
              expect(geometry.max).toBeLessThan(24);
              expect(geometry.stroke).toBe(geometry.color);
              const adapter = actions.locator(`[data-mar-icon="${name}"]`);
              expect(await adapter.evaluate((svg) => svg.innerHTML)).toBe(geometry.markup);
              await expect(graphic).toHaveAttribute('aria-hidden', 'true');
            }
          }
          const before = await query.boundingBox();
          await query.focus();
          await query.press('Enter');
          await expect(query).toBeDisabled();
          await expect(query.locator('[data-mar-icon="loading-action"]')).toBeVisible();
          expect((await query.boundingBox())!.width).toBeCloseTo(before!.width, 1);
        }
      });
    }
  });
}

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
  test(`Workspace unread badges stay legible across viewports: ${theme}`, async ({
    page
  }, testInfo) => {
    for (const locale of ['en-US', 'zh-CN']) {
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(`${fixture.url}workspace-tabs.html?locale=${locale}`);
        await page.evaluate(
          (value) => document.documentElement.setAttribute('data-theme', value),
          theme === 'light' ? 'daylight' : 'vscode-dark-2026'
        );
        const tabs = page.locator('.workspace-tab');
        const badge = tabs.first().locator('.workspace-tab-unread');
        await expect(badge).toHaveText(locale === 'en-US' ? 'Unread' : '未读');
        for (const tab of [tabs.first(), tabs.nth(1)]) {
          await tab.getByRole('tab').click();
          await expect(badge).toHaveCSS('border-top-width', '0px');
          const visible = await badge.evaluate((element) => {
            const style = getComputedStyle(element);
            const parent = element.closest('.workspace-tab')!;
            const surface = getComputedStyle(parent).backgroundColor;
            return { fill: style.backgroundColor, surface };
          });
          expect(visible.fill).not.toBe('rgba(0, 0, 0, 0)');
          expect(visible.fill).not.toBe(visible.surface);
        }
        if (locale === 'en-US') {
          await tabs.first().screenshot({
            path: testInfo.outputPath(`unread-${theme}-${width}.png`)
          });
        }
      }
    }
  });

  test(`Mobile action icons keep their visual hierarchy without scaling text or status: ${theme}`, async ({
    page
  }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    for (const width of [390, 320, 360, 420, 1280]) {
      const mobile = width < 768;
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${fixture.url}icon-system.html?composer-icons=1&theme=${theme}`);
      const attachment = page.locator('.composer-attachment-button .mar-icon');
      const attachmentButton = page.locator('.composer-attachment-button');
      const copy = page.locator('.conversation-message-action .mar-icon').first();
      const edit = page.getByRole('button', { name: 'Edit', exact: true });
      const send = page.locator('.composer-send-button');
      const stop = page.locator('.composer-stop-button');
      const rootFontSize = await page.evaluate(() =>
        parseFloat(getComputedStyle(document.documentElement).fontSize)
      );
      const expectedPrimary = mobile ? 18 : 0.92 * rootFontSize;
      for (const action of [send, stop]) {
        const graphic = action.locator('.mar-icon');
        await expect(graphic).toBeVisible();
        expect((await graphic.boundingBox())!.width).toBeCloseTo(expectedPrimary, 1);
        expect((await action.boundingBox())!.width).toBe(mobile ? 28 : 24);
      }
      const plane = await send.locator('[data-mar-icon="send"]').evaluate((element) => {
        const svg = element as SVGSVGElement;
        const paths = svg.querySelectorAll('path');
        const outline = paths[0];
        const crease = paths[paths.length - 1];
        const start = crease.getPointAtLength(0);
        const end = crease.getPointAtLength(crease.getTotalLength());
        const nose = outline.getPointAtLength(0);
        const bounds = svg.getBBox();
        const stroke = parseFloat(getComputedStyle(svg).strokeWidth);
        const radius =
          Math.max(
            ...Array.from(paths).flatMap((path) =>
              Array.from({ length: 65 }, (_, index) => {
                const point = path.getPointAtLength((path.getTotalLength() * index) / 64);
                return Math.hypot(point.x - 12, point.y - 12);
              })
            )
          ) +
          stroke / 2;
        return {
          dx: end.x - start.x,
          dy: end.y - start.y,
          join: Math.hypot(end.x - nose.x, end.y - nose.y),
          radius,
          min: Math.min(bounds.x, bounds.y) - stroke / 2,
          max: Math.max(bounds.x + bounds.width, bounds.y + bounds.height) + stroke / 2
        };
      });
      // The crease reaches the upper-right nose; it is not a floating bar in a play triangle.
      expect(plane.dx).toBeGreaterThan(5);
      expect(plane.dy).toBeLessThan(-5);
      expect(plane.join).toBeLessThan(0.01);
      // Keep the painted plane inside a circular keyline, not only the square viewBox.
      expect(plane.radius).toBeLessThanOrEqual(11.25);
      expect(plane.min).toBeGreaterThan(0);
      expect(plane.max).toBeLessThan(24);
      if (mobile) {
        await expect(attachment).toHaveCSS('width', '16px');
        await expect(attachment).toHaveCSS('height', '16px');
        for (const graphic of [copy, edit.locator('.mar-icon')]) {
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
      const attachmentBox = (await attachmentButton.boundingBox())!;
      const attachmentGraphic = (await attachment.boundingBox())!;
      const sendBox = (await send.boundingBox())!;
      expect(attachmentBox.width).toBe(mobile ? 28 : 26);
      expect(attachmentBox.height).toBe(attachmentBox.width);
      const modelBox = (await page.locator('.composer-model-slot').boundingBox())!;
      expect(modelBox.width).toBeGreaterThan(0);
      expect(attachmentBox.x + attachmentBox.width).toBeLessThanOrEqual(modelBox.x);
      expect(modelBox.x + modelBox.width).toBeLessThanOrEqual(sendBox.x);
      expect(attachmentGraphic.x + attachmentGraphic.width / 2).toBeCloseTo(
        attachmentBox.x + attachmentBox.width / 2,
        1
      );
      expect(attachmentGraphic.y + attachmentGraphic.height / 2).toBeCloseTo(
        sendBox.y + sendBox.height / 2,
        1
      );
      await expect(attachmentButton).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await attachmentButton.focus();
      await expect(attachmentButton).toBeFocused();
      await expect(attachmentButton).toHaveCSS('outline-style', 'solid');
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        attachmentButton.press('Enter')
      ]);
      expect(fileChooser.isMultiple()).toBe(true);
      await fileChooser.setFiles([]);
      await attachmentButton.evaluate((button) => button.blur());
      await expect(page.getByTestId('status-icon').locator('.mar-icon')).toHaveCSS('width', '11px');
      await expect(
        page.getByRole('button', { name: 'Explicit icon size' }).locator('.mar-icon')
      ).toHaveCSS('width', '24px');
      if (width === 390) {
        await page.screenshot({ path: testInfo.outputPath(`mobile-icons-${theme}.png`) });
      }
      if (width === 1280) {
        await page.screenshot({
          path: testInfo.outputPath(`send-ready-${theme}-desktop.png`)
        });
      }
      await stop.click();
      await expect(page.getByTestId('stops')).toHaveText('1');
      const readyColors = await send.evaluate((button) => {
        const style = getComputedStyle(button);
        const circle = getComputedStyle(button, '::before');
        return {
          color: style.color,
          background: style.backgroundColor,
          border: style.borderTopColor,
          circleBackground: circle.backgroundColor,
          circleBorder: circle.borderTopColor
        };
      });
      await send.focus();
      await send.press('Enter');
      await expect(page.getByTestId('sends')).toHaveText('1');
      await expect(send).toBeDisabled();
      await expect(send).toHaveAttribute('aria-busy', 'true');
      const pending = send.locator('[data-mar-icon="loading-action"]');
      await expect(pending).toHaveCSS('animation-duration', '1s');
      await expect(send).toHaveCSS('color', readyColors.color);
      await expect(send).toHaveCSS('background-color', readyColors.background);
      await expect(send).toHaveCSS('border-top-color', readyColors.border);
      await expect(send).toHaveCSS('cursor', 'progress');
      expect(
        await send.evaluate((button) => {
          const circle = getComputedStyle(button, '::before');
          return { background: circle.backgroundColor, border: circle.borderTopColor };
        })
      ).toEqual({ background: readyColors.circleBackground, border: readyColors.circleBorder });
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('sends')).toHaveText('1');
      // Rotation changes the painted bounds, not the icon's layout size.
      const pendingSize = await pending.evaluate((graphic) => {
        const style = getComputedStyle(graphic);
        return { width: parseFloat(style.width), height: parseFloat(style.height) };
      });
      expect(pendingSize.width).toBeCloseTo(expectedPrimary, 1);
      expect(pendingSize.height).toBeCloseTo(expectedPrimary, 1);
      if (width !== 360) {
        await page.screenshot({
          path: testInfo.outputPath(`sending-${theme}-${mobile ? 'mobile' : 'desktop'}.png`)
        });
      }
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await expect(pending).toHaveCSS('animation-name', 'none');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.goto(
        `${fixture.url}icon-system.html?composer-icons=1&empty-draft=1&theme=${theme}`
      );
      await expect(send).toBeDisabled();
      await expect(send).not.toHaveAttribute('aria-busy', 'true');
      await expect(send.locator('[data-mar-icon="send"]')).toBeVisible();
      await expect(send).toHaveCSS('cursor', 'not-allowed');
      await expect(send).not.toHaveCSS('color', readyColors.color);
    }
    expect(errors).toEqual([]);
  });

  test(`Mobile draft attachment stays reachable beside long configuration: ${theme}`, async ({
    browser
  }, testInfo) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 360 },
      isMobile: true,
      hasTouch: true
    });
    try {
      const page = await context.newPage();
      for (const width of [320, 390, 420]) {
        await page.setViewportSize({ width, height: 360 });
        await page.goto(
          `${fixture.url}icon-system.html?composer-icons=1&draft-session=1&empty-draft=1&theme=${theme}`
        );
        const attachment = page.locator('.composer-attachment-button');
        const runner = page.locator('.composer-runner-slot');
        const model = page.locator('.composer-model-slot');
        const access = page.locator('.composer-access-slot');
        const send = page.locator('.composer-send-button');
        await expect(runner).toBeVisible();
        await expect(send).toBeDisabled();
        let rightEdge = 0;
        for (const control of [attachment, runner, model, access, send]) {
          const box = (await control.boundingBox())!;
          expect(box.width).toBeGreaterThan(0);
          expect(box.x).toBeGreaterThanOrEqual(rightEdge);
          expect(box.y).toBeGreaterThanOrEqual(0);
          expect(box.y + box.height).toBeLessThanOrEqual(360);
          rightEdge = box.x + box.width;
        }
        expect(rightEdge).toBeLessThanOrEqual(width);
        const [fileChooser] = await Promise.all([
          page.waitForEvent('filechooser'),
          attachment.tap()
        ]);
        expect(fileChooser.isMultiple()).toBe(true);
        await fileChooser.setFiles([]);
        await expect(page.getByTestId('sends')).toHaveText('0');
        await model.tap();
        const modelOption = page.getByRole('option', { name: 'GPT-6-Luna Xhigh', exact: true });
        await expect(modelOption).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(modelOption).toBeHidden();
        await attachment.focus();
        await attachment.evaluate((button) => button.blur());
        await page.screenshot({ path: testInfo.outputPath(`draft-attachment-${width}.png`) });
      }
    } finally {
      await context.close();
    }
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
  test(`Recent Sessions shortcut owns Ctrl and Cmd Shift E without opening notifications: ${mobile ? 'mobile' : 'desktop'}`, async ({
    page
  }) => {
    await page.setViewportSize({ width: mobile ? 390 : 1280, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${fixture.url}icon-system.html?navigation=1${mobile ? '&mobile=1' : ''}`);
    const recent = page.locator('.recent-sessions-trigger');
    const notifications = page.locator('.workbench-notification-trigger');
    await expect(recent).toHaveAttribute('aria-expanded', 'false');
    for (const modifier of ['Control', 'Meta']) {
      await page.keyboard.press(`${modifier}+Shift+E`);
      await expect(recent).toHaveAttribute('aria-expanded', 'true');
      await expect(notifications).toHaveAttribute('aria-expanded', 'false');
      if (!mobile) await expect(recent).toBeFocused();
      const repeated = await page.evaluate(() => {
        const event = new KeyboardEvent('keydown', {
          key: 'E',
          ctrlKey: true,
          shiftKey: true,
          repeat: true,
          cancelable: true,
          bubbles: true
        });
        document.body.dispatchEvent(event);
        return event.defaultPrevented;
      });
      expect(repeated).toBe(true);
      await expect(recent).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press(`${modifier}+Shift+E`);
      await expect(recent).toHaveAttribute('aria-expanded', 'false');
    }
    for (const extra of [{ isComposing: true }, { altKey: true }, { shiftKey: false }]) {
      expect(
        await page.evaluate((extra) => {
          const event = new KeyboardEvent('keydown', {
            key: 'E',
            ctrlKey: true,
            shiftKey: true,
            cancelable: true,
            bubbles: true,
            ...extra
          });
          document.body.dispatchEvent(event);
          return event.defaultPrevented;
        }, extra)
      ).toBe(false);
      await expect(recent).toHaveAttribute('aria-expanded', 'false');
    }
    await page.evaluate(() => {
      const terminal = document.createElement('div');
      terminal.className = 'terminal-dock';
      const input = document.createElement('input');
      input.setAttribute('aria-label', 'Terminal shortcut boundary');
      terminal.append(input);
      document.body.append(terminal);
    });
    // Dispatch at the terminal target: the navigation-only mobile fixture keeps its drawer focus trap active.
    expect(
      await page.getByLabel('Terminal shortcut boundary').evaluate((input) => {
        const event = new KeyboardEvent('keydown', {
          key: 'E',
          ctrlKey: true,
          shiftKey: true,
          cancelable: true,
          bubbles: true
        });
        input.dispatchEvent(event);
        return event.defaultPrevented;
      })
    ).toBe(false);
    await expect(recent).toHaveAttribute('aria-expanded', 'false');
    if (!mobile) {
      await notifications.click();
      await page.locator('.workbench-notification-panel').evaluate((panel) => {
        panel.setAttribute('tabindex', '-1');
        (panel as HTMLElement).focus();
      });
      await expect(notifications).toHaveAttribute('aria-expanded', 'true');
      await recent.focus();
      await expect(notifications).toHaveAttribute('aria-expanded', 'false');
      await expect(recent).toHaveAttribute('aria-expanded', 'false');
    }
    await notifications.click();
    await expect(notifications).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Control+Shift+E');
    await expect(recent).toHaveAttribute('aria-expanded', 'true');
    await expect(notifications).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Control+Shift+E');
    await expect(recent).toHaveAttribute('aria-expanded', 'false');
    // Removing the owning view must also remove its global shortcut listener.
    await page.evaluate(() => {
      const app = document.querySelector('#app') as HTMLElement & {
        __vue_app__: { unmount(): void };
      };
      app.__vue_app__.unmount();
    });
    expect(
      await page.evaluate(() => {
        const event = new KeyboardEvent('keydown', {
          key: 'E',
          ctrlKey: true,
          shiftKey: true,
          cancelable: true,
          bubbles: true
        });
        document.body.dispatchEvent(event);
        return event.defaultPrevented;
      })
    ).toBe(false);
  });

  test(`Navigation icons stay centered with recent-session badges: ${mobile ? 'mobile' : 'desktop'}`, async ({
    page
  }) => {
    await page.setViewportSize({ width: mobile ? 390 : 1280, height: 900 });
    for (const count of [0, 6, 12, 120]) {
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
        await expect(badge).toHaveText(count > 99 ? '99+' : String(count));
        const badgeBounds = await badge.boundingBox();
        expect(badgeBounds!.x + badgeBounds!.width).toBeLessThanOrEqual(
          bounds!.x + bounds!.width + (mobile ? 9 : 0)
        );
        if (!mobile && count === 6) {
          expect(badgeBounds!.x).toBeLessThan(graphic!.x + graphic!.width);
          expect(badgeBounds!.x + badgeBounds!.width).toBeGreaterThan(graphic!.x + graphic!.width);
          expect(badgeBounds!.y).toBeLessThan(graphic!.y + graphic!.height / 2);
        }
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

for (const { theme, locale } of [
  { theme: 'dark', locale: 'zh-CN' },
  { theme: 'light', locale: 'en-US' }
]) {
  test(`Recent-session unread badges do not move or cover navigation icons: ${theme} ${locale}`, async ({
    page
  }, testInfo) => {
    for (const width of [320, 390, 430, 1024, 1280]) {
      const mobile = width < 768;
      await page.setViewportSize({ width, height: 900 });
      const url = `${fixture.url}icon-system.html?navigation=1&theme=${theme}&locale=${locale}${mobile ? '&mobile=1' : ''}`;
      await page.goto(`${url}&count=0`);
      const buttons = page.locator('.activity-rail nav button');
      const trigger = page.locator('.recent-sessions-trigger');
      await expect(trigger).toBeVisible();
      const baseline = await buttons.evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().toJSON())
      );
      await page.goto(`${url}&count=99&unread=1`);
      const badge = trigger.locator('.recent-sessions-badge');
      await expect(badge.locator('.session-state-count')).toHaveText('99');
      const unread = badge.locator(
        mobile ? '.recent-sessions-mobile-unread' : '.session-state-unread'
      );
      await expect(unread).toBeVisible();
      await expect(badge).toHaveCSS('border-top-width', '0px');
      if (!mobile) {
        await expect(unread).toHaveText(locale === 'zh-CN' ? '未读' : 'Unread');
        await expect(unread).toHaveCSS('border-left-width', '0px');
        await expect(badge).toHaveCSS('right', '0px');
      }
      const notificationBadge = page.locator('.workbench-notification-badge');
      await expect(notificationBadge).toHaveCSS('border-top-width', '0px');
      const countColors = await badge.locator('.session-state-count').evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        color: getComputedStyle(element).color
      }));
      await expect(notificationBadge).toHaveCSS('background-color', countColors.background);
      await expect(notificationBadge).toHaveCSS('color', countColors.color);
      const positions = await buttons.evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().toJSON())
      );
      expect(positions).toEqual(baseline);
      const bounds = (await badge.boundingBox())!;
      const navigation = (await page.locator('.activity-rail nav').boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(navigation.x);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(navigation.x + navigation.width);
      const otherIcons = await buttons
        .locator('.mar-icon:not([data-mar-icon="recent-sessions"])')
        .evaluateAll((elements) =>
          elements.map((element) => element.getBoundingClientRect().toJSON())
        );
      for (const icon of otherIcons) {
        const overlaps =
          bounds.x < icon.right &&
          bounds.x + bounds.width > icon.left &&
          bounds.y < icon.bottom &&
          bounds.y + bounds.height > icon.top;
        expect(overlaps).toBe(false);
      }
      if (mobile) {
        await expect(trigger).toHaveCSS('width', '36px');
        const icon = (await trigger.locator('[data-mar-icon="recent-sessions"]').boundingBox())!;
        const marker = (await unread.boundingBox())!;
        expect(marker.width).toBe(6);
        expect(Math.abs(bounds.x + bounds.width - (icon.x + icon.width + 3))).toBeLessThan(1);
        expect(bounds.y).toBeLessThan(icon.y + icon.height / 2);
        expect(Math.abs(marker.x + marker.width / 2 - (bounds.x + bounds.width))).toBeLessThan(4);
        await trigger.click();
        const selectedBackground = await trigger.evaluate(
          (element) => getComputedStyle(element).backgroundColor
        );
        expect(await unread.evaluate((element) => getComputedStyle(element).boxShadow)).toContain(
          selectedBackground
        );
        await trigger.click();
        await page.screenshot({
          path: testInfo.outputPath(`recent-sessions-${width}.png`),
          clip: { x: 0, y: 0, width, height: 84 }
        });
      } else {
        await trigger.hover();
        await expect(page.locator('.mar-tooltip:visible')).toContainText(
          locale === 'zh-CN' ? '未读' : 'Unread'
        );
      }
    }
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(
      `${fixture.url}icon-system.html?navigation=1&mobile=1&count=1&unread=1&theme=${theme}&locale=${locale}`
    );
    await expect(page.locator('.recent-sessions-badge .session-state-count')).toHaveText('1');
    await expect(page.locator('.recent-sessions-mobile-unread')).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('recent-sessions-one-unread.png'),
      clip: { x: 0, y: 0, width: 390, height: 84 }
    });
    await page.goto(
      `${fixture.url}icon-system.html?navigation=1&mobile=1&count=0&unread=1&theme=${theme}&locale=${locale}`
    );
    const badge = page.locator('.recent-sessions-badge');
    await expect(badge.locator('.session-state-count')).toHaveCount(0);
    await expect(badge).toHaveCSS('overflow', 'visible');
    const marker = badge.locator('.recent-sessions-mobile-unread');
    await expect(marker).toBeVisible();
    const icon = (await page.locator('[data-mar-icon="recent-sessions"]').boundingBox())!;
    const markerBounds = (await marker.boundingBox())!;
    expect(markerBounds.width).toBe(8);
    expect(markerBounds.x).toBeLessThan(icon.x + icon.width);
    expect(markerBounds.x + markerBounds.width).toBeGreaterThan(icon.x + icon.width);
    expect(markerBounds.y + markerBounds.height).toBeGreaterThan(icon.y + 4);
    expect(markerBounds.y).toBeLessThan(icon.y + icon.height / 2);
    await page.screenshot({
      path: testInfo.outputPath('recent-sessions-unread-only.png'),
      clip: { x: 0, y: 0, width: 390, height: 84 }
    });
    const trigger = page.locator('.recent-sessions-trigger');
    await trigger.click();
    const selectedBackground = await trigger.evaluate(
      (element) => getComputedStyle(element).backgroundColor
    );
    expect(await marker.evaluate((element) => getComputedStyle(element).boxShadow)).toContain(
      selectedBackground
    );
    await page.locator('.workbench-notification-trigger').click();
    await page.locator('.workbench-notification-mark-all').click();
    await expect(badge).toHaveCount(0);
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
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(close.locator('svg')).toHaveCSS('width', '14px');
  await expect(page.locator('.terminal-tab-add svg')).toHaveCSS('width', '18px');
  await close.focus();
  await page.keyboard.press('Enter');
  await expect(close).toHaveCount(0);
  expect(closed).toEqual(['/api/terminals/fixture-terminal']);
});

test('Terminal headers keep multiple shell profiles reachable on narrow screens', async ({
  page
}) => {
  const openedProfiles: string[] = [];
  await page.route('**/api/terminals**', async (route) => {
    if (route.request().method() === 'POST') {
      const profileId = route.request().postDataJSON().profileId as string;
      openedProfiles.push(profileId);
      await route.fulfill({
        json: {
          terminal: {
            id: `fixture-terminal-${openedProfiles.length}`,
            workspaceId: 'project',
            profileId,
            state: 'RUNNING',
            latestSequence: 0
          }
        }
      });
    } else {
      await route.fulfill({ json: { terminals: [] } });
    }
  });
  for (const theme of ['light', 'dark']) {
    for (const width of [320, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(
        `${fixture.url}icon-system.html?terminal=1&multipleProfiles=1&theme=${theme}`
      );
      await expect(page.getByRole('tab', { name: 'Terminal 1', exact: true })).toBeVisible();
      const profile = page.getByRole('combobox');
      await expect(profile).toBeVisible();
      const bounds = await page.locator('.admin-terminal-header').evaluate((header) => {
        const headerBox = header.getBoundingClientRect();
        const selectBox = header.querySelector('.el-select')!.getBoundingClientRect();
        const tabsBox = header.querySelector('.terminal-tabs')!.getBoundingClientRect();
        return {
          height: tabsBox.top - headerBox.top,
          left: selectBox.left - headerBox.left,
          right: headerBox.right - selectBox.right,
          tabsGap: tabsBox.top - selectBox.bottom
        };
      });
      expect(bounds.height).toBeLessThanOrEqual(72);
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeGreaterThanOrEqual(0);
      expect(bounds.tabsGap).toBeGreaterThanOrEqual(0);
      await page.locator('.terminal-profile .el-select').click();
      await page.getByRole('option', { name: 'Other shell', exact: true }).click();
      await page.getByRole('button', { name: 'New terminal', exact: true }).click();
      await expect(page.getByRole('tab', { name: 'Terminal 2', exact: true })).toBeVisible();
      expect(openedProfiles.at(-1)).toBe('other-shell');
    }
  }
});

test('Touch usage counts reveal exact values and cache details without requiring focus', async ({
  browser
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true
  });
  try {
    const page = await context.newPage();
    await page.goto(`${fixture.url}icon-system.html?usage=1&touch-details=1`);
    const overview = page.locator('.overview-cell').first();
    const input = overview.locator('.usage-count').nth(0);
    const cache = overview.locator('.usage-count').nth(1);
    const hint = page.locator('[role="tooltip"]:visible');
    await expect(input).not.toContainText('1,234,567');
    await input.tap();
    await expect(hint).toHaveText('1,234,567');
    await cache.tap();
    await expect(hint).toContainText('Cache read tokens: 345,678');
    await expect(hint).toContainText('Cache write tokens: 2,345');
    await expect(hint).toHaveCount(1);
    await overview.locator('h3').tap();
    await expect(hint).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('Usage chart hover details do not create a focus outline', async ({ page }) => {
  for (const theme of ['light', 'dark']) {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${fixture.url}icon-system.html?usage=1&theme=${theme}`);
      await expect(
        page.getByRole('heading', { name: 'Usage statistics', exact: true })
      ).toBeVisible();
      await expect(
        page.getByText('Agent usage for the current account', { exact: true })
      ).toBeVisible();
      const bucket = page.locator('.trend-bucket').first();
      const hint = page.locator('[role="tooltip"]:visible');
      await bucket.hover();
      await expect(hint).toContainText('Input tokens:');
      await bucket.click();
      await expect(bucket).not.toBeFocused();
      await expect(bucket).toHaveCSS('outline-style', 'none');
      await expect(hint).toContainText('Input tokens:');
      await page.getByRole('heading', { name: 'Usage statistics', exact: true }).hover();
      await expect(hint).toHaveCount(0);
    }
  }
});

test('Usage chart dimensions do not leak into calendar icons', async ({ page }) => {
  await page.goto(`${fixture.url}icon-system.html?usage=1`);
  const chart = page.locator('[data-testid="usage-statistics"] svg[role="img"]');
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
      await expect(create).toBeFocused();
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
      const check = page.locator('.icon-review-grid [data-mar-icon="check"]');
      await expect(check).toBeVisible();
      await expect(check).toHaveAttribute('stroke-width', '1.75');
      const checkBounds = await check.locator('path').evaluate((path) => {
        const bounds = (path as SVGPathElement).getBBox();
        return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      });
      // The check should fill its canvas without thicker strokes or clipped endpoints.
      expect(checkBounds.width).toBeGreaterThanOrEqual(16);
      expect(checkBounds.height).toBeGreaterThanOrEqual(11);
      expect(checkBounds.x).toBeGreaterThanOrEqual(1);
      expect(checkBounds.y).toBeGreaterThanOrEqual(1);
      expect(checkBounds.x + checkBounds.width).toBeLessThanOrEqual(23);
      expect(checkBounds.y + checkBounds.height).toBeLessThanOrEqual(23);
      const reasoning = page.locator('.icon-review-grid [data-mar-icon="reasoning"]');
      await expect(reasoning).toBeVisible();
      await expect(reasoning).toHaveCSS('animation-name', 'none');
      await expect(reasoning).toHaveAttribute('fill', 'none');
      const stars = await reasoning.locator('path').evaluateAll((paths) =>
        paths.map((path) => {
          const bounds = (path as SVGPathElement).getBBox();
          return { width: bounds.width, height: bounds.height };
        })
      );
      expect(stars).toHaveLength(2);
      expect(stars[0].width).toBeGreaterThan(stars[1].width);
      expect(stars[0].height).toBeGreaterThan(stars[1].height);
      const administration = page.locator('.icon-review-grid [data-mar-icon="administration"]');
      await expect(administration).toBeVisible();
      await expect(administration).toHaveAttribute('fill', 'none');
      const controls = await administration.locator('circle').evaluateAll((circles) =>
        circles.map((circle) => ({
          x: (circle as SVGCircleElement).cx.baseVal.value,
          y: (circle as SVGCircleElement).cy.baseVal.value
        }))
      );
      expect(controls).toHaveLength(2);
      expect(controls[0].x).toBeLessThan(controls[1].x);
      expect(controls[0].y).toBeLessThan(controls[1].y);
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
