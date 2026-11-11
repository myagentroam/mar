import { expect, test, type Page } from '@playwright/test';
import { startPromptCompletionViteFixture } from './support/prompt-completion-vite.js';

type ReferenceHarnessWindow = Window & {
  __referenceHarness: {
    calls: string[];
    updates: number;
    sends: number;
    messages: string[];
    aborted: number;
    pending: boolean;
  };
};

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

test('mixed results render once and session selection removes the trigger in one undoable edit', async ({
  page
}) => {
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
  await expect(options.nth(0)).toContainText('Alpha session');
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(options.nth(1)).toContainText('alpha.ts');
  const before = await page.evaluate(
    () => (window as unknown as ReferenceHarnessWindow).__referenceHarness.updates
  );
  await options.nth(0).click();
  await expect(editor).toHaveValue('before  after');
  await expect(
    page.getByRole('button', { name: 'Remove Session reference Alpha session' })
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as ReferenceHarnessWindow).__referenceHarness.updates
    )
  ).toBe(before + 1);
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
  await files.filter({ hasText: 'alpha.ts' }).click();
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

test('session-only queries need no tabs and desktop empty picker does not send', async ({
  page
}) => {
  await page.goto(`${fixture.url}/composer-reference-browser.html`);
  const editor = page.locator('textarea.composer-input');
  await editor.fill('@al');
  await expect(page.locator('.file-reference-picker [role=option]')).toHaveCount(2);
  await expect(page.locator('.reference-filters')).toHaveCount(0);
  await editor.press('Enter');
  await expect(editor).toHaveValue('');
  await expect(
    page.getByRole('button', { name: 'Remove Session reference Alpha session' })
  ).toBeVisible();
  await editor.press('Control+z');
  await expect(editor).toHaveValue('@al');
  await editor.fill('@session al');
  await expect(page.locator('.file-reference-picker [role=option]')).toHaveCount(1);
  await editor.press('End');
  await page.keyboard.type('p');
  await expect(page.locator('.file-reference-picker [role=option]')).toHaveCount(1);
  const calls = await page.evaluate(
    () => (window as unknown as ReferenceHarnessWindow).__referenceHarness.calls as string[]
  );
  expect(calls.at(-1)).toContain('/api/agent-sessions?');
  expect(calls.at(-1)).toContain('query=alp');
  await editor.fill('@session nonexistent');
  await editor.press('Enter');
  expect(
    await page.evaluate(
      () => (window as unknown as ReferenceHarnessWindow).__referenceHarness.sends
    )
  ).toBe(0);
});

