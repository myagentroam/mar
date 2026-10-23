import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

for (const theme of ['daylight', 'dark', 'custom']) {
  test(`Standalone Markdown stays light under the ${theme} console theme`, async ({ page }) => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/workspaces/workspace/files/read?**', async (route) => {
      await ready;
      await route.fulfill({
        json: {
          file: {
            path: 'guide.md',
            size: 24,
            encoding: 'utf-8',
            content: '# Preview\n\nReadable text.',
            truncated: false,
            nextOffset: null
          }
        }
      });
    });
    await page.goto(
      `${fixture.url}standalone-preview.html?markdownPreview=1&nodeId=node&workspaceId=workspace&path=guide.md&theme=${theme}`
    );
    const root = page.locator('.standalone-file-preview');
    const header = page.locator('.standalone-markdown-header');
    const loading = page.locator('.file-preview-loading');
    try {
      await expect(loading).toBeVisible();
      if (theme === 'custom') {
        await page.evaluate(() => {
          for (const name of [
            '--mar-bg-chrome',
            '--mar-bg-panel',
            '--mar-color-brand-text',
            '--mar-text-secondary'
          ]) {
            document.documentElement.style.setProperty(name, '#ff00ff');
          }
        });
      }
      await expect(root).toHaveCSS('background-color', 'rgb(255, 255, 255)');
      await expect(header).toHaveCSS('background-color', 'rgb(246, 248, 250)');
      await expect(header).toHaveCSS('color', 'rgb(87, 96, 106)');
      await expect(header).toHaveCSS('border-bottom-color', 'rgb(208, 215, 222)');
      await expect(loading).toHaveCSS('background-color', 'rgb(255, 255, 255)');
      await expect(loading).toHaveCSS('color', 'rgb(9, 105, 218)');
    } finally {
      release();
    }
    await expect(page.locator('.markdown-body')).toContainText('Readable text.');
    await expect(page.locator('.markdown-body')).toHaveCSS('color', 'rgb(31, 35, 40)');
    await expect(root).toHaveCSS('overflow-y', 'auto');
    await expect(page.locator('.markdown-body')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(page.locator('.markdown-body > :first-child')).toHaveCSS('margin-top', '0px');
    await expect(loading).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath(`${theme}-desktop.png`) });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(header).toHaveCSS('background-color', 'rgb(246, 248, 250)');
    await page.screenshot({ path: test.info().outputPath(`${theme}-mobile.png`) });
  });
}

test('Standalone preview errors remain readable on the light surface', async ({ page }) => {
  await page.goto(`${fixture.url}standalone-preview.html?markdownPreview=1`);
  await expect(page.locator('.standalone-error')).toBeVisible();
  await expect(page.locator('.standalone-error')).toHaveCSS('color', 'rgb(207, 34, 46)');
  await expect(page.locator('.standalone-file-preview')).toHaveCSS(
    'background-color',
    'rgb(255, 255, 255)'
  );
});

test('Standalone Markdown prints complete pages without the console viewport clipping', async ({
  page
}) => {
  await page.route('**/api/workspaces/workspace/files/read?**', (route) =>
    route.fulfill({
      json: {
        file: {
          path: 'guide.md',
          size: 12000,
          encoding: 'utf-8',
          content: '# Print preview\n\n' + 'Long readable paragraph.\n\n'.repeat(150),
          truncated: false,
          nextOffset: null
        }
      }
    })
  );
  await page.goto(
    `${fixture.url}standalone-preview.html?markdownPreview=1&nodeId=node&workspaceId=workspace&path=guide.md`
  );
  const body = page.locator('.markdown-body');
  await expect(body).toContainText('Print preview');
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#app')).toHaveCSS('overflow', 'visible');
  await expect(page.locator('#app')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(page.locator('.standalone-file-preview')).toHaveCSS('display', 'block');
  await expect(page.locator('.standalone-markdown-header')).toBeHidden();
  const geometry = await page.locator('.markdown-preview-page').evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      width: element.getBoundingClientRect().width,
      padding: parseFloat(style.paddingTop),
      height: element.getBoundingClientRect().height,
      viewport: innerHeight
    };
  });
  expect(geometry.width).toBeCloseTo((210 * 96) / 25.4, 0);
  expect(geometry.padding).toBeCloseTo((18 * 96) / 25.4, 0);
  expect(geometry.height).toBeGreaterThan(geometry.viewport);
});

test('Standalone HTML keeps a light shell without recoloring the document', async ({ page }) => {
  await page.route('**/api/html-preview/grants', (route) =>
    route.fulfill({
      json: { url: new URL('/preview-document', fixture.url).href }
    })
  );
  await page.route('**/preview-document', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<body style="background:#123456;color:white">Original document</body>'
    })
  );
  await page.goto(
    `${fixture.url}standalone-preview.html?htmlPreview=1&nodeId=node&workspaceId=workspace&path=guide.html`
  );
  await expect(page.locator('.standalone-markdown-header')).toHaveCSS(
    'background-color',
    'rgb(246, 248, 250)'
  );
  await expect(page.frameLocator('iframe').locator('body')).toHaveCSS(
    'background-color',
    'rgb(18, 52, 86)'
  );
  await expect(page.locator('.file-preview-loading')).toHaveCount(0);
});
