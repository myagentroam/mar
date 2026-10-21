import { requestUserNode } from './workspace-http-support.js';
import type { FastifyInstance } from 'fastify';
import { isAllowedOrigin } from './auth.js';
import type { McpService } from './mcp-service.js';
import type { SessionLookup } from './session.js';
import type { SessionRunNodeControl } from './session-run-contracts.js';
import type { CatalogResourcePolicy } from './catalog-route-contracts.js';
import type { ProcessSecretResolver } from './session-run-contracts.js';
import type { McpCatalogEntry, McpInstallationConfiguration } from '@myagentroam/protocol';
import { databaseError } from './domain-errors.js';
import { protectedAdmin, validCsrf } from './session.js';
import { sendError } from './http-errors.js';

export function registerMcpRoutes(input: {
  readonly app: FastifyInstance;
  readonly database: SessionLookup;
  readonly service: McpService;
  readonly nodeControl: Pick<SessionRunNodeControl, 'requestNode'>;
  readonly resources?: CatalogResourcePolicy;
  readonly secrets: ProcessSecretResolver;
  readonly publicOrigin?: string;
}): void {
  const { app, database, service, nodeControl, resources, secrets, publicOrigin } = input;
  app.get('/api/mcp-sources', async (request, reply) => {
    const actor = protectedAdmin(database, request, reply);
    if (actor === undefined) return;
    try {
      return reply.send({ sources: await service.listSources(actor.userId) });
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.post<{ Body: unknown }>('/api/mcp-sources', async (request, reply) => {
    const actor = writableActor(database, request, reply, publicOrigin);
    if (actor === undefined) return;
    try {
      return reply
        .code(201)
        .send({ source: await service.createSource(actor.userId, request.body) });
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.patch<{ Params: { sourceId: string }; Body: { enabled?: unknown } }>(
    '/api/mcp-sources/:sourceId',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      if (typeof request.body?.enabled !== 'boolean')
        return sendError(reply, 400, 'MCP_SOURCE_INPUT_INVALID');
      try {
        await service.setSourceEnabled(actor.userId, request.params.sourceId, request.body.enabled);
        return reply.code(204).send();
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  app.delete<{ Params: { sourceId: string } }>(
    '/api/mcp-sources/:sourceId',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        await service.removeSource(actor.userId, request.params.sourceId);
        return reply.code(204).send();
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  app.get<{ Params: { sourceId: string }; Querystring: { query?: string } }>(
    '/api/mcp-sources/:sourceId/servers',
    async (request, reply) => {
      const actor = protectedAdmin(database, request, reply);
      if (actor === undefined) return;
      try {
        return reply.send({
          servers: await service.discover(
            actor.userId,
            request.params.sourceId,
            request.query.query ?? ''
          )
        });
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  app.get<{ Querystring: Record<string, unknown> }>('/api/mcp-catalog', async (request, reply) => {
    const actor = protectedAdmin(database, request, reply);
    if (actor === undefined) return;
    try {
      return reply.send(
        Object.keys(request.query).length
          ? await service.listQuery(actor.userId, request.query)
          : { entries: await service.listCatalog(actor.userId) }
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.post<{ Body: unknown }>('/api/mcp-catalog', async (request, reply) => {
    const actor = writableActor(database, request, reply, publicOrigin);
    if (actor === undefined) return;
    try {
      return reply.code(201).send({ entry: await service.addCatalog(actor.userId, request.body) });
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.post<{ Params: { entryId: string } }>(
    '/api/mcp-catalog/:entryId/check-update',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        return reply.send(await service.checkCatalogUpdate(actor.userId, request.params.entryId));
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  app.post<{ Params: { entryId: string } }>(
    '/api/mcp-catalog/:entryId/upgrade',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        return reply.send({
          entry: await service.upgradeCatalog(actor.userId, request.params.entryId)
        });
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  app.patch<{ Params: { entryId: string }; Body: unknown }>(
    '/api/mcp-catalog/:entryId',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        await service.updateCatalogPresentation(actor.userId, request.params.entryId, request.body);
        return reply.code(204).send();
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  app.delete<{ Params: { entryId: string } }>(
    '/api/mcp-catalog/:entryId',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        await service.removeCatalog(actor.userId, request.params.entryId);
        return reply.code(204).send();
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  app.get<{ Params: { nodeId: string } }>('/api/nodes/:nodeId/mcps', async (request, reply) => {
    const actor = protectedAdmin(database, request, reply);
    if (actor === undefined) return;
    try {
      if (resources) await resources.assertCanManageNode(actor.userId, request.params.nodeId);
      return reply.send(
        await requestUserNode(nodeControl, actor, request.params.nodeId, 'node.mcps.inspect', {})
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.post<{ Params: { nodeId: string }; Body: unknown }>(
    '/api/nodes/:nodeId/mcps',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      if (!isRecord(request.body) || typeof request.body['catalogEntryId'] !== 'string')
        return sendError(reply, 400, 'MCP_INSTALL_INPUT_INVALID');
      try {
        if (resources) await resources.assertCanManageNode(actor.userId, request.params.nodeId);
        const entry = await service.getVisibleCatalog(actor.userId, request.body['catalogEntryId']);
        return reply.send(
          await requestUserNode(
            nodeControl,
            actor,
            request.params.nodeId,
            'node.mcps.install',
            {
              entry,
              enabled: request.body['enabled'] ?? true,
              configuration: request.body['configuration'] ?? {},
              secretEnvironment: await referencedSecrets(
                secrets,
                actor.userId,
                request.params.nodeId,
                entry,
                request.body['configuration']
              )
            },
            undefined,
            300_000
          )
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  app.delete<{ Params: { nodeId: string; serverName: string } }>(
    '/api/nodes/:nodeId/mcps/:serverName',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        if (resources) await resources.assertCanManageNode(actor.userId, request.params.nodeId);
        return reply.send(
          await requestUserNode(nodeControl, actor, request.params.nodeId, 'node.mcps.remove', {
            serverName: request.params.serverName
          })
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  app.get<{ Params: { workspaceId: string }; Querystring: { nodeId?: string } }>(
    '/api/workspaces/:workspaceId/mcps',
    async (request, reply) => {
      const actor = protectedAdmin(database, request, reply);
      if (actor === undefined) return;
      if (typeof request.query.nodeId !== 'string')
        return sendError(reply, 400, 'NODE_ID_REQUIRED');
      try {
        if (resources)
          await resources.assertCanUseWorkspace(
            actor.userId,
            request.query.nodeId,
            request.params.workspaceId
          );
        return reply.send(
          await requestUserNode(
            nodeControl,
            actor,
            request.query.nodeId,
            'workspace.mcps.inspect',
            { workspaceId: request.params.workspaceId },
            request.params.workspaceId,
            300_000
          )
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  app.post<{ Params: { workspaceId: string }; Querystring: { nodeId?: string }; Body: unknown }>(
    '/api/workspaces/:workspaceId/mcps',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      if (typeof request.query.nodeId !== 'string')
        return sendError(reply, 400, 'NODE_ID_REQUIRED');
      if (!isRecord(request.body) || typeof request.body['catalogEntryId'] !== 'string')
        return sendError(reply, 400, 'MCP_INSTALL_INPUT_INVALID');
      try {
        if (resources)
          await resources.assertCanManageWorkspace(
            actor.userId,
            request.query.nodeId,
            request.params.workspaceId
          );
        const entry = await service.getVisibleCatalog(actor.userId, request.body['catalogEntryId']);
        return reply.send(
          await requestUserNode(
            nodeControl,
            actor,
            request.query.nodeId,
            'workspace.mcps.install',
            {
              workspaceId: request.params.workspaceId,
              entry,
              enabled: request.body['enabled'] ?? true,
              configuration: request.body['configuration'] ?? {},
              secretEnvironment: await referencedSecrets(
                secrets,
                actor.userId,
                request.query.nodeId,
                entry,
                request.body['configuration'],
                request.params.workspaceId
              )
            },
            request.params.workspaceId,
            300_000
          )
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  app.delete<{
    Params: { workspaceId: string; serverName: string };
    Querystring: { nodeId?: string };
  }>('/api/workspaces/:workspaceId/mcps/:serverName', async (request, reply) => {
    const actor = writableActor(database, request, reply, publicOrigin);
    if (actor === undefined) return;
    if (typeof request.query.nodeId !== 'string') return sendError(reply, 400, 'NODE_ID_REQUIRED');
    try {
      if (resources)
        await resources.assertCanManageWorkspace(
          actor.userId,
          request.query.nodeId,
          request.params.workspaceId
        );
      return reply.send(
        await requestUserNode(
          nodeControl,
          actor,
          request.query.nodeId,
          'workspace.mcps.remove',
          {
            workspaceId: request.params.workspaceId,
            serverName: request.params.serverName
          },
          request.params.workspaceId
        )
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });
}

async function referencedSecrets(
  secrets: ProcessSecretResolver,
  userId: number,
  nodeId: string,
  entry: McpCatalogEntry,
  rawConfiguration: unknown,
  workspaceId?: string
): Promise<Record<string, string>> {
  const configuration = isRecord(rawConfiguration)
    ? (rawConfiguration as McpInstallationConfiguration)
    : {};
  const names = new Set(
    [
      ...Object.values(
        entry.runtime.transport === 'STDIO'
          ? (entry.runtime.environment ?? {})
          : (entry.runtime.headers ?? {})
      ),
      ...Object.values(configuration.environment ?? {}),
      ...Object.values(configuration.headers ?? {})
    ].map((reference) => reference.secretName)
  );
  const effective = await secrets.resolve(userId, nodeId, workspaceId);
  return Object.fromEntries(Object.entries(effective).filter(([name]) => names.has(name)));
}

function writableActor(
  database: SessionLookup,
  request: Parameters<typeof protectedAdmin>[1],
  reply: Parameters<typeof protectedAdmin>[2],
  publicOrigin?: string
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
