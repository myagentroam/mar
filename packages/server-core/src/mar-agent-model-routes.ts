import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  marAgentModelTransportTestResultSchema,
  type MarAgentModelTransportTestResult
} from '@myagentroam/protocol';
import { isAllowedOrigin } from './auth.js';
import type { SessionLookup } from './session.js';
import type { Pool } from 'mysql2/promise';
import type { SessionRunNodeControl } from './session-run-contracts.js';
import type { MarAgentModelService } from './mar-agent-model-service.js';
import type { MarAgentRuntimeModelService } from './mar-agent-runtime-model-service.js';
import type { ImageGenerationConfigurationService } from './image-generation-configuration-service.js';
import { protectedAdmin, validCsrf } from './session.js';
import { protectedManagementAdmin } from './session.js';
import { MarAgentCompactService } from './mar-agent-compact-service.js';
import { registerPromptCompletionSettingsRoutes } from './prompt-completion-settings-routes.js';
import { requestUserNode } from './workspace-http-support.js';
import { errorResponseOptions, safePublicError, sendError } from './http-errors.js';
type ModelRouteStore = SessionLookup & {
  readonly raw: Pool;
  userCanRequestNode(
    userId: number,
    nodeId: string,
    operation: string,
    data: unknown,
    workspaceId?: string
  ): Promise<boolean>;
};

