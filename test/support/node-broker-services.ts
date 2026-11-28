import { ModelUsageGrants } from '../../packages/server-core/src/model-usage-grant.ts';

// The release consumer check removes Common sources (including protocol) to prove the
// installed packages stand alone. Browser settings are never exercised there, so this
// test collaborator must not create a module-level dependency on protocol sources.
const browserCacheCleanupDefaultDays = 30;

/** Explicit collaborators for transport tests that do not exercise account settings. */
export function testNodeBrokerServices() {
  return {
    usageGrants: new ModelUsageGrants(Buffer.from('isolated-test-usage-key')),
    gitForwarding: { prepare: async (_node: string, _operation: string, data: unknown) => data },
    browserSettings: async (_userId: number) => ({
      revision: 0,
      cacheCleanupDays: browserCacheCleanupDefaultDays
    })
  };
}
