import { describe, expect, it } from 'vitest';
import {
  NodeUpgradeCoordinator,
  upgradeMetadata
} from '../../mar-node/src/service/node-upgrade-coordinator.js';
import { NodeControl } from '../../ee/server/src/node-control.js';
import {
  NodeUpgradeProgress,
  type StoredNodeUpgrade
} from '../../packages/server-core/src/node-upgrade-progress.js';

describe('cancelled upgrade reconciliation', () => {
  it('does not project ordinary idle state as an upgrade cancellation', () => {
    expect(upgradeMetadata({}, { state: 'IDLE', updatedAt: 1 }, true).upgrade).toBeUndefined();
  });
  it('clears only the matching waiting attempt when cancellation succeeds but its reply is lost', async () => {
    let record: StoredNodeUpgrade | null = null;
    const progress = new NodeUpgradeProgress(
      {
        async updateNodeUpgrade<T>(
          _id: string,
          update: (current: StoredNodeUpgrade | null) => {
            next: StoredNodeUpgrade | null;
            result: T;
          }
        ) {
          const result = update(record);
          record = result.next;
          return result.result;
        }
      },
      Date.now,
      async () => true
    );
    const attempt = await progress.begin('node', '1.2.3', { userId: 1, sessionHash: 'session' });
    const coordinator = new NodeUpgradeCoordinator(
      () => '/unused',
      () => 1,
      () => {},
      () => {},
      Date.now,
      async () => {}
    );
    coordinator.request({ targetVersion: '1.2.3', attemptId: attempt.attemptId });
    coordinator.cancel(); // The request's response is lost after this point.
    const handler = (
      NodeControl.prototype as unknown as {
        onNodeCapabilities(this: unknown, nodeId: string, capabilities: unknown): Promise<void>;
      }
    ).onNodeCapabilities;
    await handler.call({ consumers: { nodeUpgradeProgress: progress } }, 'node', {
      metadata: upgradeMetadata({}, coordinator.snapshot(), true)
    });
    expect(await progress.snapshot('node')).toBeNull();
    const next = await progress.begin('node', '1.2.3', { userId: 1, sessionHash: 'session' });
    await handler.call({ consumers: { nodeUpgradeProgress: progress } }, 'node', {
      metadata: upgradeMetadata({}, coordinator.snapshot(), true)
    });
    expect((await progress.snapshot('node'))?.attemptId).toBe(next.attemptId);
  });
});
