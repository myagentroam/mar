import { expect, test } from '@playwright/test';
import { resolvedColorToHex } from '../../packages/web-core/src/util/theme-palette.js';
import { grantClipboardPermissions } from './support/clipboard.js';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/conversation-style.html');
});
test.afterAll(async () => fixture?.close());

function luminance(color: string) {
  const [r, g, b] = resolvedColorToHex(color)
    .slice(1)
    .match(/../gu)!
    .map((hex) => {
      const channel = parseInt(hex, 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(first: string, second: string) {
  const values = [luminance(first), luminance(second)];
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
}

for (const [name, theme, width] of [
  ['light', 'daylight', 1280],
  ['dark', 'dark', 1280],
  ['mobile', 'daylight', 390]
] as const) {
  test(`Conversation Markdown reading hierarchy: ${name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${fixture.url}conversation-style.html?markdown-presentation&theme=${theme}`);
    await page.evaluate(() => document.fonts.ready);
    const timeline = page.locator('.conversation-timeline');
    const reply = timeline.locator('.assistant_message .agent-markdown');
    const file = reply.getByRole('link', { name: 'src/tasks.ts' });
    await expect(file).toHaveAttribute('data-workspace-file', 'src/tasks.ts');
    await expect(file).toHaveCSS('text-decoration-line', 'underline');
    const emphasis = reply.locator(':scope > p > strong');
    await expect(emphasis).toHaveText('待办任务筛选');
    await expect(emphasis).toHaveCSS('font-weight', '700');
    await expect(emphasis).toHaveCSS('font-synthesis-weight', 'auto');
    const inlineCode = reply.locator('p > code').filter({ hasText: /^title$/u });
    const inline = await inlineCode.evaluate((element) => {
      const code = getComputedStyle(element);
      return {
        text: code.color,
        fill: code.backgroundColor,
        prose: getComputedStyle(element.parentElement!).color,
        canvas: getComputedStyle(element.closest('main')!).backgroundColor
      };
    });
    expect(inline.text).toBe(inline.prose);
    expect(contrast(inline.text, inline.fill)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(inline.fill, inline.canvas)).toBeGreaterThanOrEqual(1.15);

    const heading = reply.getByRole('heading', { name: '验证结果' });
    const spacing = await heading.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        before: bounds.top - element.previousElementSibling!.getBoundingClientRect().bottom,
        after: element.nextElementSibling!.getBoundingClientRect().top - bounds.bottom
      };
    });
    expect(spacing.before).toBeGreaterThan(spacing.after);
    await expect(file.locator('code')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    const quote = reply.locator(':scope > blockquote').filter({ hasText: '只读取任务列表' });
    await expect(quote).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');

    const table = reply.getByRole('table');
    const styles = await table.evaluate((element) => {
      const head = getComputedStyle(element.querySelector('th')!);
      const canvas = getComputedStyle(element.closest('main')!).backgroundColor;
      return {
        canvas,
        quote: getComputedStyle(element.parentElement!.querySelector('blockquote')!).color,
        heading: head.color,
        tint: head.backgroundColor,
        body: getComputedStyle(element.querySelector('td')!).backgroundColor,
        scrolls: element.scrollWidth > element.clientWidth,
        pageFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth
      };
    });
    expect(styles.tint).not.toBe(styles.body);
    for (const [foreground, background] of [
      [styles.heading, styles.tint],
      [styles.quote, styles.canvas]
    ] as const) {
      expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
    }
    expect(styles.pageFits).toBe(true);
    if (name === 'mobile') expect(styles.scrolls).toBe(true);

    const widths = await reply.evaluate((element) => {
      const widthOf = (child: Element | null) => child?.getBoundingClientRect().width;
      return {
        reply: element.getBoundingClientRect().width,
        prose: widthOf(element.querySelector(':scope > p'))!,
        code: widthOf(element.querySelector(':scope > [data-code-block]')),
        codeQuote: widthOf(element.querySelector(':scope > blockquote:has([data-code-block])'))
      };
    });
    expect(widths.prose).toBeLessThanOrEqual(widths.reply);
    if (name !== 'mobile') expect(widths.prose).toBeLessThan(widths.reply);
    expect(widths.code).toBeCloseTo(widths.reply, 0);
    expect(widths.codeQuote).toBeCloseTo(widths.reply, 0);
    await timeline.screenshot({ path: testInfo.outputPath(`markdown-${name}.png`) });
  });
}

