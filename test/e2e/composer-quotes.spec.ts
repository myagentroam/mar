import { expect, test, type Page } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/composer-quotes.html');
});
test.afterAll(async () => {
  await fixture?.close();
});
test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw error;
  });
  await page.goto(`${fixture.url}composer-quotes.html`);
  await expect(page.locator('textarea.composer-input')).toHaveValue('Keep my opinion unchanged.');
});
async function selectReply(page: Page) {
  await page
    .locator('[data-quote-message-id] p')
    .first()
    .evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
}
async function rightClickSelection(page: Page) {
  const point = await page.evaluate(() => {
    const rect = window.getSelection()!.getRangeAt(0).getClientRects()[0]!;
    return { x: rect.left + 5, y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(point.x, point.y, { button: 'right' });
}
async function addInlineQuoteImage(page: Page) {
  await page
    .locator('[data-quote-message-id] p')
    .nth(1)
    .evaluate((paragraph) => {
      // Keep a bare image: Markdown image buttons would exercise the existing control guard instead.
      const image = new Image(1, 1);
      image.alt = 'Inline fixture image';
      image.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
      paragraph.append(' Before image. ', image, ' After image.');
    });
}
async function result(page: Page, name: 'references' | 'payload' | 'copied') {
  return page.evaluate(
    (name) =>
      (window as unknown as { quoteFixture: Record<string, () => unknown> }).quoteFixture[name]!(),
    name
  );
}
async function action(page: Page, name: 'changeTarget' | 'lock') {
  await page.evaluate(
    (name) =>
      (window as unknown as { quoteFixture: Record<string, () => void> }).quoteFixture[name]!(),
    name
  );
}

test('desktop selection adds only a tag and quote-only history preserves its public XML for copy', async ({
  page
}, testInfo) => {
  await selectReply(page);
  await expect(page.getByRole('group', { name: 'Quote', exact: true })).toBeVisible();
  const bubble = page.getByRole('group', { name: 'Quote', exact: true });
  await expect(bubble.locator('svg')).toHaveCount(1);
  const iconBounds = (await bubble.locator('svg').boundingBox())!;
  const labelBounds = (await bubble.getByText('Quote', { exact: true }).boundingBox())!;
  expect(labelBounds.x - iconBounds.x - iconBounds.width).toBeGreaterThanOrEqual(4);
  const bubbleWidth = await bubble.evaluate((element) => element.getBoundingClientRect().width);
  const buttonWidth = await bubble
    .getByRole('button')
    .evaluate((element) => element.getBoundingClientRect().width);
  expect(Math.abs(bubbleWidth - buttonWidth)).toBeLessThan(2);
  await page.screenshot({
    path: testInfo.outputPath('chat-quote-selection.png'),
    animations: 'disabled'
  });
  await page
    .getByRole('group', { name: 'Quote', exact: true })
    .getByRole('button', { name: 'Quote', exact: true })
    .click();
  await expect(page.locator('.composer-file-reference-state')).toContainText(
    'Select this reply excerpt.'
  );
  await page.screenshot({
    path: testInfo.outputPath('chat-quote-draft.png'),
    animations: 'disabled'
  });
  await expect(page.locator('textarea.composer-input')).toHaveValue('Keep my opinion unchanged.');
  expect(await result(page, 'references')).toMatchObject([
    { type: 'quote', source: 'assistant', text: 'Select this reply excerpt.' }
  ]);
  await page.locator('textarea.composer-input').fill('');
  await page.locator('#send').click();
  await expect(page.getByRole('group', { name: 'Quote', exact: true })).toHaveCount(0);
  await expect(page.locator('.user_message .quote-excerpt')).toHaveCount(1);
  await expect(page.locator('.user_message .quote-excerpt-text')).toHaveText(
    'Select this reply excerpt.'
  );
  await expect(page.locator('.user_message')).not.toContainText('<mar_references>');
  await expect(page.locator('#send')).toBeDisabled();
  await page
    .locator('.user_message button')
    .filter({ has: page.locator('[data-mar-icon="copy"]') })
    .click();
  expect(await result(page, 'copied')).toEqual(await result(page, 'payload'));
  expect(await result(page, 'payload')).toContain('<mar_references>');
});

test('Chat quotation preserves visible paragraph boundaries', async ({ page }) => {
  const visibleText = await page.locator('[data-quote-message-id]').evaluate((body) => {
    const paragraphs = body.querySelectorAll('p');
    const range = document.createRange();
    range.setStart(paragraphs[0]!, 0);
    // Preserve the paragraph boundary without including the link later in the second paragraph.
    const end = paragraphs[1]!.firstChild!;
    range.setEnd(end, end.textContent!.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  });
  expect(visibleText).toContain('excerpt.\n');
  await page
    .getByRole('group', { name: 'Quote', exact: true })
    .getByRole('button', { name: 'Quote', exact: true })
    .click();
  expect(await result(page, 'references')).toMatchObject([
    { source: 'assistant', text: visibleText }
  ]);
});

test('an unchanged selection stays dismissed until explicitly quoted again', async ({ page }) => {
  await selectReply(page);
  await page.getByRole('group', { name: 'Quote', exact: true }).getByRole('button').click();
  await expect(page.getByRole('group', { name: 'Quote', exact: true })).toHaveCount(0);
  await rightClickSelection(page);
  await page.getByRole('menuitem', { name: 'Quote', exact: true }).click();
  await expect(page.locator('.composer-file-reference-state')).toHaveCount(2);
  const references = (await result(page, 'references')) as { id: string }[];
  expect(references[0]!.id).not.toBe(references[1]!.id);
});

test('context menu replaces the bubble, keeps native link menus, and rejects a stale target', async ({
  page
}) => {
  await selectReply(page);
  await expect(page.getByRole('group', { name: 'Quote', exact: true })).toBeVisible();
  await rightClickSelection(page);
  await expect(page.getByRole('group', { name: 'Quote', exact: true })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Quote', exact: true })).toBeVisible();
  const menu = page.locator('.el-dropdown-menu');
  const copyItem = menu.getByRole('menuitem', { name: 'Copy', exact: true });
  const quoteItem = menu.getByRole('menuitem', { name: 'Quote', exact: true });
  await quoteItem.hover();
  const sizes = await menu.evaluate((element) => ({
    menu: element.getBoundingClientRect().width,
    items: [...element.querySelectorAll('[role="menuitem"]')].map((item) =>
      item.getBoundingClientRect().toJSON()
    )
  }));
  expect(sizes.items[0]!.height).toBe(sizes.items[1]!.height);
  expect(sizes.menu - sizes.items[1]!.width).toBeLessThanOrEqual(12);
  await expect(quoteItem).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(copyItem).toHaveCount(1);
  await copyItem.focus();
  await page.keyboard.press('ArrowDown');
  await expect(quoteItem).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await rightClickSelection(page);
  await expect(quoteItem).toBeVisible();
  await action(page, 'changeTarget');
  await page.getByRole('menuitem', { name: 'Quote', exact: true }).click();
  await expect(page.locator('.composer-file-reference-state')).toHaveCount(0);
  const native = await page
    .locator('[data-quote-message-id] a')
    .evaluate((element) =>
      element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    );
  expect(native).toBe(true);
  await selectReply(page);
  await action(page, 'lock');
  await expect(page.getByRole('group', { name: 'Quote', exact: true })).toHaveCount(0);
  await expect(page.locator('.composer-file-reference-state')).toHaveCount(0);
});

for (const excluded of ['a', 'img']) {
  for (const previous of ['none', 'bubble', 'menu']) {
    test(`a selection crossing ${excluded} preserves native text context menus after ${previous}`, async ({
      page
    }) => {
      await addInlineQuoteImage(page);
      const bubble = page.getByRole('group', { name: 'Quote', exact: true });
      const menu = page.locator('.el-dropdown-menu');
      if (previous !== 'none') {
        await selectReply(page);
        await expect(bubble).toBeVisible();
        if (previous === 'menu') {
          await rightClickSelection(page);
          await menu.getByRole('menuitem', { name: 'Copy', exact: true }).focus();
        }
      }
      const selectionText = await page.locator('[data-quote-message-id]').evaluate((body, tag) => {
        const excluded = body.querySelector(tag)!;
        const range = document.createRange();
        if (tag === 'a') {
          range.setStart(excluded.previousSibling!, 0);
          range.setEnd(excluded.firstChild!, excluded.textContent!.length);
        } else {
          range.setStart(excluded.previousSibling!, 0);
          range.setEnd(excluded.nextSibling!, excluded.nextSibling!.textContent!.length);
        }
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        return { text: selection.toString(), intersects: range.intersectsNode(excluded) };
      }, excluded);
      expect(selectionText.intersects).toBe(true);
      expect(selectionText.text.trim()).not.toBe('');
      if (previous !== 'menu') await expect(bubble).toHaveCount(0);

      const native = await page
        .locator('[data-quote-message-id] p')
        .first()
        .evaluate((text) => {
          let propagated = false;
          const observe = () => {
            propagated = true;
          };
          window.addEventListener('contextmenu', observe);
          const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
          const dispatched = text.dispatchEvent(event);
          window.removeEventListener('contextmenu', observe);
          return {
            dispatched,
            defaultPrevented: event.defaultPrevented,
            propagated,
            ordinaryTarget: !text.querySelector('a,img')
          };
        });
      expect(native).toEqual({
        dispatched: true,
        defaultPrevented: false,
        propagated: true,
        ordinaryTarget: true
      });
      await expect(menu).toBeHidden();
      await expect(bubble).toHaveCount(0);
      expect(await page.evaluate(() => window.getSelection()!.toString())).toBe(selectionText.text);
      expect(await result(page, 'references')).toEqual([]);
      expect(await result(page, 'copied')).toBe('');
      await expect(page.locator('textarea.composer-input')).toHaveValue(
        'Keep my opinion unchanged.'
      );
    });
  }
}

test('ordinary text remains quotable with nonintersecting links and images in the same body', async ({
  page
}) => {
  await addInlineQuoteImage(page);
  await selectReply(page);
  await expect(page.getByRole('group', { name: 'Quote', exact: true })).toBeVisible();
  await rightClickSelection(page);
  await page.getByRole('menuitem', { name: 'Quote', exact: true }).click();
  expect(await result(page, 'references')).toMatchObject([
    { source: 'assistant', text: 'Select this reply excerpt.' }
  ]);
});

for (const pointerType of ['touch', 'mouse']) {
  test(`selection context menus do not require character-hit coordinates for ${pointerType}`, async ({
    page
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await selectReply(page);
    const native = await page
      .locator('[data-quote-message-id] p')
      .first()
      .evaluate(
        (element, pointerType) =>
          element.dispatchEvent(
            new PointerEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              pointerType,
              clientX: 0,
              clientY: 0
            })
          ),
        pointerType
      );
    expect(native).toBe(false);
    await expect(page.getByRole('group', { name: 'Quote', exact: true })).toHaveCount(0);
    const bodyBounds = (await page.locator('[data-quote-message-id] p').first().boundingBox())!;
    await expect
      .poll(async () => (await page.locator('.el-dropdown-menu').boundingBox())?.y ?? -1)
      .toBeGreaterThanOrEqual(bodyBounds.y + bodyBounds.height);
    await page.getByRole('menuitem', { name: 'Quote', exact: true }).click();
    expect(await result(page, 'references')).toMatchObject([
      { source: 'assistant', text: 'Select this reply excerpt.' }
    ]);
  });
}

for (const nativeAction of ['link', 'noncancelable', 'outside', 'empty']) {
  test(`a native ${nativeAction} context menu dismisses the previous quote menu`, async ({
    page
  }) => {
    await selectReply(page);
    await rightClickSelection(page);
    const menu = page.locator('.el-dropdown-menu');
    await expect(menu.getByRole('menuitem', { name: 'Quote', exact: true })).toBeVisible();
    const target = page.locator(
      nativeAction === 'link'
        ? '[data-quote-message-id] a'
        : nativeAction === 'outside'
          ? '#send'
          : '[data-quote-message-id] p:first-child'
    );
    const native = await target.evaluate((element, nativeAction) => {
      if (nativeAction === 'empty') window.getSelection()!.removeAllRanges();
      return element.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: nativeAction !== 'noncancelable'
        })
      );
    }, nativeAction);
    expect(native).toBe(true);
    await expect(menu).toBeHidden();
    await expect(page.getByRole('group', { name: 'Quote', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
      nativeAction === 'empty' ? '' : 'Select this reply excerpt.'
    );
  });
}

test('an explicit context menu refreshes the selection while the previous menu has focus', async ({
  page
}) => {
  await selectReply(page);
  await rightClickSelection(page);
  await page.getByRole('menuitem', { name: 'Copy', exact: true }).focus();
  const native = await page
    .locator('[data-quote-message-id] p')
    .first()
    .evaluate((element) => {
      const range = document.createRange();
      range.setStart(element.firstChild!, 0);
      range.setEnd(element.firstChild!, 6);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      const rect = range.getBoundingClientRect();
      return element.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + 1,
          clientY: rect.top + 1
        })
      );
    });
  expect(native).toBe(false);
  await page.getByRole('menuitem', { name: 'Quote', exact: true }).click();
  expect(await result(page, 'references')).toMatchObject([{ source: 'assistant', text: 'Select' }]);
});

