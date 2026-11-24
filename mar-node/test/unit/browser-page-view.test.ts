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
    send: vi.fn(async (_method: string, _params?: object): Promise<unknown> => undefined),
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

  it.each(['static', 'static-hd', 'live', 'stopped', 'resized'] as const)(
    'seeds a new capture only when the current screencast has not painted (%s)',
    async (state) => {
      const screenshot = Promise.withResolvers<{ data: string }>();
      const session = castSession();
      session.send.mockImplementation(async (method) => {
        if (method === 'Page.getLayoutMetrics') {
          return {
            visualViewport: { pageX: 5, pageY: 30, scale: 1 },
            contentSize: { width: 1098 },
            cssContentSize: { width: 549 }
          };
        }
        if (method === 'Page.captureScreenshot') return screenshot.promise;
      });
      const viewportSize = vi.fn(() => ({ width: 549, height: 732 }));
      const view = new BrowserPageView({
        isClosed: () => false,
        viewportSize,
        context: () => ({ newCDPSession: async () => session })
      } as unknown as Page);
      const offer = vi.fn();
      const hd = state === 'static-hd';
      const render = hd ? { width: 822, height: 1096 } : { width: 550, height: 732 };
      const capture = await view.startCapture({ ...render, quality: 70 }, offer);
      await vi.waitFor(() => {
        expect(session.send).toHaveBeenCalledWith('Page.captureScreenshot', {
          format: 'jpeg',
          quality: 70,
          clip: { x: 5, y: 30, width: 549, height: 732, scale: hd ? 1096 / 1464 : 0.5 }
        });
      });
      const emit = session.on.mock.calls[0]![1];
      const native = jpegHeader(275, 366);
      emit(frame(native, 639, 732));
      emit(frame(jpegHeader(550, 550), 549, 732));
      emit(frame(jpegHeader(1098, 1464), 549, 732));
      emit(frame(jpegHeader(render.width + 1, render.height), 549, 732));
      emit(frame(jpegHeader(render.width, render.height + 1), 549, 732));
      if (state === 'live') emit(frame(native, 549, 732));
      if (state === 'stopped') await capture.stop();
      if (state === 'resized') viewportSize.mockReturnValue({ width: 700, height: 732 });
      const seed = hd ? jpegHeader(822, 1096) : jpegHeader(549, 732);
      screenshot.resolve({ data: seed.toString('base64') });
      await screenshot.promise;
      await Promise.resolve();
      expect(offer.mock.calls).toEqual(
        state === 'stopped' || state === 'resized'
          ? []
          : [[{ jpeg: state === 'live' ? native : seed, width: 549, height: 732 }]]
      );
      await capture.stop();
    }
  );

  it('serializes the static clip across viewers and continues after the first fails', async () => {
    const first = castSession();
    const second = castSession();
    const blocked = Promise.withResolvers<never>();
    const metrics = {
      visualViewport: { pageX: 0, pageY: 0, scale: 1 },
      contentSize: { width: 1600 },
      cssContentSize: { width: 800 }
    };
    const jpeg = jpegHeader(800, 450);
    first.send.mockImplementation(async (method) => {
      if (method === 'Page.getLayoutMetrics') return metrics;
      if (method === 'Page.captureScreenshot') return blocked.promise;
    });
    second.send.mockImplementation(async (method) => {
      if (method === 'Page.getLayoutMetrics') return metrics;
      if (method === 'Page.captureScreenshot') return { data: jpeg.toString('base64') };
    });
    const create = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const view = new BrowserPageView({
      viewportSize: () => ({ width: 800, height: 450 }),
      context: () => ({ newCDPSession: create })
    } as unknown as Page);
    const offer = vi.fn();
    const render = { width: 800, height: 450, quality: 85 };
    const a = await view.startCapture(render, vi.fn());
    const b = await view.startCapture(render, offer);
    await vi.waitFor(() =>
      expect(first.send).toHaveBeenCalledWith('Page.captureScreenshot', expect.anything())
    );
    expect(second.send).not.toHaveBeenCalledWith('Page.getLayoutMetrics');
    blocked.reject(new Error('screenshot failed'));
    await vi.waitFor(() =>
      expect(offer).toHaveBeenCalledExactlyOnceWith({ jpeg, width: 800, height: 450 })
    );
    await a.stop();
    await b.stop();
  });
});