test('Conversation Markdown table and inline code follow the applied custom theme', async ({
  page
}) => {
  await page.goto(`${fixture.url}conversation-style.html?markdown-presentation&theme=daylight`);
  const header = page.getByRole('columnheader', { name: '场景' });
  await expect(header).toBeVisible();
  const previous = await header.evaluate((element) => getComputedStyle(element).backgroundColor);
  await page.evaluate(async (origin) => {
    const { themePreferenceService } = await import(
      `${origin}/packages/web-core/src/service/theme-preference-service.ts`
    );
    const theme = themePreferenceService();
    const source = JSON.parse(theme.builtinSource('daylight', 'Plum'));
    source.colors['--mar-link-text'] = '#982b67';
    source.colors['--mar-conversation-code'] = '#dbeee5';
    const saved = theme.saveCustomTheme(JSON.stringify(source));
    theme.setTheme(saved.id);
  }, new URL(fixture.url).origin);
  await expect(page.getByRole('link', { name: 'src/tasks.ts' })).toHaveCSS(
    'color',
    'rgb(152, 43, 103)'
  );
  await expect(header).not.toHaveCSS('background-color', previous);
  const inlineCode = page.locator('.assistant_message p > code').filter({ hasText: /^title$/u });
  const fill = await inlineCode.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(resolvedColorToHex(fill)).toBe('#cbded7');
});

test('copying a user message with an image only copies the message text', async ({ page }) => {
  await grantClipboardPermissions(page.context());
  await page.goto(`${fixture.url}conversation-style.html?user-message-copy`);
  const messages = page.locator('.conversation-timeline .user_message');
  await expect(messages).toHaveCount(2);
  for (const message of await messages.all()) {
    const image = message.locator('.conversation-file-attachment img');
    await expect(image).toBeVisible();
    await expect(image).toHaveJSProperty('naturalWidth', 1);
  }
  const copy = messages.first().locator('.conversation-message-action');
  await copy.click();
  await expect(copy.locator('[data-mar-icon="check"]')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    'Review the **screenshot**.'
  );
  await expect(messages.last().locator('.conversation-message-action')).toHaveCount(0);
});

test('Conversation binary attachment renders its own file icon in both color themes', async ({
  page
}, testInfo) => {
  for (const theme of ['daylight', 'dark']) {
    await page.goto(`${fixture.url}conversation-style.html?binary-attachment&theme=${theme}`);
    const attachments = page.locator('.conversation-timeline .conversation-file-attachments');
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      for (const [name, id] of [
        [/firmware\.bin/u, 'binary'],
        [/notes\.txt/u, 'txt']
      ] as const) {
        const attachment = attachments.getByRole('button', { name });
        await attachment.click({ trial: true });
        const icon = attachment.locator('.mar-file-icon svg');
        await expect(icon).toBeVisible();
        const symbol = icon.locator('use');
        await expect(symbol).toHaveAttribute('href', new RegExp(`#mar-file-${id}$`, 'u'));
        await expect
          .poll(() => symbol.evaluate((node: SVGUseElement) => node.getBBox().width))
          .toBeGreaterThan(0);
        // The attachment icon is 1rem, which follows the desktop root font size.
        const size = await icon.evaluate((node) => {
          const { width, height } = node.getBoundingClientRect();
          const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
          return { width, height, rem };
        });
        expect(size.width).toBeCloseTo(size.rem, 1);
        expect(size.height).toBeCloseTo(size.rem, 1);
      }
      await page.mouse.move(0, 0);
      await attachments.screenshot({
        path: testInfo.outputPath(`binary-attachment-${theme}-${width}.png`)
      });
    }
  }
});