test('a long draft quote stays compact while preserving its full snapshot', async ({
  page
}, testInfo) => {
  const text = '引用内容😀需要保持完整，仅摘要应该限制长度。'.repeat(8);
  await page.evaluate(
    (text) =>
      (
        window as unknown as { quoteFixture: { replaceReply(text: string): void } }
      ).quoteFixture.replaceReply(text),
    text
  );
  await selectReply(page);
  await page.getByRole('group', { name: 'Quote', exact: true }).getByRole('button').click();
  const tag = page.locator('.composer-quote-tag');
  const summary = await tag.locator('.quote-tag-preview span').textContent();
  expect(Array.from(summary!)).toHaveLength(32);
  expect(summary).toBe(`${Array.from(text).slice(0, 31).join('')}…`);
  const rootFontSize = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).fontSize)
  );
  expect((await tag.boundingBox())!.width).toBeLessThanOrEqual(18 * rootFontSize);
  const tagBounds = (await tag.boundingBox())!;
  const removeBounds = (await tag.locator('.quote-tag-remove').boundingBox())!;
  expect(removeBounds.x + removeBounds.width).toBeLessThanOrEqual(tagBounds.x + tagBounds.width);
  await tag.locator('.quote-tag-preview').click();
  const region = page.getByRole('region', { name: 'Quote', exact: true });
  await expect(region).toBeVisible();
  await expect(page.locator('.el-popover').filter({ has: region })).toHaveCSS('opacity', '1');
  await region.hover();
  await expect(region).toContainText(text);
  expect(await result(page, 'references')).toMatchObject([{ text }]);
  await page.screenshot({
    path: testInfo.outputPath('compact-quote-tag.png'),
    animations: 'disabled'
  });
});

