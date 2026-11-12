import { describe, expect, it, vi } from 'vitest';
import { createQuickStartNodeBootstrap } from '../../ee/server/src/composition/quick-start-node-bootstrap.js';

describe('Quick Start local Node bootstrap', () => {
  it.each([true, false])(
    'checks pending registration without issuing blindly (recoverable=%s)',
    async (recoverable) => {
      const createNodeRegistrationToken = vi.fn();
      const recoverPersonalNodeRegistrationToken = vi.fn(async () =>
        recoverable ? { token: 'recovered', expiresAt: 100 } : undefined
      );
      const bootstrap = createQuickStartNodeBootstrap({
        isLocalAdmin: async () => true,
        assertOwnershipSelection: async () => {},
        createNodeRegistrationToken,
        recoverPersonalNodeRegistrationToken,
        isNodeConnected: () => false
      });
      if (recoverable)
        await expect(bootstrap.issue('previous')).resolves.toEqual({
          token: 'recovered',
          expiresAt: 100
        });
      else
        await expect(bootstrap.issue('previous')).rejects.toThrow(
          'QUICK_START_NODE_BOOTSTRAP_RECOVERY_REQUIRED'
        );
      expect(recoverPersonalNodeRegistrationToken).toHaveBeenCalledExactlyOnceWith(
        'previous',
        1,
        600_000
      );
      expect(createNodeRegistrationToken).not.toHaveBeenCalled();
      await expect(bootstrap.issue('previous')).rejects.toThrow(
        'QUICK_START_NODE_BOOTSTRAP_ALREADY_USED'
      );
    }
  );

  it('issues at most one registration token for the authorized fixed local administrator', async () => {
    const isLocalAdmin = vi.fn(async () => true);
    const assertOwnershipSelection = vi.fn(async () => {});
    const createNodeRegistrationToken = vi.fn(async () => ({ token: 'one-time', expiresAt: 50 }));
    const isNodeConnected = vi.fn(() => true);
    const bootstrap = createQuickStartNodeBootstrap({
      isLocalAdmin,
      assertOwnershipSelection,
      createNodeRegistrationToken,
      recoverPersonalNodeRegistrationToken: vi.fn(),
      isNodeConnected
    });
    await expect(bootstrap.issue()).resolves.toEqual({ token: 'one-time', expiresAt: 50 });
    expect(isLocalAdmin).toHaveBeenCalledWith(1);
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
      isLocalAdmin: async () => false,
      assertOwnershipSelection: async () => {},
      createNodeRegistrationToken,
      recoverPersonalNodeRegistrationToken: vi.fn(),
      isNodeConnected: () => false
    });
    await expect(bootstrap.issue()).rejects.toThrow('QUICK_START_NODE_ADMIN_UNAVAILABLE');
    expect(createNodeRegistrationToken).not.toHaveBeenCalled();
  });
});
