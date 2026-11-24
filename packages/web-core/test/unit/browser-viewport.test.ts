import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeBrowserFrame } from '@myagentroam/protocol';
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
    drawImage,
    clearRect,
    decoded: () => output(image as unknown as VideoFrame)
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('Browser viewport', () => {
  it('draws the complete H.264 access unit but reports remote CSS coordinates', async () => {
    const { canvas, viewport, image, drawImage, decoded } = fixture();
    const [first, last] = chunks();
    expect(await viewport.receive(first!)).toBeUndefined();
    expect(drawImage).not.toHaveBeenCalled();
    const draw = viewport.receive(last!);
    decoded();
    expect(await draw).toEqual({
      sequence: 1,
      viewport: { viewVersion: 1, width: 1280, height: 800 }
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
