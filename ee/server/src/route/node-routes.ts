import { registerNodeUpgradeRoutes } from '@myagentroam/server-core/node-upgrade-routes';
import { registerRunnerRoutes } from '@myagentroam/server-core/runner-routes';
import { registerTerminalRoutes } from '@myagentroam/server-core/terminal-routes';
import type { FastifyInstance } from 'fastify';
import { resourceOwnershipSchema, type ServerWorkbenchCapabilities } from '@myagentroam/protocol';
import { isAllowedOrigin } from '@myagentroam/server-core/auth';
import type { openServerDatabase } from '../database.js';
import type { MysqlServerDatabase } from '../mysql/server-database.js';
import type { NodeControl } from '../node-control.js';
import type { EnvironmentSecretService } from '../service/environment-secret-service.js';
import type { MysqlEnvironmentSecretService } from '../mysql/environment-secret-service.js';
import type { ResourceAccessService } from '../rbac/resource-access-service.js';
import type { ResourceMutationService } from '../rbac/resource-mutation-service.js';
import type { MarctlUserCredentials } from '@myagentroam/server-core/marctl-user-credentials';
import type { NodeUpgradeService } from '@myagentroam/server-core/node-upgrade-service';
import type { NodeUpgradeProgress } from '@myagentroam/server-core/node-upgrade-progress';
import type { MarAgentModelService } from '../service/mar-agent-model-service.js';
import {
  databaseError,
  protectedAdmin,
  publicNode,
  requestUserNode,
  sendError,
  validCsrf
} from '../util/http-request.js';