for (const theme of ['daylight', 'vscode-dark-2026']) {
  test(`quote removal preserves its brand foreground in ${theme}`, async ({ page }) => {
    await page.goto(`${fixture.url}composer-quotes.html?theme=${theme}`);
    if (theme === 'daylight') await expect(page.locator('html')).not.toHaveClass(/dark/u);
    else await expect(page.locator('html')).toHaveClass(/dark/u);
    await selectReply(page);
    await page.getByRole('group', { name: 'Quote', exact: true }).getByRole('button').click();
    const tag = page.locator('.composer-quote-tag');
    const remove = tag.locator('.quote-tag-remove');
    const brand = await tag.evaluate((element) => getComputedStyle(element).color);
    await expect(remove).toHaveCSS('color', brand);
    await remove.hover();
    await expect(remove).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(remove).toHaveCSS('color', brand);
    await remove.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(remove).toBeFocused();
    await expect(remove).toHaveCSS('outline-width', '2px');
    await page.mouse.move(1, 1);
    await expect(remove).toHaveCSS('color', brand);
    await remove.hover();
    await page.mouse.down();
    await expect(remove).toHaveCSS('color', brand);
    await expect(remove).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await page.mouse.move(1, 1);
    await page.mouse.up();
    await remove.press('Enter');
    await expect(tag).toHaveCount(0);
    expect(await result(page, 'references')).toEqual([]);
  });
}

