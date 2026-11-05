import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

test.describe('HTML Browser content', () => {
  test.use({ locale: 'en-US' });
  for (const width of [1280, 390]) {
    for (const theme of ['light', 'dark']) {
      test(`Browser is closable content with a compact toolbar (${theme}, ${width}px)`, async ({
        page
      }, testInfo) => {
        const fixture = await startCustomThemeFixture('test/e2e/support/workbench-aside.html');
        try {
          await page.setViewportSize({ width, height: 900 });
          const filename = `${'workspace-html-preview-'.repeat(7)}index.html`;
          const grants: string[] = [];
          await page.route('**/api/html-preview/grants', async (route) => {
            grants.push(route.request().postDataJSON().path);
            await route.fulfill({
              contentType: 'application/json',
              body: JSON.stringify({ url: new URL('/html-preview-test', fixture.url).href })
            });
          });
          await page.route('**/html-preview-test', (route) =>
            route.fulfill({
              contentType: 'text/html',
              body: '<h1>HTML content</h1>'
            })
          );
          await page.goto(
            `${fixture.url}workbench-aside.html?theme=${theme}&html-file=${encodeURIComponent(filename)}${width < 768 ? '&mobile' : ''}`
          );
          const tabs = page.getByRole('tablist', { name: 'Workbench Aside' });
          const browser = tabs.getByRole('tab', { name: 'Browser', exact: true });
          const files = tabs.getByRole('tab', { name: 'Files', exact: true });
          await expect(browser).toHaveCount(0);
          await page.getByRole('button', { name: 'Preview HTML', exact: true }).click();
          await expect(browser).toHaveAttribute('aria-selected', 'true');
          await expect(tabs.getByRole('tab').last()).toHaveText('Browser');
          await expect(
            tabs.getByRole('button', { name: 'Close Browser', exact: true })
          ).toBeVisible();
          await expect(
            page.frameLocator('iframe').getByRole('heading', { name: 'HTML content' })
          ).toBeVisible();
          const panel = page.locator('.html-browser');
          await expect(panel.locator('.warning')).toHaveCount(0);
          await expect(panel.getByText(/Trusted code:|Isolated preview/)).toHaveCount(0);
          const name = panel.locator('.html-browser-file-name');
          await expect(name).toHaveText(filename);
          expect(
            await name.evaluate((element) => ({
              overflow: element.scrollWidth > element.clientWidth,
              ellipsis: getComputedStyle(element).textOverflow === 'ellipsis'
            }))
          ).toEqual({ overflow: false, ellipsis: false });
          for (const label of ['Reload', 'Open source', 'Open in browser']) {
            const button = panel.getByRole('button', { name: label, exact: true });
            await expect(button).toHaveClass(/el-button--small/);
            await expect(button.locator('svg')).toHaveCount(1);
            await expect(button).toHaveText('');
          }
          await panel.getByRole('button', { name: 'Reload', exact: true }).focus();
          await page.keyboard.press('Enter');
          await expect.poll(() => grants.length).toBe(2);
          await expect(
            page.frameLocator('iframe').getByRole('heading', { name: 'HTML content' })
          ).toBeVisible();
          await panel.getByRole('button', { name: 'Open source', exact: true }).hover();
          await expect(page.locator('.mar-tooltip:visible')).toHaveText('Open source');
          await page.locator('.workbench-aside').screenshot({
            path: testInfo.outputPath(`html-browser-${theme}-${width}.png`),
            animations: 'disabled'
          });
          await files.click();
          await expect(page.locator('.html-browser')).toHaveCount(0);
          await expect(browser).toHaveCount(1);
          await browser.click();
          await expect.poll(() => grants.length).toBe(3);
          await tabs.getByRole('button', { name: 'Close Browser', exact: true }).click();
          await expect(browser).toHaveCount(0);
          await expect(page.locator('iframe')).toHaveCount(0);
          await expect(tabs.getByRole('tab', { name: 'Child', exact: true })).toHaveAttribute(
            'aria-selected',
            'true'
          );
          await page.getByRole('button', { name: 'Preview HTML', exact: true }).click();
          await expect.poll(() => grants.length).toBe(4);
          await files.click();
          await tabs.getByRole('button', { name: 'Close Browser', exact: true }).click();
          await expect(files).toHaveAttribute('aria-selected', 'true');
          await expect(browser).toHaveCount(0);
        } finally {
          await fixture.close();
        }
      });
    }
  }
});

