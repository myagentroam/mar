import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

for (const [language, theme] of [
  ['en', 'light'],
  ['en', 'dark'],
  ['zh', 'light'],
  ['zh', 'dark']
]) {
  test(`Aside tabs keep compact type and bound long titles (${language}, ${theme})`, async ({
    page
  }) => {
    const fixture = await startCustomThemeFixture('test/e2e/support/workbench-aside.html');
    try {
      await page.goto(
        `${fixture.url}workbench-aside.html?active-child&long-title=${language}&theme=${theme}`
      );
      const tabs = page.getByRole('tablist', { name: 'Workbench Aside' });
      const session = tabs.getByRole('tab', {
        name: language === 'zh' ? /需要保持可读/ : /A long readable/
      });
      await expect(session).toHaveCSS('font-size', '12px');
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
          closeFits: close.getBoundingClientRect().right <= strip.getBoundingClientRect().right + 1
        };
      });
      expect(geometry.width).toBeLessThanOrEqual(geometry.limit);
      expect(geometry.truncated).toBe(true);
      expect(geometry.closeFits).toBe(true);
      await session.hover();
      await expect(page.locator('.mar-tooltip:visible')).toContainText(await session.innerText());
      await page
        .locator('.workbench-aside')
        .screenshot({ path: test.info().outputPath(`aside-tabs-${language}-${theme}.png`) });
      await tabs.getByRole('button', { name: /^Close / }).click();
      await expect(session).toHaveCount(0);
    } finally {
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
    await expect(page.locator('#tool')).toHaveText('Tool files');
    await page.getByLabel('Inspector draft').fill('unsaved edit');
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
    await expect(page.getByLabel('Inspector draft')).toHaveValue('unsaved edit');
    await expect(page.locator('#tool')).toHaveAttribute('data-mounts', '1');
    await expect(page.locator('#terminal')).toBeHidden();
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

test('Shared TabStrip skips disabled tabs and exposes close intent independently', async ({
  page
}) => {
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
