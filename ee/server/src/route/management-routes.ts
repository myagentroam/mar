import { registerConversationHostingRoutes } from '@myagentroam/server-core/conversation-hosting-routes';
import { registerComputerUseRoutes } from '@myagentroam/server-core/computer-use-routes';
import { definiteNodeRejection } from '@myagentroam/server-core/node-request-error';
import {
  ManagementQueryError,
  managementPageQuery
} from '@myagentroam/server-core/management-pagination';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import { isAllowedOrigin } from '@myagentroam/server-core/auth';
import { emitAudit } from '@myagentroam/server-core/audit';
import type { openServerDatabase } from '../database.js';
import type { MysqlServerDatabase } from '../mysql/server-database.js';
import type { NodeControl } from '../node-control.js';
import type { ResourceAccessService } from '../rbac/resource-access-service.js';
import type { ResourceManagementDirectory } from '../rbac/resource-management-directory.js';
import type { NodeUpgradeService } from '@myagentroam/server-core/node-upgrade-service';
import type { NodeUpgradeProgress } from '@myagentroam/server-core/node-upgrade-progress';
import type { ServerTrafficMetrics } from '../service/server-traffic-metrics.js';
import {
  databaseError,
  normalizedOptionalText,
  positiveId,
  protectedManagementAdmin,
  publicNode,
  requestUserNode,
  sendError,
  validCsrf
} from '../util/http-request.js';

export function filterManagementNodes<
  T extends {
    readonly ownerUserId: number;
    readonly connected: boolean;
    readonly disabled: boolean;
  }
>(nodes: readonly T[], ownerUserId?: number, status?: string): readonly T[] {
  return nodes.filter(
    (node) =>
      (ownerUserId === undefined || node.ownerUserId === ownerUserId) &&
      (status === undefined ||
        (status === 'online'
          ? node.connected && !node.disabled
          : status === 'offline'
            ? !node.connected && !node.disabled
            : node.disabled))
  );
}

