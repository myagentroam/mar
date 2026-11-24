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

function pngHeader(width: number, height: number): Buffer {
  const png = Buffer.from('89504e470d0a1a0a0000000d494844520000000000000000', 'hex');
  png.writeUInt32BE(height, 20);
  png.writeUInt32BE(width, 16);
  return png;
}

describe('Browser page view', () => {
  it('rebinds screencast to the active page after a navigation replaces its target', async () => {
    const old = castSession();
    const current = castSession();
    old.send.mockRejectedValueOnce(
      new Error('Protocol error (Page.startScreencast): Not attached to an active page')
    );
    const create = vi.fn().mockResolvedValueOnce(old).mockResolvedValueOnce(current);
    const view = new BrowserPageView({
      viewportSize: () => null,
      isClosed: () => false,
      context: () => ({ newCDPSession: create })
    } as unknown as Page);
    const offer = vi.fn();
    const capture = await view.startCapture({ width: 800, height: 450 }, offer);
    expect(old.detach).toHaveBeenCalledOnce();
    expect(current.send).toHaveBeenCalledWith(
      'Page.startScreencast',
      expect.objectContaining({ format: 'png' })
    );
    const png = pngHeader(800, 450);
    current.on.mock.calls[0]![1](frame(png, 800, 450));
    expect(offer).toHaveBeenCalledOnce();
    await capture.stop();
    expect(current.detach).toHaveBeenCalledOnce();
  });
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
    const create = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(castSession())
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(castSession());
    const view = new BrowserPageView({
      isClosed: () => false,
      viewportSize: () => ({ width: 1280, height: 800 }),
      context: () => ({ newCDPSession: create })
    } as unknown as Page);
    const offer = vi.fn();
    const other = vi.fn();
    const size = { width: 640, height: 480 };
    const capture = await view.startCapture(size, offer);
    const next = await view.startCapture({ ...size, width: 800 }, other);
    const oldCallback = first.on.mock.calls[0]![1];
    const currentCallback = second.on.mock.calls[0]![1];
    const png = pngHeader(640, 400);
    oldCallback(frame(png, 960, 600));
    expect(offer).not.toHaveBeenCalled();
    oldCallback(frame(png, 1280, 800));
    expect(offer).toHaveBeenCalledExactlyOnceWith({ png, width: 1280, height: 800 });
    expect(first.send).toHaveBeenCalledWith('Page.screencastFrameAck', { sessionId: 1 });
    const stopping = capture.stop();
    oldCallback(frame(png, 1280, 800));
    currentCallback(frame(png, 1280, 800));
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
      const seedSession = castSession();
      seedSession.send.mockImplementation(async (method) => {
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
      const create = vi.fn().mockResolvedValueOnce(session).mockResolvedValueOnce(seedSession);
      const view = new BrowserPageView({
        isClosed: () => false,
        viewportSize,
        context: () => ({ newCDPSession: create })
      } as unknown as Page);
      const offer = vi.fn();
      const hd = state === 'static-hd';
      const render = hd ? { width: 822, height: 1096 } : { width: 550, height: 732 };
      const capture = await view.startCapture({ ...render }, offer);
      await vi.waitFor(() => {
        expect(seedSession.send).toHaveBeenCalledWith('Page.captureScreenshot', {
          format: 'png',
          clip: { x: 5, y: 30, width: 549, height: 732, scale: hd ? 1096 / 1464 : 0.5 }
        });
      });
      const emit = session.on.mock.calls[0]![1];
      const native = pngHeader(275, 366);
      emit(frame(native, 639, 732));
      emit(frame(pngHeader(550, 550), 549, 732));
      emit(frame(pngHeader(1098, 1464), 549, 732));
      emit(frame(pngHeader(render.width + 1, render.height), 549, 732));
      emit(frame(pngHeader(render.width, render.height + 1), 549, 732));
      if (state === 'live') emit(frame(native, 549, 732));
      const stopping = state === 'stopped' ? capture.stop() : undefined;
      if (stopping) {
        await stopping;
        expect(seedSession.detach).not.toHaveBeenCalled();
      }
      if (state === 'resized') viewportSize.mockReturnValue({ width: 700, height: 732 });
      const seed = hd ? pngHeader(822, 1096) : pngHeader(549, 732);
      screenshot.resolve({ data: seed.toString('base64') });
      await vi.waitFor(() => expect(seedSession.detach).toHaveBeenCalledOnce());
      expect(offer.mock.calls).toEqual(
        state === 'stopped' || state === 'resized'
          ? []
          : [[{ png: state === 'live' ? native : seed, width: 549, height: 732 }]]
      );
      await capture.stop();
      expect(session.detach).toHaveBeenCalledOnce();
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
    const png = pngHeader(800, 450);
    first.send.mockImplementation(async (method) => {
      if (method === 'Page.getLayoutMetrics') return metrics;
      if (method === 'Page.captureScreenshot') return blocked.promise;
    });
    second.send.mockImplementation(async (method) => {
      if (method === 'Page.getLayoutMetrics') return metrics;
      if (method === 'Page.captureScreenshot') return { data: png.toString('base64') };
    });
    const cast = castSession();
    const create = vi.fn(async () => cast);
    create.mockResolvedValueOnce(cast).mockResolvedValueOnce(first);
    const view = new BrowserPageView({
      viewportSize: () => ({ width: 800, height: 450 }),
      context: () => ({ newCDPSession: create })
    } as unknown as Page);
    const offer = vi.fn();
    const render = { width: 800, height: 450 };
    const a = await view.startCapture(render, vi.fn());
    await vi.waitFor(() =>
      expect(first.send).toHaveBeenCalledWith('Page.captureScreenshot', expect.anything())
    );
    create.mockResolvedValueOnce(castSession()).mockResolvedValueOnce(second);
    const b = await view.startCapture(render, offer);
    expect(second.send).not.toHaveBeenCalledWith('Page.getLayoutMetrics');
    blocked.reject(new Error('screenshot failed'));
    await vi.waitFor(() =>
      expect(offer).toHaveBeenCalledExactlyOnceWith({ png, width: 800, height: 450 })
    );
    await a.stop();
    await b.stop();
  });

  it('samples the final pixels once after a four-fps burst and rejects an older capture', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
    const session = castSession();
    const seed = castSession();
    const size = { width: 800, height: 450 };
    const png = pngHeader(size.width, size.height);
    seed.send.mockImplementation(async (method) => {
      if (method === 'Page.getLayoutMetrics')
        return {
          visualViewport: { pageX: 0, pageY: 0, scale: 1 },
          contentSize: size,
          cssContentSize: size
        };
      if (method === 'Page.captureScreenshot') return { data: png.toString('base64') };
    });
    const create = vi.fn().mockResolvedValueOnce(session).mockResolvedValueOnce(seed);
    const view = new BrowserPageView({
      viewportSize: () => size,
      context: () => ({ newCDPSession: create })
    } as unknown as Page);
    const offer = vi.fn();
    session.send.mockImplementationOnce(async () => {
      session.on.mock.calls[0]![1](frame(png, size.width, size.height));
    });
    try {
      const capture = await view.startCapture(size, offer, () => 4);
      const deliver = (timestamp: number) => {
        const event = frame(png, size.width, size.height);
        session.on.mock.calls[0]![1]({
          ...event,
          metadata: { ...event.metadata, timestamp }
        } as Frame);
      };
      await vi.advanceTimersByTimeAsync(260);
      deliver(2);
      deliver(1);
      expect(offer).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(499);
      expect(seed.send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(offer).toHaveBeenCalledTimes(3);
      expect(
        seed.send.mock.calls.filter(([method]) => method === 'Page.captureScreenshot')
      ).toHaveLength(1);
      await capture.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resizes only after Chromium can restore the static clip viewport', async () => {
    const seed = castSession();
    const old = { width: 800, height: 450 };
    const next = { width: 1000, height: 700 };
    let actualViewport = old;
    const screenshot = Promise.withResolvers<void>();
    seed.send.mockImplementation(async (method) => {
      if (method === 'Page.getLayoutMetrics') {
        return {
          visualViewport: { pageX: 0, pageY: 0, scale: 1 },
          contentSize: { width: 1600 },
          cssContentSize: { width: 800 }
        };
      }
      if (method === 'Page.captureScreenshot') {
        await screenshot.promise;
        actualViewport = old;
        return { data: pngHeader(800, 450).toString('base64') };
      }
    });
    const create = vi.fn().mockResolvedValueOnce(castSession()).mockResolvedValueOnce(seed);
    const view = new BrowserPageView({
      viewportSize: () => actualViewport,
      setViewportSize: async (size: typeof old) => {
        actualViewport = size;
      },
      isClosed: () => false,
      context: () => ({ newCDPSession: create })
    } as unknown as Page);
    const capture = await view.startCapture({ ...old }, vi.fn());
    await vi.waitFor(() =>
      expect(seed.send).toHaveBeenCalledWith('Page.captureScreenshot', expect.anything())
    );
    const resized = view.resize(next);
    await Promise.resolve();
    screenshot.resolve();
    await resized;
    await capture.stop();
    expect(actualViewport).toEqual(next);
  });

  it('does not hold a screencast or resize indefinitely when the static clip never answers', async () => {
    const live = castSession();
    const seed = castSession();
    const screenshot = Promise.withResolvers<{ data: string }>();
    seed.send.mockImplementation(async (method) => {
      if (method === 'Page.getLayoutMetrics') {
        return {
          visualViewport: { pageX: 0, pageY: 0, scale: 1 },
          contentSize: { width: 1600 },
          cssContentSize: { width: 800 }
        };
      }
      if (method === 'Page.captureScreenshot') return screenshot.promise;
    });
    const viewport = { width: 800, height: 450 };
    const setViewportSize = vi.fn(async (_size: typeof viewport) => {});
    const create = vi.fn().mockResolvedValueOnce(live).mockResolvedValueOnce(seed);
    const view = new BrowserPageView({
      viewportSize: () => viewport,
      setViewportSize,
      isClosed: () => false,
      context: () => ({ newCDPSession: create })
    } as unknown as Page);
    vi.useFakeTimers();
    try {
      const offer = vi.fn();
      const capture = await view.startCapture({ ...viewport }, offer);
      await vi.advanceTimersByTimeAsync(0);
      expect(seed.send).toHaveBeenCalledWith('Page.captureScreenshot', expect.anything());
      const next = { width: 1000, height: 700 };
      const resized = view.resize(next);
      await capture.stop();
      expect(live.detach).toHaveBeenCalledOnce();
      expect(seed.detach).not.toHaveBeenCalled();
      expect(setViewportSize).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      await resized;
      expect(seed.detach).toHaveBeenCalledOnce();
      expect(setViewportSize.mock.calls).toEqual([[viewport], [next]]);
      screenshot.resolve({ data: pngHeader(800, 450).toString('base64') });
      await vi.advanceTimersByTimeAsync(0);
      expect(offer).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
