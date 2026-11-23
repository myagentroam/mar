import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { BrowserPageView } from '../../src/browser/browser-page-view.js';

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

  it('drops old callbacks after capture stops and serializes a replacement behind stop', async () => {
    type Handler = (frame: { data: Buffer; viewportWidth: number; viewportHeight: number }) => void;
    const start = vi.fn(async (_: { onFrame: Handler }) => {});
    const pending = Promise.withResolvers<void>();
    const stop = vi.fn(() => pending.promise);
    const view = new BrowserPageView({ screencast: { start, stop } } as unknown as Page);
    const offer = vi.fn();
    const size = { width: 640, height: 480, quality: 70 };
    const capture = await view.startCapture(size, offer);
    const oldCallback = start.mock.calls[0]![0].onFrame;
    const frame = { data: Buffer.from([42]), viewportWidth: 1280, viewportHeight: 800 };
    oldCallback(frame);
    expect(offer).toHaveBeenCalledExactlyOnceWith({ jpeg: frame.data, width: 1280, height: 800 });
    const stopping = capture.stop();
    await expect(view.startCapture(size, offer)).rejects.toThrow('BROWSER_CAPTURE_BUSY');
    oldCallback(frame);
    expect(offer).toHaveBeenCalledOnce();
    pending.resolve();
    await stopping;
    const next = await view.startCapture(size, offer);
    oldCallback(frame);
    expect(offer).toHaveBeenCalledOnce();
    await next.stop();
  });
});
