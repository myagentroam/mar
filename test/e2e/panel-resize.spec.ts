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
