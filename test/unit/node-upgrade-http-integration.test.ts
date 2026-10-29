import Fastify from '../../ee/server/node_modules/fastify/fastify.js';
import { describe, expect, it, vi } from 'vitest';
import { NodeUpgradeReporter } from '../../mar-node/src/service/node-upgrade-reporter.js';
import {
  NodeUpgradeProgress,
  type StoredNodeUpgrade
} from '../../packages/server-core/src/node-upgrade-progress.js';
import { registerNodeUpgradeRoutes } from '../../packages/server-core/src/node-upgrade-routes.js';

describe('upgrade report over loopback HTTP', () => {
  it('reports install and requires the matching authenticated connection before success', async () => {
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
          const change = update(record);
          record = change.next;
          return change.result;
        }
      },
      Date.now,
      async () => true
    );
    const attempt = await progress.begin('node', '1.2.3', { userId: 1, sessionHash: 'session' });
    const token = await progress.issueReportCredential('node', attempt.attemptId);
    const app = Fastify();
    registerNodeUpgradeRoutes({
      app,
      progress,
      database: {} as never,
      nodeControl: {} as never,
      nodeUpgrades: {} as never,
      publicOrigin: undefined,
      authorize: async () => {},
      databaseError: (reply) => reply.code(500).send()
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const reporter = new NodeUpgradeReporter(app.listeningOrigin, 'node', token);
    try {
      reporter.update({
        attemptId: attempt.attemptId,
        step: 'WAITING_FOR_ONLINE',
        result: 'INSTALLED'
      });
      await vi.waitFor(async () => expect((await progress.snapshot('node'))?.installed).toBe(true));
      expect((await progress.snapshot('node'))?.state).toBe('UPGRADING');
      await progress.confirmConnection('node', attempt.attemptId, '1.2.2');
      expect((await progress.snapshot('node'))?.state).toBe('UPGRADING');
      await progress.confirmConnection('node', attempt.attemptId, '1.2.3');
      expect((await progress.snapshot('node'))?.state).toBe('SUCCEEDED');
    } finally {
      reporter.stop();
      await app.close();
    }
  });
});
