import { afterEach, expect, it, vi } from 'vitest';
import { createRemoteDesktopStatistics } from '../../src/service/remote-desktop-statistics.js';

afterEach(() => vi.useRealTimers());

it('samples painted updates and actual channel bytes, idles at zero, and stops with its attachment', () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  const frames = new EventTarget();
  let bytes = { receivedBytes: 20, sentBytes: 10 };
  let latency: number | undefined;
  const statistics = createRemoteDesktopStatistics({
    frames,
    channel: { getStatistics: () => bytes },
    path: 'relay',
    controlRoundTripMs: () => latency
  });
  expect(statistics.value.value).toMatchObject({ path: 'relay', controlRoundTripMs: undefined });
  frames.dispatchEvent(new Event('frame'));
  frames.dispatchEvent(new Event('frame'));
  bytes = { receivedBytes: 2068, sentBytes: 1034 };
  latency = 34;
  vi.advanceTimersByTime(1000);
  expect(statistics.value.value).toEqual({
    path: 'relay',
    framesPerSecond: 2,
    receivedBytesPerSecond: 2048,
    sentBytesPerSecond: 1024,
    controlRoundTripMs: 34
  });
  vi.advanceTimersByTime(1000);
  expect(statistics.value.value).toMatchObject({
    framesPerSecond: 0,
    receivedBytesPerSecond: 0,
    sentBytesPerSecond: 0
  });
  statistics.close();
  const final = statistics.value.value;
  frames.dispatchEvent(new Event('frame'));
  bytes = { receivedBytes: 9999, sentBytes: 9999 };
  vi.advanceTimersByTime(2000);
  expect(statistics.value.value).toBe(final);
  expect(vi.getTimerCount()).toBe(0);
});
