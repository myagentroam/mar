import { ModelUsageGrants } from '../../packages/server-core/src/model-usage-grant.ts';
import { BROWSER_CACHE_CLEANUP_DEFAULT_DAYS } from '../../packages/protocol/src/browser-settings.ts';

/** Explicit collaborators for transport tests that do not exercise account settings. */
export function testNodeBrokerServices() {
  return {
    usageGrants: new ModelUsageGrants(Buffer.from('isolated-test-usage-key')),
    gitForwarding: { prepare: async (_node: string, _operation: string, data: unknown) => data },
    browserSettings: async (_userId: number) => ({
      revision: 0,
      cacheCleanupDays: BROWSER_CACHE_CLEANUP_DEFAULT_DAYS
    })
  };
}
