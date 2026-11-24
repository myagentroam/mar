import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserAttachmentClient } from '../../src/service/browser-attachment-client.js';

const receive = vi.hoisted(() => vi.fn());
vi.mock('../../src/service/browser-viewport.js', () => ({
  BrowserViewport: class {
    receive = receive;
    setView() {}
    close() {}
  }
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
  receive
    .mockResolvedValueOnce({ sequence: 1 })
    .mockResolvedValueOnce({ sequence: 2, viewport: { viewVersion: 1, width: 960, height: 600 } });
  message(new ArrayBuffer(400));
  message(new ArrayBuffer(600));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(frame).toHaveBeenCalledOnce();
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
    viewport: { viewVersion: 2, width: 960, height: 600 }
  });
  message(new ArrayBuffer(200));
  await vi.advanceTimersByTimeAsync(0);
  expect(client.send(nextPress)).toBe(true);
  client.close();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(sample).toHaveBeenCalledTimes(2);
});

it('sends the latest visible viewport after a resize burst, and cancels on detach', async () => {
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
  const open = { type: 'OPEN' as const, attachmentId: randomUUID(), ticket: 'x'.repeat(32) };
  const client = new BrowserAttachmentClient(
    link as unknown as RTCDataChannel,
    canvas as HTMLCanvasElement,
    open,
    {
      resizeViewport: true,
      sample: vi.fn(),
      frame: vi.fn(),
      snapshot: vi.fn(),
      failed: vi.fn(),
      ended: vi.fn()
    }
  );
  link.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'ATTACHED' }) }));
  resized();
  await vi.advanceTimersByTimeAsync(120);
  expect(link.send).toHaveBeenCalledTimes(1);
  Object.assign(canvas, { clientWidth: 321, clientHeight: 601 });
  resized();
  await vi.advanceTimersByTimeAsync(60);
  Object.assign(canvas, { clientWidth: 701, clientHeight: 401 });
  resized();
  await vi.advanceTimersByTimeAsync(120);
  expect(link.send.mock.calls.map(([data]) => JSON.parse(data))).toEqual([
    open,
    { type: 'viewport.resize', width: 701, height: 401 }
  ]);
  Object.assign(canvas, { clientWidth: 601 });
  resized();
  client.close();
  await vi.advanceTimersByTimeAsync(120);
  expect(disconnect).toHaveBeenCalledOnce();
  expect(link.send).toHaveBeenCalledTimes(2);
});
