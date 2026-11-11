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
    range.setEnd(paragraphs[1]!, paragraphs[1]!.childNodes.length);
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

test('file menu selects the model text and quotes without closing the source or changing the opinion', async ({
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
  await expect(editor).toBeVisible();
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

test('mobile uses the selection bubble and standard context menu without message action buttons', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await selectReply(page);
  await expect(page.getByRole('group', { name: 'Quote', exact: true })).toBeVisible();
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

test('mobile file actions retain selection and never close the source', async ({ page }) => {
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
  await expect(page.locator('.cm-content')).toBeVisible();
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
      text: ' first value\n-old value\n+new value\n same value'
    }
  ]);
});

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
    await page.locator('.quote-tag-preview').click();
    const region = page.getByRole('region', { name: 'Quote', exact: true });
    await expect(region).toBeVisible();
    expect(await region.locator('.quote-excerpt-text').textContent()).toBe(saved);
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
    const message = page.locator('.user_message');
    const excerpt = message.locator('.quote-excerpt-text');
    expect(await excerpt.textContent()).toBe(saved);
    await expect(excerpt).toHaveClass(/collapsed/);
    await message.getByRole('button', { name: 'Show full quote', exact: true }).click();
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
