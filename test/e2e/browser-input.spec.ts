import { expect, test, type Page } from '@playwright/test';
import type {
  BrowserAttachmentMessage,
  BrowserPageInput
} from '../../packages/protocol/src/index.js';
import { installBrowserContextMenu } from '../../mar-node/src/browser/browser-context-menu.js';
import { BrowserPageView } from '../../mar-node/src/browser/browser-page-view.js';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

test('Closing the last browser page requests Aside closure only after the page is gone', async ({
  page
}) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/browser-input.html');
  try {
    await page.goto(`${fixture.url}browser-input.html?close-pages`);
    const body = page.locator('body');
    for (const id of ['first', 'last']) {
      await page.getByRole('button', { name: `Close ${id}`, exact: true }).click();
      await expect(body).toHaveAttribute('data-close-page', id);
      await expect(body).not.toHaveAttribute('data-browser-closed', 'true');
      await page.evaluate(() => document.dispatchEvent(new Event('fixture-close-page')));
      await expect(page.getByRole('tab', { name: id, exact: true })).toHaveCount(0);
    }
    await expect(body).toHaveAttribute('data-browser-closed', 'true');
  } finally {
    await fixture.close();
  }
});

test('Browser zoom is a single menu row that stays open while adjusting', async ({
  page
}, testInfo) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/browser-input.html');
  try {
    await page.goto(`${fixture.url}browser-input.html?zoom&locale=zh-CN`);
    const trigger = page.getByRole('button', { name: '浏览器命令' });
    const menu = page.getByRole('menu', { name: '浏览器命令' });
    const row = menu.getByRole('group', { name: '缩放' });
    const controls = row.locator('.node-browser-zoom-controls');
    const zoomIn = row.getByRole('menuitem', { name: '放大网页' });
    const zoomOut = row.getByRole('menuitem', { name: '缩小网页' });
    const reset = (percent: number) =>
      row.getByRole('menuitem', { name: `重置缩放（${percent}%）` });
    await trigger.press('Enter');
    await expect(row.locator('[data-mar-icon="search"]')).toBeVisible();
    await expect(controls.getByRole('menuitem')).toHaveCount(3);
    await expect(controls).toHaveCSS('border-inline-start-width', '1px');
    await expect(reset(100)).toHaveCSS('border-inline-start-width', '1px');
    await expect(zoomIn).toHaveCSS('border-inline-start-width', '1px');
    await expect(zoomIn).toHaveCSS('margin-inline-start', '0px');
    await expect(reset(100)).toBeDisabled();
    await zoomOut.focus();
    await page.keyboard.press('ArrowDown');
    await expect(reset(100)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(zoomIn).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(reset(110)).toBeEnabled();
    await expect(zoomIn).toBeFocused();
    await reset(110).click();
    await expect(reset(100)).toBeDisabled();
    await expect(reset(100)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();

    await trigger.click();
    await zoomIn.click();
    await expect(reset(110)).toBeVisible();
    await page.mouse.move(0, 0);
    await menu.screenshot({
      path: testInfo.outputPath('browser-zoom-menu.png'),
      animations: 'disabled'
    });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'vscode-dark-2026';
    });
    await menu.screenshot({
      path: testInfo.outputPath('browser-zoom-menu-dark.png'),
      animations: 'disabled'
    });
    await reset(110).click();
    const narrow = { width: 390, height: 740 };
    await page.setViewportSize(narrow);
    await zoomOut.click();
    await expect(reset(90)).toBeVisible();
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(narrow.width);
  } finally {
    await fixture.close();
  }
});

test('Browser page keyboard mode sends Tab in both directions and Escape returns focus', async ({
  page,
  context
}) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/browser-input.html');
  const remote = await context.newPage();
  try {
    await remote.setContent('<input aria-label="First"><input aria-label="Second">');
    const first = remote.getByRole('textbox', { name: 'First' });
    const second = remote.getByRole('textbox', { name: 'Second' });
    await first.focus();
    const actions = await attach(page, remote, fixture.url);
    const keyboard = page.getByRole('button', { name: 'Page keyboard mode' });
    await keyboard.focus();
    await page.keyboard.press('Tab');
    expect(actions).toEqual([]);
    await keyboard.press('Enter');
    await expect(keyboard).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Tab');
    await expect(second).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(first).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(keyboard).toBeFocused();
    await expect(keyboard).toHaveAttribute('aria-pressed', 'false');
    expect(actions.filter((action) => action.type === 'key').map((action) => action.key)).toEqual([
      'Tab',
      'Tab',
      'Shift',
      'Tab',
      'Tab',
      'Shift'
    ]);
  } finally {
    await remote.close();
    await fixture.close();
  }
});