test('mobile Enter remains a newline while the picker is open', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${fixture.url}/composer-reference-browser.html?mobile=1`);
  const editor = page.locator('textarea.composer-input');
  await editor.fill('@alpha');
  await expect(page.locator('.file-reference-picker [role=option]')).toHaveCount(2);
  await editor.press('Enter');
  await expect(editor).toHaveValue('@alpha\n');
  expect(
    await page.evaluate(
      () => (window as unknown as ReferenceHarnessWindow).__referenceHarness.sends
    )
  ).toBe(0);
});

test('an insertion cancels the old prediction and composition cannot select', async ({ page }) => {
  await page.goto(`${fixture.url}/composer-reference-browser.html`);
  const editor = page.locator('textarea.composer-input');
  await editor.fill('@al');
  const options = page.locator('.file-reference-picker [role=option]');
  await expect(options).toHaveCount(2);
  await page.locator('[data-completion-action]').click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as ReferenceHarnessWindow).__referenceHarness.pending)
    )
    .toBe(true);
  await editor.evaluate((element) =>
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  );
  await options.filter({ hasText: 'Alpha session' }).click();
  await expect(editor).toHaveValue('@al');
  await expect(options).toHaveCount(2);
  await editor.evaluate((element) =>
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
  );
  await options.filter({ hasText: 'Alpha session' }).click();
  await expect(editor).toHaveValue('');
  await expect(
    page.getByRole('button', { name: 'Remove Session reference Alpha session' })
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as ReferenceHarnessWindow).__referenceHarness.aborted
    )
  ).toBe(1);
});

test('mixed reference tags serialize as XML and support click and Backspace removal', async ({
  page
}) => {
  await page.goto(`${fixture.url}/composer-reference-browser.html`);
  const editor = page.locator('textarea.composer-input');
  await editor.fill('Compare @alpha');
  await page.getByRole('option').filter({ hasText: 'Alpha session' }).click();
  await editor.pressSequentially('@alpha');
  await page.getByRole('option').filter({ hasText: 'alpha.ts' }).click();
  await expect(editor).toHaveValue('Compare ');
  const sessionTag = page.getByRole('button', { name: 'Remove Session reference Alpha session' });
  const fileTag = page.getByRole('button', { name: 'Remove file reference alpha.ts' });
  await expect(sessionTag).toBeVisible();
  await expect(fileTag).toBeVisible();
  await editor.press('Enter');
  const messages = await page.evaluate(
    () => (window as unknown as ReferenceHarnessWindow).__referenceHarness.messages as string[]
  );
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain('<mar_references>');
  expect(messages[0]).toContain(
    '<reference type="session" sessionId="other-123456" label="Alpha session" />'
  );
  expect(messages[0]).toContain('<reference type="file" path="src/alpha.ts" label="alpha.ts" />');
  expect(messages[0]).not.toContain('<mar-session:');
  await sessionTag.click();
  await expect(sessionTag).toHaveCount(0);
  await expect(fileTag).toBeVisible();
  await editor.fill('');
  await editor.press('Backspace');
  await expect(fileTag).toHaveCount(0);
  await editor.fill('@alpha');
  await page.getByRole('option').filter({ hasText: 'Alpha session' }).click();
  await expect(sessionTag).toBeVisible();
  await editor.press('Backspace');
  await expect(sessionTag).toHaveCount(0);
});

for (const [width, theme] of [
  [390, 'daylight'],
  [320, 'vscode-dark-2026'],
  [1280, 'daylight']
] as const) {
  test(`Composer candidate popups align with the input edges (${width}px, ${theme})`, async ({
    page
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript((value) => localStorage.setItem('mar.theme', value), theme);
    await page.goto(
      `${fixture.url}composer-reference-browser.html?theme=${theme}${width < 768 ? '&mobile=1' : ''}`
    );
    await page.evaluate((value) => {
      document.documentElement.classList.add('console-ui');
      document.documentElement.dataset.theme = value;
    }, theme);
    const editor = page.locator('textarea.composer-input');
    for (const [name, text] of [
      ['references', '@long'],
      ['quick-prompts', '#review'],
      ['commands', '/']
    ] as const) {
      await editor.fill(text);
      await placeCursor(page, text.length);
      const picker = page.locator('.command-picker');
      await expect(picker).toBeVisible();
      await expect(picker).toHaveCSS(
        'background-color',
        theme === 'daylight' ? 'rgb(255, 255, 255)' : 'rgb(26, 34, 48)'
      );
      if (name !== 'commands')
        await expect(picker.getByRole('option')).toHaveCount(name === 'references' ? 2 : 1);
      await expect
        .poll(async () => {
          const popup = (await picker.boundingBox())!;
          const shell = (await page.locator('.composer-shell').boundingBox())!;
          return (
            Math.abs(popup.x - shell.x) <= 1 &&
            Math.abs(popup.x + popup.width - shell.x - shell.width) <= 1
          );
        })
        .toBe(true);
      const bounds = (await picker.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(8);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 8);
      await page.screenshot({ path: info.outputPath(`${name}.png`), animations: 'disabled' });
    }
  });
}

for (const [theme, width] of [
  ['daylight', 1280],
  ['vscode-dark-2026', 1280],
  ['daylight', 390],
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
    await expect(picker.locator('.reference-filters')).toHaveCount(0);
    const session = picker.locator('[role=option]').first();
    await expect(session).toContainText('Alpha session');
    await expect(session.locator('.entry-kind')).toHaveCount(0);
    const alignment = await session.evaluate((element) => {
      const parts = [
        element.querySelector('.mar-icon')!,
        element.querySelector('.candidate-name')!,
        element.querySelector('.candidate-meta')!
      ];
      const centers = parts.map((part) => {
        const box = part.getBoundingClientRect();
        return (box.top + box.bottom) / 2;
      });
      return {
        spread: Math.max(...centers) - Math.min(...centers),
        sameFont: getComputedStyle(parts[1]!).fontFamily === getComputedStyle(parts[2]!).fontFamily
      };
    });
    expect(alignment.spread).toBeLessThanOrEqual(1);
    expect(alignment.sameFont).toBe(true);
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
  await expect(picker.locator('.session-candidate .entry-kind')).toHaveCount(0);
  await expect(picker).not.toContainText('other-12');
  await page.screenshot({ path: testInfo.outputPath('composer-reference-mobile-long-dark.png') });
});
