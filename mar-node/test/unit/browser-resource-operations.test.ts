import { describe, expect, it, vi } from 'vitest';
import { createBrowserResourceOperation } from '../../src/browser/browser-resource-operations.js';

function fixture() {
  const settings = { revision: 2, cacheCleanupDays: 7 };
  const browser = {
    open: vi.fn(async () => 'browser-id'),
    lookup: vi.fn<() => string | undefined>(() => 'browser-id'),
    close: vi.fn(async () => {}),
    syncSettings: vi.fn(async () => settings)
  };
  const requireWorkspace = vi.fn();
  const operation = createBrowserResourceOperation(browser, requireWorkspace);
  const scope = { userId: 17, workspaceId: 'workspace-id' };
  const call = (command: unknown, fields?: object) =>
    operation({
      workspaceId: scope.workspaceId,
      __requestUserId: scope.userId,
      command,
      ...fields
    });
  return { browser, call, requireWorkspace, scope, settings };
}

describe('browser configuration on the Node resource channel', () => {
  it('applies the Server snapshot on open and accepts legacy open requests', async () => {
    const { browser, call, scope, settings, requireWorkspace } = fixture();
    await expect(call({ action: 'open', preserveLogin: true }, { settings })).resolves.toEqual({
      browserId: 'browser-id'
    });
    expect(requireWorkspace).toHaveBeenCalledWith(scope.workspaceId);
    expect(browser.open).toHaveBeenCalledWith(scope, true);
    expect(browser.syncSettings).toHaveBeenLastCalledWith(scope, 'browser-id', settings);
    await expect(call({ action: 'open', preserveLogin: false })).resolves.toEqual({
      browserId: 'browser-id'
    });
    expect(browser.syncSettings).toHaveBeenLastCalledWith(scope, 'browser-id', undefined);
  });

  it('acknowledges sync on the authorized live resource only', async () => {
    const { browser, call, scope, settings } = fixture();
    await expect(call({ action: 'sync-settings' }, { settings })).resolves.toEqual({ settings });
    expect(browser.lookup).toHaveBeenCalledWith(scope);
    expect(browser.syncSettings).toHaveBeenCalledWith(scope, 'browser-id', settings);
    expect(browser.open).not.toHaveBeenCalled();
    browser.lookup.mockReturnValue(undefined);
    await expect(call({ action: 'sync-settings' }, { settings })).rejects.toThrow(
      'BROWSER_SESSION_ENDED'
    );
  });

  it('rejects malformed snapshots and settings supplied inside the user command', async () => {
    const { browser, call, settings } = fixture();
    await expect(
      call(
        { action: 'open', preserveLogin: true },
        { settings: { ...settings, cacheCleanupDays: 0 } }
      )
    ).rejects.toThrow('BROWSER_RESOURCE_INVALID');
    await expect(call({ action: 'sync-settings', settings })).rejects.toThrow(
      'BROWSER_RESOURCE_INVALID'
    );
    expect(browser.open).not.toHaveBeenCalled();
    expect(browser.syncSettings).not.toHaveBeenCalled();
  });
});