export function registerMarAgentModelRoutes(input: {
  app: FastifyInstance;
  databaseError: (reply: FastifyReply, error: unknown) => FastifyReply;
  database: ModelRouteStore;
  models: MarAgentModelService;
  runtimeModels: Pick<MarAgentRuntimeModelService, 'prepareTest'>;
  imageGeneration?: Pick<ImageGenerationConfigurationService, 'get' | 'update'>;
  nodeControl: Pick<SessionRunNodeControl, 'requestNode'>;
  publicOrigin?: string;
}) {
  const {
    app,
    database,
    models,
    runtimeModels,
    imageGeneration,
    nodeControl,
    publicOrigin,
    databaseError
  } = input;
  const compact = new MarAgentCompactService(database, models);
  registerPromptCompletionSettingsRoutes({
    app,
    database,
    databaseError,
    models,
    publicOrigin
  });
  app.get('/api/admin/mar-agent/compact', async (request, reply) => {
    const actor = protectedManagementAdmin(database, request, reply);
    if (!actor) return;
    try {
      return reply
        .header('Cache-Control', 'private, no-store')
        .send({ configuration: await compact.read() });
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.put<{ Body: unknown }>('/api/admin/mar-agent/compact', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const actor = protectedManagementAdmin(database, request, reply);
    if (!actor) return;
    if (!validCsrf(request, actor)) return sendError(reply, 403, 'CSRF_INVALID');
    try {
      return reply
        .header('Cache-Control', 'private, no-store')
        .send({ configuration: await compact.write(actor.userId, request.body) });
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.get('/api/admin/mar-agent/models', async (request, reply) => {
    const actor = protectedAdmin(database, request, reply);
    if (!actor) return;
    try {
      return reply
        .header('Cache-Control', 'private, no-store')
        .send({ models: await models.listManagedForUser(actor.userId) });
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.get('/api/mar-agent/models', async (request, reply) => {
    const actor = protectedAdmin(database, request, reply);
    if (!actor) return;
    try {
      return reply
        .header('Cache-Control', 'private, no-store')
        .send({ models: await models.listForUser(actor.userId) });
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.get('/api/admin/mar-agent/image-generation', async (request, reply) => {
    const actor = protectedAdmin(database, request, reply);
    if (!actor) return;
    try {
      return reply
        .header('Cache-Control', 'no-store')
        .send({ configuration: (await imageGeneration?.get(actor.userId)) ?? [] });
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.put<{ Body: unknown }>('/api/admin/mar-agent/image-generation', async (request, reply) => {
    const actor = writable(database, request, reply, publicOrigin);
    if (!actor) return;
    if (imageGeneration === undefined)
      return sendError(reply, 503, 'MAR_AGENT_IMAGE_GENERATION_CONFIGURATION_UNAVAILABLE');
    try {
      return reply.send({
        configuration: await imageGeneration.update(actor.userId, request.body)
      });
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.post<{ Body: unknown }>('/api/admin/mar-agent/models', async (request, reply) => {
    const actor = writable(database, request, reply, publicOrigin);
    if (!actor) return;
    try {
      return reply.code(201).send({ model: await models.create(actor.userId, request.body) });
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.put<{ Body: unknown }>('/api/admin/mar-agent/models/order', async (request, reply) => {
    const actor = writable(database, request, reply, publicOrigin);
    if (!actor) return;
    try {
      await models.reorder(request.body, actor.userId);
      return reply.code(204).send();
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.post<{ Params: { modelId: string }; Body: unknown }>(
    '/api/admin/mar-agent/models/:modelId/duplicate',
    async (request, reply) => {
      const actor = writable(database, request, reply, publicOrigin);
      if (!actor) return;
      try {
        return reply.code(201).send({
          model: await models.duplicate(actor.userId, request.params.modelId, request.body)
        });
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  app.put<{ Body: unknown }>('/api/mar-agent/models/order', async (request, reply) => {
    const actor = personalWritable(database, request, reply, publicOrigin);
    if (!actor) return;
    try {
      await models.reorderForUser(actor.userId, request.body);
      return reply.code(204).send();
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.put<{ Params: { modelId: string }; Body: unknown }>(
    '/api/admin/mar-agent/models/:modelId',
    async (request, reply) => {
      const actor = writable(database, request, reply, publicOrigin);
      if (!actor) return;
      try {
        return reply.send({
          model: await models.update(actor.userId, request.params.modelId, request.body)
        });
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  app.delete<{ Params: { modelId: string } }>(
    '/api/admin/mar-agent/models/:modelId',
    async (request, reply) => {
      const actor = writable(database, request, reply, publicOrigin);
      if (!actor) return;
      try {
        await models.remove(request.params.modelId, actor.userId);
        return reply.code(204).send();
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  app.post<{ Params: { modelId: string }; Body: unknown }>(
    '/api/admin/mar-agent/models/:modelId/test',
    async (request, reply) => {
      const actor = writable(database, request, reply, publicOrigin);
      if (!actor) return;
      const nodeId = modelTestNodeId(request.body);
      if (nodeId === undefined) return sendError(reply, 400, 'MAR_AGENT_MODEL_TEST_INPUT_INVALID');
      try {
        await models.assertCanManage(actor.userId, request.params.modelId);
        const workspaceId = await modelTestWorkspace(database, actor.userId, nodeId);
        const prepared = await runtimeModels.prepareTest({
          userId: actor.userId,
          nodeId,
          workspaceId,
          modelId: request.params.modelId
        });
        const raw = await requestUserNode(
          nodeControl,
          actor,
          nodeId,
          'mar-agent.model.test',
          {
            runtimeScopeId: prepared.runtimeScopeId,
            executionId: randomUUID(),
            model: prepared.model
          },
          workspaceId,
          45_000
        );
        const parsed = marAgentModelTransportTestResultSchema.safeParse(raw);
        if (!parsed.success) throw new Error('MAR_AGENT_MODEL_TEST_RESPONSE_INVALID');
        const result: MarAgentModelTransportTestResult = parsed.data;
        await models.recordTestResult(request.params.modelId, result, actor.userId);
        return reply.send({ ...result, requestId: request.id });
      } catch (error) {
        const failure = safePublicError(error);
        if (failure.code === 'MAR_AGENT_MODEL_TEST_WORKSPACE_REQUIRED')
          return sendError(reply, 409, failure.code, errorResponseOptions(failure));
        return databaseError(reply, error);
      }
    }
  );
}

function modelTestNodeId(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw);
  if (entries.length !== 1 || entries[0]?.[0] !== 'nodeId') return undefined;
  const nodeId = entries[0][1];
  return typeof nodeId === 'string' && nodeId.length > 0 && nodeId.length <= 128
    ? nodeId
    : undefined;
}

async function modelTestWorkspace(
  database: ModelRouteStore,
  actorUserId: number,
  nodeId: string
): Promise<string> {
  const [rows] = await database.raw.execute<import('mysql2/promise').RowDataPacket[]>(
    'SELECT workspace_id FROM workspaces WHERE node_id=? ORDER BY workspace_id',
    [nodeId]
  );
  for (const row of rows) {
    const workspaceId = row['workspace_id'];
    if (
      typeof workspaceId === 'string' &&
      workspaceId.length > 0 &&
      (await database.userCanRequestNode(
        actorUserId,
        nodeId,
        'mar-agent.model.test',
        {},
        workspaceId
      ))
    )
      return workspaceId;
  }
  throw new Error('MAR_AGENT_MODEL_TEST_WORKSPACE_REQUIRED');
}

function writable(
  database: ModelRouteStore,
  request: Parameters<typeof protectedAdmin>[1],
  reply: Parameters<typeof protectedAdmin>[2],
  origin: string | undefined
) {
  if (!isAllowedOrigin(request, origin)) {
    void sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    return undefined;
  }
  const actor = protectedAdmin(database, request, reply);
  if (!actor) return undefined;
  if (!validCsrf(request, actor)) {
    void sendError(reply, 403, 'CSRF_INVALID');
    return undefined;
  }
  return actor;
}

function personalWritable(
  database: ModelRouteStore,
  request: Parameters<typeof protectedAdmin>[1],
  reply: Parameters<typeof protectedAdmin>[2],
  origin: string | undefined
) {
  if (!isAllowedOrigin(request, origin)) {
    void sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    return undefined;
  }
  const actor = protectedAdmin(database, request, reply);
  if (!actor) return undefined;
  if (!validCsrf(request, actor)) {
    void sendError(reply, 403, 'CSRF_INVALID');
    return undefined;
  }
  return actor;
}
