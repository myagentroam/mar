import { expect, test, type Page } from '@playwright/test';
import { startPromptCompletionViteFixture } from './support/prompt-completion-vite.js';

let fixture: Awaited<ReturnType<typeof startPromptCompletionViteFixture>>;
test.beforeAll(async () => {
  fixture = await startPromptCompletionViteFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

async function placeCursor(page: Page, position: number) {
  await page
    .locator('textarea.composer-input')
    .evaluate((editor: HTMLTextAreaElement, position) => {
      editor.focus();
      editor.setSelectionRange(position, position);
      editor.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }, position);
}

test('mixed results render once and session insertion is one undoable edit', async ({ page }) => {
  page.on('pageerror', (error) => console.error('Fixture page error:', error));
  page.on('console', (message) => {
    if (message.type() === 'error') console.error('Fixture console error:', message.text());
  });
  await page.goto(`${fixture.url}/composer-reference-browser.html`);
  const editor = page.locator('textarea.composer-input');
  await editor.fill('before @alphaSuffix after');
  await placeCursor(page, 10);
  const options = page.locator('.file-reference-picker [role=option]');
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toContainText('alpha.ts');
  await expect(options.nth(1)).toContainText('Alpha session');
  const before = await page.evaluate(() => (window as any).__referenceHarness.updates);
  await options.nth(1).click();
  await expect(editor).toHaveValue('before <mar-session: Alpha session> after');
  expect(await page.evaluate(() => (window as any).__referenceHarness.updates)).toBe(before + 1);
  await editor.press('Control+z');
  await expect(editor).toHaveValue('before @alphaSuffix after');
});

test('file insertion, quick prompt and their undo preserve surrounding text', async ({ page }) => {
  await page.goto(`${fixture.url}/composer-reference-browser.html`);
  const editor = page.locator('textarea.composer-input');
  await editor.fill('before @alphaSuffix after');
  await placeCursor(page, 10);
  const files = page.locator('.file-reference-picker [role=option]');
  await expect(files).toHaveCount(2);
  await files.first().click();
  await expect(editor).toHaveValue('before  after');
  await expect(page.locator('.composer-file-reference-state')).toContainText('alpha.ts');
  await editor.press('Control+z');
  await expect(editor).toHaveValue('before @alphaSuffix after');
  await editor.fill('before #reviewSuffix after');
  await placeCursor(page, 11);
  await expect(page.locator('.command-picker').filter({ hasText: 'review' })).toBeVisible();
  await editor.press('Enter');
  await expect(editor).toHaveValue('before Review\nchanges after');
  await editor.press('Control+z');
  await expect(editor).toHaveValue('before #reviewSuffix after');
});

test('filter persists while typing; desktop empty picker does not send', async ({ page }) => {
  await page.goto(`${fixture.url}/composer-reference-browser.html`);
  const editor = page.locator('textarea.composer-input');
  await editor.fill('@al');
  await expect(page.locator('.file-reference-picker [role=option]')).toHaveCount(2);
  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await expect(editor).toBeFocused();
  await editor.press('End');
  await page.keyboard.type('p');
  await expect(page.getByRole('button', { name: 'Sessions', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(page.locator('.file-reference-picker [role=option]')).toHaveCount(1);
  const calls = await page.evaluate(() => (window as any).__referenceHarness.calls as string[]);
  expect(calls.at(-1)).toContain('/api/agent-sessions?');
  expect(calls.at(-1)).toContain('query=alp');
  await editor.fill('@session nonexistent');
  await editor.press('Enter');
  expect(await page.evaluate(() => (window as any).__referenceHarness.sends)).toBe(0);
});

test('mobile Enter remains a newline while the picker is open', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${fixture.url}/composer-reference-browser.html?mobile=1`);
  const editor = page.locator('textarea.composer-input');
  await editor.fill('@alpha');
  await expect(page.locator('.file-reference-picker [role=option]')).toHaveCount(2);
  await editor.press('Enter');
  await expect(editor).toHaveValue('@alpha\n');
  expect(await page.evaluate(() => (window as any).__referenceHarness.sends)).toBe(0);
});

test('an insertion cancels the old prediction and composition cannot select', async ({ page }) => {
  await page.goto(`${fixture.url}/composer-reference-browser.html`);
  const editor = page.locator('textarea.composer-input');
  await editor.fill('@al');
  const options = page.locator('.file-reference-picker [role=option]');
  await expect(options).toHaveCount(2);
  await page.locator('[data-completion-action]').click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__referenceHarness.pending))
    .toBe(true);
  await editor.evaluate((element) =>
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  );
  await options.last().click();
  await expect(editor).toHaveValue('@al');
  await expect(options).toHaveCount(2);
  await editor.evaluate((element) =>
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
  );
  await options.last().click();
  await expect(editor).toHaveValue('<mar-session: Alpha session> ');
  expect(await page.evaluate(() => (window as any).__referenceHarness.aborted)).toBe(1);
});

for (const [theme, width] of [
  ['daylight', 1280],
  ['vscode-dark-2026', 390]
] as const) {
  test(`candidate groups remain readable in ${theme} at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(
      `${fixture.url}/composer-reference-browser.html${width < 500 ? '?mobile=1' : ''}`
    );
    await page.evaluate((theme) => {
      document.documentElement.classList.add('console-ui');
      document.documentElement.dataset.theme = theme;
    }, theme);
    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement)
            .getPropertyValue('--mar-control-bg-color-overlay')
            .trim()
        )
      )
      .toBe(theme === 'daylight' ? '#ffffff' : '#1a2230');
    await page.locator('textarea.composer-input').fill('@alpha');
    const picker = page.locator('.file-reference-picker');
    await expect(picker.locator('[role=option]')).toHaveCount(2);
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await expect
      .poll(() => picker.evaluate((element) => getComputedStyle(element).backgroundColor))
      .toBe(theme === 'daylight' ? 'rgb(255, 255, 255)' : 'rgb(26, 34, 48)');
    expect(await picker.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true
    );
    await page.screenshot({
      path: testInfo.outputPath(`composer-reference-${theme}-${width}.png`)
    });
  });
}

test('long mixed candidate names stay bounded at mobile width', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${fixture.url}/composer-reference-browser.html?mobile=1`);
  await page.locator('textarea.composer-input').fill('@long');
  const picker = page.locator('.file-reference-picker');
  await expect(picker.locator('[role=option]')).toHaveCount(2);
  await page.evaluate(() => {
    document.documentElement.classList.add('console-ui');
    document.documentElement.dataset.theme = 'vscode-dark-2026';
  });
  expect(await picker.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const names = picker.locator('.candidate-name');
  expect(await names.nth(0).evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
    true
  );
  expect(await names.nth(1).evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
    true
  );
  await expect(picker.locator('[role=option]').last().locator('.entry-kind')).toHaveText(
    'other-12'
  );
  await page.screenshot({ path: testInfo.outputPath('composer-reference-mobile-long-dark.png') });
});
