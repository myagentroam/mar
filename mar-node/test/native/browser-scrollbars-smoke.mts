import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createBrowserLauncher } from '../../src/browser/browser-launcher.js';
import { BrowserPageView } from '../../src/browser/browser-page-view.js';
import { BROWSER_VIEWPORT } from '../../src/browser/browser-capture-config.js';

const root = await mkdtemp(join(tmpdir(), 'mar-browser-scrollbars-'));
const errors: unknown[] = [];
const { launch } = createBrowserLauncher(join(root, 'runs'), join(root, 'profiles'), (error) =>
  errors.push(error)
);
let browser: Awaited<ReturnType<typeof launch>> | undefined;
try {
  browser = await launch();
  const page = browser.context.pages()[0]!;
  const view = new BrowserPageView(page);
  await page.setContent(`<!doctype html><style>
    :root { scrollbar-color: #00ff00 #ff00ff; }
    body { margin: 0; }
    main { width: 300vw; height: 300vh; }
  </style><main></main>`);
  const frames = new EventEmitter();
  const first = once(frames, 'jpeg', { signal: AbortSignal.timeout(5_000) });
  const capture = await view.startCapture({ ...BROWSER_VIEWPORT, quality: 85 }, ({ jpeg }) =>
    frames.emit('jpeg', jpeg)
  );
  try {
    const [jpeg] = await first;
    const { data, info } = await sharp(jpeg)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixelAt = (x: number, y: number) => {
      const pixel = (y * info.width + x) * info.channels;
      return [data[pixel]!, data[pixel + 1]!, data[pixel + 2]!] as const;
    };
    const track = (x: number, y: number) => {
      const [red, green, blue] = pixelAt(x, y);
      return red > 180 && green < 90 && blue > 180;
    };
    assert(track(info.width - 5, Math.floor(info.height / 2)), 'Vertical scrollbar in the cast');
    assert(track(Math.floor(info.width / 2), info.height - 5), 'Horizontal scrollbar in the cast');

    const startY = 40;
    const [red, green, blue] = pixelAt(info.width - 5, startY);
    assert(red < 90 && green > 180 && blue < 90, 'Drag starts on the thumb, not the track');
    const x = BROWSER_VIEWPORT.width - 5;
    await view.input({
      type: 'button',
      button: 'left',
      edge: 'down',
      x,
      y: startY,
      viewVersion: 1
    });
    await view.input({ type: 'move', x, y: 180, viewVersion: 1 });
    await page.waitForFunction(() => window.scrollY > 200, undefined, { timeout: 3_000 });
    await view.input({ type: 'button', button: 'left', edge: 'up', x, y: 180, viewVersion: 1 });
    assert.deepEqual(errors, []);
  } finally {
    await capture.stop();
  }
} finally {
  await browser?.close();
  await rm(root, { recursive: true, force: true });
}
