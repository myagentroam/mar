import { afterEach, expect, it, vi } from 'vitest';
import { encodeBrowserFrame } from '@myagentroam/protocol';
import { BrowserViewport } from '../../src/service/browser-viewport.js';

const decoder = vi.hoisted(() => ({ receive: vi.fn(), disconnect: vi.fn(), paint: () => {} }));
vi.mock('@novnc/novnc', () => ({
  default: class extends EventTarget {
    constructor(_target: HTMLElement, channel: { onmessage: (event: MessageEvent) => void }) {
      super();
      channel.onmessage = decoder.receive;
      decoder.paint = () => this.dispatchEvent(new Event('frame'));
    }
    disconnect = decoder.disconnect;
  }
}));

const chunks = (sequence = 1, viewVersion = 1, key = false) =>
  [
    ...encodeBrowserFrame({
      sequence,
      viewVersion,
      width: 1280,
      height: 800,
      key,
      data: new Uint8Array(17 * 1024)
    })
  ].map(({ bytes }) => bytes);

function fixture() {
  const drawImage = vi.fn();
  const clearRect = vi.fn();
  const image = { width: 960, height: 600 };
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage, clearRect }) };
  vi.stubGlobal('document', { createElement: () => ({ querySelector: () => image }) });
  decoder.receive.mockClear();
  const viewport = new BrowserViewport(canvas as unknown as HTMLCanvasElement, vi.fn(), vi.fn());
  viewport.setView(1, 'first');
  clearRect.mockClear();
  const receive = async (seq = 1, version = 1, resize = false) => {
    const [first, last] = chunks(seq, version, resize);
    expect(await viewport.receive(first!)).toBeUndefined();
    return { draw: viewport.receive(last!) };
  };
  return { viewport, canvas, image, receive, drawImage, clearRect };
}

afterEach(() => vi.unstubAllGlobals());

it('returns credit only on the pixel paint and reports CSS and raster dimensions separately', async () => {
  const { canvas, receive, drawImage } = fixture();
  const { draw } = await receive(1, 1, true);
  decoder.paint();
  await Promise.resolve();
  expect(drawImage).not.toHaveBeenCalled();
  decoder.paint();
  expect(await draw).toEqual({
    sequence: 1,
    viewport: { viewVersion: 1, width: 1280, height: 800, raster: { width: 960, height: 600 } }
  });
  expect(canvas.width).toBe(960);
  expect(drawImage).toHaveBeenCalledOnce();
});

it('consumes an old update without showing it and keeps the last paint of the same tab', async () => {
  const { canvas, viewport, receive, image, drawImage, clearRect } = fixture();
  const first = await receive();
  decoder.paint();
  await first.draw;
  const old = await receive(2);
  viewport.setView(2, 'first');
  decoder.paint();
  expect(await old.draw).toEqual({ sequence: 2 });
  expect(drawImage).toHaveBeenCalledOnce();
  expect(clearRect).not.toHaveBeenCalled();
  canvas.width = 960;
  image.width = 800;
  const next = await receive(3, 2);
  expect(canvas.width).toBe(960);
  decoder.paint();
  expect(await next.draw).toMatchObject({ viewport: { viewVersion: 2, raster: { width: 800 } } });
  viewport.setView(3, 'other');
  expect(clearRect).toHaveBeenCalledOnce();
});

it('closes without accepting an old connection paint or returning credit', async () => {
  const { viewport, receive, drawImage, clearRect } = fixture();
  const { draw } = await receive();
  viewport.close();
  decoder.paint();
  expect(await draw).toBeUndefined();
  expect(drawImage).not.toHaveBeenCalled();
  expect(clearRect).toHaveBeenCalledOnce();
});
