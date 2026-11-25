import { expect, test, type Locator } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

async function expectNeutralAction(action: Locator) {
  await expect(action).not.toHaveClass(/mar-ui-button--inline|mar-ui-button--(?:primary|danger)/);
  await expect(action).toHaveCSS('border-top-style', 'solid');
  await expect(action).toHaveCSS('border-top-width', '1px');
  await expect(action).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(action).not.toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
  await expect(action.locator('svg')).toHaveCount(0);
}

async function expectInlineRetry(action: Locator) {
  await expect(action).toHaveClass(/mar-ui-button--inline/);
  await expect(action).not.toHaveClass(/mar-ui-button--(?:primary|danger)/);
}

for (const theme of ['light', 'dark']) {
  test(`file preview states share human copy and action hierarchy: ${theme}`, async ({
    page
  }, testInfo) => {
    const fixture = await startCustomThemeFixture();
    try {
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        for (const scene of [
          {
            id: 'unsupported',
            query: 'preview-state=unsupported',
            copy: /cannot be previewed/i,
            action: 'Download file',
            signal: 'download'
          },
          {
            id: 'render-failed',
            query: 'preview-state=render-failed',
            copy: /unable to preview this file/i,
            action: 'Download file',
            signal: 'download'
          },
          {
            id: 'diff-missing',
            query: 'diff=HISTORY&load-failed=1',
            copy: /file not found/i,
            action: 'Retry',
            signal: 'retry'
          },
          {
            id: 'binary-diff',
            query: 'diff=HISTORY&diff-state=binary',
            copy: /non-text files do not support code comparison/i,
            action: 'Open file preview',
            signal: 'preview'
          },
          {
            id: 'empty-diff',
            query: 'diff=HISTORY&diff-state=empty',
            copy: /no displayable text content/i,
            action: 'Open file preview',
            signal: 'preview'
          }
        ]) {
          await page.goto(`${fixture.url}file-editor-layout.html?theme=${theme}&${scene.query}`);
          const state = page.locator('.file-preview-state');
          await expect(state.locator('p')).toHaveText(scene.copy);
          const action = state.getByRole('button', { name: scene.action, exact: true });
          if (scene.signal === 'retry') await expectInlineRetry(action);
          else await expectNeutralAction(action);
          await expect(page.locator('.mar-ui-message')).toHaveCount(0);
          await page.screenshot({
            path: testInfo.outputPath(`state-${scene.id}-${theme}-${width}.png`),
            animations: 'disabled'
          });
          await action.click();
          if (scene.signal === 'retry')
            await expect(page.locator('html')).toHaveAttribute('data-diff-retries', '1');
          else
            await expect(page.locator('html')).toHaveAttribute('data-state-action', scene.signal);
        }
      }
    } finally {
      await fixture.close();
    }
  });
}