test('the Chat context menu stays available for a scrolled multiline selection', async ({
  page
}, testInfo) => {
  const text = 'A selected reply line with enough content to wrap naturally. '.repeat(60);
  await page.evaluate(
    (text) =>
      (
        window as unknown as { quoteFixture: { replaceReply(text: string): void } }
      ).quoteFixture.replaceReply(text),
    text
  );
  await selectReply(page);
  await page.locator('main').evaluate(
    (element) =>
      new Promise<void>((resolve) => {
        element.addEventListener('scroll', () => resolve(), { once: true });
        element.scrollTop = 300;
      })
  );
  const point = await page.evaluate(() => {
    const viewport = document.querySelector('main')!.getBoundingClientRect();
    const rect = [...window.getSelection()!.getRangeAt(0).getClientRects()].find(
      (rect) => rect.top > viewport.top + 20 && rect.bottom < viewport.bottom - 20
    )!;
    return { x: rect.left + 8, y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Copy', exact: true })).toBeVisible();
  expect(await page.locator('main').evaluate((element) => element.scrollTop)).toBe(300);
  await page.screenshot({
    path: testInfo.outputPath('scrolled-chat-menu.png'),
    animations: 'disabled'
  });
  await page.getByRole('menuitem', { name: 'Quote', exact: true }).click();
  expect(await result(page, 'references')).toMatchObject([{ text: text.trimEnd() }]);
});

test('file menu quotes the model text and closes the source window without changing the opinion', async ({
  page
}) => {
  await page.getByRole('button', { name: 'File', exact: true }).click();
  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible();
  await editor.click();
  await editor.press('Control+a');
  await editor.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Select all', exact: true }).click();
  await expect(page.locator('.composer-file-reference-state')).toHaveCount(0);
  await editor.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Quote', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator('.workspace-file-tabs')).toHaveCount(0);
  await expect(page.locator('textarea.composer-input')).toHaveValue('Keep my opinion unchanged.');
  expect(await result(page, 'references')).toMatchObject([
    {
      source: 'file',
      startLine: 1,
      endLine: 3,
      text: 'const first = 1;\nconst second = 2;\nreturn first + second;'
    }
  ]);
});

test('Diff select all does not quote implicitly and preserves new and old line numbers', async ({
  page
}) => {
  await page.getByRole('button', { name: 'Diff', exact: true }).click();
  const pane = page.locator('.unified-history-diff');
  await pane.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Select all', exact: true }).click();
  await expect(page.locator('.composer-file-reference-state')).toHaveCount(0);
  await pane.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Quote', exact: true }).click();
  await expect(page.locator('#failure')).toBeEmpty();
  await expect(pane).toHaveCount(0);
  await expect(page.locator('.composer-file-reference-state')).toHaveCount(1);
  expect(await result(page, 'references')).toMatchObject([
    {
      source: 'diff',
      origin: 'HISTORY',
      revision: 'abc123',
      side: 'mixed',
      startLine: 2,
      endLine: 3,
      oldStartLine: 2,
      oldEndLine: 3
    }
  ]);
  const references = JSON.stringify(await result(page, 'references'));
  expect(references).toContain('-old value');
  expect(references).toContain('+new value');
  expect(references).not.toContain('Select all');
});

test('quoting closes the entire source window when multiple tabs are open', async ({ page }) => {
  await page.evaluate(() =>
    (
      window as unknown as { quoteFixture: { setSurface(value: string): void } }
    ).quoteFixture.setSurface('file-multiple')
  );
  await expect(page.getByRole('tab')).toHaveCount(2);
  const editor = page.locator('.cm-content');
  await editor.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Select all', exact: true }).click();
  await editor.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Quote', exact: true }).click();
  await expect(page.locator('.workspace-file-tabs')).toHaveCount(0);
  expect(await result(page, 'references')).toMatchObject([{ source: 'file' }]);
});

for (const source of ['File', 'Diff'] as const) {
  for (const invalidation of ['changeTarget', 'lock'] as const) {
    test(`${source} quote keeps its window open after ${invalidation}`, async ({ page }) => {
      await page.getByRole('button', { name: source, exact: true }).click();
      const body = page.locator(source === 'File' ? '.cm-content' : '.unified-history-diff');
      await body.click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Select all', exact: true }).click();
      await body.click({ button: 'right' });
      await action(page, invalidation);
      await page.getByRole('menuitem', { name: 'Quote', exact: true }).click();
      await expect(body).toBeVisible();
      expect(await result(page, 'references')).toEqual([]);
    });
  }
}

test('an oversized file quote leaves the source and opinion unchanged', async ({ page }) => {
  await page.evaluate(() =>
    (
      window as unknown as { quoteFixture: { replaceFile(text: string): void } }
    ).quoteFixture.replaceFile('x'.repeat(8001))
  );
  await page.getByRole('button', { name: 'File', exact: true }).click();
  const editor = page.locator('.cm-content');
  await editor.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Select all', exact: true }).click();
  await editor.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Quote', exact: true }).click();
  await expect(page.locator('#failure')).toHaveText('Quote rejected');
  await expect(editor).toBeVisible();
  expect(await result(page, 'references')).toEqual([]);
  await expect(page.locator('textarea.composer-input')).toHaveValue('Keep my opinion unchanged.');
});

test('a successful quote respects the unsaved-file close guard', async ({ page }) => {
  await page.getByRole('button', { name: 'File', exact: true }).click();
  const editor = page.locator('.cm-content');
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.click();
  await editor.press('Control+a');
  await editor.pressSequentially('Unsaved source text');
  await editor.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Select all', exact: true }).click();
  await editor.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Quote', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Unsaved changes', exact: true });
  await expect(confirmation).toBeVisible();
  expect(await result(page, 'references')).toMatchObject([
    { source: 'file', text: 'Unsaved source text', unsaved: true }
  ]);
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(editor).toHaveText('Unsaved source text');
  await expect(page.locator('.workspace-file-tabs')).toBeVisible();
});

test('mobile uses the selection bubble and standard context menu without message action buttons', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await selectReply(page);
  await expect(page.getByRole('group', { name: 'Quote', exact: true })).toBeVisible();
  await expect(page.locator('.quote-actions .mar-icon + span')).toHaveCSS(
    'margin-inline-start',
    '4px'
  );
  await expect(
    page
      .locator('.conversation-message-actions')
      .getByRole('button', { name: 'Quote', exact: true })
  ).toHaveCount(0);
  await rightClickSelection(page);
  await expect(page.getByRole('group', { name: 'Quote', exact: true })).toHaveCount(0);
  const menu = page.locator('.el-dropdown-menu');
  await expect(menu.getByRole('menuitem', { name: 'Copy', exact: true })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Quote', exact: true }).click();
  await expect(page.locator('.composer-file-reference-state')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('mobile quotation remains available after a cancelled touch gesture', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-quote-message-id]').evaluate((element) => {
    element.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        pointerType: 'touch',
        pointerId: 1,
        button: 0
      })
    );
    element.dispatchEvent(
      new PointerEvent('pointercancel', {
        bubbles: true,
        pointerType: 'touch',
        pointerId: 1,
        button: -1
      })
    );
  });
  await selectReply(page);
  const quote = page.getByRole('group', { name: 'Quote', exact: true }).getByRole('button', {
    name: 'Quote',
    exact: true
  });
  await expect(quote).toBeEnabled();
  await quote.click();
  expect(await result(page, 'references')).toMatchObject([
    { type: 'quote', source: 'assistant', text: 'Select this reply excerpt.' }
  ]);
});