for (const [language, theme, width] of [
  ['en', 'light', 1280],
  ['en', 'dark', 1280],
  ['zh', 'light', 1280],
  ['zh', 'dark', 1280],
  ['en', 'custom', 1280],
  ['en', 'light', 390],
  ['en', 'dark', 390],
  ['zh', 'light', 390],
  ['zh', 'dark', 390],
  ['en', 'custom', 390]
] as const) {
  test(`Aside tabs keep compact type and bound long titles (${language}, ${theme}, ${width}px)`, async ({
    page
  }) => {
    const fixture = await startCustomThemeFixture('test/e2e/support/workbench-aside.html');
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.goto(
        `${fixture.url}workbench-aside.html?active-child&long-title=${language}&theme=${theme}${width < 768 ? '&mobile' : ''}`
      );
      const tabs = page.getByRole('tablist', { name: 'Workbench Aside' });
      const session = tabs.getByRole('tab', {
        name: language === 'zh' ? /需要保持可读/ : /A long readable/
      });
      await expect(session).toHaveCSS('font-size', width < 768 ? '11px' : '12px');
      await expect(session).toHaveCSS('font-weight', '500');
      const geometry = await session.evaluate((element) => {
        const item = element.closest('.tab-strip-item')!;
        const label = element.querySelector('.workbench-aside-label')!;
        const close = item.querySelector('.tab-strip-close')!;
        const strip = item.closest('[role="tablist"]')!;
        return {
          width: item.getBoundingClientRect().width,
          limit: Math.min(
            15 * Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
            strip.clientWidth
          ),
          truncated: label.scrollWidth > label.clientWidth,
          closeFits: close.getBoundingClientRect().right <= strip.getBoundingClientRect().right + 1,
          headerHeight: item.closest('header')!.getBoundingClientRect().height,
          tabHeight: item.getBoundingClientRect().height,
          activity: (() => {
            const dot = item.querySelector('.workbench-aside-activity')!.getBoundingClientRect();
            const title = label.getBoundingClientRect();
            const button = element.getBoundingClientRect();
            return {
              afterTitle: dot.left >= title.right,
              beforeClose: dot.right <= close.getBoundingClientRect().left,
              centerOffset: Math.abs(dot.top + dot.height / 2 - button.top - button.height / 2)
            };
          })()
        };
      });
      expect(geometry.width).toBeLessThanOrEqual(geometry.limit);
      expect(geometry.truncated).toBe(true);
      expect(geometry.closeFits).toBe(true);
      expect(geometry.headerHeight).toBeLessThanOrEqual(32);
      expect(geometry.tabHeight).toBe(28);
      expect(geometry.activity.afterTitle).toBe(true);
      expect(geometry.activity.beforeClose).toBe(true);
      expect(geometry.activity.centerOffset).toBeLessThan(1);
      const seams = await tabs.evaluate((element) => {
        const items = Array.from(element.querySelectorAll<HTMLElement>('.tab-strip-item'));
        return items.slice(1).flatMap((item, index) => {
          const previous = items[index]!;
          if (previous.nextElementSibling !== item) return [];
          return [previous.getBoundingClientRect().right - item.getBoundingClientRect().left];
        });
      });
      expect(seams.length).toBeGreaterThan(0);
      for (const overlap of seams) expect(overlap).toBeCloseTo(width < 768 ? -4 : 1, 1);
      const borders = await tabs.evaluate((element) => ({
        strip: getComputedStyle(element).borderBottomWidth,
        header: getComputedStyle(element.closest('header')!).borderBottomWidth
      }));
      expect(borders).toEqual({ strip: '0px', header: '1px' });
      const colors = await tabs.evaluate((element) => {
        const probe = document.createElement('span');
        element.append(probe);
        const resolve = (token: string) => {
          probe.style.color = `var(${token})`;
          return getComputedStyle(probe).color;
        };
        const result = {
          primary: resolve('--mar-text-primary'),
          secondary: resolve('--mar-text-secondary'),
          selected: resolve('--mar-fill-selection'),
          success: resolve('--el-color-success')
        };
        probe.remove();
        return result;
      });
      await expect(session).toHaveCSS('color', colors.primary);
      await expect(session.locator('..')).toHaveCSS('background-color', colors.selected);
      await expect(tabs.getByRole('tab', { name: 'Files' })).toHaveCSS('color', colors.secondary);
      const activity = session.locator('.workbench-aside-activity');
      const dot = activity.locator('i');
      await expect(dot).toBeVisible();
      await expect(dot).toHaveCSS('background-color', colors.success);
      await expect(activity).toHaveCSS('overflow', 'visible');
      const glow = await dot.evaluate((element) => {
        const style = getComputedStyle(element);
        return { shadow: style.boxShadow, animation: style.animationName };
      });
      expect(glow.shadow).not.toBe('none');
      expect(glow.animation).not.toBe('none');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await expect(dot).toHaveCSS('animation-name', 'none');
      await expect(dot).toHaveCSS('background-color', colors.success);
      await expect(dot).toHaveCSS('box-shadow', glow.shadow);
      await session.hover();
      await expect(page.locator('.mar-tooltip:visible')).toContainText(await session.innerText());
      await page.locator('.workbench-aside').screenshot({
        path: test.info().outputPath(`aside-tabs-${language}-${theme}-${width}.png`)
      });
      await tabs.getByRole('tab', { name: 'Files', exact: true }).click();
      await expect(tabs.getByRole('tab', { name: 'Files', exact: true })).toHaveAttribute(
        'aria-selected',
        'true'
      );
      await page.locator('.workbench-aside').screenshot({
        path: test.info().outputPath(`aside-tools-${language}-${theme}-${width}.png`)
      });
      await tabs.getByRole('button', { name: /^Close / }).click();
      await expect(session).toHaveCount(0);
    } finally {
      await fixture.close();
    }
  });
}

