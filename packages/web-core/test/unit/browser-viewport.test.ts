import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeBrowserFrame } from '@myagentroam/protocol';
import { BrowserViewport } from '../../src/service/browser-viewport.js';

const chunks = (sequence = 1, viewVersion = 1) => [
  ...encodeBrowserFrame({
    sequence,
    viewVersion,
    width: 1280,
    height: 800,
    key: true,
    data: new Uint8Array(17 * 1024)
  })
];

function fixture() {
  const drawImage = vi.fn();
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
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage, clearRect: vi.fn() }) };
  const viewport = new BrowserViewport(canvas as unknown as HTMLCanvasElement);
  const image = { displayWidth: 960, displayHeight: 600, close: vi.fn() };
  viewport.setView(1);
  return {
    canvas,
    viewport,
    image,
    drawImage,
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
    viewport.setView(2);
    decoded();
    expect(await draw).toEqual({ sequence: 1 });
    expect(drawImage).not.toHaveBeenCalled();
    expect(image.close).toHaveBeenCalledOnce();
  });

  it('releases a late decoded frame after closing and returns no credit to the old connection', async () => {
    const { viewport, image, drawImage, decoded } = fixture();
    const [first, last] = chunks();
    await viewport.receive(first!);
    const draw = viewport.receive(last!);
    viewport.close();
    decoded();
    expect(await draw).toBeUndefined();
    expect(drawImage).not.toHaveBeenCalled();
    expect(image.close).toHaveBeenCalledOnce();
  });

  it('requires a key access unit before accepting frames for a new view', async () => {
    const { viewport } = fixture();
    const [delta] = [
      ...encodeBrowserFrame({
        sequence: 1,
        viewVersion: 1,
        width: 1280,
        height: 800,
        key: false,
        data: new Uint8Array(20)
      })
    ];
    await expect(viewport.receive(delta!)).rejects.toThrow('Expected a key frame.');
  });
});
