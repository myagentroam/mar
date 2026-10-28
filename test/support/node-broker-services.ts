import { ModelUsageGrants } from '../../packages/server-core/src/model-usage-grant.ts';

/** Explicit narrow collaborators for transport tests that do not exercise Git settings. */
export function testNodeBrokerServices() {
  return {
    usageGrants: new ModelUsageGrants(Buffer.from('isolated-test-usage-key')),
    gitForwarding: { prepare: async (_node: string, _operation: string, data: unknown) => data }
  };
}