test('Browser shows Agent activity without changing the viewport or blocking page commands', async ({
  page
}) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/browser-input.html');
  try {
    await page.goto(`${fixture.url}browser-input.html`);
    const viewport = page.locator('canvas');
    const size = await viewport.boundingBox();
    await page.evaluate(() => document.dispatchEvent(new Event('fixture-agent-activity')));
    await expect(page.getByText('Agent is using this browser')).toBeVisible();
    expect(await viewport.boundingBox()).toEqual(size);
    await page.evaluate(() => document.dispatchEvent(new Event('fixture-open-page')));
    await expect(page.locator('body')).toHaveAttribute('data-opened', 'https://example.test/');
    await expect(page.locator('body')).toHaveAttribute('data-consumed', 'true');
  } finally {
    await fixture.close();
  }
});

test('Browser sends wheel to its pointed scroller and coalesces a burst without dropping distance', async ({
  page,
  context
}) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/browser-input.html');
  const remote = await context.newPage();
  try {
    await remote.setViewportSize({ width: 800, height: 600 });
    await remote.setContent(
      `<style>body{margin:0;height:2000px} #pane{position:absolute;left:240px;top:60px;width:300px;height:230px;overflow:auto} #pane>div{height:3500px}</style><div id="pane"><div>Nested scroller</div></div>`
    );
    const actions = await attach(page, remote, fixture.url);
    const at = await canvasPoint(page, 300, 100);
    await page.locator('canvas').evaluate((canvas, point) => {
      for (let i = 0; i < 100; i++)
        canvas.dispatchEvent(new WheelEvent('wheel', { ...point, deltaY: 4, cancelable: true }));
    }, at);
    await expect.poll(() => remote.locator('#pane').evaluate((el) => el.scrollTop)).toBe(400);
    expect(await remote.evaluate(() => scrollY)).toBe(0);
    const wheels = actions.filter((action) => action.type === 'wheel');
    expect(wheels).toHaveLength(2);
    expect(wheels.reduce((sum, item) => sum + item.y, 0)).toBe(400);
  } finally {
    await remote.close();
    await fixture.close();
  }
});

test('Browser sends real Chromium composition once and does not send a composition after view change', async ({
  page,
  context
}) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/browser-input.html');
  const remote = await context.newPage();
  try {
    await remote.setContent('<textarea></textarea>');
    await remote.locator('textarea').focus();
    const actions = await attach(page, remote, fixture.url);
    await page.locator('[data-node-browser-input]').focus();
    const session = await context.newCDPSession(page);
    await session.send('Input.imeSetComposition', {
      text: 'ni',
      selectionStart: 2,
      selectionEnd: 2
    });
    await session.send('Input.imeSetComposition', {
      text: 'nihao',
      selectionStart: 5,
      selectionEnd: 5
    });
    expect(actions).toEqual([]);
    await session.send('Input.insertText', { text: '你好' });
    await expect(remote.locator('textarea')).toHaveValue('你好');
    expect(actions).toEqual([{ type: 'text', text: '你好', viewVersion: 1 }]);
    await session.send('Input.imeSetComposition', {
      text: 'stale',
      selectionStart: 5,
      selectionEnd: 5
    });
    await page.evaluate(() => document.dispatchEvent(new Event('fixture-view-change')));
    await session.send('Input.insertText', { text: '过期' });
    await page.keyboard.insertText('!');
    await expect(remote.locator('textarea')).toHaveValue('你好!');
    expect(actions.at(-1)).toEqual({ type: 'text', text: '!', viewVersion: 2 });
    await page.locator('[data-node-browser-input]').evaluate((target) => {
      for (const inputType of ['deleteContentBackward', 'insertLineBreak'])
        target.dispatchEvent(new InputEvent('beforeinput', { inputType, cancelable: true }));
    });
    await expect(remote.locator('textarea')).toHaveValue('你好\n');
    expect(actions.slice(-4)).toEqual([
      { type: 'key', edge: 'down', key: 'Backspace', viewVersion: 2 },
      { type: 'key', edge: 'up', key: 'Backspace', viewVersion: 2 },
      { type: 'key', edge: 'down', key: 'Enter', viewVersion: 2 },
      { type: 'key', edge: 'up', key: 'Enter', viewVersion: 2 }
    ]);
    await page.keyboard.press('Enter');
    await expect(remote.locator('textarea')).toHaveValue('你好\n\n');
    expect(actions.slice(-2)).toEqual([
      { type: 'key', edge: 'down', key: 'Enter', viewVersion: 2 },
      { type: 'key', edge: 'up', key: 'Enter', viewVersion: 2 }
    ]);
    await session.detach();
  } finally {
    await remote.close();
    await fixture.close();
  }
});

