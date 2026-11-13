import { expect, test } from '@playwright/test';
import { json, mockConsoleApi } from './support/web-console-api.js';

// Mock APIs hold initial reads so short pages cannot hide loading geometry regressions.
for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 }
]) {
  for (const entry of [
    {
      name: 'quick prompts',
      variant: 'page',
      navigation: 'Settings',
      label: 'Quick Prompts',
      createLabel: 'Add prompt',
      url: '/console?view=settings&settings=quick-prompts',
      selector: '.quick-prompts',
      api: '**/api/quick-prompts',
      response: { prompts: [] }
    },
    {
      name: 'personal Git',
      variant: 'page',
      navigation: 'Settings',
      label: 'Git configuration',
      createLabel: 'Add credential',
      url: '/console?view=settings&settings=git',
      selector: '.personal-git-settings',
      api: '**/api/personal-git',
      response: { configuration: { credentials: [] } }
    },
    {
      name: 'environment secrets',
      variant: 'region',
      navigation: 'Admin',
      label: 'Environment Secrets',
      createLabel: 'Add Environment Secret',
      url: '/console?view=management&management=secrets',
      selector: '.secret-manager',
      api: '**/api/environment-secrets**',
      response: { secrets: [], page: 1, pageSize: 20, total: 0, hasMore: false }
    }
  ]) {
    test(
      entry.name +
        ' loading fills content and dialogs cover navigation at ' +
        viewport.width +
        'px',
      async ({ page }) => {
        await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
        await page.route('**/api/auth/me', (route) =>
          json(route, {
            authenticated: true,
            mustChangePassword: false,
            username: 'admin',
            isAdmin: true
          })
        );
        await page.setViewportSize(viewport);
        await page.addInitScript(() => localStorage.setItem('mar.locale.v2', 'en-US'));
        let finish!: () => void;
        const pending = new Promise<void>((resolve) => {
          finish = resolve;
        });
        await page.route(entry.api, async (route) => {
          await pending;
          return json(route, entry.response);
        });
        await page.goto(entry.url);
        if (viewport.width < 768)
          await page.getByRole('button', { name: entry.navigation, exact: true }).click();
        await page.getByRole('button', { name: entry.label, exact: true }).click();
        const panel = page.locator(entry.selector);
        const mask = panel.locator(':scope > .el-loading-mask');
        await expect(mask).toBeVisible();
        const available = await panel.evaluate((element) => {
          const parent = element.parentElement!;
          const box = parent.getBoundingClientRect();
          const style = getComputedStyle(parent);
          const left = parseFloat(style.paddingLeft);
          const right = parseFloat(style.paddingRight);
          const top = parseFloat(style.paddingTop);
          const bottom = parseFloat(style.paddingBottom);
          return {
            x: box.x + left,
            y: box.y + top,
            width: box.width - left - right,
            height: box.height - top - bottom
          };
        });
        const box = await mask.boundingBox();
        expect(box).not.toBeNull();
        for (const key of ['x', 'y', 'width', 'height'] as const)
          expect(Math.abs(box![key] - available[key])).toBeLessThanOrEqual(1);
        const spinner = mask.locator('.el-loading-spinner');
        await expect(spinner).toBeVisible();
        let spinnerBox;
        if (entry.variant === 'page') {
          await expect(mask).toHaveClass(/mar-page-loading/);
          await expect(mask.locator('.circular')).toBeHidden();
          const ring = await spinner.evaluate((element) => {
            const style = getComputedStyle(element, '::before');
            return {
              content: style.content,
              display: style.display,
              width: parseFloat(style.width),
              height: parseFloat(style.height),
              rootSize: parseFloat(getComputedStyle(document.documentElement).fontSize),
              borderStyle: style.borderTopStyle
            };
          });
          expect(['none', 'normal']).not.toContain(ring.content);
          expect(ring.display).toBe('inline-block');
          expect(ring.width).toBeCloseTo(ring.rootSize * 1.25, 1);
          expect(ring.height).toBeCloseTo(ring.rootSize * 1.25, 1);
          expect(ring.borderStyle).toBe('solid');
          spinnerBox = await spinner.boundingBox();
          expect(spinnerBox!.height).toBeCloseTo(ring.height, 1);
        } else {
          // Region loading retains the standard Element Plus indicator, not the page ring.
          await expect(mask).not.toHaveClass(/mar-page-loading/);
          const circular = mask.locator('.circular');
          await expect(circular).toBeVisible();
          await expect(circular).toHaveCSS('width', '42px');
          await expect(circular).toHaveCSS('height', '42px');
          await expect(circular).not.toHaveCSS('animation-name', 'none');
          const color = await spinner.evaluate((element) => {
            const probe = document.createElement('span');
            probe.style.color = 'var(--mar-color-brand)';
            element.append(probe);
            const result = getComputedStyle(probe).color;
            probe.remove();
            return result;
          });
          await expect(circular.locator('.path')).toHaveCSS('stroke', color);
          spinnerBox = await circular.boundingBox();
        }
        expect(spinnerBox).not.toBeNull();
        expect(
          Math.abs(spinnerBox!.y + spinnerBox!.height / 2 - (available.y + available.height / 2))
        ).toBeLessThanOrEqual(2);
        const navigationButton = page.getByRole('button', { name: entry.navigation, exact: true });
        await expect
          .poll(() =>
            navigationButton.evaluate((element) => {
              const box = element.getBoundingClientRect();
              return element.contains(
                document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
              );
            })
          )
          .toBe(true);
        finish();
        await expect(mask).toBeHidden();
        await expect(panel).toBeVisible();
        const navigation = await navigationButton.boundingBox();
        expect(navigation).not.toBeNull();
        await panel.getByRole('button', { name: entry.createLabel, exact: true }).click();
        const dialog = page.getByRole('dialog', { name: entry.createLabel, exact: true });
        await expect(dialog).toBeVisible();
        await expect
          .poll(() =>
            dialog.evaluate(
              (element, point) =>
                element
                  .closest('.el-overlay')
                  ?.contains(document.elementFromPoint(point.x, point.y)) ?? false,
              {
                x: navigation!.x + navigation!.width / 2,
                y: navigation!.y + navigation!.height / 2
              }
            )
          )
          .toBe(true);
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
      }
    );
  }
}