for (const width of [1280, 390]) {
  test(`MarTab overflow stays compact and navigable at ${width}px`, async ({
    browser,
    browserName
  }) => {
    const fixture = await startCustomThemeFixture('test/e2e/support/workbench-aside.html');
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      hasTouch: width < 768,
      isMobile: browserName === 'chromium' && width < 768,
      locale: 'en-US',
      reducedMotion: 'reduce'
    });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript(() => {
        localStorage.setItem(
          'mar.locale.v2',
          new URLSearchParams(location.search).get('ui-locale') ?? 'en-US'
        );
      });
      for (const theme of ['light', 'dark', 'custom']) {
        await page.goto(
          `${fixture.url}workbench-aside.html?active-child&long-title=en&theme=${theme}${width < 768 ? '&mobile' : ''}${theme === 'custom' ? '&ui-locale=zh-CN' : ''}`
        );
        const tabs = page.getByRole('tablist', { name: 'Workbench Aside' });
        const host = page.locator('.workbench-aside-tabs');
        const selected = tabs.getByRole('tab', { name: /A long readable/ });
        await expect(selected).toHaveAttribute('aria-selected', 'true');
        await expect(tabs).toHaveCSS('scrollbar-width', 'none');
        expect(
          await tabs.evaluate((el) => (el as HTMLElement).offsetHeight - el.clientHeight)
        ).toBe(0);
        await expect(page.locator('.workbench-aside-header')).toHaveJSProperty('offsetHeight', 32);
        await expect(host).toHaveClass(/can-scroll-previous/);
        const controls = host.locator('.mar-tab-scroll');
        await expect(controls).toHaveCount(2);
        const before = await tabs.evaluate((el) => el.scrollLeft);
        if (width >= 768) {
          await expect(controls.first()).toBeVisible();
          await expect(controls.first()).toHaveAccessibleName(
            theme === 'custom' ? '向左浏览标签' : 'Browse previous tabs'
          );
          await controls.first().hover();
          const tooltip = page.locator('[role="tooltip"]:visible');
          await expect(tooltip).toHaveText(
            theme === 'custom' ? '向左浏览标签' : 'Browse previous tabs'
          );
          expect(
            await controls.first().evaluate((el) => getComputedStyle(el).backgroundColor)
          ).not.toBe('rgba(0, 0, 0, 0)');
          await page.mouse.move(0, 100);
          await controls.first().focus();
          await expect(tooltip).toBeVisible();
          await page.keyboard.press('Escape');
          await expect(tooltip).toHaveCount(0);
          await expect(controls.first()).toBeFocused();
          await controls.first().click();
          await expect.poll(() => tabs.evaluate((el) => el.scrollLeft)).toBeLessThan(before);
          await expect(selected).toHaveAttribute('aria-selected', 'true');
          await expect(controls.last()).toBeEnabled();
          await page.mouse.move(0, 100);
          await controls.last().focus();
          await expect(tooltip).toHaveText(
            theme === 'custom' ? '向右浏览标签' : 'Browse next tabs'
          );
          await controls.last().click();
          await expect.poll(() => tabs.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
        } else {
          await expect(controls.first()).toBeHidden();
          await expect(controls.last()).toBeHidden();
          await expect(tabs).toHaveCSS('mask-image', /linear-gradient/);
          const box = await tabs.boundingBox();
          if (box === null) throw new Error('Tab strip is missing');
          if (browserName === 'chromium') {
            const cdp = await context.newCDPSession(page);
            try {
              const y = box.y + box.height / 2;
              const x = box.x + box.width * 0.2;
              await cdp.send('Input.dispatchTouchEvent', {
                type: 'touchStart',
                touchPoints: [{ x, y }]
              });
              for (let step = 1; step <= 8; step++) {
                await cdp.send('Input.dispatchTouchEvent', {
                  type: 'touchMove',
                  touchPoints: [{ x: x + (box.width * 0.6 * step) / 8, y }]
                });
              }
              await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            } finally {
              await cdp.detach();
            }
          } else {
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.wheel(-box.width / 2, 0);
          }
          await expect.poll(() => tabs.evaluate((el) => el.scrollLeft)).toBeLessThan(before);
        }
        await page.locator('.workbench-aside-header').screenshot({
          path: test.info().outputPath(`tab-overflow-idle-${width}-${theme}.png`)
        });
        await selected.focus();
        await page.keyboard.press('Home');
        await expect(tabs.getByRole('tab', { name: 'Files', exact: true })).toBeFocused();
        await page.keyboard.press('End');
        await expect(selected).toBeFocused();
        await expect(selected).toHaveAttribute('aria-selected', 'true');
        if (width >= 768) {
          await page.locator('.workbench-aside').evaluate((el) => (el.style.width = '800px'));
          await expect(controls.first()).toBeHidden();
          await page.locator('.workbench-aside').evaluate((el) => (el.style.width = '240px'));
          await expect(controls.first()).toBeVisible();
        } else await page.setViewportSize({ width: 320, height: 900 });
        await expect
          .poll(() =>
            selected.evaluate((el) => {
              const item = el.closest('.tab-strip-item')!.getBoundingClientRect();
              const viewport = el.closest('[role="tablist"]')!.getBoundingClientRect();
              return item.left >= viewport.left - 1 && item.right <= viewport.right + 1;
            })
          )
          .toBe(true);
        await page.locator('.workbench-aside-header').screenshot({
          path: test.info().outputPath(`tab-overflow-${width}-${theme}.png`)
        });
        if (width < 768) await page.setViewportSize({ width, height: 900 });
      }
      expect(errors).toEqual([]);
    } finally {
      await context.close();
      await fixture.close();
    }
  });
}