test('Browser drag cancellation releases at the latest point without replaying the path', async ({
  page,
  context
}) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/browser-input.html');
  const remote = await context.newPage();
  try {
    await remote.setViewportSize({ width: 800, height: 600 });
    await remote.setContent(
      `<body><output></output><script>document.onmouseup = e => document.querySelector('output').textContent = String(e.clientX)</script></body>`
    );
    const actions = await attach(page, remote, fixture.url);
    const start = await canvasPoint(page, 100, 150);
    const end = await canvasPoint(page, 400, 150);
    await page.locator('canvas').evaluate((canvas) => {
      canvas.addEventListener(
        'pointerdown',
        (event) => {
          canvas.dataset.pointer = String((event as PointerEvent).pointerId);
        },
        { once: true }
      );
    });
    await page.mouse.move(start.clientX, start.clientY);
    await page.mouse.down();
    await expect(page.locator('[data-node-browser-input]')).toBeFocused();
    await page.locator('canvas').evaluate(
      (canvas, points) => {
        const pointerId = Number(canvas.dataset.pointer);
        for (let i = 1; i <= 100; i++) {
          canvas.dispatchEvent(
            new PointerEvent('pointermove', {
              pointerId,
              pointerType: 'mouse',
              buttons: 1,
              clientX:
                points.start.clientX + ((points.end.clientX - points.start.clientX) * i) / 100,
              clientY: points.end.clientY
            })
          );
        }
        canvas.dispatchEvent(
          new PointerEvent('pointercancel', { pointerId, pointerType: 'mouse' })
        );
      },
      { start, end }
    );
    await expect
      .poll(() => actions.slice(-8))
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'button', edge: 'up', x: expect.closeTo(400, -1) })
        ])
      );
    await page.mouse.up();
    await expect(remote.locator('output')).toHaveText('400');
    const down = actions.findIndex((action) => action.type === 'button' && action.edge === 'down');
    const up = actions.findIndex((action) => action.type === 'button' && action.edge === 'up');
    expect(up).toBeGreaterThan(down);
    expect(
      actions.slice(down + 1, up).filter((action) => action.type === 'move').length
    ).toBeLessThanOrEqual(2);
  } finally {
    await remote.close();
    await fixture.close();
  }
});

test('Browser releases a drag when its mouse button is released before another button', async ({
  page,
  context
}) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/browser-input.html');
  const remote = await context.newPage();
  try {
    await remote.setViewportSize({ width: 800, height: 600 });
    await remote.setContent(`<output></output><script>
      document.onmouseup = e => document.querySelector('output').textContent =
        String(e.button) + ':' + String(e.clientX);
    </script>`);
    const actions = await attach(page, remote, fixture.url);
    const start = await canvasPoint(page, 100, 150);
    const end = await canvasPoint(page, 400, 150);
    const canvas = page.locator('canvas');
    await canvas.evaluate((element) => {
      element.addEventListener(
        'pointerdown',
        (event) => {
          element.dataset.pointer = String((event as PointerEvent).pointerId);
        },
        { once: true }
      );
    });
    await page.mouse.move(start.clientX, start.clientY);
    await page.mouse.down();
    await page.mouse.move(end.clientX, end.clientY);
    // Chorded button changes use pointermove while another button is held.
    await canvas.evaluate((element, position) => {
      const pointer = {
        pointerId: Number(element.dataset.pointer),
        pointerType: 'mouse',
        ...position
      };
      element.dispatchEvent(new PointerEvent('pointermove', { ...pointer, button: 2, buttons: 3 }));
      element.dispatchEvent(new PointerEvent('pointermove', { ...pointer, button: 0, buttons: 2 }));
    }, end);
    await expect(remote.locator('output')).toHaveText('0:400');
    await page.mouse.up();
    await expect(remote.locator('output')).toHaveText('0:400');
    expect(
      actions.filter((action) => action.type === 'button').map(({ button, edge }) => [button, edge])
    ).toEqual([
      ['left', 'down'],
      ['left', 'up']
    ]);
  } finally {
    await remote.close();
    await fixture.close();
  }
});