const source = [
  '// Preserve original whitespace when copying.',
  'type Task = { title: string; completed: boolean };',
  'const docs = "https://example.invalid/documentation/a-very-long-unbroken-path-that-stays-on-one-source-line-without-changing-the-original-copied-code";',
  '',
  'export function pendingTitles(tasks: Task[]): string[] {',
  '  return tasks.filter((task) => !task.completed).map((task) => task.title);',
  '}',
  ''
].join('\n');

for (const theme of ['daylight', 'dark']) {
  for (const width of [1280, 390]) {
    test(`Conversation code headers, original copy and local scrolling at ${width}px ${theme}`, async ({
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
      const reply = timeline.locator('.assistant_message .agent-markdown');
      const webLink = reply.getByRole('link', { name: 'the documentation' });
      const fileLink = reply.getByRole('link', { name: 'src/tasks.ts' });
      const linkColor = theme === 'daylight' ? 'rgb(23, 78, 158)' : 'rgb(117, 183, 255)';
      await expect(webLink).toHaveAttribute('href', 'https://example.invalid/docs');
      await expect(fileLink).toHaveAttribute('data-workspace-file', 'src/tasks.ts');
      for (const link of [webLink, fileLink]) {
        await expect(link).toHaveCSS('color', linkColor);
        await expect(link).toHaveCSS('text-decoration-line', 'underline');
      }
      await expect(fileLink.locator('code')).toHaveCSS('color', linkColor);
      await webLink.focus();
      await expect(webLink).toHaveCSS('outline-style', 'solid');
      await webLink.hover();
      await expect(webLink).toHaveCSS(
        'color',
        theme === 'daylight' ? 'rgb(18, 58, 120)' : 'rgb(162, 206, 255)'
      );
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
          scrollHeight: pre.scrollHeight,
          clientHeight: pre.clientHeight,
          pageWidth: document.documentElement.scrollWidth,
          viewport: document.documentElement.clientWidth
        };
      });
      expect(geometry.headingBottom).toBeLessThanOrEqual(geometry.bodyTop);
      expect(geometry.actionRight).toBeLessThan(geometry.blockRight);
      expect(geometry.languageLeft).toBeCloseTo(geometry.contentLeft, 1);
      expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewport);
      const pre = block.locator('pre');
      await expect(pre).toHaveCSS('white-space', 'pre');
      await expect(pre).toHaveCSS('overflow-x', 'auto');
      expect(geometry.scrollWidth).toBeGreaterThan(geometry.clientWidth);
      expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight + 1);
      if (width === 1280) {
        const shortCode = await blocks
          .nth(1)
          .locator('pre')
          .evaluate((element) => ({
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth
          }));
        expect(shortCode.scrollWidth).toBeLessThanOrEqual(shortCode.clientWidth + 1);
      }
      const headerBefore = await header.boundingBox();
      const copyBefore = await copy.boundingBox();
      expect(
        await pre.evaluate((element) => {
          element.scrollLeft = element.scrollWidth;
          return element.scrollLeft;
        })
      ).toBeGreaterThan(0);
      expect((await header.boundingBox())!.x).toBeCloseTo(headerBefore!.x, 1);
      expect((await copy.boundingBox())!.x).toBeCloseTo(copyBefore!.x, 1);
      await pre.evaluate((element) => {
        element.scrollLeft = 0;
      });
      const keywordColor = await block
        .locator('.hljs-keyword')
        .first()
        .evaluate((element) => getComputedStyle(element).color);
      expect(keywordColor).toBe(theme === 'daylight' ? 'rgb(0, 0, 255)' : 'rgb(155, 188, 242)');
      await expect(block.locator('.hljs-title.function_').first()).toHaveCSS(
        'color',
        theme === 'daylight' ? 'rgb(121, 94, 38)' : 'rgb(220, 192, 141)'
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
