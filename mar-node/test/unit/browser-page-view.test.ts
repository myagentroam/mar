import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { BrowserPageView } from '../../src/browser/browser-page-view.js';

type Frame = {
  data: string;
  metadata: { deviceWidth: number; deviceHeight: number; timestamp?: number };
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
  it.each(['partial raster', 'stale pixels'] as const)(
    'recovers a static first frame without a viewport change (%s)',
    async (initial) => {
      const live = castSession();
      const sample = castSession();
      const viewport = { width: 657, height: 839 };
      const render = { width: 656, height: 838 };
      const full = pngHeader(render.width, render.height);
      const cropped =
        initial === 'partial raster'
          ? pngHeader(328, 419)
          : Buffer.concat([full, Buffer.from([1])]);
      const create = vi.fn().mockResolvedValueOnce(live).mockResolvedValueOnce(sample);
      const setViewportSize = vi.fn();
      const view = new BrowserPageView({
        viewportSize: () => viewport,
        setViewportSize,
        context: () => ({ newCDPSession: create })
      } as unknown as Page);
      live.send.mockImplementationOnce(async () => {
        live.on.mock.calls[0]![1](frame(cropped, viewport.width, viewport.height));
      });
      sample.send.mockImplementationOnce(async () => {
        sample.on.mock.calls[0]![1](frame(full, viewport.width, viewport.height));
      });
      const offer = vi.fn();
      const capture = await view.startCapture(render, offer, () => 6);
      try {
        await vi.waitFor(() => expect(offer).toHaveBeenLastCalledWith({ png: full, ...viewport }));
        expect(offer.mock.calls).toEqual(
          initial === 'partial raster'
            ? [[{ png: full, ...viewport }]]
            : [[{ png: cropped, ...viewport }], [{ png: full, ...viewport }]]
        );
        expect(live.send).toHaveBeenCalledWith('Page.screencastFrameAck', { sessionId: 1 });
        expect(setViewportSize).not.toHaveBeenCalled();
      } finally {
        await capture.stop();
      }
    }
  );

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
    const create = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
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
    currentCallback(frame(pngHeader(768, 480), 1280, 800));
    expect(offer).toHaveBeenCalledOnce();
    expect(other).toHaveBeenCalledOnce();
    expect(second.detach).not.toHaveBeenCalled();
    pending.resolve();
    await stopping;
    await next.stop();
  });

  it.each(['static', 'static-hd', 'live', 'stopped', 'resized'] as const)(
    'samples bounded current pixels when the cast is missing a complete frame (%s)',
    async (state) => {
      const live = castSession();
      const sample = castSession();
      const viewport = { width: 549, height: 732 };
      const render =
        state === 'static-hd' ? { width: 822, height: 1096 } : { width: 550, height: 732 };
      const viewportSize = vi.fn(() => viewport);
      const create = vi.fn().mockResolvedValueOnce(live).mockResolvedValueOnce(sample);
      const view = new BrowserPageView({
        viewportSize,
        context: () => ({ newCDPSession: create })
      } as unknown as Page);
      const offer = vi.fn();
      vi.useFakeTimers();
      try {
        const capture = await view.startCapture(render, offer);
        const emit = live.on.mock.calls[0]![1];
        emit(frame(pngHeader(render.width, render.height), 639, 732));
        emit(frame(pngHeader(render.width, 550), 549, 732));
        emit(frame(pngHeader(render.width + 1, render.height), 549, 732));
        emit(frame(pngHeader(render.width, render.height + 1), 549, 732));
        expect(offer).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(250);
        expect(sample.send).toHaveBeenCalledExactlyOnceWith('Page.startScreencast', {
          format: 'png',
          maxWidth: render.width,
          maxHeight: render.height
        });
        const late = sample.on.mock.calls[0]![1];
        const full = frame(pngHeader(render.width, render.height), 549, 732);
        const native = pngHeader(render.width - 2, render.height - 2);
        if (state === 'live') emit(frame(native, 549, 732));
        if (state === 'stopped') await capture.stop();
        if (state === 'resized') viewportSize.mockReturnValue({ width: 700, height: 732 });
        late(full);
        await vi.advanceTimersByTimeAsync(state === 'live' ? 0 : 1_000);
        expect(sample.detach).toHaveBeenCalledOnce();
        expect(offer.mock.calls).toEqual(
          state === 'stopped' || state === 'resized'
            ? []
            : [[{ png: state === 'live' ? native : Buffer.from(full.data, 'base64'), ...viewport }]]
        );
        await capture.stop();
        expect(live.detach).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it('samples the final pixels once after a four-fps burst and rejects an older capture', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
    const live = castSession();
    const sample = castSession();
    const size = { width: 800, height: 450 };
    const png = pngHeader(size.width, size.height);
    const create = vi.fn().mockResolvedValueOnce(live).mockResolvedValueOnce(sample);
    const view = new BrowserPageView({
      viewportSize: () => size,
      context: () => ({ newCDPSession: create })
    } as unknown as Page);
    const offer = vi.fn();
    live.send.mockImplementationOnce(async () => {
      live.on.mock.calls[0]![1](frame(png, size.width, size.height));
    });
    sample.send.mockImplementationOnce(async () => {
      sample.on.mock.calls[0]![1](frame(png, size.width, size.height));
    });
    try {
      const capture = await view.startCapture(size, offer, () => 4);
      const deliver = (timestamp: number) => {
        const event = frame(png, size.width, size.height);
        live.on.mock.calls[0]![1]({ ...event, metadata: { ...event.metadata, timestamp } });
      };
      await vi.advanceTimersByTimeAsync(260);
      deliver(2);
      deliver(1);
      expect(offer).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(499);
      expect(sample.send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(offer).toHaveBeenCalledTimes(3);
      expect(sample.send).toHaveBeenCalledExactlyOnceWith('Page.startScreencast', {
        format: 'png',
        maxWidth: size.width,
        maxHeight: size.height
      });
      expect(sample.detach).toHaveBeenCalledOnce();
      await capture.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers a rejected update after a good idle frame without dragging the viewport', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
    const live = castSession();
    const sample = castSession();
    const size = { width: 657, height: 839 };
    const render = { width: 656, height: 838 };
    const create = vi
      .fn()
      .mockResolvedValueOnce(live)
      .mockResolvedValueOnce(castSession())
      .mockResolvedValueOnce(sample);
    const view = new BrowserPageView({
      viewportSize: () => size,
      context: () => ({ newCDPSession: create })
    } as unknown as Page);
    const offer = vi.fn();
    const full = frame(pngHeader(render.width, render.height), size.width, size.height);
    const partial = frame(pngHeader(328, 419), size.width, size.height);
    live.send.mockImplementationOnce(async () => {
      live.on.mock.calls[0]![1]({ ...full, metadata: { ...full.metadata, timestamp: 1 } });
    });
    sample.send.mockImplementationOnce(async () => {
      const deliver = sample.on.mock.calls[0]![1];
      deliver(partial);
      deliver({ ...full, metadata: { ...full.metadata, timestamp: 0.5 } });
      deliver({ ...full, metadata: { ...full.metadata, timestamp: 4 } });
    });
    try {
      const capture = await view.startCapture(render, offer, () => 4);
      await vi.advanceTimersByTimeAsync(1_550);
      expect(offer).toHaveBeenCalledOnce();
      const emit = live.on.mock.calls[0]![1];
      emit({ ...partial, metadata: { ...partial.metadata, timestamp: 3 } });
      await vi.advanceTimersByTimeAsync(250);
      expect(offer).toHaveBeenCalledTimes(2);
      emit({ ...full, metadata: { ...full.metadata, timestamp: 2 } });
      expect(offer).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_250);
      expect(create).toHaveBeenCalledTimes(3);
      await capture.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['timeout', 'failed'] as const)(
    'releases an unsuccessful sample and does not block viewport changes (%s)',
    async (outcome) => {
      const live = castSession();
      const sample = castSession();
      const blocked = Promise.withResolvers<never>();
      sample.send.mockImplementationOnce(() => blocked.promise);
      const viewport = { width: 800, height: 450 };
      const setViewportSize = vi.fn(async (_size: typeof viewport) => {});
      const create = vi.fn().mockResolvedValueOnce(live).mockResolvedValueOnce(sample);
      const view = new BrowserPageView({
        viewportSize: () => viewport,
        setViewportSize,
        context: () => ({ newCDPSession: create })
      } as unknown as Page);
      vi.useFakeTimers();
      try {
        const offer = vi.fn();
        const capture = await view.startCapture(viewport, offer);
        await vi.advanceTimersByTimeAsync(250);
        expect(sample.send).toHaveBeenCalledWith('Page.startScreencast', expect.anything());
        const next = { width: 1000, height: 700 };
        await view.resize(next);
        expect(setViewportSize).toHaveBeenCalledExactlyOnceWith(next);
        expect(sample.detach).not.toHaveBeenCalled();
        if (outcome === 'failed') blocked.reject(new Error('sample failed'));
        await vi.advanceTimersByTimeAsync(outcome === 'timeout' ? 1_000 : 0);
        expect(sample.detach).toHaveBeenCalledOnce();
        expect(live.detach).not.toHaveBeenCalled();
        expect(offer).not.toHaveBeenCalled();
        await capture.stop();
        expect(live.detach).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    }
  );
});