test('Diff quotation excludes the unselected line at an end boundary', async ({ page }) => {
  await page.getByRole('button', { name: 'Diff', exact: true }).click();
  await page.locator('.unified-history-diff').evaluate((element) => {
    const lines = [...element.querySelectorAll('code > span')];
    const start = lines.findIndex((line) => line.textContent?.includes('+new value'));
    const range = document.createRange();
    range.setStart(lines[start]!, 0);
    range.setEnd(lines[start + 1]!, 0);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await rightClickSelection(page);
  await page.getByRole('menuitem', { name: 'Quote', exact: true }).click();
  expect(await result(page, 'references')).toMatchObject([
    { source: 'diff', text: '+new value', side: 'new', startLine: 2, endLine: 2 }
  ]);
});

test('mobile file actions preserve selection until quoting closes the source window', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await expect(page.locator('.cm-content')).toBeVisible();
  const menu = page
    .locator('.workspace-file-mobile-actions')
    .getByRole('button', { name: 'File actions', exact: true });
  await menu.click();
  await expect(page.getByRole('menuitem', { name: 'Quote', exact: true })).toBeDisabled();
  await page.getByRole('menuitem', { name: 'Select all', exact: true }).click();
  await expect(page.locator('.composer-file-reference-state')).toHaveCount(0);
  await menu.click();
  await expect(page.getByRole('menuitem', { name: 'Quote', exact: true })).toBeEnabled();
  await page.getByRole('menuitem', { name: 'Quote', exact: true }).click();
  await expect(page.locator('.composer-file-reference-state')).toHaveCount(1);
  await expect(page.locator('.cm-content')).toHaveCount(0);
  expect(await result(page, 'references')).toMatchObject([
    { source: 'file', text: 'const first = 1;\nconst second = 2;\nreturn first + second;' }
  ]);
});

test('working Diff selection quotes model content without line gutters or minimap', async ({
  page
}) => {
  await page.evaluate(() =>
    (
      window as unknown as { quoteFixture: { setSurface(value: string): void } }
    ).quoteFixture.setSurface('working-diff')
  );
  const pane = page.locator('.unified-diff-code');
  await pane.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Select all', exact: true }).click();
  await pane.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Quote', exact: true }).click();
  await expect(page.locator('.composer-file-reference-state')).toHaveCount(1);
  expect(await result(page, 'references')).toMatchObject([
    {
      source: 'diff',
      origin: 'WORKING_TREE',
      oldStartLine: 2,
      text: 'first value\nold value\nnew value\nsame value'
    }
  ]);
});

for (const selectionCase of [
  {
    name: 'the middle of an added line',
    start: [2, 7],
    end: [2, 12],
    text: 'value',
    side: 'new',
    lines: { startLine: 2, endLine: 2 }
  },
  {
    name: 'the middle of a deleted line',
    start: [1, 7],
    end: [1, 12],
    text: 'value',
    side: 'old',
    lines: { oldStartLine: 2, oldEndLine: 2 }
  },
  {
    name: 'the middle of a context line',
    start: [0, 3],
    end: [0, 10],
    text: 'context',
    side: 'new',
    lines: { startLine: 1, endLine: 1 }
  },
  {
    name: 'source-leading plus and trailing spaces',
    start: [2, 0],
    end: [2, 14],
    text: '+new + value  ',
    side: 'new',
    lines: { startLine: 2, endLine: 2 }
  },
  {
    name: 'source-leading minus and trailing spaces',
    start: [1, 0],
    end: [1, 14],
    text: '-old - value  ',
    side: 'old',
    lines: { oldStartLine: 2, oldEndLine: 2 }
  },
  {
    name: 'source-leading spaces and plus in context',
    start: [0, 0],
    end: [0, 3],
    text: '  +',
    side: 'new',
    lines: { startLine: 1, endLine: 1 }
  },
  {
    name: 'a partial cross-line selection with source symbols and whitespace',
    start: [0, 2],
    end: [4, 8],
    text: '+context - literal  \n-old - value  \n+new + value  \n-last - value  \n  tail +',
    side: 'mixed',
    lines: { startLine: 1, endLine: 4, oldStartLine: 2, oldEndLine: 2 }
  }
]) {
  test(`working Diff copies and quotes only ${selectionCase.name}`, async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: fixture.url
    });
    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          quoteFixture: {
            replaceWorkingDiff(value: { text: string; afterText: string }): void;
            setSurface(value: string): void;
          };
        }
      ).quoteFixture;
      fixture.replaceWorkingDiff({
        text: [
          '@@ -1,4 +1,4 @@',
          '   +context - literal  ',
          '--old - value  ',
          '++new + value  ',
          ' -last - value  ',
          '   tail + -  '
        ].join('\n'),
        afterText: '  +context - literal  \n+new + value  \n-last - value  \n  tail + -  '
      });
      fixture.setSurface('working-diff');
    });
    const pane = page.locator('.unified-diff-code');
    await expect(pane.locator('[data-diff-line-content]')).toHaveCount(5);
    const selectBody = () =>
      pane.evaluate((element, { start, end }) => {
        const rows = element.querySelectorAll('[data-diff-line-content]');
        function position(row: number, offset: number): [Node, number] {
          const walker = document.createTreeWalker(rows[row]!, NodeFilter.SHOW_TEXT);
          let node = walker.nextNode();
          while (node) {
            if (offset <= node.textContent!.length) return [node, offset];
            offset -= node.textContent!.length;
            node = walker.nextNode();
          }
          throw new Error('Selection offset exceeds the rendered source');
        }
        const range = document.createRange();
        range.setStart(...position(start[0]!, start[1]!));
        range.setEnd(...position(end[0]!, end[1]!));
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      }, selectionCase);

    await selectBody();
    await rightClickSelection(page);
    await page.getByRole('menuitem', { name: 'Copy', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(selectionCase.text);
    await expect(pane).toBeVisible();
    expect(await result(page, 'references')).toEqual([]);

    await selectBody();
    await rightClickSelection(page);
    await page.getByRole('menuitem', { name: 'Quote', exact: true }).click();
    await expect(pane).toHaveCount(0);
    const references = (await result(page, 'references')) as Record<string, unknown>[];
    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({
      source: 'diff',
      origin: 'WORKING_TREE',
      path: 'src/example.ts',
      text: selectionCase.text,
      side: selectionCase.side,
      ...selectionCase.lines
    });
    for (const key of ['startLine', 'endLine', 'oldStartLine', 'oldEndLine']) {
      if (!(key in selectionCase.lines)) expect(references[0]).not.toHaveProperty(key);
    }
    expect(references[0]!.text).toBe(await page.evaluate(() => navigator.clipboard.readText()));
    await expect(page.locator('textarea.composer-input')).toHaveValue('Keep my opinion unchanged.');
    await expect(page.locator('#failure')).toBeEmpty();
  });
}