export function registerNodeRoutes(input: {
  readonly app: FastifyInstance;
  readonly database: ReturnType<typeof openServerDatabase> | MysqlServerDatabase;
  readonly nodeControl: NodeControl;
  readonly nodeUpgrades: Pick<NodeUpgradeService, 'availability'>;
  readonly nodeUpgradeProgress?: NodeUpgradeProgress;
  readonly publicOrigin: string | undefined;
  readonly capabilities: ServerWorkbenchCapabilities;
  readonly secrets: EnvironmentSecretService | MysqlEnvironmentSecretService;
  readonly userCredentials?: MarctlUserCredentials;
  readonly resources: Pick<
    ResourceAccessService,
    | 'canAccessNodeContainer'
    | 'nodeOwnership'
    | 'canManageNode'
    | 'canRegisterWorkspace'
    | 'canManageNodeSecrets'
    | 'assertCanManageNode'
  >;
  readonly mutations: Pick<ResourceMutationService, 'changeNodeOwnership'>;
  readonly marAgentModels?: MarAgentModelService;
}): void {
  const {
    app,
    database,
    nodeControl,
    nodeUpgrades,
    nodeUpgradeProgress,
    secrets,
    publicOrigin,
    resources,
    mutations,
    marAgentModels
  } = input;
  app.get('/api/nodes', async (request, reply) => {
    const user = protectedAdmin(database, request, reply);
    if (user === undefined) return;
    const nodes = (await nodeControl.listNodes()).filter((node) => !node.disabled);
    const visibleNodes = (
      await Promise.all(
        nodes.map(async (node) =>
          (await resources.canAccessNodeContainer(user.userId, node.id)) ? node : undefined
        )
      )
    ).filter((node): node is NonNullable<typeof node> => node !== undefined);
    return reply.send({
      nodes: await Promise.all(
        visibleNodes.map(async (node) => {
          const projection = publicNode(node) as {
            readonly nodeAppVersion: string;
            readonly metadata?: { readonly supervisedUpgrade?: boolean };
          };
          return {
            ...projection,
            upgradeProgress: (await nodeUpgradeProgress?.snapshot(node.id)) ?? null,
            ownership: await resources.nodeOwnership(node.id),
            manageable: await resources.canManageNode(user.userId, node.id),
            workspaceCreatable: await resources.canRegisterWorkspace(user.userId, node.id),
            secretManageable: await resources.canManageNodeSecrets(user.userId, node.id),
            upgradeAvailability: await nodeUpgrades.availability(
              projection.nodeAppVersion,
              projection.metadata?.supervisedUpgrade === true,
              nodeControl.isNodeUpgradeOnly(node.id)
            )
          };
        })
      )
    });
  });

  registerNodeUpgradeRoutes({
    app,
    database,
    nodeControl,
    nodeUpgrades,
    ...(nodeUpgradeProgress === undefined ? {} : { progress: nodeUpgradeProgress }),
    publicOrigin,
    databaseError,
    authorize: async (userId, nodeId) => {
      await resources.assertCanManageNode(userId, nodeId);
    }
  });

  app.patch<{
    Params: { nodeId: string };
    Body: { displayName?: unknown; ownership?: unknown };
  }>('/api/nodes/:nodeId', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    const value = request.body?.displayName;
    const ownership =
      request.body?.ownership === undefined
        ? undefined
        : resourceOwnershipSchema.safeParse(request.body.ownership).data;
    if (
      (request.body?.displayName === undefined && ownership === undefined) ||
      (value !== undefined && value !== null && typeof value !== 'string') ||
      (request.body?.ownership !== undefined && ownership === undefined)
    )
      return sendError(reply, 400, 'NODE_DISPLAY_NAME_INVALID');
    try {
      await resources.assertCanManageNode(admin.userId, request.params.nodeId);
      if (ownership !== undefined)
        await mutations.changeNodeOwnership(admin.userId, request.params.nodeId, ownership);
      if (ownership !== undefined) await nodeControl.revalidateTerminalAuthorizations();
      if (value === undefined) {
        const node = (await nodeControl.listNodes()).find(
          (candidate) => candidate.id === request.params.nodeId
        );
        return node === undefined
          ? sendError(reply, 404, 'NODE_NOT_FOUND')
          : reply.send({ node: publicNode(node) });
      }
      const node = await database.updateNodeDisplayName(
        request.params.nodeId,
        value ?? null,
        admin.userId
      );
      if (node === undefined) return sendError(reply, 404, 'NODE_NOT_FOUND');
      return reply.send({
        node: publicNode({ ...node, connected: nodeControl.isNodeConnected(node.id) })
      });
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  registerRunnerRoutes({
    app,
    database,
    nodeControl,
    secrets,
    ...(marAgentModels === undefined ? {} : { marAgentModels }),
    publicOrigin,
    capabilities: input.capabilities,
    databaseError
  });

  registerTerminalRoutes({
    app,
    database,
    nodeControl,
    secrets,
    publicOrigin,
    databaseError,
    ...(input.userCredentials === undefined ? {} : { userCredentials: input.userCredentials })
  });

  app.get<{ Params: { nodeId: string } }>('/api/nodes/:nodeId/metrics', async (request, reply) => {
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    try {
      return reply.send(
        await requestUserNode(nodeControl, admin, request.params.nodeId, 'node.metrics', {})
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.post<{ Params: { nodeId: string } }>('/api/nodes/:nodeId/revoke', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) {
      return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    }
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    try {
      await resources.assertCanManageNode(admin.userId, request.params.nodeId);
    } catch (error) {
      return databaseError(reply, error);
    }
    if (!(await nodeControl.revokeNode(request.params.nodeId, admin.userId))) {
      return sendError(reply, 404, 'NODE_NOT_FOUND');
    }
    return reply.code(204).send();
  });

  app.delete<{ Params: { nodeId: string } }>('/api/nodes/:nodeId', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) {
      return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    }
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    try {
      await resources.assertCanManageNode(admin.userId, request.params.nodeId);
    } catch (error) {
      return databaseError(reply, error);
    }
    try {
      if (!(await nodeControl.deleteNode(request.params.nodeId, admin.userId))) {
        return sendError(reply, 404, 'NODE_NOT_FOUND');
      }
      return reply.code(204).send();
    } catch (error) {
      return databaseError(reply, error);
    }
  });
}
