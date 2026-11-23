import { expect, test, type Locator, type Page } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.use({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});
test.beforeEach(({ browserName }) => {
  test.skip(browserName !== 'chromium', 'Native touch input is exercised through Chromium CDP.');
});
test.beforeEach(({ page }) => {
  page.on('pageerror', (error) => {
    console.error('Composer fixture page error:', error.stack);
  });
});

async function touchButton(page: Page, button: Locator) {
  await expect(button).toBeVisible();
  const bounds = await button.boundingBox();
  if (!bounds) throw new Error('Send button is not visible');
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  const client = await page.context().newCDPSession(page);
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y, id: 1 }]
  });
  const moveTo = (nextY: number) =>
    client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: nextY, id: 1 }]
    });
  return {
    async move(distance: number) {
      await moveTo(y - distance);
    },
    async moveAboveComposer() {
      const top = await button.evaluate(
        (element: HTMLButtonElement) => element.form!.getBoundingClientRect().top
      );
      await moveTo(top - 8);
    },
    async end(cancel = false) {
      await client.send('Input.dispatchTouchEvent', {
        type: cancel ? 'touchCancel' : 'touchEnd',
        touchPoints: []
      });
      await client.detach();
    }
  };
}

async function openWorkspace(page: Page, query = '') {
  await page.goto(`${fixture.url}workbench-style.html?composer=1&send-gesture=1${query}`);
  return {
    button: page.locator('.composer-send-button'),
    draft: page.locator('textarea.composer-input'),
    submitted: page.getByRole('status', { name: 'Submitted intents' }),
    hint: page.locator('.composer-steer-hint')
  };
}

test('A native touch tap retains ordinary mobile sending and does not steer', async ({ page }) => {
  const ui = await openWorkspace(page);
  await ui.button.tap();
  await expect(ui.submitted).toHaveText('SEND');
  await expect(ui.draft).toHaveValue('');
});

test('Holding without sliding up keeps ordinary sending', async ({ page }) => {
  const ui = await openWorkspace(page);
  await ui.draft.tap();
  const touch = await touchButton(page, ui.button);
  await expect(ui.hint).toContainText('Slide up to steer');
  await expect(ui.submitted).toBeEmpty();
  await touch.end();
  await expect(ui.submitted).toHaveText('SEND');
  await expect(ui.draft).toBeFocused();
});

for (const idle of [false, true]) {
  test(`The ${idle ? 'idle' : 'running'} Composer can hold and swipe when touch reaches Send without pointerdown`, async ({
    page
  }) => {
    const ui = await openWorkspace(page, idle ? '&idle-composer=1' : '');
    await ui.draft.tap();
    // Keep native Touch Events while simulating a missing start to the Pointer Event stream.
    await page.evaluate(() => {
      window.addEventListener(
        'pointerdown',
        (event) => {
          if (
            event.pointerType === 'touch' &&
            (event.target as Element).closest('.composer-send-control')
          )
            event.stopImmediatePropagation();
        },
        { capture: true }
      );
    });
    const held = await touchButton(page, ui.button);
    await expect(ui.hint).toBeVisible();
    await expect(ui.hint).toContainText(idle ? 'Release to send' : 'Slide up to steer');
    await held.moveAboveComposer();
    await expect(ui.hint).toHaveText('Release to cancel');
    await held.end();
    await expect(ui.hint).toHaveCount(0);
    await expect(ui.submitted).toBeEmpty();
    await expect(ui.draft).toHaveValue('Follow up on mobile layout.');

    const next = await touchButton(page, ui.button);
    await expect(ui.hint).toBeVisible();
    await next.move(16);
    await expect(ui.hint).toContainText(idle ? 'Release to send' : 'Release to steer');
    await expect(ui.submitted).toBeEmpty();
    await next.end();
    await expect(ui.submitted).toHaveText(idle ? 'SEND' : 'REPLACE_CURRENT');
    await expect(ui.draft).toBeFocused();
  });
}

test('Sliding back to Send restores ordinary sending', async ({ page }) => {
  const ui = await openWorkspace(page);
  const touch = await touchButton(page, ui.button);
  await touch.move(16);
  await expect(ui.hint).toContainText('Release to steer');
  await touch.move(0);
  await expect(ui.hint.filter({ hasText: 'Release to steer' })).toHaveCount(0);
  await touch.end();
  await expect(ui.submitted).toHaveText('SEND');
});