test('an oversized selection is rejected without rewriting the draft', async ({ page }) => {
  await page.evaluate(() =>
    (
      window as unknown as { quoteFixture: { replaceReply(text: string): void } }
    ).quoteFixture.replaceReply('x'.repeat(8001))
  );
  await selectReply(page);
  await page
    .getByRole('group', { name: 'Quote', exact: true })
    .getByRole('button', { name: 'Quote', exact: true })
    .click();
  await expect(page.locator('#failure')).toHaveText('Quote rejected');
  await expect(page.locator('.composer-file-reference-state')).toHaveCount(0);
  await expect(page.locator('textarea.composer-input')).toHaveValue('Keep my opinion unchanged.');
});

test('draft quote previews on hover, keyboard focus and click without removing the snapshot', async ({
  page
}) => {
  await selectReply(page);
  await page.getByRole('group', { name: 'Quote', exact: true }).getByRole('button').click();
  const tag = page.locator('.composer-file-reference-state');
  const preview = tag.getByRole('button', {
    name: 'Preview quote: Select this reply excerpt.',
    exact: true
  });
  const region = page.getByRole('region', { name: 'Quote', exact: true });
  await preview.hover();
  await expect(region).toContainText('Select this reply excerpt.');
  await page.locator('textarea.composer-input').click();
  await expect(page.getByRole('group', { name: 'Quote', exact: true })).toHaveCount(0);
  await preview.focus();
  await expect(region).toBeVisible();
  await preview.press('Escape');
  await expect(region).toBeHidden();
  await preview.click();
  await expect(region).toBeVisible();
  expect(await result(page, 'references')).toHaveLength(1);
  await tag
    .getByRole('button', { name: 'Remove quote Select this reply excerpt.', exact: true })
    .click();
  await expect(tag).toHaveCount(0);
  await expect(region).toHaveCount(0);
  await expect(page.locator('textarea.composer-input')).toHaveValue('Keep my opinion unchanged.');
});

