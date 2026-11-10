import { describe, expect, it, vi } from 'vitest';
import { createQuickStartNodeBootstrap } from '../../ee/server/src/composition/quick-start-node-bootstrap.js';

describe('Quick Start local Node bootstrap', () => {
  it('issues at most one registration token for the authorized fixed personal administrator', async () => {
    const isPersonalAdmin = vi.fn(async () => true);
    const assertOwnershipSelection = vi.fn(async () => {});
    const createNodeRegistrationToken = vi.fn(async () => ({ token: 'one-time', expiresAt: 50 }));
    const isNodeConnected = vi.fn(() => true);
    const bootstrap = createQuickStartNodeBootstrap({
      isPersonalAdmin,
      assertOwnershipSelection,
      createNodeRegistrationToken,
      isNodeConnected
    });
    await expect(bootstrap.issue()).resolves.toEqual({ token: 'one-time', expiresAt: 50 });
    expect(isPersonalAdmin).toHaveBeenCalledWith(1);
    expect(assertOwnershipSelection).toHaveBeenCalledWith(1, {
      ownerType: 'PERSONAL',
      ownerUserId: 1
    });
    expect(createNodeRegistrationToken).toHaveBeenCalledWith(
      1,
      600_000,
      { ownerType: 'PERSONAL', ownerUserId: 1 },
      'Local Node'
    );
    await expect(bootstrap.issue()).rejects.toThrow('QUICK_START_NODE_BOOTSTRAP_ALREADY_USED');
    expect(createNodeRegistrationToken).toHaveBeenCalledTimes(1);
    expect(bootstrap.online('node-id')).toBe(true);
  });

  it('does not issue a token when fixed administrator admission fails', async () => {
    const createNodeRegistrationToken = vi.fn();
    const bootstrap = createQuickStartNodeBootstrap({
      isPersonalAdmin: async () => false,
      assertOwnershipSelection: async () => {},
      createNodeRegistrationToken,
      isNodeConnected: () => false
    });
    await expect(bootstrap.issue()).rejects.toThrow('QUICK_START_NODE_ADMIN_UNAVAILABLE');
    expect(createNodeRegistrationToken).not.toHaveBeenCalled();
  });
});
