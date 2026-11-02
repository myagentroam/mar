import { expect, test, type Locator } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

async function expectReadIndicator(indicator: Locator, size: number) {
  await expect(indicator).toBeVisible();
  const actual = await indicator.evaluate((element) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--mar-color-brand-text)';
    element.parentElement!.append(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    const style = getComputedStyle(element);
    return {
      color: style.color,
      expected,
      size:
        parseFloat(style.width) / parseFloat(getComputedStyle(document.documentElement).fontSize)
    };
  });
  expect(actual.color).toBe(actual.expected);
  expect(actual.size).toBeCloseTo(size);
}

for (const theme of ['daylight', 'vscode-dark-2026']) {
  test(`Session cleanup uses button loading without a content mask: ${theme}`, async ({
    page
  }, testInfo) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${fixture.url}visual-alignment.html?loading-feedback=1&theme=${theme}`);
      const controls = page.getByTestId('cleanup-controls');
      await controls.getByRole('button', { name: 'Open cleanup', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Clean up sessions', exact: true });
      const submit = dialog.getByRole('button', { name: 'Clean up sessions', exact: true });
      const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
      const days = dialog.getByRole('spinbutton');
      await days.fill('');
      await submit.click();
      await expect(dialog.getByText('Enter a whole number of days from 1 to 365.')).toBeVisible();
      await expect(controls).toHaveAttribute('data-request-count', '0');
      await days.fill('45');
      await submit.click();
      await expect(controls).toHaveAttribute('data-request-count', '1');
      await expect(controls).toHaveAttribute('data-inactive-days', '45');
      await expect(dialog.getByText('Enter a whole number of days from 1 to 365.')).toBeHidden();
      await expect(submit).toHaveText('Clean up sessions');
      await expect(submit).toHaveClass(/is-loading/);
      await expect(submit.locator('[data-mar-icon="loading-action"]')).toBeVisible();
      await expect(dialog.locator('.el-loading-mask')).toHaveCount(0);
      await expect(dialog.locator('.workspace-session-cleanup-content')).toHaveAttribute(
        'aria-busy',
        'true'
      );
      await expect(days).toBeDisabled();
      await expect(cancel).toBeDisabled();
      await expect(dialog.locator('.el-dialog__headerbtn')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeVisible();
      await page.mouse.click(2, 2);
      await expect(dialog).toBeVisible();
      await submit.dispatchEvent('click');
      await expect(controls).toHaveAttribute('data-request-count', '1');
      await page.screenshot({ path: testInfo.outputPath(`cleanup-loading-${width}.png`) });

      // Settle the controlled request without interacting through the modal backdrop.
      await controls
        .getByRole('button', { name: 'Fail cleanup', exact: true })
        .dispatchEvent('click');
      await expect(page.locator('.el-message--error')).toContainText('Fixture cleanup failed');
      await expect(submit).not.toHaveClass(/is-loading/);
      await expect(days).toBeEnabled();
      await expect(days).toHaveValue('45');
      await expect(cancel).toBeEnabled();
      await expect(dialog.locator('.el-dialog__headerbtn')).toBeVisible();
      await submit.click();
      await expect(controls).toHaveAttribute('data-request-count', '2');
      await controls
        .getByRole('button', { name: 'Finish cleanup', exact: true })
        .dispatchEvent('click');
      await expect(
        dialog.getByRole('heading', { name: 'Cleanup complete', exact: true })
      ).toBeVisible();
      const result = dialog.locator('.workspace-session-cleanup-statistics');
      for (const [label, value] of [
        ['Deleted', '2'],
        ['Skipped', '1'],
        ['Failed', '0']
      ] as const) {
        await expect(
          result
            .locator('div')
            .filter({ has: page.getByText(label, { exact: true }) })
            .locator('dd')
        ).toHaveText(value);
      }
      await expect(dialog.locator('[data-mar-icon="loading-action"]')).toHaveCount(0);
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await controls.getByRole('button', { name: 'Open cleanup', exact: true }).click();
      await expect(days).toHaveValue('30');
      await expect(submit).toBeEnabled();
      await cancel.click();
      await expect(dialog).toHaveCount(0);
      await expect(controls).toHaveAttribute('data-request-count', '2');
    }
  });

  test(`File tree automatically loads and retries in place: ${theme}`, async ({ page }) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${fixture.url}visual-alignment.html?loading-feedback=1&theme=${theme}`);
      const tree = page.getByTestId('real-file-tree');
      await expect(tree).toHaveAttribute('data-request-count', '1');
      const retry = tree.locator('.file-tree-load-more button');
      await expect(retry).toBeVisible();
      await expect(retry).toHaveClass(/is-link/);
      await expect(retry).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await retry.hover();
      await expect(retry).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      const hoverColor = await retry.evaluate((element) => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--el-button-hover-link-text-color)';
        element.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });
      await expect(retry).toHaveCSS('color', hoverColor);
      const retryHeight = (await retry.boundingBox())!.height;
      await expect(tree.getByText('first.ts')).toBeVisible();
      await retry.focus();
      await retry.press('Enter');
      await expect(tree).toHaveAttribute('data-request-count', '2');
      await expect(retry).toBeFocused();
      await expect(retry).toHaveAttribute('aria-busy', 'true');
      await expect(retry).toContainText('Loading…');
      await expect(retry.locator('[data-mar-icon="loading-action"]')).toBeVisible();
      await expect(retry.locator('[data-mar-icon="loading-action"]')).toHaveCSS(
        'color',
        await retry.evaluate((element) => getComputedStyle(element).color)
      );
      expect((await retry.boundingBox())!.height).toBe(retryHeight);
      await retry.press('Enter');
      await expect(tree).toHaveAttribute('data-request-count', '2');
      await page.getByRole('button', { name: 'Finish tree retry' }).click();
      await expect(tree.getByText('later.ts')).toBeVisible();
      await expect(tree.getByText('first.ts')).toBeVisible();
      await expect(tree.getByRole('button', { name: 'Load more' })).toHaveCount(0);
    }
  });

  test(`File tree clears a recovered root failure after a Watch snapshot: ${theme}`, async ({
    page
  }) => {
    await page.goto(`${fixture.url}visual-alignment.html?loading-feedback=1&theme=${theme}`);
    const tree = page.getByTestId('real-file-tree');
    const retry = tree.locator('.file-tree-load-more button');
    await expect(tree).toHaveAttribute('data-request-count', '1');
    await expect(retry).toHaveText('Failed to load. Retry');

    await page.getByRole('button', { name: 'Apply recovered root snapshot', exact: true }).click();

    await expect(tree.getByText('recovered.ts')).toBeVisible();
    await expect(tree.getByText('first.ts')).toBeVisible();
    await expect(tree.locator('.file-tree-load-more')).toHaveCount(0);
    await expect(tree).toHaveAttribute('data-request-count', '1');
  });

  test(`File tree filtering does not load hidden pages: ${theme}`, async ({ page }) => {
    await page.goto(`${fixture.url}visual-alignment.html?loading-feedback=1&theme=${theme}`);
    const tree = page.getByTestId('filter-file-tree');
    await expect(tree.getByText('file-0.ts')).toBeVisible();
    await expect(tree).toHaveAttribute('data-request-count', '0');
    await page.getByRole('textbox', { name: 'Filter fixture' }).fill('file-0.ts');
    await expect(tree.locator('.file-tree-load-more')).toBeVisible();
    await page.waitForTimeout(150);
    await expect(tree).toHaveAttribute('data-request-count', '0');
    await page.getByRole('button', { name: 'Toggle filtered tree' }).click();
    await expect(tree.locator('.file-tree-load-more')).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Filter fixture' }).clear();
    await expect(tree).toHaveAttribute('data-request-count', '0');
    await page.getByRole('button', { name: 'Toggle filtered tree' }).click();
    await tree.locator('.workspace-file-tree').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(tree).toHaveAttribute('data-request-count', '1');
  });

  test(`Read loading shares theme colors and distinguishes resource rows: ${theme}`, async ({
    page
  }, testInfo) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${fixture.url}visual-alignment.html?loading-feedback=1&theme=${theme}`);
      const preview = page.getByTestId('file-content').getByRole('status');
      const pagePreview = page.getByTestId('file-page-content').getByRole('status');
      const previews = [preview, pagePreview];
      const history = page.getByTestId('history-older');
      const indicators = [
        page.getByTestId('history-initial').locator('.busy-indicator'),
        history.locator('.busy-indicator'),
        page.getByTestId('management-append').locator('.busy-indicator')
      ];
      for (const loading of previews) {
        await expect(loading).toHaveText('');
        await expect(loading).toHaveAttribute('aria-busy', 'true');
        await expect(loading).toHaveAttribute('aria-label', /.+/);
        await expectReadIndicator(loading.locator('.busy-indicator'), 1.25);
      }
      const surface = (await pagePreview.locator('..').boundingBox())!;
      const spinner = (await pagePreview.locator('.busy-indicator').boundingBox())!;
      expect(Math.abs(spinner.x + spinner.width / 2 - surface.x - surface.width / 2)).toBeLessThan(
        1
      );
      expect(
        Math.abs(spinner.y + spinner.height / 2 - surface.y - surface.height / 2)
      ).toBeLessThan(1);
      for (const indicator of indicators) await expectReadIndicator(indicator, 0.875);
      const runtime = page.getByTestId('runtime-indicator');
      const runtimeColor = await runtime.evaluate((element) => getComputedStyle(element).color);
      expect(
        await runtime.evaluate(
          (element) =>
            parseFloat(getComputedStyle(element).width) /
            parseFloat(getComputedStyle(document.documentElement).fontSize)
        )
      ).toBeCloseTo(0.75);
      const tree = page.getByTestId('file-tree');
      const row = tree.locator('.file-tree-row-shell').filter({ hasText: 'src' });
      const rowHeight = (await row.boundingBox())!.height;
      const star = tree.getByRole('status').locator('[data-mar-icon="loading-action"]');
      await expect(star).toBeVisible();
      await expect(star).not.toHaveCSS('animation-name', 'none');
      await expect(tree.locator('.busy-indicator')).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`read-loading-${width}.png`) });
      await page
        .locator('html')
        .evaluate((element) => element.style.setProperty('--mar-color-brand-text', '#c084fc'));
      for (const loading of previews)
        await expectReadIndicator(loading.locator('.busy-indicator'), 1.25);
      for (const indicator of indicators) await expectReadIndicator(indicator, 0.875);
      await expect(runtime).toHaveCSS('color', runtimeColor);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await expect(star).toHaveCSS('animation-name', 'none');
      for (const loading of previews)
        await expect(loading.locator('.busy-indicator')).toHaveCSS('animation-name', 'none');
      await page.getByRole('button', { name: 'Finish directory load' }).click();
      await expect(star).toHaveCount(0);
      expect((await row.boundingBox())!.height).toBe(rowHeight);
      await page.getByRole('button', { name: 'Finish history load' }).click();
      const boundary = history.locator('.conversation-history-control');
      const scroll = history.locator('.conversation-scroll');
      await expect(history).toHaveAttribute('data-request-count', '1');
      await expect(boundary).toHaveAttribute('aria-busy', 'true');
      await expect(boundary.getByRole('button')).toHaveCount(0);
      await expect(boundary).toHaveText('');
      await expectReadIndicator(boundary.locator('.busy-indicator'), 0.875);
      await expect(history.locator('.busy-indicator')).toHaveCount(1);
      await expect(history.locator('[data-mar-icon="loading-action"]')).toHaveCount(0);
      await expect(boundary.locator('.busy-indicator')).toHaveCSS('animation-name', 'none');
      await scroll.dispatchEvent('wheel', { deltaY: -100 });
      await expect(history).toHaveAttribute('data-request-count', '1');
      await expect(history.getByText('Existing message remains readable')).toBeVisible();
      await page.getByRole('button', { name: 'Finish history load' }).click();
      await expect(boundary).toHaveAttribute('aria-busy', 'false');
      await expect(history.locator('.busy-indicator')).toHaveCount(0);
      await page.getByRole('button', { name: 'Fail history load', exact: true }).click();
      const retry = history.locator('button[data-history-action="retry"]');
      await expect(retry).toHaveText('Failed to load. Retry');
      await scroll.dispatchEvent('wheel', { deltaY: -100 });
      await expect(history).toHaveAttribute('data-request-count', '1');
      await retry.focus();
      await retry.press('Enter');
      await expect(retry).toBeFocused();
      await expect(retry).toHaveText('');
      await expect(retry).toHaveAttribute('aria-disabled', 'true');
      await expect(retry).toHaveAttribute('aria-busy', 'true');
      await expectReadIndicator(retry.locator('.busy-indicator'), 0.875);
      await expect(history.locator('.busy-indicator')).toHaveCount(1);
      await retry.dispatchEvent('click');
      await expect(history).toHaveAttribute('data-request-count', '2');
      await page.getByRole('button', { name: 'Finish history load' }).click();
      await expect(retry).toHaveCount(0);
      await expect(boundary.getByRole('button')).toHaveCount(0);
      await page.getByRole('button', { name: 'Fail initial history load' }).click();
      const initial = page.getByTestId('history-initial');
      const reload = initial.locator('button.conversation-reload');
      await expect(reload).toHaveText('Failed to load. Retry');
      await reload.focus();
      await reload.press('Enter');
      await expect(reload).toBeFocused();
      await expect(reload).toHaveText('');
      await expect(reload).toHaveAttribute('aria-busy', 'true');
      await expectReadIndicator(reload.locator('.busy-indicator'), 0.875);
      await expect(initial.locator('.busy-indicator')).toHaveCount(1);
      await expect(initial.locator('[data-mar-icon="loading-action"]')).toHaveCount(0);
      await reload.dispatchEvent('click');
      await expect(initial).toHaveAttribute('data-request-count', '1');
      await page.screenshot({ path: testInfo.outputPath(`history-retry-${width}.png`) });
      await page.getByRole('button', { name: 'Finish file load' }).click();
      await expect(page.getByText('Preview ready')).toBeVisible();
      for (const loading of previews) await expect(loading).toHaveCount(0);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
    }
  });
}
