import type { ResourceOwnership } from '@myagentroam/protocol';

/** In-process, single-use bootstrap for the local deployment; no HTTP surface is registered. */
export function createQuickStartNodeBootstrap(input: {
  readonly isPersonalAdmin: (userId: number) => Promise<boolean>;
  readonly assertOwnershipSelection: (
    userId: number,
    ownership: ResourceOwnership
  ) => Promise<void>;
  readonly createNodeRegistrationToken: (
    userId: number,
    ttlMs: number,
    ownership: ResourceOwnership,
    displayName: string
  ) => Promise<{ token: string; expiresAt: number }>;
  readonly recoverPersonalNodeRegistrationToken: (
    token: string,
    userId: number,
    ttlMs: number
  ) => Promise<{ token: string; expiresAt: number } | undefined>;
  readonly isNodeConnected: (nodeId: string) => boolean;
}) {
  let attempted = false;
  return {
    async issue(previousToken?: string) {
      if (attempted) throw new Error('QUICK_START_NODE_BOOTSTRAP_ALREADY_USED');
      attempted = true;
      const userId = 1;
      if (!(await input.isPersonalAdmin(userId)))
        throw new Error('QUICK_START_NODE_ADMIN_UNAVAILABLE');
      const ownership: ResourceOwnership = { ownerType: 'PERSONAL', ownerUserId: userId };
      await input.assertOwnershipSelection(userId, ownership);
      if (previousToken !== undefined) {
        const recovered = await input.recoverPersonalNodeRegistrationToken(
          previousToken,
          userId,
          600_000
        );
        if (!recovered)
          throw Object.assign(new Error('QUICK_START_NODE_BOOTSTRAP_RECOVERY_REQUIRED'), {
            code: 'QUICK_START_NODE_BOOTSTRAP_RECOVERY_REQUIRED'
          });
        return recovered;
      }
      return input.createNodeRegistrationToken(userId, 600_000, ownership, 'Local Node');
    },
    online: input.isNodeConnected
  };
}

export type QuickStartNodeBootstrap = ReturnType<typeof createQuickStartNodeBootstrap>;
