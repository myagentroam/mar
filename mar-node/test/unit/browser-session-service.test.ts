import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserSessionService } from '../../src/browser/browser-session-service.js';

const one = { workspaceId: 'workspace-one', userId: 1 };
const two = { workspaceId: 'workspace-two', userId: 1 };

afterEach(() => vi.useRealTimers());

describe('Node Browser live session cache', () => {
  it('coalesces same-scope launches without sharing across workspaces or users', async () => {
    const launch = vi.fn(async () => ({ resource: {}, close: vi.fn(async () => {}) }));
    const service = new BrowserSessionService({ launch, limit: 3, onCloseFailed: vi.fn() });
    expect(service.lookup(one)).toBeUndefined();
    const [a, aAgain, b, c] = await Promise.all([
      service.open(one),
      service.open(one),
      service.open(two),
      service.open({ ...one, userId: 2 })
    ]);
    expect(launch).toHaveBeenCalledTimes(3);
    expect(aAgain).toBe(a);
    expect(new Set([a, b, c]).size).toBe(3);
    expect(service.lookup(one)).toBe(a);
    const first = service.pin(one, a);
    const second = service.pin(one, a);
    expect(second.resource).toBe(first.resource);
    second.release();
    expect(() => service.pin(two, a)).toThrow('BROWSER_SESSION_ENDED');
    first.release();
    expect(service.pin(one, a).resource).toBe(first.resource);
    expect(service.pin(two, b).resource).not.toBe(first.resource);
    await service.shutdown();
  });

  it('uses the latest operation, not concurrent connections or release, for its idle deadline', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
    const close = vi.fn(async () => {});
    const service = new BrowserSessionService({
      launch: async () => ({ resource: {}, close }),
      limit: 1,
      onCloseFailed: vi.fn()
    });
    const id = await service.open(one);
    const web = service.pin(one, id);
    const other = service.pin(one, id);
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(web.activity()).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    other.release();
    expect(service.touch(one, id)).toBe(true); // Playwright, even without the panel.
    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1);
    expect(service.lookup(one)).toBe(id);
    await vi.advanceTimersByTimeAsync(1);
    expect(close).toHaveBeenCalledOnce();
    expect(web.activity()).toBe(false);
    expect(service.touch(two, id)).toBe(false);
    expect(service.lookup(one)).toBeUndefined();
    web.release();
    await service.shutdown();
  });

  it('does not take a live attachment or reuse capacity until the evicted process exits', async () => {
    const exit = Promise.withResolvers<void>();
    const firstClose = vi.fn(() => exit.promise);
    const launch = vi
      .fn(async () => ({ resource: {}, close: async () => {} }))
      .mockResolvedValueOnce({ resource: {}, close: firstClose });
    const service = new BrowserSessionService({ launch, limit: 1, onCloseFailed: vi.fn() });
    const id = await service.open(one);
    const { release } = service.pin(one, id);
    await expect(service.open(two)).rejects.toThrow('BROWSER_CAPACITY');
    release();
    const next = service.open(two);
    await vi.waitFor(() => expect(firstClose).toHaveBeenCalledOnce());
    expect(launch).toHaveBeenCalledOnce();
    exit.resolve();
    expect(await next).not.toBe(id);
    expect(launch).toHaveBeenCalledTimes(2);
    await service.shutdown();
  });

  it('does not publish a launch that completes during shutdown', async () => {
    const pending = Promise.withResolvers<{ resource: object; close(): Promise<void> }>();
    const close = vi.fn(async () => {});
    const launch = vi.fn(() => pending.promise);
    const service = new BrowserSessionService({ launch, limit: 1, onCloseFailed: vi.fn() });
    const opening = service.open(one);
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
    const shuttingDown = service.shutdown();
    pending.resolve({ resource: {}, close });
    await expect(opening).rejects.toThrow('BROWSER_SESSION_ENDED');
    await shuttingDown;
    expect(close).toHaveBeenCalledOnce();
  });

  it('waits for other processes to exit before reporting a shutdown failure', async () => {
    const exit = Promise.withResolvers<void>();
    const failure = new Error('Browser process did not exit');
    const close = vi.fn(() => exit.promise);
    const service = new BrowserSessionService({
      launch: async ({ workspaceId }) => ({
        resource: {},
        close:
          workspaceId === one.workspaceId
            ? async () => {
                throw failure;
              }
            : close
      }),
      limit: 2,
      onCloseFailed: vi.fn()
    });
    await Promise.all([service.open(one), service.open(two)]);
    const reported = vi.fn();
    const shutdown = service.shutdown().catch(reported);
    try {
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(reported).not.toHaveBeenCalled();
    } finally {
      exit.resolve();
      await shutdown;
    }
    expect(reported).toHaveBeenCalledExactlyOnceWith(failure);
  });
});
