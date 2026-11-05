import { expect, test, type Locator } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

async function expectNeutralAction(action: Locator) {
  await expect(action).not.toHaveClass(/is-link|el-button--(?:primary|danger)/);
  await expect(action).toHaveCSS('border-top-style', 'solid');
  await expect(action).toHaveCSS('border-top-width', '1px');
  await expect(action).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(action).not.toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
  await expect(action.locator('svg')).toHaveCount(0);
}

for (const theme of ['light', 'dark']) {
  test(`file preview states share human copy and neutral actions: ${theme}`, async ({
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
          await expectNeutralAction(action);
          await expect(page.locator('.el-message')).toHaveCount(0);
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

for (const theme of ['vscode-light-2026', 'vscode-dark-2026']) {
  test(`file read failure stays inside its file page and retries: ${theme}`, async ({
    page
  }, testInfo) => {
    const fixture = await startCustomThemeFixture('test/e2e/support/file-tabs.html');
    try {
      await page.addInitScript(() => localStorage.setItem('mar.locale.v2', 'en-US'));
      let reads = 0;
      await page.route('**/api/workspaces/workspace/files/read?*', (route) => {
        reads += 1;
        return reads % 2 === 1
          ? route.fulfill({
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
            })
          : route.fulfill({
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
        await expectNeutralAction(retry);
        await page.mouse.move(0, 0);
        await expect(page.locator('.cm-editor')).toHaveCount(0);
        await expect(page.locator('.el-message')).toHaveCount(0);
        expect(await page.locator('html').getAttribute('data-file-notice')).toBeNull();
        const layout = await failure.evaluate((element) => {
          const message = element.querySelector('p')!;
          const button = element.querySelector('button')!;
          const bounds = element.getBoundingClientRect();
          const top = message.getBoundingClientRect().top;
          const bottom = button.getBoundingClientRect().bottom;
          const probe = document.createElement('span');
          probe.style.color = 'var(--mar-text-secondary)';
          element.appendChild(probe);
          const messageColor = getComputedStyle(probe).color;
          probe.style.color = 'var(--el-text-color-regular)';
          const actionColor = getComputedStyle(probe).color;
          probe.remove();
          return {
            messageColor,
            actionColor,
            actualMessageColor: getComputedStyle(message).color,
            actualActionColor: getComputedStyle(button).color,
            centerOffset: Math.abs((top + bottom) / 2 - (bounds.top + bounds.bottom) / 2),
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
        await failure.getByRole('button', { name: 'Retry', exact: true }).click();
        await expect(failure).toHaveCount(0);
        await expect(page.locator('.cm-content')).toContainText('Recovered');
        expect(await page.locator('html').getAttribute('data-file-notice')).toBeNull();
        await expect(page.locator('.workspace-file-tabs [role="tab"]')).toHaveCount(1);
      }
      expect(reads).toBe(4);
    } finally {
      await fixture.close();
    }
  });
}
