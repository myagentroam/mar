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
      navigation: 'Admin',
      label: 'Environment Secrets',
      createLabel: 'Add Environment Secret',
      url: '/console?view=management&management=secrets',
      selector: '.secret-manager',
      tableLoading: true,
      api: '**/api/environment-secrets**',
      response: { secrets: [], page: 1, pageSize: 20, total: 0, hasMore: false }
    }
  ]) {
    test(
      entry.name +
        ('tableLoading' in entry ? ' loads in the table' : ' loading fills content') +
        ' and dialogs cover navigation at ' +
        viewport.width +
        'px',
      async ({ page }) => {
        await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
        await page.route('**/api/auth/me', (route) =>
          json(route, {
            authenticated: true,
            userId: 1,
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
        const mask = panel.locator(':scope > .mar-ui-loading');
        const progress = panel.getByRole('progressbar', { name: 'Loading' });
        if ('tableLoading' in entry) {
          const table = panel.locator('.mar-ui-table');
          await expect(mask).toHaveCount(0);
          await expect(table).toHaveAttribute('aria-busy', 'true');
          await expect(table.getByRole('columnheader').first()).toBeVisible();
          await expect(table.getByRole('progressbar', { name: 'Loading' })).toBeVisible();
          await expect(progress).toHaveCount(1);
          await expect(table.getByText('No data', { exact: true })).toBeHidden();
        } else {
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
          const spinner = mask.locator('.mar-ui-loading__indicator');
          await expect(spinner).toBeVisible();
          await expect(mask).toHaveAttribute('data-variant', 'page');
          const indicator = await spinner.evaluate((element) => {
            const style = getComputedStyle(element);
            const probe = document.createElement('span');
            probe.style.color = 'var(--mar-text-secondary)';
            element.append(probe);
            const color = getComputedStyle(probe).color;
            probe.remove();
            const size = 1.25 * parseFloat(getComputedStyle(document.documentElement).fontSize);
            return {
              width: parseFloat(style.width),
              height: parseFloat(style.height),
              border: style.borderTopStyle,
              animation: style.animationName,
              actualColor: style.borderTopColor,
              color,
              size
            };
          });
          expect(indicator.width).toBeCloseTo(indicator.size);
          expect(indicator.height).toBeCloseTo(indicator.size);
          expect(indicator.border).toBe('solid');
          expect(indicator.animation).not.toBe('none');
          expect(indicator.actualColor).toBe(indicator.color);
          const spinnerBox = await spinner.boundingBox();
          expect(spinnerBox).not.toBeNull();
          expect(
            Math.abs(spinnerBox!.y + spinnerBox!.height / 2 - (available.y + available.height / 2))
          ).toBeLessThanOrEqual(2);
        }
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
        if ('tableLoading' in entry) {
          await expect(progress).toBeHidden();
          await expect(panel.getByText('No data', { exact: true })).toBeVisible();
          const filterSize = '12px';
          const filter = panel.getByPlaceholder('Search names', { exact: true });
          await expect(filter).toHaveCSS('font-size', filterSize);
          expect(
            await filter.evaluate((element) => getComputedStyle(element, '::placeholder').fontSize)
          ).toBe(filterSize);
        }
        await expect(panel).toBeVisible();
        const navigation = await navigationButton.boundingBox();
        expect(navigation).not.toBeNull();
        await panel.getByRole('button', { name: entry.createLabel, exact: true }).click();
        const dialog = page.getByRole('dialog', { name: entry.createLabel, exact: true });
        await expect(dialog).toBeVisible();
        if ('tableLoading' in entry) {
          const value = dialog.getByPlaceholder('Enter a secret value', { exact: true });
          await expect(value).toHaveCSS('font-size', '12px');
          expect(
            await value.evaluate((element) => getComputedStyle(element, '::placeholder').fontSize)
          ).toBe('12px');
        }
        await expect
          .poll(() =>
            dialog.evaluate(
              (element, point) =>
                element
                  .closest('dialog[open]')
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