test('An idle conversation sends after sliding up within the Composer', async ({ page }, info) => {
  const ui = await openWorkspace(page, '&idle-composer=1');
  await ui.draft.tap();
  await expect(ui.draft).toBeFocused();
  const touch = await touchButton(page, ui.button);
  await touch.move(16);
  await expect(ui.hint).toHaveText('Release to send · Above the Composer cancels');
  await expect(ui.submitted).toBeEmpty();
  await page.screenshot({ path: info.outputPath('mobile-idle-send.png') });
  await touch.end();
  await expect(ui.submitted).toHaveText('SEND');
  await expect(ui.draft).toBeFocused();
  await expect(ui.draft).toHaveValue('');
});

test('An idle new conversation can cancel a held send without losing focus or its draft', async ({
  page
}) => {
  const ui = await openWorkspace(page, '&idle-composer=1');
  await ui.draft.tap();
  const touch = await touchButton(page, ui.button);
  await expect(ui.hint).toHaveText('Release to send · Above the Composer cancels');
  await touch.moveAboveComposer();
  await expect(ui.hint).toHaveText('Release to cancel');
  await touch.end();
  await expect(ui.submitted).toBeEmpty();
  await expect(ui.draft).toHaveValue('Follow up on mobile layout.');
  await expect(ui.draft).toBeFocused();
});

test('Multiline drafts allow a swipe past 60px and cancel only above the Composer', async ({
  page
}) => {
  const ui = await openWorkspace(page);
  await ui.draft.fill(Array.from({ length: 10 }, (_, index) => `Draft line ${index}`).join('\n'));
  await expect(ui.draft).toHaveValue(/Draft line 9/u);
  const bounds = (await ui.button.boundingBox())!;
  const top = await ui.button.evaluate(
    (element: HTMLButtonElement) => element.form!.getBoundingClientRect().top
  );
  expect(bounds.y + bounds.height / 2 - top).toBeGreaterThan(70);
  const touch = await touchButton(page, ui.button);
  await touch.move(70);
  await expect(ui.hint).toContainText('Release to steer');
  await touch.moveAboveComposer();
  await expect(ui.hint).toHaveText('Release to cancel');
  await touch.move(70);
  await expect(ui.hint).toContainText('Release to steer');
  await touch.end();
  await expect(ui.submitted).toHaveText('REPLACE_CURRENT');
  await expect(ui.draft).toBeFocused();
});

for (const theme of ['daylight', 'vscode-dark-2026']) {
  test(`Sliding up inside the Composer steers once on release (${theme})`, async ({
    page
  }, info) => {
    await page.setViewportSize({ width: 320, height: 700 });
    const ui = await openWorkspace(page, `&theme=${theme}&locale=zh-CN`);
    const gestureDescription = '上滑插入消息，越过输入框顶部取消。';
    await expect(page.getByText(gestureDescription, { exact: true })).toHaveCount(0);
    await expect(ui.button).toHaveAccessibleDescription(gestureDescription);
    const sendBounds = await ui.button.boundingBox();
    const stopBounds = await page.locator('.composer-stop-button').boundingBox();
    expect(sendBounds!.x + sendBounds!.width).toBeLessThanOrEqual(320);
    expect(stopBounds!.x + stopBounds!.width).toBeLessThanOrEqual(sendBounds!.x);
    await ui.draft.focus();
    const touch = await touchButton(page, ui.button);
    await expect(ui.draft).toBeFocused();
    await expect(ui.hint).toContainText('上滑插入消息');
    await touch.move(16);
    await expect(ui.hint).toHaveText('松手插入消息 · 越过输入框顶部取消');
    await expect(ui.submitted).toBeEmpty();
    const bounds = await ui.hint.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    await page.screenshot({ path: info.outputPath(`mobile-steer-${theme}.png`) });
    await touch.end();
    await expect(ui.submitted).toHaveText('REPLACE_CURRENT');
    await expect(ui.draft).toBeFocused();
    await expect(ui.hint).toHaveCount(0);
    await expect(ui.draft).toHaveValue('');
  });
}

test('Moving away cancels without sending, and the next tap still sends normally', async ({
  page
}) => {
  const ui = await openWorkspace(page);
  await ui.draft.tap();
  const touch = await touchButton(page, ui.button);
  await touch.move(16);
  await expect(ui.hint).toContainText('Release to steer');
  await touch.moveAboveComposer();
  await expect(ui.hint).toHaveText('Release to cancel');
  await touch.end();
  await expect(ui.submitted).toBeEmpty();
  await expect(ui.draft).toBeFocused();
  await expect(ui.draft).toHaveValue('Follow up on mobile layout.');
  await ui.button.tap();
  await expect(ui.submitted).toHaveText('SEND');
});