test('Browser drag-selects remote text and delivers a right click to the remote page', async ({
  page,
  context
}) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/browser-input.html');
  const remote = await context.newPage();
  try {
    await remote.setViewportSize({ width: 800, height: 600 });
    await setContextPage(
      remote,
      `<style>
      p { position: absolute; top: 100px; left: 100px; font: 24px monospace; margin: 0; }
      button { position: absolute; top: 200px; left: 100px; }
    </style><p>Remote selectable words</p><button>Page menu</button><output></output><script>
      document.querySelector('button').oncontextmenu = event => {
        event.preventDefault();
        document.querySelector('output').textContent = 'Page menu opened';
      };
    </script>`
    );
    await attach(page, remote, fixture.url);
    const bounds = (await remote.locator('p').boundingBox())!;
    const start = await canvasPoint(page, bounds.x + 1, bounds.y + bounds.height / 2);
    const end = await canvasPoint(page, bounds.x + bounds.width - 1, bounds.y + bounds.height / 2);
    await page.mouse.move(start.clientX, start.clientY);
    await page.mouse.down();
    await page.mouse.move(end.clientX, end.clientY, { steps: 10 });
    await page.mouse.up();
    await expect
      .poll(() => remote.evaluate(() => getSelection()?.toString()))
      .toBe('Remote selectable words');

    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: fixture.url });
    await page.keyboard.press('Control+c');
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('Remote selectable words');

    const menu = await canvasPoint(page, 120, 211);
    await page.mouse.click(menu.clientX, menu.clientY, { button: 'right' });
    await expect(remote.locator('output')).toHaveText('Page menu opened');
    await expect(page.getByRole('menu', { name: 'Page context menu' })).toHaveCount(0);
  } finally {
    await remote.close();
    await fixture.close();
  }
});

test('Browser opens the context menu for text, fields, and links and preserves a page override', async ({
  page,
  context
}, testInfo) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/browser-input.html');
  const remote = await context.newPage();
  try {
    await remote.setViewportSize({ width: 800, height: 600 });
    await setContextPage(
      remote,
      `<style>
      p, input, a { position: absolute; left: 100px; margin: 0; }
      p { top: 80px; } input { top: 140px; } a { top: 200px; }
    </style>
    <p>Selected remotely</p><input><a href="https://example.test/path">Link</a>
    <script>
      window.addEventListener('contextmenu', event => {
        document.body.dataset.contextEvents = Number(document.body.dataset.contextEvents || 0) + 1;
        if (!document.body.dataset.intercept) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        document.body.dataset.count = Number(document.body.dataset.count || 0) + 1;
      }, true);
    </script>`
    );
    await attach(page, remote, fixture.url);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: fixture.url });
    const menu = page.getByRole('menu', { name: 'Page context menu' });
    async function clickAt(x: number, y: number, button: 'left' | 'right' = 'right') {
      const position = await canvasPoint(page, x, y);
      await page.mouse.click(position.clientX, position.clientY, { button });
    }

    await remote.locator('p').evaluate((element) => getSelection()?.selectAllChildren(element));
    // Some hosts dispatch contextmenu before pointerdown. One physical click
    // must still send exactly one request without canceling its own result.
    const selectionPoint = await canvasPoint(page, 110, 88);
    await page.locator('canvas').dispatchEvent('contextmenu', { ...selectionPoint, button: 2 });
    await clickAt(110, 88);
    await expect(remote.locator('body')).toHaveAttribute('data-context-events', '1');
    await expect(menu.locator('kbd')).toHaveText([/^(Ctrl\+|⌘)C$/u, /^(Ctrl\+|⌘)V$/u]);
    await menu.screenshot({
      path: testInfo.outputPath('chrome-context-menu-light.png'),
      animations: 'disabled'
    });
    await menu.getByRole('menuitem', { name: 'Copy', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('Selected remotely');

    await page.evaluate(() => navigator.clipboard.writeText('Paste from the device'));
    await clickAt(110, 150);
    const paste = menu.getByRole('menuitem', { name: 'Paste', exact: true });
    await expect(menu).toBeFocused();
    await expect(paste).not.toBeFocused();
    await expect(paste).toHaveCSS('outline-style', 'none');
    await page.keyboard.press('ArrowDown');
    await expect(paste).toBeFocused();
    await expect(paste).toHaveCSS('outline-style', 'solid');
    await page.keyboard.press('Enter');
    await expect(remote.locator('input')).toHaveValue('Paste from the device');

    await clickAt(110, 207);
    await expect(menu.getByRole('menuitem', { name: 'Open link in new tab' })).toBeEnabled();
    await menu.getByRole('menuitem', { name: 'Copy link address' }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('https://example.test/path');

    await remote.locator('body').evaluate((body) => {
      body.dataset.intercept = '1';
    });
    await clickAt(110, 150, 'left');
    await clickAt(110, 150);
    await expect(remote.locator('body')).toHaveAttribute('data-count', '1');
    await expect(menu).toBeHidden();
    await page.keyboard.press('Shift+F10');
    await expect(menu.getByRole('menuitem', { name: 'Paste', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(page.locator('[data-node-browser-input]')).toBeFocused();
    await page.keyboard.down('Shift');
    await clickAt(110, 150);
    await page.keyboard.up('Shift');
    await expect(menu).toBeVisible();
    await expect(remote.locator('body')).toHaveAttribute('data-count', '1');
    await page.evaluate(() => document.dispatchEvent(new Event('fixture-view-change')));
    await expect(menu).toBeHidden();
    await remote.locator('body').evaluate((body) => delete body.dataset.intercept);
    await page.setViewportSize({ width: 390, height: 700 });
    await page.evaluate(() =>
      document.documentElement.setAttribute('data-theme', 'vscode-dark-2026')
    );
    await clickAt(780, 560);
    await expect(menu).toHaveCSS('background-color', 'rgb(41, 42, 45)');
    const menuBox = (await menu.boundingBox())!;
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(390);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(700);
    await menu.screenshot({
      path: testInfo.outputPath('chrome-context-menu-dark.png'),
      animations: 'disabled'
    });
  } finally {
    await remote.close();
    await fixture.close();
  }
});

test('Browser drops delayed menu paste after a view change and does not paste into a replacement field', async ({
  page,
  context
}) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/browser-input.html');
  const remote = await context.newPage();
  try {
    await remote.setViewportSize({ width: 800, height: 600 });
    await setContextPage(
      remote,
      '<textarea id="first"></textarea><textarea id="second"></textarea>'
    );
    let sent = 0;
    await attach(page, remote, fixture.url, undefined, () => {
      sent++;
    });
    const menu = page.getByRole('menu', { name: 'Page context menu' });
    const input = page.locator('[data-node-browser-input]');
    const paste = menu.getByRole('menuitem', { name: 'Paste', exact: true });
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, 'readText', {
        value: () =>
          new Promise<string>((resolve) => {
            document.documentElement.dataset.pendingClipboard = 'yes';
            document.addEventListener(
              'finish-fixture-clipboard',
              () => resolve('Do not redirect'),
              { once: true }
            );
          })
      });
    });
    await remote.locator('#first').focus();
    await input.focus();
    await page.keyboard.press('Shift+F10');
    await paste.click();
    await expect(page.locator('html')).toHaveAttribute('data-pending-clipboard', 'yes');
    await page.evaluate(async () => {
      document.dispatchEvent(new Event('fixture-view-change'));
      document.dispatchEvent(new Event('finish-fixture-clipboard'));
      await new Promise(requestAnimationFrame);
    });
    expect(sent).toBe(0);
    await expect(remote.locator('#first')).toHaveValue('');

    await input.focus();
    await page.keyboard.press('Shift+F10');
    await paste.click();
    const toolbar = page.getByRole('button', { name: 'Browser commands' });
    await toolbar.focus();
    await expect(toolbar).toBeFocused();
    await input.focus();
    await page.evaluate(async () => {
      document.dispatchEvent(new Event('finish-fixture-clipboard'));
      await new Promise(requestAnimationFrame);
    });
    expect(sent).toBe(0);

    await input.focus();
    await page.keyboard.press('Shift+F10');
    await expect(paste).toBeEnabled();
    await remote.locator('#second').focus();
    await paste.click();
    await page.evaluate(() => document.dispatchEvent(new Event('finish-fixture-clipboard')));
    await expect.poll(() => sent).toBe(1);
    await expect(remote.locator('#first')).toHaveValue('');
    await expect(remote.locator('#second')).toHaveValue('');
  } finally {
    await remote.close();
    await fixture.close();
  }
});

