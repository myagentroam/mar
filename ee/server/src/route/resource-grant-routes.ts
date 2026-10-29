import { managementPageQuery } from '@myagentroam/server-core/management-pagination';
import type { NodeUpgradeService } from '@myagentroam/server-core/node-upgrade-service';
import type { NodeUpgradeProgress } from '@myagentroam/server-core/node-upgrade-progress';
import type { FastifyInstance } from 'fastify';
import { isAllowedOrigin } from '@myagentroam/server-core/auth';
import type { MysqlServerDatabase } from '../mysql/server-database.js';
import type { NodeControl } from '../node-control.js';
import type { ResourceManagementDirectory } from '../rbac/resource-management-directory.js';
import type { ResourceGrantService } from '../rbac/resource-grant-service.js';
import type { GrantTarget } from '../rbac/resource-grant-contracts.js';
import { databaseError, protectedAdmin, sendError, validCsrf } from '../util/http-request.js';

export function registerResourceGrantRoutes(input: {
  readonly app: FastifyInstance;
  readonly database: MysqlServerDatabase;
  readonly directory: Pick<
    ResourceManagementDirectory,
    'listManagedResources' | 'listManagedResourcePage'
  >;
  readonly grants: ResourceGrantService;
  readonly nodeControl: NodeControl;
  readonly nodeUpgrades: Pick<NodeUpgradeService, 'availability'>;
  readonly nodeUpgradeProgress?: NodeUpgradeProgress;
  readonly publicOrigin: string | undefined;
}): void {
  const { app, database, directory, grants, nodeControl, nodeUpgrades, publicOrigin } = input;
  app.get<{ Querystring: Record<string, unknown> }>('/api/resources', async (request, reply) => {
    const actor = protectedAdmin(database, request, reply);
    if (actor === undefined) return;
    try {
      if (managementPageQuery(request.query) !== undefined) {
        const overview = await directory.listManagedResourcePage(
          actor.userId,
          request.query,
          nodeControl.connectedNodeIds()
        );
        return reply.send({
          ...overview,
          nodes: await Promise.all(
            overview.nodes.map(async (node) => ({
              ...node,
              upgradeProgress: node.disabled
                ? null
                : ((await input.nodeUpgradeProgress?.snapshot(node.id)) ?? null),
              upgradeAvailability: await nodeUpgrades.availability(
                node.nodeAppVersion,
                node.metadata?.['supervisedUpgrade'] === true,
                nodeControl.isNodeUpgradeOnly(node.id)
              )
            }))
          )
        });
      }
      const overview = await directory.listManagedResources(
        actor.userId,
        request.query.management === 'all'
      );
      return reply.send({
        ...overview,
        nodes: await Promise.all(
          overview.nodes.map(async (node) => ({
            ...node,
            upgradeProgress: node.disabled
              ? null
              : ((await input.nodeUpgradeProgress?.snapshot(node.id)) ?? null),
            connected: nodeControl.isNodeConnected(node.id)
          }))
        )
      });
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.get<{
    Querystring: {
      resourceType?: string;
      nodeId?: string;
      workspaceId?: string;
      modelId?: string;
      imageModelId?: string;
      templateId?: string;
    };
  }>('/api/resource-grants', async (request, reply) => {
    const actor = protectedAdmin(database, request, reply);
    if (actor === undefined) return;
    const resource = resourceQuery(request.query);
    if (resource === undefined) return sendError(reply, 400, 'RESOURCE_INPUT_INVALID');
    try {
      return reply.send({
        grants: await grants.listGrants(
          actor.userId,
          resource.resourceType,
          resource.resourceId,
          resource.workspaceId
        )
      });
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.post<{
    Body: {
      resourceType?: unknown;
      nodeId?: unknown;
      workspaceId?: unknown;
      modelId?: unknown;
      imageModelId?: unknown;
      templateId?: unknown;
      targetType?: unknown;
      targetUserId?: unknown;
      targetOrganizationId?: unknown;
    };
  }>('/api/resource-grants', async (request, reply) => {
    const actor = writableActor(database, request, reply, publicOrigin);
    if (actor === undefined) return;
    const resource = resourceQuery(request.body);
    const target = grantTarget(request.body);
    if (
      resource === undefined ||
      target === undefined ||
      (resource.resourceType === 'TEMPLATE' && target.targetType !== 'ORGANIZATION')
    )
      return sendError(reply, 400, 'RESOURCE_GRANT_INPUT_INVALID');
    try {
      const id = await grants.createGrant(
        actor.userId,
        resource.resourceType,
        resource.resourceId,
        resource.workspaceId,
        target
      );
      return reply.code(201).send({ id });
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.delete<{ Params: { grantId: string } }>(
    '/api/resource-grants/:grantId',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        const resourceType = await grants.removeGrant(actor.userId, request.params.grantId);
        if (resourceType !== 'MODEL' && resourceType !== 'TEMPLATE')
          await nodeControl.revalidateTerminalAuthorizations();
        return reply.code(204).send();
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
}

function resourceQuery(input: {
  readonly resourceType?: unknown;
  readonly nodeId?: unknown;
  readonly workspaceId?: unknown;
  readonly modelId?: unknown;
  readonly imageModelId?: unknown;
  readonly templateId?: unknown;
}):
  | {
      readonly resourceType: 'NODE' | 'WORKSPACE' | 'MODEL' | 'IMAGE_MODEL' | 'TEMPLATE';
      readonly resourceId: string;
      readonly workspaceId: string | null;
    }
  | undefined {
  if (
    input.resourceType === 'TEMPLATE' &&
    typeof input.templateId === 'string' &&
    input.templateId.length > 0 &&
    input.nodeId === undefined &&
    input.workspaceId === undefined &&
    input.modelId === undefined &&
    input.imageModelId === undefined
  ) {
    return {
      resourceType: input.resourceType,
      resourceId: input.templateId,
      workspaceId: null
    };
  }
  if (
    input.resourceType === 'MODEL' &&
    typeof input.modelId === 'string' &&
    input.modelId.length > 0 &&
    input.nodeId === undefined &&
    input.workspaceId === undefined &&
    input.templateId === undefined &&
    input.imageModelId === undefined
  ) {
    return {
      resourceType: input.resourceType,
      resourceId: input.modelId,
      workspaceId: null
    };
  }
  if (
    input.resourceType === 'IMAGE_MODEL' &&
    typeof input.imageModelId === 'string' &&
    input.imageModelId.length > 0 &&
    input.nodeId === undefined &&
    input.workspaceId === undefined &&
    input.modelId === undefined &&
    input.templateId === undefined
  ) {
    return {
      resourceType: input.resourceType,
      resourceId: input.imageModelId,
      workspaceId: null
    };
  }
  if (
    (input.resourceType !== 'NODE' && input.resourceType !== 'WORKSPACE') ||
    typeof input.nodeId !== 'string' ||
    input.nodeId.length === 0 ||
    input.modelId !== undefined ||
    input.imageModelId !== undefined ||
    input.templateId !== undefined ||
    (input.resourceType === 'WORKSPACE' &&
      (typeof input.workspaceId !== 'string' || input.workspaceId.length === 0))
  ) {
    return undefined;
  }
  return {
    resourceType: input.resourceType as 'NODE' | 'WORKSPACE',
    resourceId: input.nodeId,
    workspaceId: input.resourceType === 'WORKSPACE' ? (input.workspaceId as string) : null
  };
}

function grantTarget(input: {
  readonly targetType?: unknown;
  readonly targetUserId?: unknown;
  readonly targetOrganizationId?: unknown;
}): GrantTarget | undefined {
  if (input.targetType === 'USER' && positiveNumber(input.targetUserId))
    return { targetType: input.targetType, targetUserId: input.targetUserId };
  if (input.targetType === 'ORGANIZATION' && positiveNumber(input.targetOrganizationId))
    return {
      targetType: input.targetType,
      targetOrganizationId: input.targetOrganizationId
    };
  return undefined;
}

function writableActor(
  database: MysqlServerDatabase,
  request: Parameters<typeof protectedAdmin>[1],
  reply: Parameters<typeof protectedAdmin>[2],
  publicOrigin: string | undefined
) {
  if (!isAllowedOrigin(request, publicOrigin)) {
    void sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    return undefined;
  }
  const actor = protectedAdmin(database, request, reply);
  if (actor === undefined) return undefined;
  if (!validCsrf(request, actor)) {
    void sendError(reply, 403, 'CSRF_INVALID');
    return undefined;
  }
  return actor;
}

function positiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
