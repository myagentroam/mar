import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

test('Panel resize takes over an unfinished width transition without jumping', async ({ page }) => {
  await page.goto(`${fixture.url}panel-resize.html`);
  const intermediateWidth = await page
    .getByRole('button', { name: 'Expand' })
    .evaluate(async (button: HTMLElement) => {
      const panel = document.querySelector('#panel')!;
      // Establish the initial layout and pause in the same task as the state change.
      panel.getBoundingClientRect();
      button.click();
      await Promise.resolve();
      const transition = panel
        .getAnimations()
        .find((animation) => animation instanceof CSSTransition);
      if (!transition) throw new Error('Expected an active width transition');
      transition.pause();
      transition.currentTime = 30;
      return panel.getBoundingClientRect().width;
    });
  expect(intermediateWidth).toBeGreaterThan(100);
  expect(intermediateWidth).toBeLessThan(300);

  const handle = page.getByRole('separator', { name: 'Resize panel' });
  await handle.hover();
  await expect(page.getByRole('tooltip')).toHaveText('Resize panel');
  const bounds = (await handle.boundingBox())!;
  expect(bounds.x).toBe(450);
  await page.mouse.move(bounds.x + 3, bounds.y + 30);
  await page.mouse.down();
  expect(
    await page.locator('#panel').evaluate((panel) => panel.getBoundingClientRect().width)
  ).toBe(300);
  await page.mouse.move(bounds.x + 23, bounds.y + 30);
  await expect(page.locator('#panel')).toHaveAttribute('data-width', '320');
  await page.mouse.move(bounds.x + 203, bounds.y + 30);
  await expect(page.locator('#panel')).toHaveAttribute('data-width', '420');
  await page.mouse.move(bounds.x - 197, bounds.y + 30);
  await expect(page.locator('#panel')).toHaveAttribute('data-width', '180');
  await page.mouse.up();
  await page.mouse.move(bounds.x + 53, bounds.y + 30);
  await expect(page.locator('#panel')).toHaveAttribute('data-width', '180');
});

test('Panel resize supports bounded keyboard adjustment and cancels a drag on mode change', async ({
  page
}) => {
  await page.goto(`${fixture.url}panel-resize.html`);
  const handle = page.getByRole('separator', { name: 'Resize panel' });
  const panel = page.locator('#panel');
  await handle.focus();
  await page.keyboard.press('Home');
  await expect(panel).toHaveAttribute('data-width', '180');
  await page.keyboard.press('End');
  await expect(panel).toHaveAttribute('data-width', '420');
  const bounds = (await handle.boundingBox())!;
  await page.mouse.move(bounds.x + 3, bounds.y + 30);
  await page.mouse.down();
  await page
    .getByRole('button', { name: 'Switch mode' })
    .evaluate((button: HTMLElement) => button.click());
  await page.mouse.move(bounds.x - 100, bounds.y + 30);
  await page.mouse.up();
  await expect(panel).toHaveAttribute('data-width', '420');
});

test('Panel resize reflects externally changed effective widths without another gesture', async ({
  page
}) => {
  await page.goto(`${fixture.url}panel-resize.html`);
  const panel = page.locator('#panel');
  const handle = page.getByRole('separator', { name: 'Resize panel' });
  await panel.evaluate((element: HTMLElement) => {
    element.style.transition = 'none';
  });
  for (const [label, width] of [
    ['Content width', 400],
    ['Compact width', 240],
    ['Constrain width', 190]
  ] as const) {
    await page.getByRole('button', { name: label }).click();
    await expect(handle).toHaveAttribute('aria-valuenow', String(width));
    expect((await panel.boundingBox())?.width).toBe(width);
  }
});