export function registerManagementRoutes(input: {
  readonly app: FastifyInstance;
  readonly database: ReturnType<typeof openServerDatabase> | MysqlServerDatabase;
  readonly nodeControl: NodeControl;
  readonly nodeUpgrades: Pick<NodeUpgradeService, 'availability'>;
  readonly nodeUpgradeProgress?: NodeUpgradeProgress;
  readonly resources: Pick<ResourceAccessService, 'assertCanHostConversationTemplate'>;
  readonly directory: Pick<ResourceManagementDirectory, 'listManagedResourcePage'>;
  readonly users: {
    list(query: Record<string, unknown>): Promise<{
      readonly users: readonly {
        readonly id: number;
        readonly username: string;
        readonly email: string | null;
        readonly nickname: string | null;
        readonly isAdmin: boolean;
        readonly createdAt: number;
      }[];
      readonly page?: number;
      readonly pageSize?: number;
      readonly total?: number;
      readonly hasMore?: boolean;
    }>;
    deletionSummary(userId: number): Promise<
      | {
          readonly organizationId: number | null;
          readonly role: string | null;
          readonly sessions: number;
          readonly externalIdentities: number;
          readonly grants: number;
          readonly personalNodes: number;
          readonly personalWorkspaces: number;
        }
      | undefined
    >;
  };
  readonly traffic: ServerTrafficMetrics;
  readonly publicOrigin: string | undefined;
}): void {
  const {
    app,
    database,
    nodeControl,
    nodeUpgrades,
    resources,
    directory,
    users,
    traffic,
    publicOrigin
  } = input;
  app.get('/api/management/server-traffic', async (request, reply) => {
    if (protectedManagementAdmin(database, request, reply) === undefined) return;
    return reply.send(traffic.snapshot());
  });
  app.get<{ Querystring: Record<string, unknown> }>(
    '/api/management/users',
    async (request, reply) => {
      if (protectedManagementAdmin(database, request, reply) === undefined) return;
      try {
        return reply.send(await users.list(request.query));
      } catch (error) {
        if (error instanceof ManagementQueryError) return sendError(reply, 400, error.code);
        return databaseError(reply, error);
      }
    }
  );
  app.post<{ Body: { username?: unknown; email?: unknown; nickname?: unknown } }>(
    '/api/management/users',
    async (request, reply) => {
      if (!isAllowedOrigin(request, publicOrigin))
        return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
      const admin = protectedManagementAdmin(database, request, reply);
      if (admin === undefined) return;
      if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
      const body = request.body ?? {};
      const username = normalizedOptionalText(body.username, 80);
      const email = normalizedOptionalText(body.email, 254);
      const nickname = normalizedOptionalText(body.nickname, 80);
      if (
        typeof username !== 'string' ||
        (body.email !== undefined && email === undefined) ||
        (body.nickname !== undefined && nickname === undefined)
      )
        return sendError(reply, 400, 'USER_INPUT_INVALID');
      if (typeof email === 'string' && !email.includes('@'))
        return sendError(reply, 400, 'USER_EMAIL_INVALID');
      try {
        const temporaryPassword = randomBytes(18).toString('base64url');
        const userId = await database.createUser({
          username,
          email: email ?? null,
          nickname: nickname ?? null,
          password: temporaryPassword
        });
        emitAudit(database, {
          eventType: 'user_created_by_admin',
          actorUserId: admin.userId,
          targetType: 'USER',
          targetId: String(userId),
          targetName: username,
          organizationId: 1,
          metadata: JSON.stringify({ userId })
        });
        return reply.code(201).send({
          user: (await database.listUsers()).find((user) => user.id === userId),
          temporaryPassword
        });
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  app.post<{ Params: { userId: string } }>(
    '/api/management/users/:userId/reset-password',
    async (request, reply) => {
      if (!isAllowedOrigin(request, publicOrigin))
        return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
      const admin = protectedManagementAdmin(database, request, reply);
      if (admin === undefined) return;
      if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
      const userId = positiveId(request.params.userId);
      if (userId === undefined) return sendError(reply, 400, 'USER_ID_INVALID');
      const temporaryPassword = randomBytes(18).toString('base64url');
      try {
        await database.resetUserPassword(userId, temporaryPassword, admin.userId);
        nodeControl.closeUserSessions(userId);
        return reply.send({ temporaryPassword });
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  app.delete<{ Params: { userId: string } }>(
    '/api/management/users/:userId',
    async (request, reply) => {
      if (!isAllowedOrigin(request, publicOrigin))
        return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
      const admin = protectedManagementAdmin(database, request, reply);
      if (admin === undefined) return;
      if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
      const userId = positiveId(request.params.userId);
      if (userId === undefined) return sendError(reply, 400, 'USER_ID_INVALID');
      try {
        const nodeIds = await database.deleteUser(userId, admin.userId);
        if (nodeIds === undefined) return sendError(reply, 404, 'USER_NOT_FOUND');
        nodeControl.closeUserSessions(userId);
        for (const nodeId of nodeIds) nodeControl.closeManagedNode(nodeId);
        return reply.code(204).send();
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  app.get<{ Params: { userId: string } }>(
    '/api/management/users/:userId/deletion-summary',
    async (request, reply) => {
      if (protectedManagementAdmin(database, request, reply) === undefined) return;
      const userId = positiveId(request.params.userId);
      if (userId === undefined) return sendError(reply, 400, 'USER_ID_INVALID');
      const summary = await users.deletionSummary(userId);
      return summary === undefined
        ? sendError(reply, 404, 'USER_NOT_FOUND')
        : reply.send({ summary });
    }
  );
  app.get<{ Querystring: Record<string, unknown> & { ownerUserId?: string; status?: string } }>(
    '/api/management/nodes',
    async (request, reply) => {
      const admin = protectedManagementAdmin(database, request, reply);
      if (admin === undefined) return;
      try {
        if (managementPageQuery(request.query) !== undefined) {
          const overview = await directory.listManagedResourcePage(
            admin.userId,
            { ...request.query, resourceType: 'NODE', management: 'all' },
            nodeControl.connectedNodeIds()
          );
          return reply.send({
            ...overview,
            workspaces: undefined,
            nodes: await Promise.all(
              overview.nodes.map(async (node) => ({
                ...node,
                upgradeProgress: node.disabled
                  ? null
                  : ((await input.nodeUpgradeProgress?.snapshot(node.id)) ?? null),
                upgradeAvailability: await nodeUpgrades.availability(
                  node.nodeAppVersion,
                  node.metadata['supervisedUpgrade'] === true,
                  nodeControl.isNodeUpgradeOnly(node.id)
                )
              }))
            )
          });
        }
      } catch (error) {
        return databaseError(reply, error);
      }
      const ownerUserId =
        request.query.ownerUserId === undefined ? undefined : positiveId(request.query.ownerUserId);
      if (request.query.ownerUserId !== undefined && ownerUserId === undefined)
        return sendError(reply, 400, 'USER_ID_INVALID');
      const status = request.query.status;
      if (
        status !== undefined &&
        status !== 'online' &&
        status !== 'offline' &&
        status !== 'disabled'
      )
        return sendError(reply, 400, 'NODE_STATUS_INVALID');
      const users = new Map((await database.listUsers()).map((user) => [user.id, user.username]));
      const nodes = await Promise.all(
        filterManagementNodes(await nodeControl.listNodes(), ownerUserId, status).map(
          async (node) => {
            const projection = publicNode(node) as {
              readonly nodeAppVersion: string;
              readonly metadata?: { readonly supervisedUpgrade?: boolean };
            };
            return {
              ...projection,
              upgradeProgress: node.disabled
                ? null
                : ((await input.nodeUpgradeProgress?.snapshot(node.id)) ?? null),
              ownerUserId: node.ownerUserId,
              ownerUsername: users.get(node.ownerUserId) ?? null,
              upgradeAvailability: await nodeUpgrades.availability(
                projection.nodeAppVersion,
                projection.metadata?.supervisedUpgrade === true,
                nodeControl.isNodeUpgradeOnly(node.id)
              )
            };
          }
        )
      );
      return reply.send({ nodes });
    }
  );
  registerConversationHostingRoutes({
    app,
    database,
    nodeControl,
    publicOrigin,
    authorizeNode: async () => undefined,
    canEnableNode: async (_userId, nodeId) => {
      try {
        await resources.assertCanHostConversationTemplate(nodeId);
        return true;
      } catch {
        return false;
      }
    },
    enableDeniedCode: 'CONVERSATION_HOSTING_ENABLE_ORGANIZATION_NODE_REQUIRED'
  });
  registerComputerUseRoutes({
    app,
    database,
    nodeControl,
    publicOrigin,
    authorizeNode: async () => undefined
  });
  app.delete<{ Params: { nodeId: string } }>(
    '/api/management/nodes/:nodeId',
    async (request, reply) => {
      if (!isAllowedOrigin(request, publicOrigin))
        return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
      const admin = protectedManagementAdmin(database, request, reply);
      if (admin === undefined) return;
      if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
      return (await nodeControl.deleteNode(request.params.nodeId, admin.userId))
        ? reply.code(204).send()
        : sendError(reply, 404, 'NODE_NOT_FOUND');
    }
  );
  app.post<{ Params: { nodeId: string } }>(
    '/api/management/nodes/:nodeId/upgrade',
    async (request, reply) => {
      if (!isAllowedOrigin(request, publicOrigin))
        return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
      const admin = protectedManagementAdmin(database, request, reply);
      if (admin === undefined) return;
      if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
      try {
        const node = (await nodeControl.listNodes()).find(
          (candidate) => candidate.id === request.params.nodeId
        );
        if (node === undefined) return sendError(reply, 404, 'NODE_NOT_FOUND');
        if (!node.connected || node.disabled) return sendError(reply, 409, 'NODE_OFFLINE');
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
        const pending = await input.nodeUpgradeProgress?.snapshot(node.id);
        if (pending?.state === 'WAITING_FOR_RUNS' || pending?.state === 'UPGRADING') {
          if (pending.targetVersion !== availability.targetVersion)
            return sendError(reply, 409, 'NODE_UPGRADE_ALREADY_IN_PROGRESS');
          return reply.code(202).send({
            status: pending.requestAccepted ? 'ALREADY_PENDING' : 'PENDING_CONFIRMATION',
            targetVersion: pending.targetVersion,
            attemptId: pending.attemptId
          });
        }
        const supportsProgress =
          nodeControl.upgradeCapabilities(node.id)?.metadata?.upgradeProgress?.apiVersion === 1;
        const attempt = supportsProgress
          ? await input.nodeUpgradeProgress?.begin(node.id, availability.targetVersion, {
              userId: admin.userId,
              sessionHash: admin.sessionHash
            })
          : undefined;
        if (attempt?.existing)
          return reply.code(202).send({
            status: (await input.nodeUpgradeProgress!.snapshot(node.id))?.requestAccepted
              ? 'ALREADY_PENDING'
              : 'PENDING_CONFIRMATION',
            targetVersion: availability.targetVersion,
            attemptId: attempt.attemptId
          });
        let result: unknown;
        try {
          result = await requestUserNode(nodeControl, admin, node.id, 'node.upgrade.request', {
            targetVersion: availability.targetVersion,
            ...(attempt === undefined ? {} : { attemptId: attempt.attemptId })
          });
        } catch (error) {
          const code = definiteNodeRejection(error);
          if (attempt !== undefined && code !== undefined)
            await input.nodeUpgradeProgress!.failBeforeHandoff(node.id, attempt.attemptId, code);
          throw error;
        }
        if (attempt !== undefined)
          await input.nodeUpgradeProgress!.markAccepted(node.id, attempt.attemptId);
        return reply.code(202).send(result);
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
}
