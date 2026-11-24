import { expect, test, type Page } from '@playwright/test';
import type { BrowserPageInput } from '../../packages/protocol/src/index.js';
import { BrowserPageView } from '../../mar-node/src/browser/browser-page-view.js';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

test('Browser sends wheel to its pointed scroller and coalesces a burst without dropping distance', async ({
  page,
  context
}) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/browser-input.html');
  const remote = await context.newPage({});
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
    await remote.setContent(`<style>
      p { position: absolute; top: 100px; left: 100px; font: 24px monospace; margin: 0; }
      button { position: absolute; top: 200px; left: 100px; }
    </style><p>Remote selectable words</p><button>Page menu</button><output></output><script>
      document.querySelector('button').oncontextmenu = event => {
        event.preventDefault();
        document.querySelector('output').textContent = 'Page menu opened';
      };
    </script>`);
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
          element.dataset.testPointer = String(event.pointerId);
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

async function attach(
  page: Page,
  remote: Page,
  url: string,
  observeCopy?: (lastAction: BrowserPageInput | undefined) => void
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
  await page.setViewportSize({ width: 880, height: 760 });
  await page.goto(`${url}browser-input.html`);
  await expect(page.locator('canvas')).toHaveJSProperty('width', 800);
  return actions;
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
