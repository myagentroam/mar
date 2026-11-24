import { afterEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_VIDEO_HD_CODEC, encodeBrowserFrame } from '@myagentroam/protocol';
import { BrowserViewport } from '../../src/service/browser-viewport.js';

const chunks = (sequence = 1, viewVersion = 1, key = true) =>
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
  const configure = vi.fn();
  const decode = vi.fn();
  let output: VideoDecoderInit['output'];
  vi.stubGlobal(
    'VideoDecoder',
    class {
      constructor(init: VideoDecoderInit) {
        output = init.output;
      }
      configure = configure;
      decode = decode;
      reset() {}
      close() {}
    }
  );
  vi.stubGlobal(
    'EncodedVideoChunk',
    class {
      constructor(public readonly init: EncodedVideoChunkInit) {}
    }
  );
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage, clearRect }) };
  const viewport = new BrowserViewport(canvas as unknown as HTMLCanvasElement);
  const image = { displayWidth: 960, displayHeight: 600, close: vi.fn() };
  viewport.setView(1, 'first-tab');
  return {
    canvas,
    viewport,
    image,
    configure,
    drawImage,
    clearRect,
    decoded: () => output(image as unknown as VideoFrame)
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('Browser viewport', () => {
  it('reports both remote CSS coordinates and the decoded raster after drawing', async () => {
    const { canvas, viewport, image, drawImage, decoded } = fixture();
    const [first, last] = chunks();
    expect(await viewport.receive(first!)).toBeUndefined();
    expect(drawImage).not.toHaveBeenCalled();
    const draw = viewport.receive(last!);
    decoded();
    expect(await draw).toEqual({
      sequence: 1,
      viewport: { viewVersion: 1, width: 1280, height: 800, raster: { width: 960, height: 600 } }
    });
    expect(canvas.width).toBe(960);
    expect(drawImage).toHaveBeenCalledOnce();
    expect(image.close).toHaveBeenCalledOnce();
  });

  it('returns credit without drawing if the active view changes during decoding', async () => {
    const { viewport, image, drawImage, decoded } = fixture();
    const [first, last] = chunks();
    await viewport.receive(first!);
    const draw = viewport.receive(last!);
    viewport.setView(2, 'first-tab');
    decoded();
    expect(await draw).toEqual({ sequence: 1 });
    expect(drawImage).not.toHaveBeenCalled();
    expect(image.close).toHaveBeenCalledOnce();
  });

  it('retains the last picture within a tab until its next view is drawn', async () => {
    const { canvas, viewport, image, drawImage, clearRect, decoded } = fixture();
    const render = async (sequence: number, viewVersion: number) => {
      const [first, last] = chunks(sequence, viewVersion);
      await viewport.receive(first!);
      const draw = viewport.receive(last!);
      decoded();
      return draw;
    };
    await render(1, 1);
    clearRect.mockClear();

    viewport.setView(2, 'first-tab');
    viewport.setView(3, 'first-tab');
    expect(clearRect).not.toHaveBeenCalled();
    expect(canvas.width).toBe(960);
    expect(drawImage).toHaveBeenCalledOnce();

    image.displayWidth = 800;
    expect(await render(2, 3)).toMatchObject({ viewport: { viewVersion: 3 } });
    expect(canvas.width).toBe(800);
    expect(drawImage).toHaveBeenCalledTimes(2);

    viewport.setView(4, 'other-tab');
    expect(clearRect).toHaveBeenCalledOnce();
  });

  it('keeps the old bitmap and the negotiated codec until a same-view raster change is drawn', async () => {
    const { canvas, viewport, image, configure, drawImage, clearRect, decoded } = fixture();
    viewport.setHd(true);
    const receive = async (sequence: number) => {
      const [first, last] = chunks(sequence);
      await viewport.receive(first!);
      return { draw: viewport.receive(last!) };
    };
    image.displayWidth = 1920;
    image.displayHeight = 1080;
    const first = await receive(1);
    decoded();
    expect(await first.draw).toMatchObject({ viewport: { raster: { width: 1920, height: 1080 } } });
    clearRect.mockClear();

    const down = await receive(2);
    expect([canvas.width, canvas.height]).toEqual([1920, 1080]);
    expect(drawImage).toHaveBeenCalledOnce();
    expect(clearRect).not.toHaveBeenCalled();
    image.displayWidth = 1280;
    image.displayHeight = 720;
    decoded();
    expect(await down.draw).toEqual({
      sequence: 2,
      viewport: { viewVersion: 1, width: 1280, height: 800, raster: { width: 1280, height: 720 } }
    });
    expect([canvas.width, canvas.height]).toEqual([1280, 720]);
    expect(drawImage).toHaveBeenCalledTimes(2);
    expect(configure).toHaveBeenCalledExactlyOnceWith({
      codec: BROWSER_VIDEO_HD_CODEC,
      optimizeForLatency: true
    });
  });

  it('releases a late decoded frame after closing and returns no credit to the old connection', async () => {
    const { viewport, image, drawImage, clearRect, decoded } = fixture();
    const [first, last] = chunks();
    await viewport.receive(first!);
    const draw = viewport.receive(last!);
    clearRect.mockClear();
    viewport.close();
    decoded();
    expect(await draw).toBeUndefined();
    expect(drawImage).not.toHaveBeenCalled();
    expect(clearRect).toHaveBeenCalledOnce();
    expect(image.close).toHaveBeenCalledOnce();
  });

  it('requires a key access unit before accepting frames for a new view', async () => {
    const { viewport } = fixture();
    const [first, last] = chunks(1, 1, false);
    expect(await viewport.receive(first!)).toBeUndefined();
    await expect(viewport.receive(last!)).rejects.toThrow('Expected a key frame.');
  });
});
