import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWatchLeaseLifecycleService } from '../../src/service/WatchLeaseLifecycleService.js';

describe('Shared Watch lease lifecycle', () => {
  afterEach(() => vi.useRealTimers());
  it('starts renewal after the initial request succeeds and stops renewing after stop', async () => {
    vi.useFakeTimers();
    const renew = vi.fn(async () => undefined);
    const state = createWatchLeaseLifecycleService({
      heartbeatMs: 15_000,
      requestTimeoutMs: 10_000,
      confirmationTimeoutMs: 45_000,
      maxFailures: 3,
      eligible: () => true,
      renew,
      onExpired: vi.fn()
    });

    state.start('session-1');
    await Promise.resolve();
    await Promise.resolve();
    expect(renew).toHaveBeenCalledTimes(1);
    state.stop();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(renew).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('ignores a late initial result from a restarted Watch without overlapping renewals', async () => {
    vi.useFakeTimers();
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const first = new Promise<void>((resolve) => (finishFirst = resolve));
    const second = new Promise<void>((resolve) => (finishSecond = resolve));
    const renew = vi
      .fn()
      .mockImplementationOnce(async () => first)
      .mockImplementationOnce(async () => second)
      .mockResolvedValue(undefined);
    const state = createWatchLeaseLifecycleService({
      heartbeatMs: 100,
      requestTimeoutMs: 10_000,
      confirmationTimeoutMs: 45_000,
      maxFailures: 3,
      eligible: () => true,
      renew,
      onExpired: vi.fn()
    });

    state.start('session-1');
    await Promise.resolve();
    state.stop();
    state.start('session-1');
    await Promise.resolve();
    expect(renew).toHaveBeenCalledTimes(2);

    finishFirst();
    await first;
    await vi.advanceTimersByTimeAsync(500);
    expect(renew).toHaveBeenCalledTimes(2);

    finishSecond();
    await second;
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(renew).toHaveBeenCalledTimes(3);
    state.stop();
    vi.useRealTimers();
  });

  it('stays stopped after initial timeout and waits for a user reload instead of renewing', async () => {
    vi.useFakeTimers();
    const renew = vi.fn(async () => {
      throw new Error('timeout');
    });
    const state = createWatchLeaseLifecycleService({
      heartbeatMs: 15_000,
      requestTimeoutMs: 10_000,
      confirmationTimeoutMs: 45_000,
      maxFailures: 3,
      eligible: () => true,
      renew,
      onExpired: vi.fn()
    });

    const initial = state.start('session-1');
    await expect(initial).rejects.toThrow('timeout');
    await vi.advanceTimersByTimeAsync(60_000);

    expect(renew).toHaveBeenCalledTimes(1);
    expect(renew).toHaveBeenCalledWith('session-1', expect.any(AbortSignal), 'initial');
    state.stop();
    vi.useRealTimers();
  });

  it('pauses the heartbeat when the page connection closes and sends no renewal before recovery', async () => {
    vi.useFakeTimers();
    let finishInitial!: () => void;
    const initial = new Promise<void>((resolve) => (finishInitial = resolve));
    const renew = vi.fn(async () => initial);
    const state = createWatchLeaseLifecycleService({
      heartbeatMs: 15_000,
      requestTimeoutMs: 10_000,
      confirmationTimeoutMs: 45_000,
      maxFailures: 3,
      eligible: () => true,
      renew,
      onExpired: vi.fn()
    });
    state.start('session-1');
    await Promise.resolve();
    state.pause();
    finishInitial();
    await initial;
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(renew).toHaveBeenCalledOnce();
    state.stop();
    vi.useRealTimers();
  });

  it('requests an authoritative refresh after consecutive renewal failures reach the threshold', async () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    const state = createWatchLeaseLifecycleService({
      heartbeatMs: 15_000,
      requestTimeoutMs: 10_000,
      confirmationTimeoutMs: 45_000,
      maxFailures: 3,
      eligible: () => true,
      renew: async (_sessionId, _signal, mode) => {
        if (mode === 'initial') return undefined;
        throw new Error('offline');
      },
      onExpired: expired
    });

    state.start('session-1');
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(expired).toHaveBeenCalledTimes(1);
    state.stop();
    vi.useRealTimers();
  });
});

describe('Watch cancellation reasons', () => {
  it.each(['timeout', 'stop'] as const)(
    'classifies %s without leaking a generic AbortError',
    async (mode) => {
      vi.useFakeTimers();
      let signal!: AbortSignal;
      const state = createWatchLeaseLifecycleService({
        heartbeatMs: 15_000,
        requestTimeoutMs: 10_000,
        confirmationTimeoutMs: 45_000,
        maxFailures: 3,
        eligible: () => true,
        onExpired: vi.fn(),
        renew: async (_target, currentSignal) => {
          signal = currentSignal;
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('Generic cancellation', 'AbortError')),
              { once: true }
            );
          });
        }
      });
      try {
        const result = state.start('session')!.then(
          () => undefined,
          (error: unknown) => error
        );
        if (mode === 'stop') state.stop();
        else await vi.advanceTimersByTimeAsync(10_000);
        expect(signal.reason).toMatchObject({
          code: mode === 'stop' ? 'WATCH_CANCELLED' : 'WATCH_REQUEST_TIMEOUT'
        });
        if (mode === 'stop') expect(await result).toBeUndefined();
        else expect(await result).toMatchObject({ code: 'WATCH_REQUEST_TIMEOUT' });
      } finally {
        state.stop();
        vi.useRealTimers();
      }
    }
  );
});