test('Browser discards delayed menu paste after typing or moving the caret in the same field', async ({
  page,
  context
}) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/browser-input.html');
  const remote = await context.newPage();
  let sent = 0;
  try {
    await remote.setViewportSize({ width: 800, height: 600 });
    await setContextPage(remote, '<textarea>ab</textarea>');
    await attach(page, remote, fixture.url, undefined, () => sent++);
    const field = remote.locator('textarea');
    const sink = page.locator('[data-node-browser-input]');
    const paste = page.getByRole('menuitem', { name: 'Paste', exact: true });
    await remote.evaluate(() => {
      const field = document.querySelector('textarea')!;
      field.focus();
      field.setSelectionRange(2, 2);
    });
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, 'readText', {
        value: () =>
          new Promise<string>((resolve) => {
            document.documentElement.dataset.pendingClipboard = 'yes';
            document.addEventListener('finish-fixture-clipboard', () => resolve('late'), {
              once: true
            });
          })
      });
    });
    for (const [key, caret, value] of [
      ['ArrowLeft', 1, 'ab'],
      ['x', 2, 'axb']
    ] as const) {
      await sink.focus();
      await page.keyboard.press('Shift+F10');
      await paste.click();
      await expect(page.locator('html')).toHaveAttribute('data-pending-clipboard', 'yes');
      await expect(sink).toBeFocused();
      await page.keyboard.press(key);
      await expect
        .poll(() => field.evaluate((input: HTMLTextAreaElement) => input.selectionStart))
        .toBe(caret);
      await page.evaluate(async () => {
        delete document.documentElement.dataset.pendingClipboard;
        document.dispatchEvent(new Event('finish-fixture-clipboard'));
        await new Promise(requestAnimationFrame);
      });
      await expect(field).toHaveValue(value);
    }
    expect(sent).toBe(0);
    await page.keyboard.press('Shift+F10');
    await paste.click();
    await page.evaluate(() => document.dispatchEvent(new Event('finish-fixture-clipboard')));
    await expect(field).toHaveValue('axlateb');
    await expect.poll(() => sent).toBe(1);
  } finally {
    await remote.close();
    await fixture.close();
  }
});

