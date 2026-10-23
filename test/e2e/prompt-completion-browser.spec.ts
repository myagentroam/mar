import { expect, test, type Locator, type Page } from '@playwright/test';
import { startPromptCompletionViteFixture } from './support/prompt-completion-vite.js';

interface PromptCompletionHarness {
  readonly requests: {
    readonly contextKey: string;
    readonly draft: { readonly text: string; readonly cursor: number };
    aborted: boolean;
  }[];
  readonly submissions: number;
  readonly interrupts: number;
  readonly parentKeydowns: number;
  signalTerminal(key: string): void;
  reviseContext(key: string): void;
  selectContext(key: string, automaticKey?: string | null, terminalKey?: string | null): void;
  restoreFocus(): void;
  foreground(visible: boolean, focused: boolean): void;
  resolve(index: number, suggestion: string | null): void;
}

let fixture: Awaited<ReturnType<typeof startPromptCompletionViteFixture>>;

test.beforeAll(async () => {
  fixture = await startPromptCompletionViteFixture();
});

test.afterAll(async () => {
  await fixture?.close();
});

for (const mode of ['workspace'] as const) {
  test.describe(`${mode} Composer Prompt Completion`, () => {
    test.beforeEach(async ({ page }) => {
      await page.clock.install();
      await openComposer(page);
    });

    test('empty prediction stays inline and restores Generate without retrying', async ({
      page
    }) => {
      const editor = page.locator('textarea.composer-input');
      await startPendingRequest(editor, page, '', 0);
      await page.evaluate(() => window.__promptCompletionHarness.resolve(0, null));
      await expect(page.locator('.completion-status')).toHaveText(
        'No suitable prediction right now.'
      );
      await expect(page.locator('[data-completion-action]')).toHaveText('Generate');
      await page.clock.fastForward(3100);
      await expect(page.locator('.completion-status')).toHaveText('Composer Prediction');
      expect(await requestCount(page)).toBe(1);
    });

    for (const theme of ['daylight', 'vscode-dark-2026'] as const) {
      test(`prediction actions use shared interaction colors in ${theme}`, async ({ page }) => {
        await page.goto(`${fixture.url}/?automatic=0`);
        await page.evaluate((theme) => {
          document.documentElement.classList.add('console-ui');
          document.documentElement.dataset.theme = theme;
        }, theme);
        const palette = await page.evaluate(() => {
          const probe = document.createElement('span');
          document.body.append(probe);
          const read = (token: string) => {
            probe.style.color = `var(${token})`;
            return getComputedStyle(probe).color;
          };
          const colors = {
            normal: read('--mar-text-secondary'),
            hover: read('--mar-color-brand-text'),
            outline: read('--mar-color-brand')
          };
          probe.remove();
          return colors;
        });
        const editor = page.locator('textarea.composer-input');
        const action = page.locator('[data-completion-action]');
        async function expectActionStyles(button: Locator) {
          await editor.focus();
          await page.mouse.move(0, 0);
          await expect(button).toHaveCSS('color', palette.normal);
          await expect(button).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
          await button.hover();
          await expect(button).toHaveCSS('color', palette.hover);
          await expect(button).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
          await page.mouse.down();
          try {
            await expect(button).toHaveCSS('color', palette.hover);
            await expect(button).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
          } finally {
            await page.mouse.move(0, 0);
            await page.mouse.up();
          }
          await page.keyboard.press('Shift');
          await button.focus();
          await expect(button).toBeFocused();
          await expect(button).toHaveCSS('outline-style', 'solid');
          await expect(button).toHaveCSS('outline-width', '2px');
          await expect(button).toHaveCSS('outline-color', palette.outline);
        }

        await expect(action).toHaveText('Generate');
        await expectActionStyles(action);
        await startPendingRequest(editor, page, '', 0);
        await expect(action).toHaveText('Cancel');
        await expectActionStyles(action);
        await resolveRequest(page, 0, 'Check the recent changes.');
        await expect(action).toHaveText('Accept');
        await expectActionStyles(action);
        await expectActionStyles(page.locator('[data-completion-cancel]'));
        expect(await requestCount(page)).toBe(1);
      });
    }

    for (const language of ['en-US', 'zh-CN'] as const) {
      test(`prediction status bar has state feedback and respects reduced motion ${language}`, async ({
        page
      }, testInfo) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${fixture.url}/?locale=${language}`);
        await page.evaluate(() => {
          document.documentElement.classList.add('console-ui');
          document.documentElement.dataset.theme = 'vscode-dark-2026';
        });
        const status = page.locator('.completion-status');
        await expect(page.locator('[data-completion-action]')).toHaveText(
          language === 'en-US' ? 'Generate' : '生成'
        );
        await expect(status).toHaveText(language === 'en-US' ? 'Composer Prediction' : '输入预测');
        const indicator = page.locator(
          '.completion-status > .completion-indicator, .completion-status > .busy-indicator'
        );
        await expect(indicator).toHaveCSS('width', '5px');
        await expect(indicator).toHaveCSS('height', '5px');
        const editor = page.locator('textarea.composer-input');
        await startPendingRequest(editor, page, '', 0);
        await expect(status).toHaveText(language === 'en-US' ? 'Generating…' : '生成中…');
        await expect(page.locator('[data-completion-action]')).toHaveText(
          language === 'en-US' ? 'Cancel' : '取消'
        );
        await expect(indicator).toHaveCSS('width', '12px');
        const bar = page.locator('.completion-actions');
        await expect(page.locator('.completion-hint')).toBeHidden();
        await expect.poll(async () => (await bar.boundingBox())!.height).toBeLessThanOrEqual(28);
        await expect(indicator).toHaveCSS('animation-name', /^busy-indicator-spin/);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await expect(indicator).toHaveCSS('animation-name', 'none');
        await resolveRequest(page, 0, 'Check the recent changes.');
        await expect(status).toHaveText(language === 'en-US' ? 'Prediction ready' : '预测已就绪');
        await expect(indicator).toHaveCSS('width', '5px');
        await expect(page.locator('[data-completion-action]')).toHaveText(
          language === 'en-US' ? 'Accept' : '采用'
        );
        await expect.poll(async () => (await bar.boundingBox())!.height).toBeLessThanOrEqual(28);
        await expect(bar).toHaveCSS('border-radius', '0px');
        const font = await status.evaluate((el) => getComputedStyle(el).fontSize);
        await expect(page.locator('[data-completion-action]')).toHaveCSS('font-size', font);
        expect(await bar.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath('prediction-status.png') });
        await page.setViewportSize({ width: 1280, height: 720 });
        await expect.poll(async () => (await bar.boundingBox())!.height).toBeLessThanOrEqual(28);
        await editor.press('Escape');
        await expect(status).toHaveText(language === 'en-US' ? 'Composer Prediction' : '输入预测');
      });

      test(`mobile action buttons cancel pending work and accept the ready suggestion ${language}`, async ({
        browser
      }) => {
        const context = await browser.newContext({
          viewport: { width: 390, height: 844 },
          hasTouch: true
        });
        try {
          const page = await context.newPage();
          await page.goto(`${fixture.url}/?locale=${language}`);
          const editor = page.locator('textarea.composer-input');
          const action = page.locator('button[data-completion-action]');

          await startPendingRequest(editor, page, 'Cancel this request', 9);
          await expect(action).toHaveText(language === 'en-US' ? 'Cancel' : '取消');
          await page.evaluate(() => {
            const editor = document.querySelector('textarea.composer-input')!;
            const action = document.querySelector('button[data-completion-action]')!;
            const record = (name: string) => {
              const events = document.documentElement.dataset.completionPointerEvents ?? '';
              document.documentElement.dataset.completionPointerEvents = [events, name]
                .filter(Boolean)
                .join(',');
            };
            document.addEventListener(
              'pointerdown',
              (event) => {
                if (action.contains(event.target as Node))
                  record(`pointerdown:${(event as PointerEvent).pointerType}`);
              },
              true
            );
            editor.addEventListener('blur', () => record('blur'));
            document.addEventListener(
              'click',
              (event) => {
                if (action.contains(event.target as Node)) record('click');
              },
              true
            );
          });
          await action.tap();
          await expect(page.locator('html')).toHaveAttribute(
            'data-completion-pointer-events',
            'pointerdown:touch,blur,click'
          );
          await expect.poll(() => requestAborted(page, 0)).toBe(true);
          await expect.poll(() => requestCount(page)).toBe(1);
          await expect(page.locator('.completion-status')).toHaveText(
            language === 'en-US' ? 'Composer Prediction' : '输入预测'
          );

          await startPendingRequest(editor, page, 'Accept this suggestion', 6, 2);
          await resolveRequest(page, 1, 'Rewritten prompt');
          await expect(action).toHaveText(language === 'en-US' ? 'Accept' : '采用');
          await page.locator('html').evaluate((element) => {
            delete (element as HTMLElement).dataset.completionPointerEvents;
          });
          await action.tap();
          await expect(page.locator('html')).toHaveAttribute(
            'data-completion-pointer-events',
            'pointerdown:touch,blur,click'
          );
          await expect(editor).toHaveValue('Rewritten prompt');
          await expect.poll(() => submissionCount(page)).toBe(0);
        } finally {
          await context.close();
        }
      });
    }

    test('double Tab requests once; preview replaces the whole draft without submitting and supports undo/redo', async ({
      page
    }) => {
      const editor = page.locator('textarea.composer-input');
      await setDraft(editor, 'Check suffix', 6);
      await editor.press('Tab');
      await editor.press('Tab');
      await expect.poll(() => requestCount(page)).toBe(1);
      expect(await requestDraft(page, 0)).toEqual({ text: 'Check suffix', cursor: 12 });

      await resolveRequest(page, 0, 'API ');
      await expect(page.locator('.completion-mirror')).toHaveText('API ');
      await expect(page.locator('.completion-insertion')).toHaveText('API ');
      await expect(editor).toHaveValue('Check suffix');

      await editor.press('Tab');
      await expect(editor).toHaveValue('API ');
      await expect.poll(() => submissionCount(page)).toBe(0);
      await editor.press('Control+z');
      await expect(editor).toHaveValue('Check suffix');
      await editor.press('Control+Shift+z');
      await expect(editor).toHaveValue('API ');
      await expect.poll(() => submissionCount(page)).toBe(0);
    });

    test('wrapped preview follows editor width and preserves multiline replacement', async ({
      page
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      const editor = page.locator('textarea.composer-input');
      const draft =
        'Check the current implementation and preserve the existing API contract.\nThen test it.';
      const cursor = draft.indexOf('\n');
      await setDraft(editor, draft, cursor);
      await editor.press('Tab');
      await editor.press('Tab');
      await expect.poll(() => requestCount(page)).toBe(1);
      const insertion = '\nInclude compatibility checks.';
      await resolveRequest(page, 0, insertion);
      const mirror = page.locator('.completion-mirror');
      await expect(mirror).toBeVisible();
      const inputBox = await editor.boundingBox();
      const previewBox = await mirror.boundingBox();
      expect(Math.abs(inputBox!.x - previewBox!.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(inputBox!.width - previewBox!.width)).toBeLessThanOrEqual(1);
      await expect(editor).toHaveValue(draft);
      await editor.press('Tab');
      await expect(editor).toHaveValue(insertion);
      await expect.poll(() => submissionCount(page)).toBe(0);
    });

    test('focus changes preserve pending and ready predictions until explicit cancellation', async ({
      page
    }) => {
      const editor = page.locator('textarea.composer-input');
      await startPendingRequest(editor, page, '', 0);
      await page.getByTestId('after-composer').click();
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      expect(await requestAborted(page, 0)).toBe(false);
      await resolveRequest(page, 0, 'Keep this prediction');
      await expect(editor).toHaveAttribute('placeholder', 'Keep this prediction');
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await editor.focus();
      await expect(editor).toHaveAttribute('placeholder', 'Keep this prediction');
      await editor.press('Shift+Tab');
      await expect(editor).not.toBeFocused();
      await expect(editor).toHaveAttribute('placeholder', 'Keep this prediction');
      await page.locator('[data-completion-cancel]').click();
      await expect(editor).toHaveValue('');
      await expect(editor).toHaveAttribute('placeholder', 'Fixture message placeholder');
      await expect.poll(() => requestCount(page)).toBe(1);
      await expect(editor).toBeFocused();
    });

    test('unfocused replies do not refresh after editing, while endings and focused replies do', async ({
      page
    }) => {
      const editor = page.locator('textarea.composer-input');
      const outside = page.getByTestId('after-composer');
      // Editing consumes entry intent, isolating reply and ending signals in this test.
      await editor.fill('Draft');
      await editor.fill('');
      await outside.click();
      await page.evaluate(() => window.__promptCompletionHarness.signal('working-reply'));
      await page.clock.fastForward(1000);
      expect(await requestCount(page)).toBe(0);
      await page.evaluate(() => window.__promptCompletionHarness.signalTerminal('turn-ended'));
      await page.clock.fastForward(800);
      expect(await requestCount(page)).toBe(1);
      await resolveRequest(page, 0, 'Next without editor focus');
      await expect(editor).toHaveAttribute('placeholder', 'Next without editor focus');
      await expect(outside).toBeFocused();
      await expect(editor).toHaveValue('');
      await page.evaluate(() => window.__promptCompletionHarness.signal('late-final-reply'));
      await page.clock.fastForward(16_000);
      expect(await requestCount(page)).toBe(1);
      await editor.click();
      await page.clock.fastForward(800);
      expect(await requestCount(page)).toBe(2);
      await resolveRequest(page, 1, 'Focused next');
      await page.evaluate(() => window.__promptCompletionHarness.signal('focused-reply'));
      await page.clock.fastForward(15_000);
      expect(await requestCount(page)).toBe(3);
    });

    test('an unfocused ending waits for foreground and each entered history checks once', async ({
      page
    }) => {
      const editor = page.locator('textarea.composer-input');
      await page.getByTestId('after-composer').click();
      await page.evaluate(() => {
        window.__promptCompletionHarness.foreground(false, false);
        window.__promptCompletionHarness.signalTerminal('ended-in-background');
      });
      await page.clock.fastForward(1000);
      expect(await requestCount(page)).toBe(0);
      await page.evaluate(() => window.__promptCompletionHarness.foreground(true, true));
      await page.clock.fastForward(800);
      expect(await requestCount(page)).toBe(1);
      await resolveRequest(page, 0, 'Returned ending');
      await expect(editor).toHaveAttribute('placeholder', 'Returned ending');
      await expect(editor).not.toBeFocused();
      for (const [index, key] of ['loaded-other', 'loaded-first'].entries()) {
        await page.evaluate(
          (key) =>
            window.__promptCompletionHarness.selectContext(key, `${key}-reply`, `${key}-ended`),
          key
        );
        await page.clock.fastForward(1000);
        expect(await requestCount(page)).toBe(index + 2);
        await resolveRequest(page, index + 1, `Next for ${key}`);
        await page.clock.fastForward(16_000);
        expect(await requestCount(page)).toBe(index + 2);
      }
    });

    test('starting a new turn discards its previous queued ending and drafts still block requests', async ({
      page
    }) => {
      const editor = page.locator('textarea.composer-input');
      await editor.fill('Draft');
      await editor.fill('');
      await page.getByTestId('after-composer').click();
      await page.evaluate(() => window.__promptCompletionHarness.signalTerminal('previous-ending'));
      await page.clock.fastForward(400);
      await page.evaluate(() => {
        window.__promptCompletionHarness.signalTerminal('');
        window.__promptCompletionHarness.signal('new-running-reply');
      });
      await page.clock.fastForward(1000);
      expect(await requestCount(page)).toBe(0);
      await editor.fill('Keep my unsent draft');
      await page.getByTestId('after-composer').click();
      await page.evaluate(() => window.__promptCompletionHarness.signalTerminal('new-ending'));
      await page.clock.fastForward(16_000);
      expect(await requestCount(page)).toBe(0);
      await expect(editor).toHaveValue('Keep my unsent draft');
    });

    test('refocus respects absent automatic capability while retaining manual prediction', async ({
      page
    }) => {
      await page.goto(`${fixture.url}/?automatic=0`);
      const editor = page.locator('textarea.composer-input');
      await editor.click();
      await page.clock.fastForward(16_000);
      expect(await requestCount(page)).toBe(0);
      await editor.press('Tab');
      await editor.press('Tab');
      expect(await requestCount(page)).toBe(1);
      expect(await page.evaluate(() => window.__promptCompletionHarness.requests[0]?.trigger)).toBe(
        'MANUAL'
      );
    });

    test('entry and refocus predict running turns while reusing the latest valid candidate', async ({
      page
    }) => {
      const editor = page.locator('textarea.composer-input');
      await page.evaluate(() =>
        window.__promptCompletionHarness.selectContext('running', 'loaded', '')
      );
      await editor.click();
      await page.clock.fastForward(1000);
      expect(await requestCount(page)).toBe(1);
      await page.getByTestId('after-composer').click();
      await editor.click();
      await resolveRequest(page, 0, 'Next step');
      await page.clock.fastForward(16_000);
      expect(await requestCount(page)).toBe(1);
      await page.getByTestId('after-composer').click();
      await editor.click();
      await page.clock.fastForward(1000);
      expect(await requestCount(page)).toBe(1);
      await expect(editor).toHaveAttribute('placeholder', 'Next step');
      await page.clock.fastForward(61_000);
      await page.getByTestId('after-composer').click();
      await editor.click();
      await page.clock.fastForward(800);
      expect(await requestCount(page)).toBe(2);
    });

    test('a one-second session visit predicts without editor focus or cross-session cooldown', async ({
      page
    }) => {
      const editor = page.locator('textarea.composer-input');
      await editor.fill('Pause initial entry');
      await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000));
      await editor.fill('');
      for (const [index, key] of ['session-b', 'session-a', 'session-b'].entries()) {
        await page.getByTestId('after-composer').click();
        await page.evaluate(
          (key) =>
            window.__promptCompletionHarness.selectContext(key, `${key}-loaded`, `${key}-ended`),
          key
        );
        await page.clock.fastForward(999);
        expect(await requestCount(page)).toBe(index);
        await page.clock.fastForward(1);
        expect(await requestCount(page)).toBe(index + 1);
        await expect(editor).not.toBeFocused();
        await page.evaluate(() => window.__promptCompletionHarness.restoreFocus());
        await page.clock.fastForward(800);
        expect(await requestCount(page)).toBe(index + 1);
        await resolveRequest(page, index, `Next for ${key}`);
      }
      await page.locator('[data-completion-cancel]').click();
      await expect(editor).toBeFocused();
      await page.clock.fastForward(16_000);
      expect(await requestCount(page)).toBe(3);
      await page.evaluate(() => window.__promptCompletionHarness.signal('fresh-reply'));
      await page.clock.fastForward(800);
      expect(await requestCount(page)).toBe(4);
    });

    test('short visits are skipped and late predictions cannot appear in the next conversation', async ({
      page
    }) => {
      const editor = page.locator('textarea.composer-input');
      await editor.fill('Pause initial entry');
      await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000));
      await editor.fill('');
      await page.getByTestId('after-composer').click();
      await page.evaluate(() =>
        window.__promptCompletionHarness.selectContext('brief', 'reply', '')
      );
      await page.clock.fastForward(600);
      await page.evaluate(() =>
        window.__promptCompletionHarness.selectContext('staying', 'reply', '')
      );
      await page.clock.fastForward(999);
      expect(await requestCount(page)).toBe(0);
      await page.clock.fastForward(1);
      expect(await requestCount(page)).toBe(1);
      expect(
        await page.evaluate(() => window.__promptCompletionHarness.requests[0]?.contextKey)
      ).toBe('staying');
      await page.evaluate(() =>
        window.__promptCompletionHarness.selectContext('next', 'reply', '')
      );
      expect(await requestAborted(page, 0)).toBe(true);
      await resolveRequest(page, 0, 'Old conversation prediction');
      await expect(editor).toHaveAttribute('placeholder', 'Fixture message placeholder');
      await page.clock.fastForward(1000);
      expect(await requestCount(page)).toBe(2);
      expect(
        await page.evaluate(() => window.__promptCompletionHarness.requests[1]?.contextKey)
      ).toBe('next');
      await expect(editor).not.toBeFocused();
    });

    test('early Composer focus survives delayed history readiness without another dwell delay', async ({
      page
    }) => {
      const editor = page.locator('textarea.composer-input');
      await editor.fill('Pause initial entry');
      await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000));
      await editor.fill('');
      await page.evaluate(() =>
        window.__promptCompletionHarness.selectContext('loading', null, null)
      );
      await editor.focus();
      await page.clock.fastForward(1300);
      expect(await requestCount(page)).toBe(0);
      await page.evaluate(() =>
        window.__promptCompletionHarness.selectContext('loading', 'loaded', '')
      );
      await page.clock.fastForward(0);
      expect(await requestCount(page)).toBe(1);
      await resolveRequest(page, 0, 'Continue from current progress');
      await expect(editor).toHaveAttribute('placeholder', 'Continue from current progress');
      await expect(editor).toBeFocused();
      await page.clock.fastForward(16_000);
      expect(await requestCount(page)).toBe(1);
    });

    test('browser foreground return coalesces focus and visibility using the current completed turn', async ({
      page
    }) => {
      const editor = page.locator('textarea.composer-input');
      await page.evaluate(() => window.__promptCompletionHarness.restoreFocus());
      await page.evaluate(() => window.__promptCompletionHarness.foreground(false, false));
      await page.evaluate(() =>
        window.__promptCompletionHarness.selectContext('completed', 'loaded', 'ended')
      );
      await page.clock.fastForward(1000);
      expect(await requestCount(page)).toBe(0);
      await page.evaluate(() => window.__promptCompletionHarness.foreground(true, true));
      await page.clock.fastForward(800);
      expect(await requestCount(page)).toBe(1);
      await resolveRequest(page, 0, 'Returned next step');
      await expect(editor).toHaveAttribute('placeholder', 'Returned next step');
      await page.evaluate(() => window.__promptCompletionHarness.foreground(false, false));
      await page.evaluate(() =>
        window.__promptCompletionHarness.selectContext('other', 'other-loaded', 'other-ended')
      );
      await page.evaluate(() => window.__promptCompletionHarness.foreground(true, true));
      await page.clock.fastForward(15_000);
      expect(await requestCount(page)).toBe(2);
    });

    test('automatic prediction requires empty focused Composer and coalesces new Agent events', async ({
      page
    }) => {
      const editor = page.locator('textarea.composer-input');
      await editor.focus();
      await page.evaluate(() => {
        window.__promptCompletionHarness.signal('message-1');
        window.__promptCompletionHarness.signal('message-2');
      });
      await page.clock.fastForward(1000);
      await expect.poll(() => requestCount(page)).toBe(1);
      expect(await page.evaluate(() => window.__promptCompletionHarness.requests[0]?.trigger)).toBe(
        'AUTO'
      );
      await resolveRequest(page, 0, 'Next action');
      await page.evaluate(() => window.__promptCompletionHarness.signal('completed'));
      await expect(editor).toHaveAttribute('placeholder', 'Next action');
      await page.clock.fastForward(16_000);
      await expect.poll(() => requestCount(page)).toBe(2);
      await resolveRequest(page, 1, 'New completed-turn action');
      await expect(editor).toHaveAttribute('placeholder', 'New completed-turn action');
      await page.locator('[data-completion-cancel]').click();
      await editor.fill('Keep my draft');
      await page.evaluate(() => window.__promptCompletionHarness.signal('message-with-draft'));
      await expect(page.locator('[data-completion-action]')).toHaveText('Generate');
      expect(await requestCount(page)).toBe(2);
    });

    test('running refocus creates its own missing-candidate check rather than replaying replies', async ({
      page
    }) => {
      const editor = page.locator('textarea.composer-input');
      await editor.fill('Draft');
      await editor.fill('');
      await page.getByTestId('after-composer').click();
      await page.evaluate(() => window.__promptCompletionHarness.signal('unfocused-message'));
      await page.clock.fastForward(1000);
      expect(await requestCount(page)).toBe(0);
      await editor.click();
      await page.clock.fastForward(1000);
      expect(await requestCount(page)).toBe(1);
      await resolveRequest(page, 0, 'Review progress');
      await page.evaluate(() => window.__promptCompletionHarness.signal('focused-message'));
      await page.clock.fastForward(15_000);
      expect(await requestCount(page)).toBe(2);
      await resolveRequest(page, 1, 'Review current progress');
      await editor.press('Tab');
      await expect(editor).toHaveValue('Review current progress');
    });

    test('completed-turn refocus refreshes changed browsing and task context but those changes alone do not trigger', async ({
      page
    }) => {
      const editor = page.locator('textarea.composer-input');
      await page.evaluate(() =>
        window.__promptCompletionHarness.selectContext('completed', 'reply', 'ended')
      );
      await editor.click();
      await page.clock.fastForward(1000);
      await resolveRequest(page, 0, 'Original context');
      await page.getByTestId('after-composer').click();
      await page.evaluate(() =>
        window.__promptCompletionHarness.reviseContext('new-diff-and-goal')
      );
      await page.clock.fastForward(16_000);
      expect(await requestCount(page)).toBe(1);
      await editor.click();
      await page.clock.fastForward(800);
      expect(await requestCount(page)).toBe(2);
      await resolveRequest(page, 1, 'Updated context');
      await expect(editor).toHaveAttribute('placeholder', 'Updated context');
    });

    for (const gesture of ['double', 'single'] as const) {
      test(`${gesture} Tab gesture takes priority over an automatic request becoming due`, async ({
        page
      }) => {
        const editor = page.locator('textarea.composer-input');
        await editor.click();
        await page.evaluate(() => window.__promptCompletionHarness.signal('reply'));
        await page.clock.fastForward(600);
        await editor.press('Tab');
        await page.clock.fastForward(200);
        expect(await requestCount(page)).toBe(0);
        if (gesture === 'double') {
          await editor.press('Tab');
        } else {
          await page.clock.fastForward(100);
          await page.clock.fastForward(800);
        }
        expect(await requestCount(page)).toBe(1);
        expect(
          await page.evaluate(() => window.__promptCompletionHarness.requests[0]?.trigger)
        ).toBe(gesture === 'double' ? 'MANUAL' : 'AUTO');
        await resolveRequest(page, 0, 'Available suggestion');
        await page.clock.fastForward(16_000);
        expect(await requestCount(page)).toBe(1);
        await expect(editor).toHaveAttribute('placeholder', 'Available suggestion');
        await expect(editor).toBeFocused();
      });
    }

    test('automatic abstention is silent and overlapping reply, ending and focus signals request once', async ({
      page
    }) => {
      const editor = page.locator('textarea.composer-input');
      await editor.click();
      await page.evaluate(() => {
        window.__promptCompletionHarness.signal('reply');
        window.__promptCompletionHarness.signalTerminal('ended');
      });
      await page.getByTestId('after-composer').click();
      await editor.click();
      await page.clock.fastForward(1000);
      expect(await requestCount(page)).toBe(1);
      await page.evaluate(() => window.__promptCompletionHarness.resolve(0, null));
      await expect(page.locator('.completion-status')).toHaveText('Composer Prediction');
      await page.clock.fastForward(16_000);
      expect(await requestCount(page)).toBe(1);
      await expect(editor).toHaveValue('');
    });

    test('automatic refresh preserves the visible candidate while generating and replaces it without changing the draft', async ({
      page
    }) => {
      const editor = page.locator('textarea.composer-input');
      await editor.click();
      await page.evaluate(() => window.__promptCompletionHarness.signal('first'));
      await page.clock.fastForward(1000);
      await resolveRequest(page, 0, 'Existing suggestion');
      await page.evaluate(() => window.__promptCompletionHarness.signal('next'));
      await page.clock.fastForward(15_000);
      expect(await requestCount(page)).toBe(2);
      await expect(page.locator('[data-completion-action]')).toHaveText('Cancel');
      await expect(editor).toHaveAttribute('placeholder', 'Existing suggestion');
      await expect(editor).toHaveValue('');
      await resolveRequest(page, 1, 'Refreshed suggestion');
      await expect(editor).toHaveAttribute('placeholder', 'Refreshed suggestion');
      await expect(editor).toBeFocused();
      await expect(editor).toHaveValue('');
    });

    test('empty draft previews through the placeholder and acceptance restores its original value', async ({
      page
    }) => {
      const editor = page.locator('textarea.composer-input');
      await setDraft(editor, '', 0);
      await editor.press('Tab');
      await editor.press('Tab');
      await expect.poll(() => requestCount(page)).toBe(1);
      await resolveRequest(page, 0, 'Next step');

      await expect(editor).toHaveAttribute('placeholder', 'Next step');
      await expect(editor).toHaveValue('');
      await editor.press('Tab');
      await expect(editor).toHaveValue('Next step');
      await expect(editor).toHaveAttribute('placeholder', 'Fixture message placeholder');
      await expect.poll(() => submissionCount(page)).toBe(0);
    });

    test('mobile Composer uses one compact size for placeholder, preview and editable text', async ({
      page
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await expect
        .poll(() =>
          page.evaluate(() =>
            getComputedStyle(document.documentElement)
              .getPropertyValue('--mar-font-size-input')
              .trim()
          )
        )
        .toBe('0.875rem');
      const editor = page.locator('textarea.composer-input');
      const placeholderSize = () =>
        editor.evaluate((element) => getComputedStyle(element, '::placeholder').fontSize);
      await setDraft(editor, '', 0);
      await expect(editor).toHaveCSS('font-size', '14px');
      await expect.poll(placeholderSize).toBe('14px');
      await editor.press('Tab');
      await editor.press('Tab');
      await expect.poll(() => requestCount(page)).toBe(1);
      await resolveRequest(page, 0, 'Next step');
      await expect(editor).toHaveAttribute('placeholder', 'Next step');
      await expect.poll(placeholderSize).toBe('14px');
      await editor.press('Tab');
      await expect(editor).toHaveValue('Next step');
      await expect(editor).toHaveCSS('font-size', '14px');
      await expect(editor).toHaveAttribute('placeholder', 'Fixture message placeholder');
      await expect.poll(placeholderSize).toBe('14px');
    });

    test('Escape cancels a pending request without reaching Composer stop handling', async ({
      page
    }) => {
      const editor = page.locator('textarea.composer-input');
      await setDraft(editor, 'Pending draft', 7);
      await editor.press('Tab');
      await editor.press('Tab');
      await expect.poll(() => requestCount(page)).toBe(1);

      await editor.press('Escape');
      await expect.poll(() => requestAborted(page, 0)).toBe(true);
      await expect.poll(() => interruptCount(page)).toBe(0);
      await expect.poll(() => parentKeydownCount(page)).toBe(0);
    });

    test('text input cancels pending work and ignores its late response', async ({ page }) => {
      const editor = page.locator('textarea.composer-input');
      await startPendingRequest(editor, page, 'Draft before input', 18);
      await editor.pressSequentially(' edited');
      await expect.poll(() => requestAborted(page, 0)).toBe(true);
      await resolveRequest(page, 0, 'stale');
      await expect(page.locator('.completion-mirror')).toHaveCount(0);
      await expect(editor).toHaveValue('Draft before input edited');
    });

    test('selection changes preserve a pending whole-prompt prediction', async ({ page }) => {
      const editor = page.locator('textarea.composer-input');
      await startPendingRequest(editor, page, 'Move the caret', 5);
      await editor.evaluate((element) => {
        const textarea = element as HTMLTextAreaElement;
        textarea.setSelectionRange(2, 2);
        document.dispatchEvent(new Event('selectionchange'));
      });
      await expect.poll(() => requestAborted(page, 0)).toBe(false);
      await resolveRequest(page, 0, 'stale');
      await expect(page.locator('.completion-mirror')).toHaveText('stale');
    });

    test('IME composition cancels pending work and composing Tab does not request', async ({
      page
    }) => {
      const editor = page.locator('textarea.composer-input');
      await startPendingRequest(editor, page, 'Composition draft', 5);
      await editor.evaluate((element) =>
        element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      );
      await expect.poll(() => requestAborted(page, 0)).toBe(true);
      await resolveRequest(page, 0, 'stale');
      await expect(page.locator('.completion-mirror')).toHaveCount(0);

      await editor.evaluate((element) => {
        element.focus();
        element.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Tab',
            bubbles: true,
            cancelable: true,
            isComposing: true
          })
        );
      });
      await expect.poll(() => requestCount(page)).toBe(1);
    });

    test('composition blocks button requests until composition ends', async ({ page }) => {
      const editor = page.locator('textarea.composer-input');
      await setDraft(editor, 'Draft in composition', 5);
      await editor.dispatchEvent('compositionstart');
      await page
        .locator('button[data-completion-action]')
        .evaluate((button) => (button as HTMLButtonElement).click());
      await expect.poll(() => requestCount(page)).toBe(0);
      await editor.dispatchEvent('compositionend');
      await page.locator('button[data-completion-action]').click();
      await expect.poll(() => requestCount(page)).toBe(1);
    });

    test('Tab keeps focus when disabled and selections allow whole-prompt generation', async ({
      page
    }) => {
      await page.goto(new URL('/?enabled=0', page.url()).href);
      const editor = page.locator('textarea.composer-input');
      await editor.focus();
      await editor.press('Tab');
      await expect(editor).toBeFocused();
      expect(await requestCount(page)).toBe(0);
      await page.goto(new URL('/', page.url()).href);
      await editor.fill('selected draft');
      await editor.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(0, 5));
      await editor.press('Tab');
      await editor.press('Tab');
      await expect(editor).toBeFocused();
      expect(await requestCount(page)).toBe(1);
      await editor.press('Shift+Tab');
      await expect(page.getByTestId('before-composer')).toBeFocused();
    });

    test('a single Tab keeps focus without requesting', async ({ page }) => {
      const editor = page.locator('textarea.composer-input');
      await editor.focus();
      await editor.press('Tab');
      await expect(editor).toBeFocused();
      await expect(page.locator('.completion-status')).toHaveText('Composer Prediction');
      await expect.poll(() => requestCount(page)).toBe(0);
    });

    test('completion action retains ready state while focused and accepts from its own button', async ({
      page
    }) => {
      const editor = page.locator('textarea.composer-input');
      await startPendingRequest(editor, page, 'Button focus', 7);
      await resolveRequest(page, 0, 'works ');
      const action = page.locator('button[data-completion-action]');
      await expect(action).toBeVisible();
      await action.focus();
      await expect(page.locator('.completion-mirror')).toBeVisible();
      await action.click();
      await expect(editor).toHaveValue('works ');
      await expect(editor).toBeFocused();
      await expect.poll(() => submissionCount(page)).toBe(0);
    });

    test('single Tab cancels pending work and a late response cannot become an insertion', async ({
      page
    }) => {
      const editor = page.locator('textarea.composer-input');
      await startPendingRequest(editor, page, 'Pending cancellation', 8);
      await editor.press('Tab');
      await expect.poll(() => requestAborted(page, 0)).toBe(true);
      await resolveRequest(page, 0, 'late');
      await expect(page.locator('.completion-mirror')).toHaveCount(0);
      await expect(editor).toHaveValue('Pending cancellation');
    });

    for (const key of [' ', 'Enter'] as const) {
      test(`keyboard ${key === ' ' ? 'Space' : 'Enter'} activation keeps the pending action snapshot`, async ({
        page
      }) => {
        const editor = page.locator('textarea.composer-input');
        await startPendingRequest(editor, page, 'Keyboard action', 8);
        const action = page.locator('button[data-completion-action]');
        await action.focus();

        // Separate the button keydown from native activation so the response settles in between.
        await action.evaluate(
          (button, pressedKey) =>
            button.dispatchEvent(
              new KeyboardEvent('keydown', {
                key: pressedKey,
                bubbles: true,
                cancelable: true
              })
            ),
          key
        );
        await resolveRequest(page, 0, 'must not insert');
        await expect(page.locator('.completion-mirror')).toBeVisible();
        await action.evaluate((button) => (button as HTMLButtonElement).click());

        await expect(editor).toHaveValue('Keyboard action');
        await expect(page.locator('.completion-mirror')).toHaveCount(0);
        await expect.poll(() => submissionCount(page)).toBe(0);
      });
    }
  });
}

async function openComposer(page: Page) {
  await page.goto(fixture.url);
  await expect(page.locator('textarea.composer-input')).toBeVisible();
}

async function setDraft(editor: Locator, text: string, cursor: number) {
  await editor.fill(text);
  await editor.evaluate((element, position) => {
    const textarea = element as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(position, position);
  }, cursor);
}

async function startPendingRequest(
  editor: Locator,
  page: Page,
  text: string,
  cursor: number,
  expectedRequestCount = 1
) {
  await setDraft(editor, text, cursor);
  await editor.press('Tab');
  await editor.press('Tab');
  await expect.poll(() => requestCount(page)).toBe(expectedRequestCount);
}

async function requestCount(page: Page) {
  return page.evaluate(
    () =>
      (window as Window & { __promptCompletionHarness: PromptCompletionHarness })
        .__promptCompletionHarness.requests.length
  );
}

async function requestDraft(page: Page, index: number) {
  return page.evaluate(
    (requestIndex) =>
      (window as Window & { __promptCompletionHarness: PromptCompletionHarness })
        .__promptCompletionHarness.requests[requestIndex]?.draft,
    index
  );
}

async function requestAborted(page: Page, index: number) {
  return page.evaluate(
    (requestIndex) =>
      (window as Window & { __promptCompletionHarness: PromptCompletionHarness })
        .__promptCompletionHarness.requests[requestIndex]?.aborted,
    index
  );
}

async function submissionCount(page: Page) {
  return page.evaluate(
    () =>
      (window as Window & { __promptCompletionHarness: PromptCompletionHarness })
        .__promptCompletionHarness.submissions
  );
}

async function interruptCount(page: Page) {
  return page.evaluate(
    () =>
      (window as Window & { __promptCompletionHarness: PromptCompletionHarness })
        .__promptCompletionHarness.interrupts
  );
}

async function parentKeydownCount(page: Page) {
  return page.evaluate(
    () =>
      (window as Window & { __promptCompletionHarness: PromptCompletionHarness })
        .__promptCompletionHarness.parentKeydowns
  );
}

async function resolveRequest(page: Page, index: number, suggestion: string) {
  await page.evaluate(
    ({ requestIndex, text }) =>
      (
        window as Window & { __promptCompletionHarness: PromptCompletionHarness }
      ).__promptCompletionHarness.resolve(requestIndex, text),
    { requestIndex: index, text: suggestion }
  );
}