for (const theme of ['vscode-light-2026', 'dark']) {
  test(`file read failure stays inside its file page and retries: ${theme}`, async ({
    page
  }, testInfo) => {
    const fixture = await startCustomThemeFixture('test/e2e/support/file-tabs.html');
    try {
      await page.addInitScript(() => localStorage.setItem('mar.locale.v2', 'en-US'));
      let reads = 0;
      let retryResponseGate: Promise<void> = Promise.resolve();
      let releaseRetryResponse: () => void = () => {};
      await page.route('**/api/workspaces/workspace/files/read?*', async (route) => {
        reads += 1;
        if (reads % 2 === 1)
          return route.fulfill({
            status: 404,
            json: {
              error: {
                code: 'FILE_NOT_FOUND',
                message: 'File was not found.',
                details: 'Missing index.html.',
                requestId: 'file-preview-request',
                upstreamRequestId: 'node-file-request'
              }
            }
          });
        await retryResponseGate;
        return route.fulfill({
          json: {
            file: {
              encoding: 'utf-8',
              size: 18,
              content: '<h1>Recovered</h1>',
              nextOffset: null,
              revision: 'r1'
            }
          }
        });
      });
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(`${fixture.url}file-tabs.html?html-handoff`);
        await page
          .locator('html')
          .evaluate((element, value) => element.setAttribute('data-theme', value), theme);
        await page.locator('#open-html-source').click();
        const failure = page.locator('.file-preview-state');
        await expect(failure).toBeVisible();
        await expect(failure.locator('p')).toHaveText('File not found.');
        for (const fact of [
          'FILE_NOT_FOUND',
          'Missing index.html.',
          'file-preview-request',
          'node-file-request'
        ])
          await expect(failure).not.toContainText(fact);
        const retry = failure.getByRole('button', { name: 'Retry', exact: true });
        await expectInlineRetry(retry);
        await page.mouse.move(0, 0);
        await expect(page.locator('.cm-editor')).toHaveCount(0);
        await expect(page.locator('.mar-ui-message')).toHaveCount(0);
        expect(await page.locator('html').getAttribute('data-file-notice')).toBeNull();
        const layout = await failure.evaluate((element) => {
          const message = element.querySelector('p')!;
          const button = element.querySelector('button')!;
          const contentBounds = element
            .closest('.workspace-file-page-frame-content')!
            .getBoundingClientRect();
          const top = message.getBoundingClientRect().top;
          const bottom = button.getBoundingClientRect().bottom;
          const probe = document.createElement('span');
          probe.style.color = 'var(--mar-text-secondary)';
          element.appendChild(probe);
          const messageColor = getComputedStyle(probe).color;
          probe.style.color = 'var(--mar-text-secondary)';
          const actionColor = getComputedStyle(probe).color;
          probe.remove();
          return {
            messageColor,
            actionColor,
            actualMessageColor: getComputedStyle(message).color,
            actualActionColor: getComputedStyle(button).color,
            centerOffset: Math.abs(
              (top + bottom) / 2 - (contentBounds.top + contentBounds.bottom) / 2
            ),
            fits: element.scrollWidth <= element.clientWidth
          };
        });
        expect(layout.actualMessageColor).toBe(layout.messageColor);
        expect(layout.actualActionColor).toBe(layout.actionColor);
        expect(layout.centerOffset).toBeLessThan(2);
        expect(layout.fits).toBe(true);
        await page.screenshot({
          path: testInfo.outputPath(`file-error-${theme}-${width}.png`),
          animations: 'disabled'
        });
        const retryContentBounds = (await page
          .locator('.workspace-file-page-frame-content')
          .boundingBox())!;
        retryResponseGate = new Promise<void>((resolve) => {
          releaseRetryResponse = resolve;
        });
        try {
          await retry.click();
          const retrying = page.getByRole('button', { name: 'Loading…', exact: true });
          await expect(retrying).toHaveAttribute('aria-busy', 'true');
          await expect(retrying).toHaveAttribute('aria-disabled', 'true');
          await expect(retrying).toBeFocused();
          await expect(retrying.locator('.mar-busy-indicator')).toBeVisible();
          await expect(failure.locator('p')).toHaveCount(0);
          const retryingBounds = (await retrying.boundingBox())!;
          expect(
            Math.abs(
              retryingBounds.x +
                retryingBounds.width / 2 -
                retryContentBounds.x -
                retryContentBounds.width / 2
            )
          ).toBeLessThan(2);
          expect(
            Math.abs(
              retryingBounds.y +
                retryingBounds.height / 2 -
                retryContentBounds.y -
                retryContentBounds.height / 2
            )
          ).toBeLessThan(2);
          await page.screenshot({
            path: testInfo.outputPath(`file-error-retrying-${theme}-${width}.png`),
            animations: 'disabled'
          });
        } finally {
          releaseRetryResponse();
        }
        await expect(failure).toHaveCount(0);
        await expect(page.locator('.cm-content')).toContainText('Recovered');
        await expect(page.locator('.workspace-file-page-frame')).toBeFocused();
        expect(await page.locator('html').getAttribute('data-file-notice')).toBeNull();
        await expect(page.locator('.workspace-file-tabs [role="tab"]')).toHaveCount(1);
      }
      expect(reads).toBe(4);
    } finally {
      await fixture.close();
    }
  });
}
