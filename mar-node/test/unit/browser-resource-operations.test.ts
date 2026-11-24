import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createBrowserResourceOperation } from '../../src/browser/browser-resource-operations.js';

function fixture() {
  const settings = { revision: 2, cacheCleanupDays: 7 };
  const browserId = randomUUID();
  const browser = {
    open: vi.fn(async () => browserId),
    lookup: vi.fn(() => browserId),
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
  return { browser, browserId, call, requireWorkspace, scope, settings };
}

describe('browser configuration on the Node resource channel', () => {
  it('applies the Server snapshot on open and accepts legacy open requests', async () => {
    const { browser, browserId, call, scope, settings, requireWorkspace } = fixture();
    await expect(call({ action: 'open', preserveLogin: true }, { settings })).resolves.toEqual({
      browserId
    });
    expect(requireWorkspace).toHaveBeenCalledWith(scope.workspaceId);
    expect(browser.open).toHaveBeenCalledWith(scope, true);
    expect(browser.syncSettings).toHaveBeenLastCalledWith(scope, browserId, settings);
    await expect(call({ action: 'open', preserveLogin: false })).resolves.toEqual({
      browserId
    });
    expect(browser.syncSettings).toHaveBeenLastCalledWith(scope, browserId, undefined);
  });

  it('does not apply settings on lookup or close', async () => {
    const { browser, browserId, call, scope } = fixture();
    await expect(call({ action: 'lookup' })).resolves.toEqual({ browserId });
    expect(browser.lookup).toHaveBeenCalledWith(scope);
    await expect(call({ action: 'close', browserId })).resolves.toEqual({});
    expect(browser.close).toHaveBeenCalledWith(scope, browserId);
    expect(browser.syncSettings).not.toHaveBeenCalled();
  });

  it('rejects malformed snapshots and settings supplied inside the user command', async () => {
    const { browser, call, settings } = fixture();
    await expect(
      call(
        { action: 'open', preserveLogin: true },
        { settings: { ...settings, cacheCleanupDays: 0 } }
      )
    ).rejects.toThrow('BROWSER_RESOURCE_INVALID');
    await expect(call({ action: 'open', preserveLogin: true, settings })).rejects.toThrow(
      'BROWSER_RESOURCE_INVALID'
    );
    expect(browser.open).not.toHaveBeenCalled();
    expect(browser.syncSettings).not.toHaveBeenCalled();
  });
});
