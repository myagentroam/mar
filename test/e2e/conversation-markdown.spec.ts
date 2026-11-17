import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/conversation-style.html');
});
test.afterAll(async () => fixture?.close());

const source = [
  '// Preserve original whitespace when copying.',
  'type Task = { title: string; completed: boolean };',
  'const docs = "https://example.invalid/documentation/a-very-long-unbroken-path-that-must-wrap-in-the-conversation-without-changing-the-original-copied-code";',
  '',
  'export function pendingTitles(tasks: Task[]): string[] {',
  '  return tasks.filter((task) => !task.completed).map((task) => task.title);',
  '}',
  ''
].join('\n');

for (const theme of ['daylight', 'vscode-dark-2026']) {
  for (const width of [1280, 390]) {
    test(`Conversation code headers, original copy and automatic wrapping at ${width}px ${theme}`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: async (text: string) => {
              (window as Window & { copiedCode?: string }).copiedCode = text;
            }
          }
        });
      });
      await page.goto(
        `${fixture.url}conversation-style.html?markdown-blocks&theme=${theme}&language=${width === 390 ? 'zh-CN' : 'en-US'}`
      );
      const timeline = page.locator('.conversation-timeline');
      const user = timeline.locator('.user_message');
      await expect(user.locator('.conversation-item-heading')).toHaveCount(0);
      await expect(user.locator('.conversation-message')).toContainText('待办任务');
      await expect(user.locator('.conversation-message-action')).toHaveCount(1);
      const blocks = timeline.locator('[data-code-block]');
      await expect(blocks).toHaveCount(2);
      const block = blocks.first();
      const header = block.locator('.agent-markdown-code-header');
      await expect(header.locator('.agent-markdown-code-language')).toHaveText('typescript');
      const copy = header.locator('[data-code-copy]');
      await expect(copy).toBeVisible();
      await expect(copy).toHaveCSS('opacity', '1');
      await expect(copy).toHaveCSS('width', width === 390 ? '28px' : '24px');
      await copy.focus();
      await expect(copy).toBeFocused();
      await expect(copy).toHaveCSS('outline-style', 'solid');
      await copy.press('Enter');
      await expect
        .poll(() => page.evaluate(() => (window as Window & { copiedCode?: string }).copiedCode))
        .toBe(source);
      await expect(block.locator('pre code')).toHaveText(source);
      const geometry = await block.evaluate((element) => {
        const pre = element.querySelector('pre')!;
        const code = pre.querySelector('code')!;
        const heading = element.querySelector('.agent-markdown-code-header')!;
        const action = element.querySelector('[data-code-copy]')!;
        return {
          headingBottom: heading.getBoundingClientRect().bottom,
          bodyTop: pre.getBoundingClientRect().top,
          actionRight: action.getBoundingClientRect().right,
          blockRight: element.getBoundingClientRect().right,
          contentLeft:
            pre.getBoundingClientRect().left + parseFloat(getComputedStyle(pre).paddingLeft),
          languageLeft: element
            .querySelector('.agent-markdown-code-language')!
            .getBoundingClientRect().left,
          scrollWidth: pre.scrollWidth,
          clientWidth: pre.clientWidth,
          codeHeight: code.getBoundingClientRect().height,
          lineHeight: parseFloat(getComputedStyle(code).lineHeight),
          pageWidth: document.documentElement.scrollWidth,
          viewport: document.documentElement.clientWidth
        };
      });
      expect(geometry.headingBottom).toBeLessThanOrEqual(geometry.bodyTop);
      expect(geometry.actionRight).toBeLessThan(geometry.blockRight);
      expect(geometry.languageLeft).toBeCloseTo(geometry.contentLeft, 1);
      expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewport);
      await expect(block.locator('pre')).toHaveCSS('white-space', 'pre-wrap');
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
      if (width === 390)
        expect(geometry.codeHeight).toBeGreaterThan(
          source.split('\n').length * geometry.lineHeight
        );
      const keywordColor = await block
        .locator('.hljs-keyword')
        .first()
        .evaluate((element) => getComputedStyle(element).color);
      expect(keywordColor).toBe(theme === 'daylight' ? 'rgb(0, 0, 255)' : 'rgb(86, 156, 214)');
      await expect(block.locator('.hljs-title.function_').first()).toHaveCSS(
        'color',
        theme === 'daylight' ? 'rgb(121, 94, 38)' : 'rgb(220, 220, 170)'
      );
      await expect(blocks.nth(1).locator('.agent-markdown-code-language')).toHaveText(
        width === 390 ? '代码' : 'Code'
      );
      await copy.blur();
      await page.mouse.move(0, 0);
      await expect(copy).not.toHaveAttribute('data-copied', 'true');
      await timeline.screenshot({
        path: testInfo.outputPath(`conversation-code-${width}-${theme}.png`)
      });

      // Registered surface tokens and the shared syntax palette remain live CSS consumers.
      await block.evaluate((element) => {
        element.style.setProperty('--mar-fill-subtle', 'rgb(30, 40, 50)');
        element.style.setProperty('--mar-editor-keyword', 'rgb(90, 180, 210)');
      });
      await expect(block).toHaveCSS('background-color', 'rgb(30, 40, 50)');
      await expect(block.locator('.hljs-keyword').first()).toHaveCSS('color', 'rgb(90, 180, 210)');
    });
  }
}

test('Conversation code labels react to locale and replacement without executing code or language metadata', async ({
  page
}) => {
  await page.goto(`${fixture.url}conversation-style.html?markdown-blocks&theme=daylight`);
  const labels = page.locator('.agent-markdown-code-language');
  await expect(labels).toHaveText(['typescript', 'Code']);
  await page.getByTestId('markdown-chinese').click();
  await expect(labels).toHaveText(['typescript', '代码']);
  await page.getByTestId('markdown-english').click();
  await expect(labels).toHaveText(['typescript', 'Code']);
  await page.getByTestId('markdown-replace').click();
  await expect(labels).toHaveText(['<img', 'ts']);
  await expect(page.locator('.agent-markdown img, .agent-markdown script')).toHaveCount(0);
  await expect(page.locator('.agent-markdown pre code').first()).toHaveText(
    '<script>window.markdownExecuted = true</script>\n'
  );
  expect(
    await page.evaluate(() => (window as Window & { markdownExecuted?: boolean }).markdownExecuted)
  ).toBeUndefined();
  await expect(page.locator('.agent-markdown pre code').nth(1)).toHaveText(
    'const next = "updated";\n'
  );
  await expect(page.locator('[data-code-copy]')).toHaveCount(2);
  await expect(page.locator('.agent-markdown .hljs-string')).toHaveCSS('color', 'rgb(163, 21, 21)');
});