test('A managed session without a current Run can still steer on touch', async ({ page }) => {
  const ui = await openWorkspace(page, '&managed-session-only=1');
  await expect(page.locator('.composer-stop-button')).toBeEnabled();
  const touch = await touchButton(page, ui.button);
  await touch.move(16);
  await expect(ui.hint).toContainText('Release to steer');
  await touch.end();
  await expect(ui.submitted).toHaveText('REPLACE_CURRENT');
  await expect(ui.draft).toHaveValue('');
});

test('Switching managed sessions without a Run cancels an in-flight touch', async ({ page }) => {
  const ui = await openWorkspace(page, '&managed-session-only=1');
  const touch = await touchButton(page, ui.button);
  await touch.move(16);
  await expect(ui.hint).toContainText('Release to steer');
  await page
    .getByRole('button', { name: 'Change session' })
    .evaluate((button: HTMLButtonElement) => button.click());
  await expect(ui.hint).toHaveCount(0);
  await touch.end();
  await expect(ui.submitted).toBeEmpty();
  await expect(ui.draft).toHaveValue('Follow up on mobile layout.');
});

test('Switching draft Workspaces cancels an in-flight touch without sending to the new target', async ({
  page
}) => {
  const ui = await openWorkspace(page, '&idle-composer=1');
  await ui.draft.tap();
  const touch = await touchButton(page, ui.button);
  await touch.move(16);
  await expect(ui.hint).toContainText('Release to send');
  await page
    .getByRole('button', { name: 'Change workspace' })
    .evaluate((button: HTMLButtonElement) => button.click());
  await touch.end();
  await expect(ui.submitted).toBeEmpty();
  await expect(ui.draft).toHaveValue('Follow up on mobile layout.');
  await expect(ui.draft).toBeFocused();
});

test('Returning from the cancellation range restores steering before release', async ({ page }) => {
  const ui = await openWorkspace(page);
  const touch = await touchButton(page, ui.button);
  await touch.move(16);
  await expect(ui.hint).toContainText('Release to steer');
  await touch.moveAboveComposer();
  await expect(ui.hint).toHaveText('Release to cancel');
  await touch.move(15);
  await expect(ui.hint).toContainText('Release to steer');
  await touch.end();
  await expect(ui.submitted).toHaveText('REPLACE_CURRENT');
});

test('A system touch cancellation preserves the draft and submits nothing', async ({ page }) => {
  const ui = await openWorkspace(page);
  const touch = await touchButton(page, ui.button);
  await touch.move(16);
  await expect(ui.hint).toContainText('Release to steer');
  await touch.end(true);
  await expect(ui.hint).toHaveCount(0);
  await expect(ui.submitted).toBeEmpty();
  await expect(ui.draft).toHaveValue('Follow up on mobile layout.');
});

for (const idle of [false, true]) {
  for (const queued of [false, true]) {
    test(`The ${idle ? 'idle' : 'running'} Composer ${queued ? 'with' : 'without'} queued messages accepts the next swipe after a missing release`, async ({
      page
    }) => {
      const ui = await openWorkspace(
        page,
        `${idle ? '&idle-composer=1' : ''}${queued ? '&queued-composer=1' : ''}`
      );
      await expect(page.getByText('Earlier queued message', { exact: true })).toHaveCount(
        queued ? 1 : 0
      );
      await ui.draft.tap();
      // Simulate an interruption where no terminal pointer event reaches the Composer.
      await page.evaluate(() => {
        for (const type of ['pointerup', 'lostpointercapture']) {
          window.addEventListener(type, (event) => event.stopImmediatePropagation(), {
            capture: true,
            once: true
          });
        }
      });
      const releaseHint = idle ? 'Release to send' : 'Release to steer';
      const interrupted = await touchButton(page, ui.button);
      await interrupted.move(16);
      await expect(ui.hint).toContainText(releaseHint);
      await interrupted.end();
      await expect(ui.submitted).toBeEmpty();

      const next = await touchButton(page, ui.button);
      await expect(ui.hint).toContainText(idle ? releaseHint : 'Slide up to steer');
      await next.move(16);
      await expect(ui.hint).toContainText(releaseHint);
      await next.moveAboveComposer();
      await expect(ui.hint).toContainText('Release to cancel');
      await next.move(16);
      await expect(ui.hint).toContainText(releaseHint);
      await expect(ui.submitted).toBeEmpty();
      await next.end();
      await expect(ui.submitted).toHaveText(idle ? 'SEND' : 'REPLACE_CURRENT');
      await expect(ui.draft).toBeFocused();
    });
  }
}