for (const width of [320, 390]) {
  test(`long quote previews and sent snapshots stay readable at ${width}px`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const text = Array.from(
      { length: 24 },
      (_, index) => `Saved line ${index + 1}: literal <mar_goal> & text.`
    ).join('\n\n');
    await page.evaluate(
      (text) =>
        (
          window as unknown as { quoteFixture: { replaceReply(text: string): void } }
        ).quoteFixture.replaceReply(text),
      text
    );
    await page.locator('[data-quote-message-id]').evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    });
    await page.getByRole('group', { name: 'Quote', exact: true }).getByRole('button').click();
    const saved = ((await result(page, 'references')) as { text: string }[])[0]!.text;
    const preview = `${Array.from(saved).slice(0, 499).join('')}…`;
    await page.locator('.quote-tag-preview').click();
    const region = page.getByRole('region', { name: 'Quote', exact: true });
    await expect(region).toBeVisible();
    expect(await region.locator('.quote-excerpt-text').textContent()).toBe(preview);
    const metrics = await region.evaluate((element) => ({
      left: element.getBoundingClientRect().left,
      right: element.getBoundingClientRect().right,
      scrolls: element.scrollHeight > element.clientHeight
    }));
    expect(metrics.left).toBeGreaterThanOrEqual(0);
    expect(metrics.right).toBeLessThanOrEqual(width);
    expect(metrics.scrolls).toBe(true);
    await region.focus();
    await region.press('PageDown');
    await expect.poll(() => region.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await page.screenshot({
      path: testInfo.outputPath('draft-full-snapshot.png'),
      animations: 'disabled'
    });
    await page.locator('#send').click();
    expect(await result(page, 'payload')).toContain('Saved line 24:');
    const message = page.locator('.user_message');
    const excerpt = message.locator('.quote-excerpt-text');
    expect(await excerpt.textContent()).toBe(preview);
    await expect(excerpt).toHaveClass(/collapsed/);
    await message.getByRole('button', { name: 'Expand quote', exact: true }).click();
    await expect(excerpt).not.toHaveClass(/collapsed/);
    await message.getByRole('button', { name: 'Collapse quote', exact: true }).click();
    expect(
      await message.evaluate(
        (element) =>
          !!(
            element
              .querySelector('.quote-excerpt')!
              .compareDocumentPosition(element.querySelector('.conversation-message')!) &
            Node.DOCUMENT_POSITION_FOLLOWING
          )
      )
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath('sent-snapshot.png'),
      animations: 'disabled'
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
  });
}

