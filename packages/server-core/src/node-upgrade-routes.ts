import type { FastifyInstance, FastifyReply } from 'fastify';
import { isAllowedOrigin } from './auth.js';
import { protectedAdmin, validCsrf, type SessionLookup } from './session.js';
import { sendError } from './http-errors.js';
import { publicNode } from './node-projection.js';
import { requestUserNode } from './workspace-http-support.js';
import type { SessionRunNodeControl } from './session-run-contracts.js';
import type { NodeUpgradeService } from './node-upgrade-service.js';
export function registerNodeUpgradeRoutes(input: {
  app: FastifyInstance;
  database: SessionLookup;
  nodeControl: Pick<SessionRunNodeControl, 'requestNode'> & {
    isNodeUpgradeOnly(nodeId: string): boolean;
    listNodes():
      | readonly Parameters<typeof publicNode>[0][]
      | Promise<readonly Parameters<typeof publicNode>[0][]>;
  };
  nodeUpgrades: Pick<NodeUpgradeService, 'availability'>;
  publicOrigin: string | undefined;
  authorize(userId: number, nodeId: string): Promise<void>;
  databaseError(reply: FastifyReply, error: unknown): FastifyReply;
}): void {
  const { app, database, nodeControl, nodeUpgrades, publicOrigin, authorize, databaseError } =
    input;
  for (const action of ['upgrade', 'upgrade/cancel'] as const) {
    app.post<{ Params: { nodeId: string } }>(
      `/api/nodes/:nodeId/${action}`,
      async (request, reply) => {
        if (!isAllowedOrigin(request, publicOrigin))
          return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
        const admin = protectedAdmin(database, request, reply);
        if (admin === undefined) return;
        if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
        try {
          await authorize(admin.userId, request.params.nodeId);
          const node = (await nodeControl.listNodes()).find(
            (item) => item.id === request.params.nodeId
          );
          if (node === undefined) return sendError(reply, 404, 'NODE_NOT_FOUND');
          if (!node.connected || node.disabled) return sendError(reply, 409, 'NODE_OFFLINE');
          if (action === 'upgrade/cancel')
            return reply.send(
              await requestUserNode(nodeControl, admin, node.id, 'node.upgrade.cancel', {})
            );
          const projection = publicNode(node) as {
            readonly nodeAppVersion: string;
            readonly metadata?: { readonly supervisedUpgrade?: boolean };
          };
          const availability = await nodeUpgrades.availability(
            projection.nodeAppVersion,
            projection.metadata?.supervisedUpgrade === true,
            nodeControl.isNodeUpgradeOnly(node.id)
          );
          if (availability.state !== 'AVAILABLE')
            return sendError(reply, 409, `NODE_UPGRADE_${availability.state}`);
          const result = await requestUserNode(
            nodeControl,
            admin,
            node.id,
            'node.upgrade.request',
            {
              targetVersion: availability.targetVersion
            }
          );
          return reply.code(202).send(result);
        } catch (error) {
          return databaseError(reply, error);
        }
      }
    );
  }
}
