import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

const entry = 'test/e2e/support/mar-dialog.html';
let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture(entry);
});
test.afterAll(async () => {
  await fixture?.close();
});
test.beforeEach(async ({ page }) => {
  await page.goto(`${fixture.url}mar-dialog.html`);
});

test('Dialog help closes before its modal and feedback stays with its owner', async ({ page }) => {
  await page.getByRole('button', { name: 'Open editor' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit record' });
  const help = editor.getByRole('button', { name: 'Field help' });
  await help.hover();
  await help.focus();
  const hint = editor.getByRole('tooltip');
  await expect(hint).toHaveText('Help for this field');
  await expect(help).toHaveAccessibleDescription('Help for this field');
  await page.keyboard.press('Escape');
  await expect(hint).toBeHidden();
  await expect(help).toBeFocused();
  await expect(editor).toBeVisible();
  await editor.getByRole('button', { name: 'Save draft' }).click();
  const feedback = editor.getByRole('status');
  await expect(feedback).toHaveText('<b>Draft saved</b>');
  await expect(feedback.locator('b')).toHaveCount(0);
  await editor.getByRole('button', { name: 'Owner close' }).click();
  await expect(page.getByText('<b>Draft saved</b>', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Background command' }).click();
  await expect(page.getByText('Background saved', { exact: true })).toBeVisible();
});

for (const dismissal of ['manual', 'automatic'] as const) {
  test(`Message feedback slides and fades on entry and ${dismissal} dismissal`, async ({
    page
  }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const transitions = await page.evaluateHandle(() => {
      const samples: Array<{ property: string; from: number; to: number }> = [];
      document.addEventListener('transitionstart', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement) || !target.matches('.mar-message')) return;
        const transition = target
          .getAnimations()
          .find(
            (animation) =>
              animation instanceof CSSTransition &&
              animation.transitionProperty === event.propertyName
          );
        if (!(transition?.effect instanceof KeyframeEffect)) return;
        const [first, last] = transition.effect.getKeyframes();
        if (event.propertyName === 'opacity') {
          samples.push({
            property: 'opacity',
            from: Number(first?.opacity),
            to: Number(last?.opacity)
          });
        } else if (event.propertyName === 'transform') {
          const y = (value: unknown) => {
            if (value === 'none') return 0;
            // Transition keyframes may keep percentage translations instead of resolving pixels.
            const transform = String(value).replace(
              /(-?[\d.]+)%/g,
              (_, percent) => `${(Number(percent) / 100) * target.offsetHeight}px`
            );
            return new DOMMatrixReadOnly(transform).m42;
          };
          samples.push({
            property: 'transform',
            from: y(first?.transform),
            to: y(last?.transform)
          });
        }
      });
      return samples;
    });
    await page.getByRole('button', { name: 'Background command' }).press('Enter');
    const message = page.locator('.mar-message').filter({ hasText: 'Background saved' });
    await expect.poll(() => transitions.evaluate((samples) => samples.length)).toBe(2);
    await expect(message).toHaveCSS('opacity', '1');

    if (dismissal === 'manual') await message.getByRole('button', { name: 'Close' }).press('Enter');
    await expect(message).toHaveCount(0);
    const samples = await transitions.jsonValue();
    expect(
      samples.filter(({ property }) => property === 'opacity').map(({ from, to }) => [from, to])
    ).toEqual([
      [0, 1],
      [1, 0]
    ]);
    const [enter, leave] = samples.filter(({ property }) => property === 'transform');
    expect(enter?.from).toBeLessThan(0);
    expect(enter?.to).toBe(0);
    expect(leave?.from).toBe(0);
    expect(leave?.to).toBeLessThan(0);
  });
}

test('Message feedback skips motion when reduced motion is requested', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const events = await page.evaluateHandle(() => {
    const started: string[] = [];
    for (const type of ['transitionstart', 'animationstart']) {
      document.addEventListener(type, ({ target }) => {
        if (target instanceof HTMLElement && target.matches('.mar-message')) started.push(type);
      });
    }
    return started;
  });
  await page.getByRole('button', { name: 'Background command' }).press('Enter');
  const message = page.locator('.mar-message').filter({ hasText: 'Background saved' });
  await expect(message).toBeInViewport();
  await expect(message).toHaveCSS('opacity', '1');
  await message.getByRole('button', { name: 'Close' }).press('Enter');
  await expect(message).toHaveCount(0);
  expect(await events.jsonValue()).toEqual([]);
});