test('hosted quote preview and removal use the same independent actions', async ({ page }) => {
  await page.goto(
    `${fixture.url}workbench-style.html?hosted-gesture=1&idle-composer=1&quote-selection=1`
  );
  await page.getByRole('button', { name: 'Add saved quote', exact: true }).click();
  const tag = page.locator('.composer-file-reference-state');
  await tag
    .getByRole('button', { name: 'Preview quote: Hosted saved snapshot.', exact: true })
    .click();
  await expect(page.getByRole('region', { name: 'Quote', exact: true })).toContainText(
    'Hosted saved snapshot.'
  );
  await tag
    .getByRole('button', { name: 'Remove quote Hosted saved snapshot.', exact: true })
    .click();
  await expect(tag).toHaveCount(0);
  await expect(page.getByRole('status', { name: 'Submitted intents' })).toBeEmpty();
});

test.describe('touch quote actions', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  test('supports tapping the bubble, full snapshot preview and outside dismissal', async ({
    page
  }) => {
    await selectReply(page);
    await page.getByRole('group', { name: 'Quote', exact: true }).getByRole('button').tap();
    const tag = page.locator('.composer-file-reference-state');
    await tag
      .getByRole('button', { name: 'Preview quote: Select this reply excerpt.', exact: true })
      .tap();
    const region = page.getByRole('region', { name: 'Quote', exact: true });
    await expect(region).toContainText('Select this reply excerpt.');
    await page.locator('textarea.composer-input').tap();
    await expect(region).toBeHidden();
    await tag
      .getByRole('button', { name: 'Remove quote Select this reply excerpt.', exact: true })
      .tap();
    await expect(tag).toHaveCount(0);
    await selectReply(page);
    const intercepted = await page
      .locator('[data-quote-message-id] p')
      .first()
      .evaluate((element) => {
        const rect = window.getSelection()!.getRangeAt(0).getClientRects()[0]!;
        const event = new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + 5,
          clientY: rect.top + rect.height / 2
        });
        element.dispatchEvent(event);
        // A queued selection notification must not replace an explicitly opened menu.
        document.dispatchEvent(new Event('selectionchange'));
        return event.defaultPrevented;
      });
    expect(intercepted).toBe(true);
    await page.getByRole('menuitem', { name: 'Quote', exact: true }).tap();
    await expect(tag).toHaveCount(1);
  });
});
