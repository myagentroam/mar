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
    expect(() => service.pin(one, a)).toThrow('BROWSER_ATTACHMENT_BUSY');
    expect(() => service.pin(two, a)).toThrow('BROWSER_SESSION_ENDED');
    first.release();
    expect(service.pin(one, a).resource).toBe(first.resource);
    expect(service.pin(two, b).resource).not.toBe(first.resource);
    await service.shutdown();
  });

  it('closes the process 15 minutes after the last release, not after the last input', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
    const close = vi.fn(async () => {});
    const service = new BrowserSessionService({
      launch: async () => ({ resource: {}, close }),
      limit: 1,
      onCloseFailed: vi.fn()
    });
    const id = await service.open(one);
    const { release } = service.pin(one, id);
    await vi.advanceTimersByTimeAsync(16 * 60_000);
    expect(service.lookup(one)).toBe(id);
    release();
    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1);
    expect(service.lookup(one)).toBe(id);
    await vi.advanceTimersByTimeAsync(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(service.lookup(one)).toBeUndefined();
    expect(() => service.pin(one, id)).toThrow('BROWSER_SESSION_ENDED');
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

  it('retains the browser after Web detaches until the agent releases its lease', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
    const close = vi.fn(async () => {});
    const service = new BrowserSessionService({
      launch: async () => ({ resource: {}, close }),
      limit: 1,
      idleMs: 1000,
      onCloseFailed: vi.fn()
    });
    try {
      const id = await service.open(one);
      const web = service.pin(one, id);
      const release = service.retain(one, id);
      web.release();
      await vi.advanceTimersByTimeAsync(2000);
      expect(service.lookup(one)).toBe(id);
      await expect(service.open(two)).rejects.toThrow('BROWSER_CAPACITY');
      release();
      await vi.advanceTimersByTimeAsync(999);
      release();
      expect(close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(close).toHaveBeenCalledOnce();
      expect(service.lookup(one)).toBeUndefined();
    } finally {
      await service.shutdown();
    }
  });

  it('can retry closing after an Agent revocation failure without losing released borrows', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
    const failure = Promise.withResolvers<void>();
    const close = vi.fn(async () => {}).mockReturnValueOnce(failure.promise);
    const service = new BrowserSessionService({
      launch: async () => ({ resource: {}, close }),
      limit: 1,
      idleMs: 1000,
      onCloseFailed: vi.fn()
    });
    const id = await service.open(one);
    const web = service.pin(one, id);
    const agent = service.retain(one, id);
    const pending = service.close(one, id);
    const duplicate = service.close(one, id);
    web.release();
    const failed = Promise.all([
      expect(pending).rejects.toThrow('BROWSER_USE_REVOKE_FAILED'),
      expect(duplicate).rejects.toThrow('BROWSER_USE_REVOKE_FAILED')
    ]);
    failure.reject(new Error('BROWSER_USE_REVOKE_FAILED'));
    await failed;
    expect(close).toHaveBeenCalledOnce();
    expect(service.lookup(one)).toBe(id);
    await expect(service.open(two)).rejects.toThrow('BROWSER_CAPACITY');
    agent();
    await vi.advanceTimersByTimeAsync(1000);
    expect(close).toHaveBeenCalledTimes(2);
    expect(service.lookup(one)).toBeUndefined();
    await expect(service.open(two)).resolves.not.toBe(id);
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