test('Browser resolves the context menu inside nested open shadow roots', async ({
  page,
  context
}) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/browser-input.html');
  const remote = await context.newPage();
  try {
    await remote.setViewportSize({ width: 800, height: 600 });
    await setContextPage(
      remote,
      `<div id="outer"></div><script>
        const outer = document.getElementById('outer').attachShadow({mode:'open'});
        const host = document.createElement('div');
        outer.append(host);
        const inner = host.attachShadow({mode:'open'});
        inner.innerHTML = '<input value="Shadow text"><input type="password" value="secret"><p style="margin-top: 4rem"><a href="https://example.test/shadow"><span>Shadow link</span></a></p>';
      </script>`
    );
    await attach(page, remote, fixture.url);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: fixture.url });
    const field = remote.locator('input:not([type])');
    const password = remote.locator('input[type=password]');
    const menu = page.getByRole('menu', { name: 'Page context menu' });
    const copy = menu.getByRole('menuitem', { name: 'Copy', exact: true });
    const paste = menu.getByRole('menuitem', { name: 'Paste', exact: true });
    await field.selectText();
    await page.locator('[data-node-browser-input]').focus();
    await page.keyboard.press('Shift+F10');
    await copy.click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('Shadow text');

    const bounds = (await field.boundingBox())!;
    const point = await canvasPoint(page, bounds.x + 10, bounds.y + bounds.height / 2);
    await page.evaluate(() => navigator.clipboard.writeText('Pasted into shadow'));
    await page.mouse.click(point.clientX, point.clientY, { button: 'right' });
    await paste.click();
    await expect(field).toHaveValue('Pasted into shadow');

    const view = new BrowserPageView(remote);
    await expect(view.contextMenu.open('focus-change')).resolves.toMatchObject({ paste: true });
    await password.focus();
    await field.focus();
    await view.contextMenu.paste('focus-change', 'Stale target');
    await expect(field).toHaveValue('Pasted into shadow');
    await page.bringToFront();

    await password.selectText();
    await page.locator('[data-node-browser-input]').focus();
    await page.keyboard.press('Shift+F10');
    await expect(copy).toBeDisabled();
    await page.keyboard.press('Escape');

    const link = (await remote.locator('a span').boundingBox())!;
    const linkPoint = await canvasPoint(page, link.x + 5, link.y + 5);
    await page.mouse.click(linkPoint.clientX, linkPoint.clientY, { button: 'right' });
    await expect(menu.getByRole('menuitem', { name: 'Open link in new tab' })).toBeEnabled();
    await menu.getByRole('menuitem', { name: 'Copy link address' }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('https://example.test/shadow');
  } finally {
    await remote.close();
    await fixture.close();
  }
});

test('Browser sends a single-finger swipe as native touch and scrolls remote content', async ({
  page,
  context
}) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/browser-input.html');
  const remote = await context.newPage();
  try {
    await remote.setViewportSize({ width: 800, height: 600 });
    await remote.setContent('<style>body{height:3000px; margin:0}</style>Scroll target');
    const actions = await attach(page, remote, fixture.url);
    const session = await context.newCDPSession(page);
    await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    const from = await canvasPoint(page, 400, 470);
    const to = await canvasPoint(page, 400, 150);
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: from.clientX, y: from.clientY }]
    });
    for (let i = 1; i <= 12; i++)
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: to.clientX, y: from.clientY + ((to.clientY - from.clientY) * i) / 12 }]
      });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => remote.evaluate(() => scrollY)).toBeGreaterThan(100);
    await expect.poll(() => actions.at(-1)).toMatchObject({ type: 'touch', phase: 'end' });
    expect(actions[0]).toMatchObject({ type: 'touch', phase: 'start' });
    expect(actions.at(-2)).toMatchObject({
      type: 'touch',
      phase: 'move',
      y: expect.closeTo(150, -1)
    });
    expect(actions.every((action) => action.type === 'touch')).toBe(true);
    await session.detach();
  } finally {
    await remote.close();
    await fixture.close();
  }
});

