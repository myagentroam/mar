import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let server: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  server = await startCustomThemeFixture('test/e2e/support/remote-desktop-novnc.html');
});
test.afterAll(async () => {
  await server?.close();
});

test.beforeEach(async ({ page }) => {
  await page.goto(`${server.url}remote-desktop-novnc.html`);
  await page.evaluate(() => (window as any).fixture.connect());
  await expect.poll(() => page.evaluate(() => (window as any).fixture.events.connected)).toBe(1);
});

test('noVNC waits for real pixels and does not request the remote clipboard', async ({ page }) => {
  const encodings = await page.evaluate(() => (window as any).fixture.offeredEncodings());
  expect(encodings).toContain(0);
  expect(
    encodings.every((encoding: number) =>
      [0, 7, 21, -223, -224, -239, -254, -29, -26, -23, -1063131698].includes(encoding)
    )
  ).toBe(true);
  expect(await page.evaluate(() => (window as any).fixture.endContinuousUpdates())).toEqual([]);
  await page.evaluate(() => (window as any).fixture.pseudo());
  expect(await page.evaluate(() => (window as any).fixture.events.firstframe)).toBe(0);
  expect(await page.evaluate(() => (window as any).fixture.clipboardNotify())).toEqual([]);
  expect(await page.evaluate(() => (window as any).fixture.events.clipboard)).toBe(0);
  expect(
    await page.evaluate(() => [
      (window as any).fixture.events.clipboardRead,
      (window as any).fixture.events.clipboardWrite
    ])
  ).toEqual([0, 0]);
  const pasted = await page.evaluate(() => (window as any).fixture.pasteOnce());
  expect(pasted[0]).toBe(true);
  expect(pasted[1]).toBeGreaterThan(0);
  expect(pasted[2]).toBe(0);
  await page.evaluate(() => (window as any).fixture.clipboardProvide());
  await page.evaluate(() => (window as any).fixture.raw());
  await expect.poll(() => page.evaluate(() => (window as any).fixture.events.firstframe)).toBe(1);
});

test('noVNC sends native quality levels when quality changes', async ({ page }) => {
  expect(await page.evaluate(() => (window as any).fixture.offeredEncodings())).toEqual(
    expect.arrayContaining([7, -26, -254])
  );
  for (const [quality, pseudo] of [
    [3, -29],
    [6, -26],
    [9, -23]
  ]) {
    const encodings = await page.evaluate(
      (level) => (window as any).fixture.setQuality(level),
      quality
    );
    expect(encodings).toEqual(expect.arrayContaining([7, pseudo, -254]));
    expect(encodings.filter((encoding: number) => encoding >= -32 && encoding <= -23)).toEqual([
      pseudo
    ]);
  }
});

test('noVNC waits for asynchronous image painting', async ({ page }) => {
  await page.evaluate(() => (window as any).fixture.delayedImage());
  expect(await page.evaluate(() => (window as any).fixture.events.firstframe)).toBe(0);
  await page.evaluate(() => (window as any).fixture.releaseImage());
  await expect.poll(() => page.evaluate(() => (window as any).fixture.events.firstframe)).toBe(1);
});

test('noVNC sends bounded explicit soft-keyboard text through ordinary RFB key events', async ({
  page
}) => {
  const result = await page.evaluate(() => (window as any).fixture.sendText('Aé中'));
  expect(result.accepted).toBe(true);
  expect(result.messages).toEqual([
    [4, 1, 0, 0, 0, 0, 0, 65],
    [4, 0, 0, 0, 0, 0, 0, 65],
    [4, 1, 0, 0, 0, 0, 0, 233],
    [4, 0, 0, 0, 0, 0, 0, 233],
    [4, 1, 0, 0, 1, 0, 78, 45],
    [4, 0, 0, 0, 1, 0, 78, 45]
  ]);
  const boundary = await page.evaluate(() => (window as any).fixture.sendText('x'.repeat(256)));
  expect(boundary.accepted).toBe(true);
  expect(boundary.messages).toHaveLength(512);
  for (const value of ['a\nb', 'x'.repeat(257), '\ud800'])
    expect(await page.evaluate((text) => (window as any).fixture.sendText(text), value)).toEqual({
      accepted: false,
      messages: []
    });
  expect(await page.evaluate(() => (window as any).fixture.sendText('A', true))).toEqual({
    accepted: false,
    messages: []
  });
});

test('noVNC receive queue overflow closes the attachment with a stable error', async ({ page }) => {
  const failure = await page.evaluate(() => (window as any).fixture.overflowNoVncReceiveQueue());
  expect(failure).toBe('DESKTOP_BACKPRESSURE');
});

test('noVNC ignores an image paint completing after replacement', async ({ page }) => {
  await page.evaluate(() => (window as any).fixture.delayedImage());
  await page.evaluate(() => (window as any).fixture.replace());
  await page.evaluate(() => (window as any).fixture.releaseImage());
  await expect.poll(() => page.evaluate(() => (window as any).fixture.events.imageLoaded)).toBe(1);
  expect(await page.evaluate(() => (window as any).fixture.events.firstframe)).toBe(0);
  expect(await page.evaluate(() => (window as any).fixture.events.replacementFirstframe)).toBe(0);
  await page.evaluate(() => (window as any).fixture.replacementRaw());
  await expect
    .poll(() => page.evaluate(() => (window as any).fixture.events.replacementFirstframe))
    .toBe(1);
});
