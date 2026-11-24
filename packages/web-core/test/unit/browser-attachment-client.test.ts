import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserAttachmentClient } from '../../src/service/browser-attachment-client.js';

const { receive, setHd } = vi.hoisted(() => ({ receive: vi.fn(), setHd: vi.fn() }));
vi.mock('../../src/service/browser-viewport.js', () => ({
  BrowserViewport: class {
    receive = receive;
    setHd = setHd;
    setView() {}
    close() {}
  }
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([
  { offered: true, accepted: true },
  { offered: true, accepted: false },
  { offered: false, accepted: true }
])('honors the negotiated decoder profile: %o', ({ offered, accepted }) => {
  setHd.mockClear();
  const link = Object.assign(new EventTarget(), {
    readyState: 'open',
    send: vi.fn(),
    close: vi.fn()
  });
  const attached = vi.fn();
  const failed = vi.fn();
  const client = new BrowserAttachmentClient(
    link as unknown as RTCDataChannel,
    {} as HTMLCanvasElement,
    {
      type: 'OPEN',
      attachmentId: randomUUID(),
      ticket: 'x'.repeat(32),
      ...(offered && { hd: true })
    },
    { attached, failed, snapshot: vi.fn(), frame: vi.fn(), sample: vi.fn(), ended: vi.fn() }
  );
  link.dispatchEvent(
    new MessageEvent('message', {
      data: JSON.stringify({ type: 'ATTACHED', ...(accepted && { hd: true }) })
    })
  );
  if (accepted && !offered) {
    expect(setHd).not.toHaveBeenCalled();
    expect(attached).not.toHaveBeenCalled();
  } else {
    expect(setHd).toHaveBeenCalledWith(accepted);
    expect(attached).toHaveBeenCalledOnce();
  }
  client.close();
});

it('measures received bytes and drawn frames separately, then stops sampling when detached', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  const link = Object.assign(new EventTarget(), {
    readyState: 'open',
    bufferedAmount: 0,
    send: vi.fn(),
    close: vi.fn()
  });
  const sample = vi.fn();
  const frame = vi.fn();
  const client = new BrowserAttachmentClient(
    link as unknown as RTCDataChannel,
    {} as HTMLCanvasElement,
    { type: 'OPEN', attachmentId: randomUUID(), ticket: 'x'.repeat(32) },
    { sample, frame, snapshot: vi.fn(), failed: vi.fn(), ended: vi.fn() }
  );
  const message = (data: string | ArrayBuffer) =>
    link.dispatchEvent(new MessageEvent('message', { data }));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(sample).not.toHaveBeenCalled();
  message(JSON.stringify({ type: 'ATTACHED' }));
  message(
    JSON.stringify({
      type: 'snapshot',
      snapshot: { viewVersion: 1, tabs: [] }
    })
  );
  const drawn = { viewVersion: 1, width: 960, height: 600, raster: { width: 768, height: 480 } };
  receive
    .mockResolvedValueOnce({ sequence: 1 })
    .mockResolvedValueOnce({ sequence: 2, viewport: drawn });
  message(new ArrayBuffer(400));
  message(new ArrayBuffer(600));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(frame).toHaveBeenCalledOnce();
  expect(frame).toHaveBeenCalledWith(drawn);
  expect(sample).toHaveBeenLastCalledWith({ bitsPerSecond: 8_000, framesPerSecond: 1 });
  const press = {
    type: 'input',
    action: { type: 'key', viewVersion: 1, edge: 'down', key: 'Enter' }
  } as const;
  expect(client.send(press)).toBe(true);
  message(JSON.stringify({ type: 'snapshot', snapshot: { viewVersion: 2, tabs: [] } }));
  expect(client.send(press)).toBe(false);
  const nextPress = { ...press, action: { ...press.action, viewVersion: 2 } };
  expect(client.send(nextPress)).toBe(false);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(sample).toHaveBeenLastCalledWith({ bitsPerSecond: 0, framesPerSecond: 0 });
  receive.mockResolvedValueOnce({
    sequence: 3,
    viewport: { ...drawn, viewVersion: 2 }
  });
  message(new ArrayBuffer(200));
  await vi.advanceTimersByTimeAsync(0);
  expect(client.send(nextPress)).toBe(true);
  client.close();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(sample).toHaveBeenCalledTimes(2);
});

it('sends the content size before the first frame or navigation and debounces resize bursts', async () => {
  vi.useFakeTimers();
  const disconnect = vi.fn();
  let resized!: () => void;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe() {}
      disconnect = disconnect;
    }
  );
  const link = Object.assign(new EventTarget(), {
    readyState: 'open',
    bufferedAmount: 0,
    send: vi.fn(),
    close: vi.fn()
  });
  const canvas = { clientWidth: 0, clientHeight: 0 };
  const body = { clientWidth: 510, clientHeight: 880 };
  const open = { type: 'OPEN' as const, attachmentId: randomUUID(), ticket: 'x'.repeat(32) };
  const client = new BrowserAttachmentClient(
    link as unknown as RTCDataChannel,
    canvas as HTMLCanvasElement,
    open,
    {
      viewportElement: body as HTMLElement,
      sample: vi.fn(),
      frame: vi.fn(),
      snapshot: vi.fn(),
      failed: vi.fn(),
      ended: vi.fn()
    }
  );
  link.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'ATTACHED' }) }));
  expect(link.send.mock.calls.map(([data]) => JSON.parse(data))).toEqual([
    open,
    { type: 'viewport.resize', width: 510, height: 880 }
  ]);
  Object.assign(body, { clientWidth: 520 });
  const navigate = { type: 'navigate', viewVersion: 1, address: 'https://example.test/' } as const;
  expect(client.send(navigate)).toBe(true);
  expect(link.send.mock.calls.slice(-2).map(([data]) => JSON.parse(data))).toEqual([
    { type: 'viewport.resize', width: 520, height: 880 },
    navigate
  ]);
  Object.assign(body, { clientWidth: 321, clientHeight: 601 });
  resized();
  await vi.advanceTimersByTimeAsync(60);
  Object.assign(body, { clientWidth: 701, clientHeight: 401 });
  resized();
  await vi.advanceTimersByTimeAsync(120);
  expect(link.send).toHaveBeenCalledTimes(5);
  expect(JSON.parse(link.send.mock.lastCall![0])).toEqual({
    type: 'viewport.resize',
    width: 701,
    height: 401
  });
  Object.assign(body, { clientWidth: 0, clientHeight: 0 });
  resized();
  await vi.advanceTimersByTimeAsync(120);
  expect(link.send).toHaveBeenCalledTimes(5);
  Object.assign(body, { clientWidth: 601, clientHeight: 401 });
  resized();
  client.close();
  await vi.advanceTimersByTimeAsync(120);
  expect(disconnect).toHaveBeenCalledOnce();
  expect(link.send).toHaveBeenCalledTimes(5);
});
