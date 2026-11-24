import { afterEach, expect, it, vi } from 'vitest';
import { BrowserCacheMaintenance } from '../../src/browser/browser-cache-maintenance.js';
import { createBrowserResourceOperation } from '../../src/browser/browser-resource-operations.js';

const DAY = 24 * 60 * 60_000;
afterEach(() => vi.useRealTimers());

it('uses the default for legacy connections, advances only after a successful clear and then follows the new interval', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(DAY);
  const clear = vi.fn(async () => undefined).mockRejectedValueOnce(new Error('unavailable'));
  const failed = vi.fn();
  const record = vi.fn(async () => undefined);
  const cache = new BrowserCacheMaintenance({ lastCleanupAt: 0, record, clear, failed });
  expect(cache.sync()).toEqual({ revision: 0, cacheCleanupDays: 30 });
  expect(clear).not.toHaveBeenCalled();
  const settings = { revision: 2, cacheCleanupDays: 1 };
  expect(cache.sync(settings)).toEqual(settings);
  expect(cache.sync({ revision: 1, cacheCleanupDays: 60 })).toEqual(settings);
  await vi.advanceTimersByTimeAsync(0);
  expect(clear).toHaveBeenCalledOnce();
  expect(failed).toHaveBeenCalledOnce();
  expect(record).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  expect(record).toHaveBeenCalledWith(Date.now());
  await vi.advanceTimersByTimeAsync(DAY - 1);
  expect(clear).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(clear).toHaveBeenCalledTimes(3);
  await cache.close();
  await vi.advanceTimersByTimeAsync(DAY);
  expect(clear).toHaveBeenCalledTimes(3);
});

it('applies only a trusted connection snapshot to the scoped browser and acknowledges manual sync', async () => {
  const settings = { revision: 4, cacheCleanupDays: 21 };
  const scope = { workspaceId: 'workspace', userId: 7 };
  const fixture = {
    open: vi.fn(async () => 'browser'),
    lookup: vi.fn(() => 'browser' as string | undefined),
    close: vi.fn(),
    syncSettings: vi.fn(async () => settings)
  };
  const requireWorkspace = vi.fn();
  const request = createBrowserResourceOperation(fixture, requireWorkspace);
  const owner = { workspaceId: scope.workspaceId, __requestUserId: scope.userId };
  await expect(
    request({ ...owner, command: { action: 'open', preserveLogin: true } })
  ).resolves.toEqual({ browserId: 'browser' });
  expect(fixture.syncSettings).toHaveBeenLastCalledWith(scope, 'browser', undefined);
  await expect(
    request({ ...owner, command: { action: 'open', preserveLogin: true }, settings })
  ).resolves.toEqual({ browserId: 'browser' });
  expect(fixture.syncSettings).toHaveBeenLastCalledWith(scope, 'browser', settings);
  await expect(
    request({ ...owner, command: { action: 'sync-settings' }, settings })
  ).resolves.toEqual({ settings });
  expect(requireWorkspace).toHaveBeenLastCalledWith(scope.workspaceId);
  await expect(
    request({ ...owner, command: { action: 'sync-settings', settings } })
  ).rejects.toThrow('BROWSER_RESOURCE_INVALID');
  fixture.lookup.mockReturnValueOnce(undefined);
  await expect(
    request({ ...owner, command: { action: 'sync-settings' }, settings })
  ).rejects.toThrow('BROWSER_SESSION_ENDED');
});