test('Changing the target Run cancels an in-flight touch rather than sending to its replacement', async ({
  page
}) => {
  const ui = await openWorkspace(page);
  const touch = await touchButton(page, ui.button);
  await touch.move(16);
  await expect(ui.hint).toContainText('Release to steer');
  await page
    .getByRole('button', { name: 'Change run' })
    .evaluate((button: HTMLButtonElement) => button.click());
  await expect(ui.hint).toHaveCount(0);
  await touch.end();
  await expect(ui.submitted).toBeEmpty();
});

test('Removing the held send button before release cannot click the adjacent Stop action', async ({
  page
}) => {
  const ui = await openWorkspace(page);
  const touch = await touchButton(page, ui.button);
  await touch.move(16);
  await expect(ui.hint).toContainText('Release to steer');
  await page
    .getByRole('button', { name: 'Clear draft' })
    .evaluate((button: HTMLButtonElement) => button.click());
  await expect(ui.button).toHaveCount(0);
  await touch.end();
  await expect(ui.submitted).toBeEmpty();
});

for (const idle of [false, true]) {
  for (const cancelled of [false, true]) {
    test(`Hosted mobile ${idle ? 'idle' : 'running'} conversations ${cancelled ? 'cancel' : 'submit'} a held message without queueing`, async ({
      page
    }) => {
      await page.goto(
        `${fixture.url}workbench-style.html?hosted-gesture=1${idle ? '&idle-composer=1' : ''}`
      );
      const draft = page.locator('textarea.composer-input');
      await draft.fill('Hosted follow-up');
      const button = page.getByRole('button', { name: idle ? 'Send' : 'Steer', exact: true });
      const gestureDescription = idle
        ? 'Slide up, then release to send. Move above the Composer to cancel.'
        : 'Slide up to steer. Move above the Composer to cancel.';
      await expect(page.getByText(gestureDescription, { exact: true })).toHaveCount(0);
      await expect(button).toHaveAccessibleDescription(gestureDescription);
      const touch = await touchButton(page, button);
      await expect(draft).toBeFocused();
      const hint = page.locator('.composer-steer-hint');
      await touch.move(16);
      await expect(hint).toContainText(idle ? 'Release to send' : 'Release to steer');
      if (cancelled) {
        await touch.moveAboveComposer();
        await expect(hint).toHaveText('Release to cancel');
      }
      await touch.end();
      await expect(page.getByRole('status', { name: 'Submitted intents' })).toHaveText(
        cancelled ? '' : idle ? 'SEND' : 'REPLACE_CURRENT'
      );
      await expect(draft).toHaveValue(cancelled ? 'Hosted follow-up' : '');
      await expect(draft).toBeFocused();
    });
  }
}

test('Hosted mobile steering also retains a directly tappable action', async ({ page }) => {
  await page.goto(`${fixture.url}workbench-style.html?hosted-gesture=1`);
  await page.locator('textarea.composer-input').fill('Tap to steer');
  const steer = page.getByRole('button', { name: 'Steer', exact: true });
  const stop = page.getByRole('button', { name: 'Stop', exact: true });
  const [stopBox, steerBox] = await Promise.all([stop.boundingBox(), steer.boundingBox()]);
  expect(stopBox!.y).toBe(steerBox!.y);
  expect(stopBox!.x + stopBox!.width).toBeLessThan(steerBox!.x);
  await stop.tap();
  await steer.tap();
  await expect(page.getByRole('status', { name: 'Submitted intents' })).toHaveText(
    'STOP,REPLACE_CURRENT'
  );
});

test('Hosted desktop retains the Ctrl+Enter steering hint while running', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.goto(`${fixture.url}workbench-style.html?hosted-gesture=1&desktop-composer=1`);
  await expect(
    page.getByText('While working, press Ctrl+Enter to steer with this message.', { exact: true })
  ).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).hover();
  await expect(page.getByRole('tooltip')).toHaveText('Stop (press Esc in the message field)');
});

test('Desktop mouse clicks retain ordinary sending without arming a touch gesture', async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  const ui = await openWorkspace(page);
  await ui.button.hover();
  await expect(page.getByRole('tooltip')).toHaveText(
    'Queue message (Enter) Steer (press Ctrl+Enter in the message field)'
  );
  const bounds = (await ui.button.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(250);
  await expect(ui.hint).toHaveCount(0);
  await page.mouse.up();
  await expect(ui.submitted).toHaveText('SEND');
});