test('Local loading marks only its owner busy and retains its content', async ({ page }) => {
  const region = page.getByRole('region', { name: 'Record results' });
  const trigger = page.getByRole('checkbox', { name: 'Load region' });
  await trigger.check();
  await expect(region).toHaveAttribute('aria-busy', 'true');
  await expect(region).toContainText('Retained record');
  await expect(region.locator('.mar-ui-loading')).toHaveAttribute('data-variant', 'region');
  await expect(page.getByRole('button', { name: 'Open editor' })).toBeEnabled();
  await trigger.uncheck();
  await expect(region.locator('.mar-ui-loading')).toHaveCount(0);
  await expect(region).not.toHaveAttribute('aria-busy');
});

test('MessageBox alert keeps its explicit acknowledgement on Escape and backdrop', async ({
  page
}) => {
  const trigger = page.getByRole('button', { name: 'Open alert' });
  await trigger.click();
  const alert = page.getByRole('dialog', { name: 'Result' });
  await expect(alert).toBeVisible();
  await page.keyboard.press('Escape');
  await page.mouse.click(4, 4);
  await expect(alert).toBeVisible();
  await alert.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(alert).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('Dialog isolates background focus, returns it to the opener and destroys its draft', async ({
  page
}) => {
  const opener = page.getByRole('button', { name: 'Open editor' });
  await opener.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Edit record' });
  const input = dialog.getByRole('textbox', { name: 'Draft' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(':focus')).toHaveCount(1);
  await input.fill('First draft');
  await page.evaluate(() => {
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent === 'Background command')
      ?.focus();
  });
  await expect(input).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(page.getByText('Closed 1', { exact: true })).toBeVisible();
  await opener.click();
  await expect(input).toHaveValue('');
  await dialog.getByRole('button', { name: 'Owner close' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('Dialog only closes the active layer and permits retry after a rejected close guard', async ({
  page
}) => {
  await page.getByRole('checkbox', { name: 'Guard close' }).check();
  await page.getByRole('button', { name: 'Open editor' }).click();
  const parent = page.getByRole('dialog', { name: 'Edit record' });
  await parent.getByRole('textbox', { name: 'Draft' }).fill('Keep this');
  await page.keyboard.press('Escape');
  const child = page.getByRole('dialog', { name: 'Discard changes?' });
  await expect(child).toBeVisible();
  await child.getByRole('button', { name: 'Keep draft' }).click();
  await expect(child).toHaveCount(0);
  await expect(parent.getByRole('textbox', { name: 'Draft' })).toHaveValue('Keep this');
  await page.keyboard.press('Escape');
  await child.getByRole('button', { name: 'Discard draft' }).click();
  await expect(parent).toHaveCount(0);
  await expect(page.getByText('Closed 1', { exact: true })).toBeVisible();
});

test('Dialog honors explicit autofocus on its form field', async ({ page }) => {
  await page.getByRole('checkbox', { name: 'Autofocus draft' }).check();
  await page.getByRole('button', { name: 'Open editor' }).press('Enter');
  await expect(page.getByRole('textbox', { name: 'Draft' })).toBeFocused();
});

test('Dialog and scrim fade together before the modal releases the page', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const closingFrame = await page.addStyleTag({
    content: `
      .mar-ui-dialog-overlay[data-closing],
      .mar-ui-dialog-overlay[data-closing]::backdrop {
        animation-delay: -65ms !important;
        animation-play-state: paused !important;
      }
    `
  });
  const opener = page.getByRole('button', { name: 'Open editor' });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Edit record' });
  await dialog.getByRole('button', { name: 'Close this dialog' }).click();

  await expect(dialog).toHaveAttribute('data-closing', 'true');
  const { panel, scrim, modal } = await dialog.evaluate((element) => ({
    panel: Number(getComputedStyle(element).opacity),
    scrim: Number(getComputedStyle(element, '::backdrop').opacity),
    modal: element.matches(':modal')
  }));
  expect(panel).toBeGreaterThan(0);
  expect(panel).toBeLessThan(1);
  expect(scrim).toBeCloseTo(panel, 3);
  expect(modal).toBe(true);
  await expect(page.getByText('Closed 0', { exact: true })).toBeVisible();

  await closingFrame.evaluate((style) => style.remove());
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(page.getByText('Closed 1', { exact: true })).toBeVisible();
});

for (const width of [390, 1280]) {
  test(`Dialog header close uses a square icon action at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 });
    const opener = page.getByRole('button', { name: 'Open editor' });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Edit record' });
    const close = dialog.getByRole('button', { name: 'Close this dialog' });
    await expect(close).toHaveCSS('width', '32px');
    await expect(close).toHaveCSS('height', '32px');
    await expect(close).toHaveCSS('padding', '0px');
    await close.click();
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });
}

test('Dialog returns focus to the active parent when the nested opener is removed', async ({
  page
}) => {
  await page.getByRole('checkbox', { name: 'Guard close' }).check();
  await page.getByRole('button', { name: 'Open editor' }).press('Enter');
  await page.keyboard.press('Escape');
  const parent = page.getByRole('dialog', { name: 'Discard changes?' });
  await parent.getByRole('button', { name: 'Open more options' }).press('Enter');
  const child = page.getByRole('dialog', { name: 'More options' });
  await child.getByRole('button', { name: 'Remove opener and close' }).press('Enter');
  await expect(child).toHaveCount(0);
  await expect(parent.locator('[data-mar-dialog-panel]')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(parent.getByRole('button', { name: 'Close this dialog' })).toBeFocused();
});

test('Dialog respects disabled Escape and backdrop and keeps actions visible on a short viewport', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 370 });
  await page.getByRole('checkbox', { name: 'Disable Escape' }).check();
  await page.getByRole('checkbox', { name: 'Disable backdrop' }).check();
  await page.getByRole('button', { name: 'Open editor' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit record' });
  await expect(dialog.getByRole('button', { name: 'Owner close' })).toBeInViewport();
  await expect(dialog.getByText('Content line 40')).not.toBeInViewport();
  await page.mouse.click(4, 4);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  const draft = dialog.getByRole('textbox', { name: 'Draft' });
  await draft.fill('Keep this draft');
  await dialog.evaluate((element: HTMLDialogElement) => {
    if (element.dispatchEvent(new Event('cancel', { cancelable: false }))) element.close();
  });
  await expect(dialog).toBeVisible();
  await expect(draft).toBeFocused();
  await expect(draft).toHaveValue('Keep this draft');
  await dialog.getByRole('button', { name: 'Close this dialog', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test('Dialog backdrop dismisses only when both ends of the pointer gesture are outside', async ({
  page
}) => {
  await page.getByRole('button', { name: 'Open editor' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit record' });
  const panel = dialog.locator('[data-mar-dialog-panel]');
  const bounds = (await panel.boundingBox())!;
  const inside = { x: bounds.x + bounds.width / 2, y: bounds.y + 10 };
  const outside = { x: 6, y: 6 };

  for (const [start, end] of [
    [outside, inside],
    [inside, outside]
  ]) {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y);
    await page.mouse.up();
    await expect(dialog).toBeVisible();
    await expect(dialog).not.toHaveAttribute('data-closing', 'true');
  }

  await page.mouse.click(outside.x, outside.y);
  await expect(dialog).toHaveCount(0);
});

test('MessageBox keeps invalid input focused and resolves only the confirmed value', async ({
  page
}) => {
  const trigger = page.getByRole('button', { name: 'Open prompt' });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Rename record' });
  const input = dialog.getByRole('textbox', { name: 'Record name' });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('Initial');
  await input.fill('');
  await input.press('Enter');
  await expect(dialog.getByRole('alert')).toHaveText('A name is required');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(input).toHaveAccessibleDescription('A name is required');
  await expect(input).toBeFocused();
  await input.fill('New name');
  await input.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('Prompt result')).toHaveText('New name');
  await expect(trigger).toBeFocused();
});

test('Mobile Back rejects an input prompt inside a Dialog without committing its value or closing the parent', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await page.getByRole('button', { name: 'Open editor' }).click();
  const parent = page.getByRole('dialog', { name: 'Edit record' });
  const trigger = parent.getByRole('button', { name: 'Rename inside editor' });
  await trigger.click();
  const prompt = page.getByRole('dialog', { name: 'Rename record' });
  await prompt.getByRole('textbox').fill('Unconfirmed');
  await page.evaluate(() => history.back());
  await expect(prompt).toHaveCount(0);
  await expect(parent).toBeVisible();
  await expect(trigger).toBeFocused();
  await parent.getByRole('button', { name: 'Owner close' }).click();
  await expect(page.getByLabel('Prompt result')).toHaveText('cancel');
});
