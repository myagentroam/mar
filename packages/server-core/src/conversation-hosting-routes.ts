import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  conversationHostingCleanupExecuteInputSchema,
  conversationHostingDisableInputSchema,
  conversationHostingEnableInputSchema,
  conversationHostingEnableResultSchema,
  conversationHostingCleanupPreviewInputSchema,
  conversationHostingCleanupPreviewSchema,
  conversationHostingCleanupResultSchema,
  conversationHostingStorageCapacitySchema
} from '@myagentroam/protocol';
import { isAllowedOrigin } from './auth.js';
import { protectedManagementAdmin, validCsrf, type SessionLookup } from './session.js';
import { databaseError } from './domain-errors.js';
import { sendError } from './http-errors.js';
import { requestUserNode } from './workspace-http-support.js';
import { publicNode } from './node-projection.js';
import { emitAudit } from './audit.js';
import type { SessionRunNodeControl } from './session-run-contracts.js';

export function registerConversationHostingRoutes(input: {
  app: FastifyInstance;
  database: SessionLookup & {
    audit(event: {
      eventType: string;
      actorUserId: number;
      metadata: string;
    }): void | Promise<void>;
  };
  nodeControl: Pick<SessionRunNodeControl, 'requestNode'> & {
    listNodes():
      | readonly Parameters<typeof publicNode>[0][]
      | Promise<readonly Parameters<typeof publicNode>[0][]>;
  };
  publicOrigin: string | undefined;
  authorizeNode(userId: number, nodeId: string): Promise<void>;
  canEnableNode(userId: number, nodeId: string): Promise<boolean>;
  enableDeniedCode: string;
}): void {
  const {
    app,
    database,
    nodeControl,
    publicOrigin,
    authorizeNode,
    canEnableNode,
    enableDeniedCode
  } = input;
  app.get<{ Params: { nodeId: string } }>(
    '/api/management/nodes/:nodeId/conversation-hosting/storage',
    async (request, reply) => {
      const admin = protectedManagementAdmin(database, request, reply);
      if (admin === undefined) return;
      try {
        await authorizeNode(admin.userId, request.params.nodeId);
      } catch (error) {
        return databaseError(reply, error);
      }
      const node = (await nodeControl.listNodes()).find(
        (candidate) => candidate.id === request.params.nodeId
      );
      if (node === undefined) return sendError(reply, 404, 'NODE_NOT_FOUND');
      if (!node.connected || node.disabled) return sendError(reply, 409, 'NODE_OFFLINE');
      try {
        const result = await requestUserNode(
          nodeControl,
          admin,
          node.id,
          'conversation.hosting.storage.inspect',
          {}
        );
        const storage = maintenancePayload(
          result,
          'storage',
          conversationHostingStorageCapacitySchema
        );
        emitAudit(database, {
          eventType: 'conversation_hosting_storage_inspected',
          actorUserId: admin.userId,
          metadata: JSON.stringify({ nodeId: node.id })
        });
        return reply.send({ storage });
      } catch (error) {
        return maintenanceRouteError(reply, error);
      }
    }
  );
  app.post<{ Params: { nodeId: string }; Body: unknown }>(
    '/api/management/nodes/:nodeId/conversation-hosting/enable',
    async (request, reply) => {
      if (!isAllowedOrigin(request, publicOrigin))
        return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
      const admin = protectedManagementAdmin(database, request, reply);
      if (admin === undefined) return;
      try {
        await authorizeNode(admin.userId, request.params.nodeId);
      } catch (error) {
        return databaseError(reply, error);
      }
      if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
      const parsed = conversationHostingEnableInputSchema.safeParse(request.body);
      if (!parsed.success)
        return sendError(reply, 400, 'CONVERSATION_HOSTING_ENABLE_INPUT_INVALID');
      const node = (await nodeControl.listNodes()).find(
        (candidate) => candidate.id === request.params.nodeId
      );
      if (node === undefined) return sendError(reply, 404, 'NODE_NOT_FOUND');
      try {
        if (!(await canEnableNode(admin.userId, node.id)))
          return sendError(reply, 409, enableDeniedCode);
      } catch (error) {
        return databaseError(reply, error);
      }
      if (!node.connected || node.disabled) return sendError(reply, 409, 'NODE_OFFLINE');
      const projection = publicNode(node) as {
        readonly platform: string;
      };
      if (projection.platform !== 'linux')
        return sendError(reply, 409, 'CONVERSATION_HOSTING_ENABLE_PLATFORM_UNSUPPORTED');
      try {
        const result = conversationHostingEnableResultSchema.parse(
          await requestUserNode(
            nodeControl,
            admin,
            node.id,
            'conversation.hosting.enable',
            parsed.data
          )
        );
        return reply.send(result);
      } catch (error) {
        return enablementRouteError(reply, error);
      }
    }
  );
  app.post<{ Params: { nodeId: string }; Body: unknown }>(
    '/api/management/nodes/:nodeId/conversation-hosting/disable',
    async (request, reply) => {
      if (!isAllowedOrigin(request, publicOrigin))
        return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
      const admin = protectedManagementAdmin(database, request, reply);
      if (admin === undefined) return;
      try {
        await authorizeNode(admin.userId, request.params.nodeId);
      } catch (error) {
        return databaseError(reply, error);
      }
      if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
      const parsed = conversationHostingDisableInputSchema.safeParse(request.body);
      if (!parsed.success)
        return sendError(reply, 400, 'CONVERSATION_HOSTING_DISABLE_INPUT_INVALID');
      const node = (await nodeControl.listNodes()).find(
        (candidate) => candidate.id === request.params.nodeId
      );
      if (node === undefined) return sendError(reply, 404, 'NODE_NOT_FOUND');
      if (!node.connected || node.disabled) return sendError(reply, 409, 'NODE_OFFLINE');
      const projection = publicNode(node) as {
        readonly platform: string;
      };
      if (projection.platform !== 'linux')
        return sendError(reply, 409, 'CONVERSATION_HOSTING_DISABLE_PLATFORM_UNSUPPORTED');
      try {
        const result = conversationHostingEnableResultSchema.parse(
          await requestUserNode(
            nodeControl,
            admin,
            node.id,
            'conversation.hosting.disable',
            parsed.data
          )
        );
        return reply.send(result);
      } catch (error) {
        return disablementRouteError(reply, error);
      }
    }
  );
  app.post<{ Params: { nodeId: string }; Body: unknown }>(
    '/api/management/nodes/:nodeId/conversation-hosting/cleanup/preview',
    async (request, reply) => {
      if (!isAllowedOrigin(request, publicOrigin))
        return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
      const admin = protectedManagementAdmin(database, request, reply);
      if (admin === undefined) return;
      try {
        await authorizeNode(admin.userId, request.params.nodeId);
      } catch (error) {
        return databaseError(reply, error);
      }
      if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
      const parsed = conversationHostingCleanupPreviewInputSchema.safeParse(request.body);
      if (!parsed.success)
        return sendError(reply, 400, 'CONVERSATION_HOSTING_CLEANUP_INPUT_INVALID');
      const node = (await nodeControl.listNodes()).find(
        (candidate) => candidate.id === request.params.nodeId
      );
      if (node === undefined) return sendError(reply, 404, 'NODE_NOT_FOUND');
      if (!node.connected || node.disabled) return sendError(reply, 409, 'NODE_OFFLINE');
      try {
        const result = await requestUserNode(
          nodeControl,
          admin,
          node.id,
          'conversation.hosting.cleanup.preview',
          parsed.data
        );
        const preview = maintenancePayload(
          result,
          'preview',
          conversationHostingCleanupPreviewSchema
        );
        const response = { preview };
        emitAudit(database, {
          eventType: 'conversation_hosting_cleanup_previewed',
          actorUserId: admin.userId,
          metadata: JSON.stringify({
            nodeId: node.id,
            inactiveDays: parsed.data.inactiveDays,
            ...maintenanceAggregate(response)
          })
        });
        return reply.send(response);
      } catch (error) {
        return maintenanceRouteError(reply, error);
      }
    }
  );
  app.post<{ Params: { nodeId: string }; Body: unknown }>(
    '/api/management/nodes/:nodeId/conversation-hosting/cleanup',
    async (request, reply) => {
      if (!isAllowedOrigin(request, publicOrigin))
        return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
      const admin = protectedManagementAdmin(database, request, reply);
      if (admin === undefined) return;
      try {
        await authorizeNode(admin.userId, request.params.nodeId);
      } catch (error) {
        return databaseError(reply, error);
      }
      if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
      const parsed = conversationHostingCleanupExecuteInputSchema.safeParse(request.body);
      if (!parsed.success)
        return sendError(reply, 400, 'CONVERSATION_HOSTING_CLEANUP_INPUT_INVALID');
      const node = (await nodeControl.listNodes()).find(
        (candidate) => candidate.id === request.params.nodeId
      );
      if (node === undefined) return sendError(reply, 404, 'NODE_NOT_FOUND');
      if (!node.connected || node.disabled) return sendError(reply, 409, 'NODE_OFFLINE');
      try {
        const result = await requestUserNode(
          nodeControl,
          admin,
          node.id,
          'conversation.hosting.cleanup.execute',
          parsed.data
        );
        const cleanupResult = maintenancePayload(
          result,
          'result',
          conversationHostingCleanupResultSchema
        );
        const response = { result: cleanupResult };
        return reply.send(response);
      } catch (error) {
        return maintenanceRouteError(reply, error);
      }
    }
  );
}

