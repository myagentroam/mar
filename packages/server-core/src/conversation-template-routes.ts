import type { FastifyInstance } from 'fastify';
import {
  conversationTemplatePublishRequestSchema,
  conversationTemplatePublishStatusInputSchema,
  conversationTemplateSourceInspectInputSchema
} from '@myagentroam/protocol';
import { isAllowedOrigin } from './auth.js';
import type { SessionLookup } from './session.js';
import type { SessionRunNodeControl } from './session-run-contracts.js';
import type { ConversationTemplateService } from './conversation-template-service.js';
import { databaseError } from './domain-errors.js';
import { protectedAdmin, protectedManagementAdmin, validCsrf } from './session.js';
import { sendError } from './http-errors.js';
import { requestUserNode } from './workspace-http-support.js';

export function registerConversationTemplateRoutes(input: {
  readonly app: FastifyInstance;
  readonly database: SessionLookup;
  readonly templates: ConversationTemplateService;
  readonly nodeControl: Pick<SessionRunNodeControl, 'requestNode'>;
  readonly publicOrigin: string | undefined;
}): void {
  const { app, database, templates, nodeControl, publicOrigin } = input;

  app.get('/api/conversation-templates', async (request, reply) => {
    const actor = protectedAdmin(database, request, reply);
    if (actor === undefined) return;
    try {
      return reply.send({ templates: await templates.listForUser(actor.userId) });
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.get<{ Querystring: Record<string, unknown> }>(
    '/api/admin/conversation-templates',
    async (request, reply) => {
      const actor = protectedManagementAdmin(database, request, reply);
      if (actor === undefined) return;
      try {
        return reply.send(
          Object.keys(request.query).length
            ? await templates.listAdminQuery(request.query)
            : { templates: await templates.listAdmin() }
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.get<{ Querystring: { nodeId?: string } }>(
    '/api/admin/conversation-templates/model-options',
    async (request, reply) => {
      const actor = protectedManagementAdmin(database, request, reply);
      if (actor === undefined) return;
      const nodeId = modelOptionsNodeId(request.query);
      if (nodeId === undefined) return sendError(reply, 400, 'CONVERSATION_TEMPLATE_INPUT_INVALID');
      try {
        return reply.send({ models: await templates.listModelOptions(nodeId) });
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.get<{ Params: { templateId: string } }>(
    '/api/admin/conversation-templates/:templateId',
    async (request, reply) => {
      const actor = protectedManagementAdmin(database, request, reply);
      if (actor === undefined) return;
      try {
        return reply.send(await templates.detail(request.params.templateId));
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.post<{ Body: unknown }>('/api/admin/conversation-templates', async (request, reply) => {
    const actor = writableActor(database, request, reply, publicOrigin);
    if (actor === undefined) return;
    try {
      const created = await templates.create(actor.userId, request.body, async (draft, mode) =>
        requestUserNode(
          nodeControl,
          actor,
          draft.nodeId,
          'conversation.template.source.inspect',
          conversationTemplateSourceInspectInputSchema.parse({ mode, draft }),
          draft.workspaceId
        )
      );
      return reply.code(201).send(created);
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.put<{ Params: { templateId: string }; Body: unknown }>(
    '/api/admin/conversation-templates/:templateId',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        return reply.send(
          await templates.update(
            actor.userId,
            request.params.templateId,
            request.body,
            async (draft, mode) =>
              requestUserNode(
                nodeControl,
                actor,
                draft.nodeId,
                'conversation.template.source.inspect',
                conversationTemplateSourceInspectInputSchema.parse({ mode, draft }),
                draft.workspaceId
              )
          )
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.post<{ Params: { templateId: string }; Body: unknown }>(
    '/api/admin/conversation-templates/:templateId/test',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        const inspection = await templates.testDraft(
          actor.userId,
          request.params.templateId,
          request.body,
          async (draft, mode) =>
            requestUserNode(
              nodeControl,
              actor,
              draft.nodeId,
              'conversation.template.source.inspect',
              conversationTemplateSourceInspectInputSchema.parse({ mode, draft }),
              draft.workspaceId
            )
        );
        return reply.send({ inspection });
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.post<{ Params: { templateId: string }; Body: unknown }>(
    '/api/admin/conversation-templates/:templateId/publish',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        const job = await templates.publish(
          actor.userId,
          request.params.templateId,
          request.body,
          async (draft, jobId, requestedByUserId) =>
            requestUserNode(
              nodeControl,
              actor,
              draft.nodeId,
              'conversation.template.publish',
              conversationTemplatePublishRequestSchema.parse({
                templateId: draft.templateId,
                jobId,
                draft,
                requestedByUserId
              }),
              draft.workspaceId
            )
        );
        return reply.code(202).send({ job });
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.get<{ Params: { templateId: string; jobId: string } }>(
    '/api/admin/conversation-templates/:templateId/publish-jobs/:jobId',
    async (request, reply) => {
      const actor = protectedManagementAdmin(database, request, reply);
      if (actor === undefined) return;
      try {
        const job = await templates.publishStatus(
          actor.userId,
          request.params.templateId,
          request.params.jobId,
          async (nodeId, _workspaceId, templateId, jobId) =>
            requestUserNode(
              nodeControl,
              actor,
              nodeId,
              'conversation.template.publish.status',
              conversationTemplatePublishStatusInputSchema.parse({ templateId, jobId })
            )
        );
        return reply.send({ job });
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.post<{ Params: { templateId: string } }>(
    '/api/admin/conversation-templates/:templateId/disable',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        await templates.disable(actor.userId, request.params.templateId);
        return reply.code(204).send();
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.post<{ Params: { templateId: string } }>(
    '/api/admin/conversation-templates/:templateId/archive',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        await templates.archive(actor.userId, request.params.templateId);
        return reply.code(204).send();
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.delete<{ Params: { templateId: string } }>(
    '/api/admin/conversation-templates/:templateId',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        await templates.remove(actor.userId, request.params.templateId);
        return reply.code(204).send();
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
}

function writableActor(
  database: SessionLookup,
  request: Parameters<typeof protectedManagementAdmin>[1],
  reply: Parameters<typeof protectedManagementAdmin>[2],
  publicOrigin: string | undefined
) {
  if (!isAllowedOrigin(request, publicOrigin)) {
    void sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    return undefined;
  }
  const actor = protectedManagementAdmin(database, request, reply);
  if (actor === undefined) return undefined;
  if (!validCsrf(request, actor)) {
    void sendError(reply, 403, 'CSRF_INVALID');
    return undefined;
  }
  return actor;
}

function modelOptionsNodeId(query: unknown): string | undefined {
  if (query === null || typeof query !== 'object' || Array.isArray(query)) return undefined;
  const record = query as Record<string, unknown>;
  if (Object.keys(record).length !== 1) return undefined;
  const nodeId = record['nodeId'];
  return typeof nodeId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(nodeId)
    ? nodeId
    : undefined;
}
