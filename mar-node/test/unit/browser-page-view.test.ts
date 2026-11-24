import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { BrowserPageView } from '../../src/browser/browser-page-view.js';

type Frame = {
  data: string;
  metadata: { deviceWidth: number; deviceHeight: number };
  sessionId: number;
};

function castSession() {
  return {
    on: vi.fn((_name: string, _receive: (frame: Frame) => void) => {}),
    off: vi.fn(),
    send: vi.fn(async (_method: string, _params?: object) => {}),
    detach: vi.fn(async () => {})
  };
}

function frame(data: Buffer, deviceWidth: number, deviceHeight: number): Frame {
  return { data: data.toString('base64'), metadata: { deviceWidth, deviceHeight }, sessionId: 1 };
}

function jpegHeader(width: number, height: number): Buffer {
  const jpeg = Buffer.from('ffd8ffc00008080000000003', 'hex');
  jpeg.writeUInt16BE(height, 7);
  jpeg.writeUInt16BE(width, 9);
  return jpeg;
}

describe('Browser page view', () => {
  it('dispatches HTTP navigation only and does not wait for the full page load', async () => {
    const goto = vi.fn(async () => null);
    const view = new BrowserPageView({ goto } as unknown as Page);
    await expect(view.navigate('file:///tmp/example')).rejects.toThrow('BROWSER_INVALID_ADDRESS');
    await expect(view.navigate('https://user:pass@example.com/')).rejects.toThrow(
      'BROWSER_INVALID_ADDRESS'
    );
    await view.navigate('https://example.com');
    expect(goto).toHaveBeenCalledExactlyOnceWith('https://example.com/', { waitUntil: 'commit' });
  });

  it('keeps two capture subscriptions independent when the first stops', async () => {
    const pending = Promise.withResolvers<void>();
    const first = castSession();
    const second = castSession();
    first.detach.mockReturnValueOnce(pending.promise);
    const create = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const view = new BrowserPageView({
      isClosed: () => false,
      viewportSize: () => ({ width: 1280, height: 800 }),
      screenshot: () => new Promise(() => {}),
      context: () => ({ newCDPSession: create })
    } as unknown as Page);
    const offer = vi.fn();
    const other = vi.fn();
    const size = { width: 640, height: 480, quality: 70 };
    const capture = await view.startCapture(size, offer);
    const next = await view.startCapture({ ...size, width: 800 }, other);
    const oldCallback = first.on.mock.calls[0]![1];
    const currentCallback = second.on.mock.calls[0]![1];
    const jpeg = jpegHeader(640, 400);
    oldCallback(frame(jpeg, 960, 600));
    expect(offer).not.toHaveBeenCalled();
    oldCallback(frame(jpeg, 1280, 800));
    expect(offer).toHaveBeenCalledExactlyOnceWith({ jpeg, width: 1280, height: 800 });
    expect(first.send).toHaveBeenCalledWith('Page.screencastFrameAck', { sessionId: 1 });
    const stopping = capture.stop();
    oldCallback(frame(jpeg, 1280, 800));
    currentCallback(frame(jpeg, 1280, 800));
    expect(offer).toHaveBeenCalledOnce();
    expect(other).toHaveBeenCalledOnce();
    expect(second.detach).not.toHaveBeenCalled();
    pending.resolve();
    await stopping;
    await next.stop();
  });

  it.each(['static', 'static-hd', 'live', 'stopped'] as const)(
    'seeds a new capture only when the current screencast has not painted (%s)',
    async (state) => {
      const screenshot = Promise.withResolvers<Buffer>();
      const takeScreenshot = vi.fn(() => screenshot.promise);
      const session = castSession();
      const view = new BrowserPageView({
        isClosed: () => false,
        viewportSize: () => ({ width: 549, height: 732 }),
        screenshot: takeScreenshot,
        context: () => ({ newCDPSession: async () => session })
      } as unknown as Page);
      const offer = vi.fn();
      const hd = state === 'static-hd';
      const capture = await view.startCapture({ width: 550, height: 732, quality: 70, hd }, offer);
      expect(takeScreenshot).toHaveBeenCalledExactlyOnceWith({
        type: 'jpeg',
        quality: 70,
        scale: hd ? 'device' : 'css',
        timeout: 3000
      });
      const emit = session.on.mock.calls[0]![1];
      const native = jpegHeader(275, 366);
      emit(frame(native, 639, 732));
      emit(frame(jpegHeader(550, 550), 549, 732));
      if (state === 'live') emit(frame(native, 549, 732));
      if (state === 'stopped') await capture.stop();
      const seed = hd ? jpegHeader(1098, 1464) : jpegHeader(549, 732);
      screenshot.resolve(seed);
      await screenshot.promise;
      expect(offer.mock.calls).toEqual(
        state === 'stopped'
          ? []
          : [[{ jpeg: state === 'live' ? native : seed, width: 549, height: 732 }]]
      );
      await capture.stop();
    }
  );
});