test('Browser releases the original remote key after modifier changes', async ({
  page,
  context
}) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/browser-input.html');
  const remote = await context.newPage();
  try {
    await remote.setContent('<textarea></textarea>');
    await remote.locator('textarea').focus();
    const actions = await attach(page, remote, fixture.url);
    await page.locator('[data-node-browser-input]').focus();
    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await page.keyboard.down('KeyY');
    await page.keyboard.up('Shift');
    await page.keyboard.up('KeyY');
    await page.keyboard.up('Control');
    await expect
      .poll(() => actions.filter((action) => action.type === 'key'))
      .toEqual([
        { type: 'key', edge: 'down', key: 'Control', viewVersion: 1 },
        { type: 'key', edge: 'down', key: 'Shift', viewVersion: 1 },
        { type: 'key', edge: 'down', key: 'Y', viewVersion: 1 },
        { type: 'key', edge: 'up', key: 'Shift', viewVersion: 1 },
        { type: 'key', edge: 'up', key: 'Y', viewVersion: 1 },
        { type: 'key', edge: 'up', key: 'Control', viewVersion: 1 }
      ]);
    await page.keyboard.type('y');
    await expect(remote.locator('textarea')).toHaveValue('y');
  } finally {
    await remote.close();
    await fixture.close();
  }
});

test('Browser copies and pastes text by keyboard without forwarding C or V to the remote page', async ({
  page,
  context
}) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/browser-input.html');
  const remote = await context.newPage();
  try {
    await remote.setContent('<textarea>网页选区</textarea>');
    await remote.locator('textarea').evaluate((field: HTMLTextAreaElement) => {
      field.focus();
      field.select();
    });
    const actions = await attach(page, remote, fixture.url);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: new URL(fixture.url).origin
    });
    const hit = await canvasPoint(page, 30, 20);
    await page.mouse.click(hit.clientX, hit.clientY);
    // The remote click in a real attachment also focuses a field; select the
    // full fixture value before testing the explicit copy action.
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+c');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('网页选区');
    await page.locator('[data-node-browser-input]').focus();
    await page.evaluate(() => navigator.clipboard.writeText('本机粘贴'));
    await page.keyboard.press('Control+v');
    await expect(remote.locator('textarea')).toHaveValue('本机粘贴');
    expect(actions.filter((action) => action.type === 'text')).toEqual([
      { type: 'text', viewVersion: 1, text: '本机粘贴' }
    ]);
    expect(
      actions.filter((action) => action.type === 'key' && /^[cv]$/iu.test(action.key))
    ).toEqual([]);
  } finally {
    await remote.close();
    await fixture.close();
  }
});

test('Browser flushes the latest drag position before requesting the copied selection', async ({
  page,
  context
}) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/browser-input.html');
  const remote = await context.newPage();
  try {
    await remote.setContent('<textarea>drag selection</textarea>');
    const atCopy: BrowserPageInput[] = [];
    await attach(page, remote, fixture.url, (action) => {
      if (action) atCopy.push(action);
    });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: new URL(fixture.url).origin
    });
    const start = await canvasPoint(page, 20, 18);
    const first = await canvasPoint(page, 35, 18);
    const last = await canvasPoint(page, 105, 18);
    const canvas = page.locator('canvas');
    await canvas.evaluate((element) => {
      element.addEventListener(
        'pointerdown',
        (event) => {
          element.dataset.testPointer = String((event as PointerEvent).pointerId);
        },
        { once: true }
      );
    });
    await page.mouse.move(start.clientX, start.clientY);
    await page.mouse.down();
    await canvas.evaluate(
      (element, { first, last }) => {
        for (const point of [first, last]) {
          element.dispatchEvent(
            new PointerEvent('pointermove', {
              ...point,
              pointerId: Number(element.dataset.testPointer),
              pointerType: 'mouse',
              buttons: 1
            })
          );
        }
        // Keep both moves and the copy request in the same animation frame.
        document.activeElement?.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'c',
            code: 'KeyC',
            ctrlKey: true,
            bubbles: true,
            cancelable: true
          })
        );
      },
      { first, last }
    );
    await expect.poll(() => atCopy.length).toBe(1);
    expect(atCopy[0]).toMatchObject({ type: 'move', x: 105 });
    await page.mouse.up();
  } finally {
    await remote.close();
    await fixture.close();
  }
});