function maintenanceRouteError(reply: FastifyReply, error: unknown): FastifyReply {
  return error instanceof Error &&
    error.message === 'CONVERSATION_HOSTING_MAINTENANCE_RESPONSE_INVALID'
    ? sendError(reply, 502, error.message)
    : databaseError(reply, error);
}

function enablementRouteError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof Error && error.name === 'ZodError')
    return sendError(reply, 502, 'CONVERSATION_HOSTING_ENABLE_RESPONSE_INVALID');
  return databaseError(reply, error);
}

function disablementRouteError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof Error && error.name === 'ZodError')
    return sendError(reply, 502, 'CONVERSATION_HOSTING_DISABLE_RESPONSE_INVALID');
  return databaseError(reply, error);
}

function maintenancePayload<T>(
  value: unknown,
  key: 'storage' | 'preview' | 'result',
  schema: { parse(input: unknown): T }
): T {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw new Error('invalid wrapper');
    return schema.parse((value as Record<string, unknown>)[key]);
  } catch {
    throw new Error('CONVERSATION_HOSTING_MAINTENANCE_RESPONSE_INVALID');
  }
}

function maintenanceAggregate(value: unknown): Record<string, number> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const wrapper = value as Record<string, unknown>;
  const aggregate = wrapper['preview'] ?? wrapper['result'];
  if (aggregate === null || typeof aggregate !== 'object' || Array.isArray(aggregate)) return {};
  const source = aggregate as Record<string, unknown>;
  const output: Record<string, number> = {};
  for (const key of [
    'candidateConversationCount',
    'reclaimableBytes',
    'deletedConversationCount',
    'releasedBytes',
    'skippedConversationCount'
  ]) {
    const candidate = source[key];
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0)
      output[key] = candidate;
  }
  return output;
}
