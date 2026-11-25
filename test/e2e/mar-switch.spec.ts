import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

const entry = 'test/e2e/support/mar-switch.html';
let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture(entry);
});
test.afterAll(async () => {
  await fixture?.close();
});

test('MAR switch uses native labels, keyboard and draft form values', async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${fixture.url}mar-switch.html`);
  const draft = page.getByRole('switch', { name: 'Draft setting' });
  const disabled = page.getByRole('switch', { name: 'Unavailable setting' });
  const changes = page.getByRole('status', { name: 'Draft changes' });
  const track = page.locator('#draft + .mar-ui-switch__track');
  await expect(track).toHaveCSS('width', '36px');
  await expect(track).toHaveCSS('height', '18px');
  await expect(track.locator('.mar-ui-switch__thumb')).toHaveCSS('height', '12px');
  await expect(draft).toHaveCSS('height', '26px');

  await page.keyboard.press('Tab');
  await expect(draft).toBeFocused();
  await expect(draft).not.toBeChecked();
  await page.keyboard.press('Space');
  await expect(draft).toBeChecked();
  await expect(changes).toHaveText('true');
  expect(
    await page.locator('form').evaluate((form: HTMLFormElement) => new FormData(form).get('draft'))
  ).toBe('on');
  await expect(track).toHaveCSS('outline-style', 'solid');
  await expect(disabled).toBeDisabled();
  await expect(disabled).toBeChecked();
  await page.locator('main').screenshot({ path: testInfo.outputPath('switch-dark-keyboard.png') });

  await page.getByText('Draft setting', { exact: true }).click();
  await expect(draft).not.toBeChecked();
  await expect(changes).toHaveText('true,false');
  expect(
    await page.locator('form').evaluate((form: HTMLFormElement) => new FormData(form).has('draft'))
  ).toBe(false);
});

test('MAR switch preserves confirmed state during controlled writes', async ({ page }) => {
  await page.goto(`${fixture.url}mar-switch.html`);
  const remote = page.getByRole('switch', { name: 'Controlled setting' });
  const track = page.locator('#remote + .mar-ui-switch__track');
  await remote.click();
  await expect(remote).toBeDisabled();
  await expect(remote).toHaveAttribute('aria-busy', 'true');
  await expect(remote).not.toBeChecked();
  const spinner = track.locator('[data-mar-icon="loading-action"]');
  await expect(spinner).toBeVisible();
  await expect(spinner).toHaveCSS('height', '12px');
  await page.getByRole('button', { name: 'Reject write' }).click();
  await expect(remote).toBeEnabled();
  await expect(remote).not.toBeChecked();
  await remote.press('Space');
  await page.getByRole('button', { name: 'Accept write' }).click();
  await expect(remote).toBeEnabled();
  await expect(remote).toBeChecked();
  await expect(track.locator('[data-mar-icon="loading-action"]')).toHaveCount(0);
});

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`MAR switch updates its thumb and track with ${reducedMotion} motion`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await page.goto(`${fixture.url}mar-switch.html`);
    const draft = page.getByRole('switch', { name: 'Draft setting' });
    const frames = await draft.evaluate(async (input: HTMLInputElement) => {
      const track = input.nextElementSibling!;
      const thumb = track.firstElementChild!;
      const read = () => ({
        x: thumb.getBoundingClientRect().x,
        fill: getComputedStyle(track).backgroundColor
      });
      async function toggle() {
        const before = read();
        input.click();
        await new Promise(requestAnimationFrame);
        read();
        const animations = [...track.getAnimations(), ...thumb.getAnimations()];
        for (const animation of animations) {
          animation.pause();
          animation.currentTime = Number(animation.effect!.getTiming().duration) / 2;
        }
        const middle = read();
        for (const animation of animations) animation.finish();
        return { before, middle, end: read(), animated: animations.length > 0 };
      }
      return [await toggle(), await toggle()] as const;
    });
    const [opening, closing] = frames;
    expect(opening.end.x).toBeGreaterThan(opening.before.x);
    expect(closing.end.x).toBeCloseTo(opening.before.x);
    for (const { before, middle, end, animated } of frames) {
      expect(end.fill).not.toBe(before.fill);
      expect(animated).toBe(reducedMotion === 'no-preference');
      if (reducedMotion === 'reduce') {
        expect(middle).toEqual(end);
      } else {
        expect(middle.x).toBeGreaterThan(Math.min(before.x, end.x));
        expect(middle.x).toBeLessThan(Math.max(before.x, end.x));
        expect(middle.fill).not.toBe(before.fill);
        expect(middle.fill).not.toBe(end.fill);
      }
    }
    await expect(draft).not.toBeChecked();
  });
}

test('MAR switch uses a white thumb on the dark Primary track', async ({ page }, testInfo) => {
  await page.goto(`${fixture.url}mar-switch.html`);
  const draft = page.getByRole('switch', { name: 'Draft setting' });
  await draft.press('Space');
  await expect(draft).toBeChecked();
  const track = page.locator('#draft + .mar-ui-switch__track');
  await expect(track).toHaveCSS('background-color', 'rgb(23, 137, 252)');
  await expect(track.locator('.mar-ui-switch__thumb')).toHaveCSS(
    'background-color',
    'rgb(255, 255, 255)'
  );
  await page.locator('main').screenshot({ path: testInfo.outputPath('switch-dark-checked.png') });
});

test.describe('390px touch viewport', () => {
  test.use({
    hasTouch: true,
    viewport: { width: 390, height: 740 }
  });

  test('MAR switch preserves a visible tap-sized track and light theme while busy', async ({
    page
  }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${fixture.url}mar-switch.html?theme=light`);
    const draft = page.getByRole('switch', { name: 'Draft setting' });
    await draft.tap();
    await expect(draft).toBeChecked();
    await expect(draft).toHaveCSS('height', '26px');
    const track = page.locator('#draft + .mar-ui-switch__track');
    await expect(track).toHaveCSS('height', '24px');
    await expect(track).toHaveCSS('width', '40px');
    await expect(track).toHaveCSS('background-color', 'rgb(0, 87, 219)');
    await expect(track.locator('.mar-ui-switch__thumb')).toHaveCSS('height', '16px');
    await expect(track.locator('.mar-ui-switch__thumb')).toHaveCSS(
      'background-color',
      'rgb(255, 255, 255)'
    );
    await page.getByRole('switch', { name: 'Controlled setting' }).tap();
    const spinner = page.locator(
      '#remote + .mar-ui-switch__track [data-mar-icon="loading-action"]'
    );
    await expect(spinner).toHaveCSS('height', '16px');
    await expect(spinner).toHaveCSS('animation-name', 'none');
    await page
      .locator('main')
      .screenshot({ path: testInfo.outputPath('switch-light-mobile-loading.png') });
  });
});