test('Browser toolbar pastes only into the current remote view', async ({ page, context }) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/browser-input.html');
  const remote = await context.newPage();
  try {
    await remote.setContent('<input aria-label="Remote field">');
    const actions = await attach(page, remote, fixture.url);
    await remote.getByRole('textbox').focus();
    const paste = page.getByRole('button', { name: 'Paste plain text', exact: true });
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, 'readText', {
        configurable: true,
        value: async () => 'From the toolbar'
      });
    });
    await paste.click();
    await expect(remote.getByRole('textbox')).toHaveValue('From the toolbar');
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, 'readText', {
        configurable: true,
        value: async () => {
          throw new DOMException('Denied', 'NotAllowedError');
        }
      });
    });
    await paste.click();
    await expect(
      page.getByText('Could not paste. Focus the field and use your paste shortcut.')
    ).toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, 'readText', {
        configurable: true,
        value: () =>
          new Promise<string>((resolve) => {
            document.addEventListener('fixture-finish-toolbar-paste', () => resolve('Stale text'), {
              once: true
            });
            document.documentElement.dataset.pastePending = 'true';
          })
      });
    });
    await paste.click();
    await expect(page.locator('html')).toHaveAttribute('data-paste-pending', 'true');
    await page.evaluate(() => {
      document.dispatchEvent(new Event('fixture-view-change'));
      document.dispatchEvent(new Event('fixture-finish-toolbar-paste'));
    });
    await paste.press('Tab');
    expect(actions.filter((action) => action.type === 'text')).toEqual([
      { type: 'text', text: 'From the toolbar', viewVersion: 1 }
    ]);
    await page.evaluate(() => {
      document.dispatchEvent(new Event('fixture-snapshot-ahead'));
      delete document.documentElement.dataset.pastePending;
    });
    await paste.click();
    await expect(page.locator('html')).not.toHaveAttribute('data-paste-pending', 'true');
  } finally {
    await remote.close();
    await fixture.close();
  }
});

async function attach(
  page: Page,
  remote: Page,
  url: string,
  observeCopy?: (lastAction: BrowserPageInput | undefined) => void,
  observePaste?: () => void
) {
  const actions: BrowserPageInput[] = [];
  const view = new BrowserPageView(remote);
  let ordered = Promise.resolve();
  await page.exposeFunction('fixtureInput', (action: BrowserPageInput) => {
    actions.push(action);
    ordered = ordered.then(() => view.input(action));
    return ordered;
  });
  await page.exposeFunction('fixtureCopy', async () => {
    observeCopy?.(actions.at(-1));
    await ordered;
    // The fixture uses two tabs of the same browser, unlike a real Node.
    await remote.bringToFront();
    try {
      return await view.selectedText();
    } finally {
      await page.bringToFront();
    }
  });
  await page.exposeFunction(
    'fixtureContext',
    async (id: string, point?: { x: number; y: number }) => {
      await ordered;
      await remote.bringToFront();
      try {
        return await view.contextMenu.open(id, point);
      } finally {
        await page.bringToFront();
      }
    }
  );
  await page.exposeFunction(
    'fixturePaste',
    async (message: Extract<BrowserAttachmentMessage, { type: 'context.paste' }>) => {
      await remote.bringToFront();
      try {
        await view.contextMenu.paste(message.id, message.text);
        observePaste?.();
      } finally {
        await page.bringToFront();
      }
    }
  );
  await page.setViewportSize({ width: 880, height: 760 });
  await page.goto(`${url}browser-input.html`);
  await expect(page.locator('canvas')).toHaveJSProperty('width', 800);
  return actions;
}

async function setContextPage(remote: Page, html: string): Promise<void> {
  await installBrowserContextMenu(remote.context());
  await remote.goto(`data:text/html,${encodeURIComponent(html)}`);
}

function canvasPoint(page: Page, x: number, y: number) {
  return page.locator('canvas').evaluate(
    (canvas: HTMLCanvasElement, point) => {
      const box = canvas.getBoundingClientRect();
      const scale = Math.min(box.width / canvas.width, box.height / canvas.height);
      return {
        clientX: box.x + (box.width - canvas.width * scale) / 2 + point.x * scale,
        clientY: box.y + (box.height - canvas.height * scale) / 2 + point.y * scale
      };
    },
    { x, y }
  );
}

test('Browser performance separates the CSS viewport from the decoded resolution', async ({
  page
}) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/browser-input.html');
  try {
    await page.goto(`${fixture.url}browser-input.html`);
    await page.getByRole('button', { name: 'Browser streaming performance' }).click();
    const panel = page.getByRole('region', { name: 'Browser streaming performance' });
    const value = (label: string) => panel.getByText(label, { exact: true }).locator('+ dd');
    await expect(value('CSS viewport')).toHaveText('800 × 600');
    await expect(value('Decoded resolution')).toHaveText('800 × 600');
    await page.evaluate(() => document.dispatchEvent(new Event('fixture-raster-change')));
    await expect(value('Decoded resolution')).toHaveText('640 × 480');
    await expect(value('CSS viewport')).toHaveText('800 × 600');
  } finally {
    await fixture.close();
  }
});