test('Aside uses shared tabs for tool, session and stable Terminal surfaces', async ({ page }) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/workbench-aside.html');
  try {
    await page.goto(`${fixture.url}workbench-aside.html`);
    const tabs = page.getByRole('tablist', { name: 'Workbench Aside' });
    await expect(tabs.locator('.tab-strip-separator')).toHaveCount(1);
    for (const tab of await tabs.getByRole('tab').all()) {
      expect(
        await tab.evaluate((el) => {
          const panel = document.getElementById(el.getAttribute('aria-controls') ?? '');
          return Boolean(
            el.id &&
            panel?.getAttribute('role') === 'tabpanel' &&
            panel.getAttribute('aria-labelledby') === el.id
          );
        })
      ).toBe(true);
    }
    await expect(tabs.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true');
    const files = page.getByTestId('tool-files');
    const search = page.getByTestId('tool-search');
    await expect(files).toContainText('Tool files');
    await files.getByLabel('Inspector draft').fill('unsaved edit');
    const childIds = await tabs.getByRole('tab', { name: 'Child' }).evaluate((el) => ({
      id: el.id,
      controls: el.getAttribute('aria-controls')
    }));
    await tabs.getByRole('tab', { name: 'Child' }).click();
    await expect(page.locator('#session')).toHaveText('Session child');
    await tabs.getByRole('tab', { name: 'Terminal' }).click();
    await expect(page.locator('#terminal')).toBeVisible();
    await expect(page.locator('#terminal')).toHaveAttribute('data-mounts', '1');
    await tabs.getByRole('tab', { name: 'Search' }).click();
    await expect(search).toHaveAttribute('data-mounts', '1');
    await expect(page.locator('#terminal')).toBeHidden();
    await tabs.getByRole('tab', { name: 'Files' }).click();
    await expect(files.getByLabel('Inspector draft')).toHaveValue('unsaved edit');
    await expect(files).toHaveAttribute('data-mounts', '1');
    expect(
      await tabs.getByRole('tab', { name: 'Child' }).evaluate((el) => ({
        id: el.id,
        controls: el.getAttribute('aria-controls')
      }))
    ).toEqual(childIds);
    await tabs.getByRole('tab', { name: 'Terminal' }).click();
    await expect(page.locator('#terminal')).toHaveAttribute('data-mounts', '1');
    await tabs.getByRole('button', { name: 'Close Child' }).click();
    await expect(tabs.getByRole('tab', { name: 'Child' })).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});

test('MarTab skips disabled tabs and exposes close intent independently', async ({ page }) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/workbench-aside.html');
  try {
    await page.goto(`${fixture.url}workbench-aside.html`);
    const tabs = page.getByRole('tablist', { name: 'Generic tabs' });
    await tabs.getByRole('tab', { name: 'One' }).focus();
    await page.keyboard.press('Alt+ArrowRight');
    await expect(tabs.getByRole('tab', { name: 'One' })).toBeFocused();
    await expect(page.locator('#activations')).toHaveText('0');
    await page.keyboard.press('ArrowRight');
    await expect(tabs.getByRole('tab', { name: 'Last' })).toBeFocused();
    await expect(tabs.getByRole('tab', { name: 'One' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#activations')).toHaveText('0');
    await page.keyboard.press('Enter');
    await expect(tabs.getByRole('tab', { name: 'Last' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#activations')).toHaveText('1');
    await page.keyboard.press('Home');
    await expect(tabs.getByRole('tab', { name: 'One' })).toBeFocused();
    await expect(tabs.getByRole('tab', { name: 'Last' })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Space');
    await expect(tabs.getByRole('tab', { name: 'One' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#activations')).toHaveText('2');
    await tabs.getByRole('button', { name: 'Close Last' }).click();
    await expect(page.locator('#closed')).toHaveText('c');
    await expect(tabs.getByRole('tab', { name: 'One' })).toHaveAttribute('aria-selected', 'true');
  } finally {
    await fixture.close();
  }
});

test('restores an overflowed active tab and returns focus after closing it', async ({ page }) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/workbench-aside.html');
  try {
    await page.goto(`${fixture.url}workbench-aside.html?active-child`);
    const tabs = page.getByRole('tablist', { name: 'Workbench Aside' });
    const child = tabs.getByRole('tab', { name: 'Child' });
    await expect(child).toHaveAttribute('aria-selected', 'true');
    expect(await tabs.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await expect.poll(() => tabs.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    await expect
      .poll(() =>
        child.evaluate((el) => {
          const bounds = el.getBoundingClientRect();
          const parent = el.closest('[role=tablist]')!.getBoundingClientRect();
          // Native nearest scrolling rounds offsets while layout edges can be fractional.
          return bounds.left >= parent.left - 1 && bounds.right <= parent.right + 1;
        })
      )
      .toBe(true);
    const close = tabs.getByRole('button', { name: 'Close Child' });
    await close.focus();
    await page.keyboard.press('Enter');
    await expect(child).toHaveCount(0);
    await expect(tabs.getByRole('tab', { name: 'Files' })).toBeFocused();
  } finally {
    await fixture.close();
  }
});

test('Aside tool tabs keep balanced label spacing on touch screens', async ({ browser }) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/workbench-aside.html');
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true
  });
  try {
    const page = await context.newPage();
    for (const language of ['en', 'zh']) {
      for (const theme of ['light', 'dark']) {
        await page.goto(
          `${fixture.url}workbench-aside.html?mobile&lang=${language}&theme=${theme}`
        );
        const tabs = page.getByRole('tablist', { name: 'Workbench Aside' });
        await expect(tabs.getByRole('tab')).toHaveCount(6);
        for (const width of [320, 390, 430]) {
          await page.setViewportSize({ width, height: 844 });
          const back = page.locator('.workbench-aside-back');
          const headerGeometry = await back.evaluate((element) => {
            const button = element.getBoundingClientRect();
            const icon = element.querySelector('svg')!.getBoundingClientRect();
            const tabs = element
              .parentElement!.querySelector('[role="tablist"]')!
              .getBoundingClientRect();
            return {
              button: { width: button.width, right: button.right },
              icon: { left: icon.left, right: icon.right },
              tabsLeft: tabs.left
            };
          });
          expect(headerGeometry.button.width).toBe(30);
          expect(headerGeometry.tabsLeft).toBe(headerGeometry.button.right);
          expect(headerGeometry.icon.right).toBeLessThanOrEqual(headerGeometry.button.right);
          await expect(tabs.getByRole('tab').first()).toHaveCSS('font-size', '11px');
          await expect(tabs.getByRole('tab').last()).toHaveCSS('font-size', '11px');
          const spacing = await tabs.getByRole('tab').evaluateAll((elements) =>
            elements.flatMap((element) => {
              const item = element.closest('.tab-strip-item')!;
              if (item.querySelector('.tab-strip-close')) return [];
              const bounds = item.getBoundingClientRect();
              const label = element.lastElementChild!.getBoundingClientRect();
              return [
                {
                  label: element.textContent,
                  left: label.left - bounds.left,
                  right: bounds.right - label.right
                }
              ];
            })
          );
          expect(spacing).toHaveLength(5);
          for (const { label, left, right } of spacing) {
            expect(
              Math.abs(left - right),
              `${label} at ${width}px (${language}, ${theme})`
            ).toBeLessThanOrEqual(0.5);
          }
        }
        await tabs
          .getByRole('tab', { name: language === 'zh' ? '终端' : 'Terminal', exact: true })
          .tap();
        await expect(page.locator('#terminal')).toBeVisible();
        await tabs.getByRole('button', { name: 'Close Child' }).tap();
        await expect(tabs.getByRole('tab', { name: 'Child', exact: true })).toHaveCount(0);
        await page
          .locator('.workbench-aside-header')
          .screenshot({ path: test.info().outputPath(`aside-spacing-${language}-${theme}.png`) });
      }
    }
  } finally {
    await context.close();
    await fixture.close();
  }
});
