import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { NodeRequestError } from '../../src/node-request-error.js';
import { hashOpaque } from '../../src/session-token.js';
import { registerNodeUpgradeRoutes } from '../../src/node-upgrade-routes.js';
import {
  NodeUpgradeProgress,
  type NodeUpgradeProgressStore,
  type StoredNodeUpgrade
} from '../../src/node-upgrade-progress.js';

describe('Node upgrade reporting endpoint', () => {
  it.each(['rejected', 'timeout'] as const)(
    'records a definite %s without treating an uncertain request as rejected',
    async (outcome) => {
      let record: StoredNodeUpgrade | null = null;
      const store: NodeUpgradeProgressStore = {
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
      };
      const progress = new NodeUpgradeProgress(
        store,
        () => 100,
        async () => true
      );
      const failure =
        outcome === 'rejected'
          ? new NodeRequestError(
              { error: 'NODE_UPGRADE_REQUEST_INVALID', message: 'Rejected.' },
              'request',
              'node'
            )
          : new NodeRequestError(
              { error: 'NODE_REQUEST_TIMEOUT', message: 'Timed out.' },
              'request',
              'transport'
            );
      const requestNode = vi.fn().mockRejectedValue(failure);
      const app = Fastify();
      registerNodeUpgradeRoutes({
        app,
        progress,
        database: {
          findCurrentUserSession: () => ({
            userId: 1,
            username: 'admin',
            isAdmin: true,
            sessionHash: 'hash',
            mustChangePassword: false,
            csrfTokenHash: hashOpaque('csrf')
          })
        },
        nodeControl: {
          listNodes: () => [
            {
              id: 'node',
              connected: true,
              disabled: false,
              metadata: JSON.stringify({ nodeAppVersion: '1.0.0', supervisedUpgrade: true })
            }
          ],
          isNodeUpgradeOnly: () => false,
          requestNode,
          upgradeCapabilities: () => ({ metadata: { upgradeProgress: { apiVersion: 1 } } })
        } as never,
        nodeUpgrades: {
          availability: async () => ({ state: 'AVAILABLE', targetVersion: '1.2.3' })
        },
        publicOrigin: undefined,
        authorize: async () => undefined,
        databaseError: (reply) => reply.code(409).send()
      });
      try {
        const input = {
          method: 'POST' as const,
          url: '/api/nodes/node/upgrade',
          headers: { cookie: 'mar_user_session=session', 'x-csrf-token': 'csrf' }
        };
        expect((await app.inject(input)).statusCode).toBe(409);
        const snapshot = await progress.snapshot('node');
        expect(snapshot?.state).toBe(outcome === 'rejected' ? 'FAILED' : 'WAITING_FOR_RUNS');
        expect(snapshot?.operationEnded).toBe(outcome === 'rejected' ? true : undefined);
        await app.inject(input);
        expect(requestNode).toHaveBeenCalledTimes(outcome === 'rejected' ? 2 : 1);
      } finally {
        await app.close();
      }
    }
  );
  it('accepts only the current scoped credential and validated, bounded reports', async () => {
    let record: StoredNodeUpgrade | null = null;
    const store: NodeUpgradeProgressStore = {
      async updateNodeUpgrade<T>(
        _nodeId: string,
        update: (current: StoredNodeUpgrade | null) => { next: StoredNodeUpgrade | null; result: T }
      ): Promise<T> {
        const change = update(record);
        record = change.next;
        return change.result;
      }
    };
    const progress = new NodeUpgradeProgress(
      store,
      () => 100,
      async () => true
    );
    const { attemptId } = await progress.begin('node', '1.2.3', {
      userId: 1,
      sessionHash: 'session-hash'
    });
    const token = await progress.issueReportCredential('node', attemptId);
    const app = Fastify();
    registerNodeUpgradeRoutes({
      app,
      progress,
      database: {} as never,
      nodeControl: {} as never,
      nodeUpgrades: {} as never,
      publicOrigin: undefined,
      authorize: async () => undefined,
      databaseError: (reply) => reply.code(500).send()
    });
    try {
      const url = '/api/nodes/node/upgrade/report';
      const payload = { attemptId, step: 'INSTALLING' };
      expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: { authorization: `Bearer ${token}` },
            payload: { ...payload, extra: true }
          })
        ).statusCode
      ).toBe(400);
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${token}` },
        payload
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ attemptId, state: 'UPGRADING', step: 'INSTALLING' });
      expect(response.body).not.toContain(token);
      expect(response.json()).not.toHaveProperty('reportCredentialHash');
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: { authorization: `Bearer ${'A'.repeat(43)}` },
            payload
          })
        ).statusCode
      ).toBe(401);
    } finally {
      await app.close();
    }
  });
});
