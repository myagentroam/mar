import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, type ZodType } from 'zod';
import {
  toolResultResourceInputSchema,
  toolResultResourcePageSchema,
  hostedConversationConfigUpdateInputSchema,
  hostedConversationCreateInputSchema,
  hostedConversationDeleteResultSchema,
  hostedConversationDirectoryPageSchema,
  hostedConversationFileDeleteInputSchema,
  hostedConversationFileDeleteResultSchema,
  hostedConversationFileReadInputSchema,
  hostedConversationFileReadResultSchema,
  hostedConversationHistoryInputSchema,
  hostedConversationHistoryPageSchema,
  hostedConversationIdInputSchema,
  hostedConversationImageReadInputSchema,
  hostedConversationListInputSchema,
  hostedConversationListPageSchema,
  hostedConversationMessageInputSchema,
  hostedConversationMetadataUpdateInputSchema,
  hostedConversationRollbackInputSchema,
  hostedConversationSnapshotSchema,
  hostedConversationUnwatchInputSchema,
  hostedConversationUploadChunkInputSchema,
  hostedConversationUploadControlInputSchema,
  hostedConversationUploadCreateInputSchema,
  hostedConversationUploadPreflightInputSchema,
  hostedConversationWatchInputSchema,
  type ConversationFileProjection,
  type ConversationTemplateSummary,
  type HostedConversationListInput,
  type HostedConversationSnapshot,
  type MarAgentRuntimeModelConfiguration
} from '@myagentroam/protocol';
import { isAllowedOrigin } from './auth.js';
import type { CurrentUserSession } from './session.js';
import type { SessionLookup } from './session.js';
import type { HostedNodeControl } from './hosted-contracts.js';
import type { ConversationTemplateService } from './conversation-template-service.js';
import { HostedConversationDirectoryService } from './hosted-conversation-directory-service.js';
import type { MarAgentModelService } from './mar-agent-model-service.js';
import type { MarAgentRuntimeModelService } from './mar-agent-runtime-model-service.js';
import {
  fileContentChunks,
  fileContentType,
  parseHttpByteRange,
  sendFileContentHead,
  type FileContentChunk
} from './file-content-stream.js';
import { databaseError } from './domain-errors.js';
import { protectedAdmin, validCsrf } from './session.js';
import { sendError } from './http-errors.js';
import { parseBoundedInteger } from './workspace-http-support.js';
import { requestHostedConversationNode } from './hosted-http-support.js';

const EMPTY_BODY_SCHEMA = z.object({}).strict();
const LIST_QUERY_SCHEMA = z
  .object({
    limit: z.string().optional(),
    cursor: z.string().optional()
  })
  .strict();
const FILE_QUERY_SCHEMA = z
  .object({
    offset: z.string().optional(),
    limit: z.string().optional()
  })
  .strict();
const HISTORY_QUERY_SCHEMA = z
  .object({
    limit: z.string().optional(),
    cursor: z.string().optional()
  })
  .strict();
const FILE_CONTENT_QUERY_SCHEMA = z
  .object({
    download: z.literal('1').optional()
  })
  .strict();
const FILE_CONTENT_CHUNK_BYTES = 512 * 1024;
interface HostedRouteDependencies {
  readonly app: FastifyInstance;
  readonly database: SessionLookup;
  readonly templates: ConversationTemplateService;
  readonly models: MarAgentModelService;
  readonly marAgentRuntimeModels?: MarAgentRuntimeModelService;
  readonly nodeControl: HostedNodeControl;
  readonly publicOrigin: string | undefined;
}

interface ExistingConversationAuthorization {
  readonly snapshot: HostedConversationSnapshot;
  readonly modelCatalog: readonly MarAgentRuntimeModelConfiguration[];
  readonly runtime: Awaited<ReturnType<typeof hostedRuntimeModels>>;
  readonly workspaceId?: string;
}

interface HostedFileContentChunk extends FileContentChunk {
  readonly file: ConversationFileProjection;
}

export function registerHostedConversationRoutes(input: HostedRouteDependencies): void {
  const { app, database, templates, models, marAgentRuntimeModels, nodeControl, publicOrigin } =
    input;
  app.get<{
    Params: { nodeId: string; conversationId: string; resourceRef: string };
    Querystring: { cursor?: string; maxBytes?: string };
  }>(
    '/api/nodes/:nodeId/hosted-conversations/:conversationId/tool-resources/:resourceRef',
    async (request, reply) => {
      const actor = protectedAdmin(database, request, reply);
      if (actor === undefined) return;
      reply.header('cache-control', 'private, no-store');
      const parsed = toolResultResourceInputSchema.safeParse({
        resourceRef: request.params.resourceRef,
        ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
        ...(request.query.maxBytes === undefined
          ? {}
          : { maxBytes: Number(request.query.maxBytes) })
      });
      if (!parsed.success) return sendError(reply, 400, 'TOOL_RESOURCE_INPUT_INVALID');
      try {
        await authorizeExistingConversation(input, actor, request.params);
        const result = await requestHostedConversationNode(
          nodeControl,
          actor,
          request.params.nodeId,
          'conversation.hosted.tool-resource.read',
          { conversationId: request.params.conversationId, ...parsed.data }
        );
        return reply.send(toolResultResourcePageSchema.parse(result));
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  const authorizeHostedConversation = async (
    userId: number,
    nodeId: string,
    templateId: string
  ): Promise<boolean> => {
    try {
      return (await templates.assertCanUse(userId, templateId)).nodeId === nodeId;
    } catch {
      return false;
    }
  };
  const directory = new HostedConversationDirectoryService(
    nodeControl,
    authorizeHostedConversation
  );

  app.get<{
    Querystring: { limit?: string; cursor?: string };
  }>('/api/hosted-conversations', async (request, reply) => {
    const actor = protectedAdmin(database, request, reply);
    if (actor === undefined) return;
    try {
      return reply.send(
        hostedConversationDirectoryPageSchema.parse(
          await directory.list(actor, parseHostedConversationListQuery(request.query))
        )
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.get<{
    Params: { nodeId: string };
    Querystring: { limit?: string; cursor?: string };
  }>('/api/nodes/:nodeId/hosted-conversations', async (request, reply) => {
    const actor = protectedAdmin(database, request, reply);
    if (actor === undefined) return;
    try {
      const data = parseHostedConversationListQuery(request.query);
      return reply.send(
        hostedConversationListPageSchema.parse(
          await directory.listNode(actor, request.params.nodeId, data)
        )
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.post<{
    Params: { nodeId: string };
    Body: unknown;
  }>('/api/nodes/:nodeId/hosted-conversations', async (request, reply) => {
    const actor = writableActor(database, request, reply, publicOrigin);
    if (actor === undefined) return;
    try {
      const data = parsePublic(hostedConversationCreateInputSchema, request.body);
      const template = await templates.requireForCreate(actor.userId, data.templateId);
      if (template.nodeId !== request.params.nodeId)
        throw new Error('CONVERSATION_TEMPLATE_NOT_AUTHORIZED');
      const templateRuntime =
        marAgentRuntimeModels === undefined
          ? undefined
          : await templates.runtimeContext(actor.userId, data.templateId);
      if (
        templateRuntime !== undefined &&
        (templateRuntime.template.id !== template.id ||
          templateRuntime.nodeId !== request.params.nodeId)
      )
        throw new Error('CONVERSATION_TEMPLATE_NOT_AUTHORIZED');
      const runtime = await hostedRuntimeModels({
        userId: actor.userId,
        nodeId: request.params.nodeId,
        ...(templateRuntime === undefined ? {} : { workspaceId: templateRuntime.workspaceId }),
        models,
        ...(marAgentRuntimeModels === undefined ? {} : { marAgentRuntimeModels })
      });
      const result = await requestHostedConversationNode(
        nodeControl,
        actor,
        request.params.nodeId,
        'conversation.hosted.create',
        {
          ...data,
          __template: template,
          ...hostedRuntimePayload(runtime)
        }
      );
      return reply.code(201).send(hostedConversationSnapshotSchema.parse(result));
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.get<{
    Params: { nodeId: string; conversationId: string };
  }>('/api/nodes/:nodeId/hosted-conversations/:conversationId', async (request, reply) => {
    const actor = protectedAdmin(database, request, reply);
    if (actor === undefined) return;
    try {
      const authorized = await authorizeExistingConversation(input, actor, request.params);
      return reply.send(authorized.snapshot);
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.get<{
    Params: { nodeId: string; conversationId: string };
    Querystring: { limit?: string; cursor?: string };
  }>('/api/nodes/:nodeId/hosted-conversations/:conversationId/history', async (request, reply) => {
    const actor = protectedAdmin(database, request, reply);
    if (actor === undefined) return;
    try {
      const query = HISTORY_QUERY_SCHEMA.parse(request.query);
      const data = hostedConversationHistoryInputSchema.parse({
        conversationId: request.params.conversationId,
        ...(query.limit === undefined ? {} : { limit: parseBoundedInteger(query.limit, 1, 100) }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor })
      });
      await authorizeExistingConversation(input, actor, request.params);
      const result = await requestHostedConversationNode(
        nodeControl,
        actor,
        request.params.nodeId,
        'conversation.hosted.history',
        data
      );
      return reply.send(hostedConversationHistoryPageSchema.parse(result));
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.patch<{
    Params: { nodeId: string; conversationId: string };
    Body: unknown;
  }>('/api/nodes/:nodeId/hosted-conversations/:conversationId', async (request, reply) => {
    const actor = writableActor(database, request, reply, publicOrigin);
    if (actor === undefined) return;
    try {
      const data = parseBodyWithPath(hostedConversationMetadataUpdateInputSchema, request.body, {
        conversationId: request.params.conversationId
      });
      await authorizeExistingConversation(input, actor, request.params);
      return reply.send(
        await requestHostedConversationNode(
          nodeControl,
          actor,
          request.params.nodeId,
          'conversation.hosted.metadata.update',
          data
        )
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.post<{
    Params: { nodeId: string; conversationId: string };
    Body: unknown;
  }>('/api/nodes/:nodeId/hosted-conversations/:conversationId/watch', async (request, reply) => {
    const actor = writableActor(database, request, reply, publicOrigin);
    if (actor === undefined) return;
    try {
      const data = parseBodyWithPath(hostedConversationWatchInputSchema, request.body, {
        conversationId: request.params.conversationId
      });
      if (!nodeControl.ownsWorkbenchConnection(actor.sessionHash, data.workbenchConnectionId))
        throw new Error('HOSTED_CONVERSATION_INPUT_INVALID');
      const authorized = await authorizeExistingConversation(input, actor, request.params);
      const runtime = await hostedRuntimeModels({
        userId: actor.userId,
        nodeId: request.params.nodeId,
        ...(authorized.workspaceId === undefined ? {} : { workspaceId: authorized.workspaceId }),
        sessionId: authorized.snapshot.conversation.sessionId,
        models,
        ...(marAgentRuntimeModels === undefined ? {} : { marAgentRuntimeModels })
      });
      const result = await requestHostedConversationNode(
        nodeControl,
        actor,
        request.params.nodeId,
        'conversation.hosted.watch',
        {
          ...data,
          ...hostedRuntimePayload(runtime)
        }
      );
      return data.mode === 'renew' ? reply.code(204).send() : reply.send(result);
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.delete<{
    Params: { nodeId: string; conversationId: string };
    Body: unknown;
  }>('/api/nodes/:nodeId/hosted-conversations/:conversationId/watch', async (request, reply) => {
    const actor = writableActor(database, request, reply, publicOrigin);
    if (actor === undefined) return;
    try {
      const data = parseBodyWithPath(hostedConversationUnwatchInputSchema, request.body, {
        conversationId: request.params.conversationId
      });
      if (!nodeControl.ownsWorkbenchConnection(actor.sessionHash, data.workbenchConnectionId))
        throw new Error('HOSTED_CONVERSATION_INPUT_INVALID');
      await authorizeExistingConversation(input, actor, request.params);
      return reply.send(
        await requestHostedConversationNode(
          nodeControl,
          actor,
          request.params.nodeId,
          'conversation.hosted.unwatch',
          data
        )
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.post<{
    Params: { nodeId: string; conversationId: string };
    Body: unknown;
  }>('/api/nodes/:nodeId/hosted-conversations/:conversationId/messages', async (request, reply) => {
    const actor = writableActor(database, request, reply, publicOrigin);
    if (actor === undefined) return;
    try {
      const data = parseBodyWithPath(hostedConversationMessageInputSchema, request.body, {
        conversationId: request.params.conversationId
      });
      const authorized = await authorizeExistingConversation(input, actor, request.params);
      const requestedModelId = data.modelId ?? authorized.snapshot.conversation.modelId;
      const runtime = await hostedRuntimeModels({
        userId: actor.userId,
        nodeId: request.params.nodeId,
        ...(authorized.workspaceId === undefined ? {} : { workspaceId: authorized.workspaceId }),
        sessionId: authorized.snapshot.conversation.sessionId,
        ...(authorized.modelCatalog.some((candidate) => candidate.id === requestedModelId)
          ? { selectedModelId: requestedModelId }
          : {}),
        models,
        ...(marAgentRuntimeModels === undefined ? {} : { marAgentRuntimeModels })
      });
      return reply.send(
        await requestHostedConversationNode(
          nodeControl,
          actor,
          request.params.nodeId,
          'conversation.hosted.message',
          {
            ...data,
            ...hostedRuntimePayload(runtime)
          }
        )
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.post<{
    Params: { nodeId: string; conversationId: string };
    Body: unknown;
  }>('/api/nodes/:nodeId/hosted-conversations/:conversationId/rollback', async (request, reply) => {
    const actor = writableActor(database, request, reply, publicOrigin);
    if (actor === undefined) return;
    try {
      const data = parseBodyWithPath(hostedConversationRollbackInputSchema, request.body, {
        conversationId: request.params.conversationId
      });
      const authorized = await authorizeExistingConversation(input, actor, request.params);
      const snapshot = hostedConversationSnapshotSchema.parse(
        await requestHostedConversationNode(
          nodeControl,
          actor,
          request.params.nodeId,
          'conversation.hosted.rollback',
          {
            ...data,
            ...hostedRuntimePayload(authorized.runtime)
          }
        )
      );
      assertHostedSnapshotIdentity(snapshot, request.params);
      if (
        snapshot.conversation.templateId !== authorized.snapshot.conversation.templateId ||
        snapshot.conversation.sessionId !== authorized.snapshot.conversation.sessionId
      )
        throw new Error('HOSTED_CONVERSATION_NOT_AUTHORIZED');
      return reply.send(snapshot);
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.post<{
    Params: { nodeId: string; conversationId: string };
    Body: unknown;
  }>(
    '/api/nodes/:nodeId/hosted-conversations/:conversationId/interrupt',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        parsePublic(EMPTY_BODY_SCHEMA, request.body ?? {});
        await authorizeExistingConversation(input, actor, request.params);
        return reply.send(
          await requestHostedConversationNode(
            nodeControl,
            actor,
            request.params.nodeId,
            'conversation.hosted.interrupt',
            hostedConversationIdInputSchema.parse({
              conversationId: request.params.conversationId
            })
          )
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.patch<{
    Params: { nodeId: string; conversationId: string };
    Body: unknown;
  }>('/api/nodes/:nodeId/hosted-conversations/:conversationId/config', async (request, reply) => {
    const actor = writableActor(database, request, reply, publicOrigin);
    if (actor === undefined) return;
    try {
      const data = parseBodyWithPath(hostedConversationConfigUpdateInputSchema, request.body, {
        conversationId: request.params.conversationId
      });
      const authorized = await authorizeExistingConversation(input, actor, request.params);
      const runtime = await hostedRuntimeModels({
        userId: actor.userId,
        nodeId: request.params.nodeId,
        ...(authorized.workspaceId === undefined ? {} : { workspaceId: authorized.workspaceId }),
        sessionId: authorized.snapshot.conversation.sessionId,
        selectedModelId: data.modelId ?? authorized.snapshot.conversation.modelId,
        models,
        ...(marAgentRuntimeModels === undefined ? {} : { marAgentRuntimeModels })
      });
      return reply.send(
        await requestHostedConversationNode(
          nodeControl,
          actor,
          request.params.nodeId,
          'conversation.hosted.config.update',
          {
            ...data,
            ...hostedRuntimePayload(runtime)
          }
        )
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.get<{
    Params: { nodeId: string; conversationId: string; runId: string; imageRef: string };
  }>(
    '/api/nodes/:nodeId/hosted-conversations/:conversationId/runs/:runId/images/:imageRef',
    async (request, reply) => {
      const actor = protectedAdmin(database, request, reply);
      if (actor === undefined) return;
      reply.header('cache-control', 'private, no-store');
      const parsed = hostedConversationImageReadInputSchema.safeParse({
        conversationId: request.params.conversationId,
        runId: request.params.runId,
        imageRef: request.params.imageRef
      });
      if (!parsed.success) return sendError(reply, 400, 'RUN_IMAGE_INVALID');
      try {
        await authorizeExistingConversation(input, actor, request.params);
        const result = (await requestHostedConversationNode(
          nodeControl,
          actor,
          request.params.nodeId,
          'conversation.hosted.image.read',
          parsed.data
        )) as { readonly image?: { readonly mime?: unknown; readonly dataBase64?: unknown } };
        if (
          typeof result.image?.mime !== 'string' ||
          !result.image.mime.startsWith('image/') ||
          typeof result.image.dataBase64 !== 'string'
        )
          return sendError(reply, 502, 'RUN_IMAGE_INVALID');
        return reply
          .header('cache-control', 'private, no-store')
          .type(result.image.mime)
          .send(Buffer.from(result.image.dataBase64, 'base64'));
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.get<{
    Params: { nodeId: string; conversationId: string };
  }>('/api/nodes/:nodeId/hosted-conversations/:conversationId/files', async (request, reply) => {
    const actor = protectedAdmin(database, request, reply);
    if (actor === undefined) return;
    try {
      await authorizeExistingConversation(input, actor, request.params);
      return reply.send(
        await requestHostedConversationNode(
          nodeControl,
          actor,
          request.params.nodeId,
          'conversation.hosted.files.list',
          hostedConversationIdInputSchema.parse({
            conversationId: request.params.conversationId
          })
        )
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.get<{
    Params: { nodeId: string; conversationId: string; fileId: string };
    Querystring: { download?: string };
  }>(
    '/api/nodes/:nodeId/hosted-conversations/:conversationId/files/:fileId/content',
    async (request, reply) => {
      const actor = protectedAdmin(database, request, reply);
      if (actor === undefined) return;
      try {
        const query = parsePublic(FILE_CONTENT_QUERY_SCHEMA, request.query);
        await authorizeExistingConversation(input, actor, request.params);
        const first = await readHostedFileContentChunk({
          nodeControl,
          actor,
          nodeId: request.params.nodeId,
          conversationId: request.params.conversationId,
          fileId: request.params.fileId,
          offset: 0,
          limit: 1
        });
        const range = parseHttpByteRange(request.headers.range, first.size);
        if (range === null) return sendError(reply, 416, 'FILE_RANGE_INVALID');
        const start = range?.start ?? 0;
        const end = range?.end ?? first.size - 1;
        const length = first.size === 0 ? 0 : end - start + 1;
        let firstContent: HostedFileContentChunk | undefined;
        if (request.method !== 'HEAD' && length > 0) {
          firstContent = await readHostedFileContentChunk({
            nodeControl,
            actor,
            nodeId: request.params.nodeId,
            conversationId: request.params.conversationId,
            fileId: request.params.fileId,
            offset: start,
            limit: Math.min(FILE_CONTENT_CHUNK_BYTES, length)
          });
          if (!sameHostedFileProjection(first.file, firstContent.file))
            throw new Error('NODE_RESPONSE_INVALID');
        }
        const contentType = fileContentType(first.file.relativePath);
        const disposition = query.download === '1' ? 'attachment' : 'inline';
        reply
          .header('accept-ranges', 'bytes')
          .header('cache-control', 'private, no-store')
          .header('content-type', contentType)
          .header(
            'content-disposition',
            `${disposition}; filename*=UTF-8''${encodeURIComponent(first.file.displayName)}`
          )
          .header('x-content-type-options', 'nosniff');
        if (contentType === 'image/svg+xml') reply.header('content-security-policy', 'sandbox');
        if (range !== undefined && first.size > 0)
          reply.code(206).header('content-range', `bytes ${start}-${end}/${first.size}`);
        if (request.method === 'HEAD') return sendFileContentHead(reply, length);
        return reply.header('content-length', String(length)).send(
          Readable.from(
            fileContentChunks(
              async (offset, limit) => {
                if (firstContent !== undefined) {
                  const content = firstContent;
                  firstContent = undefined;
                  return content;
                }
                const content = await readHostedFileContentChunk({
                  nodeControl,
                  actor,
                  nodeId: request.params.nodeId,
                  conversationId: request.params.conversationId,
                  fileId: request.params.fileId,
                  offset,
                  limit
                });
                if (!sameHostedFileProjection(first.file, content.file))
                  throw new Error('NODE_RESPONSE_INVALID');
                return content;
              },
              start,
              end,
              FILE_CONTENT_CHUNK_BYTES
            )
          )
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.get<{
    Params: { nodeId: string; conversationId: string; fileId: string };
    Querystring: { offset?: string; limit?: string };
  }>(
    '/api/nodes/:nodeId/hosted-conversations/:conversationId/files/:fileId',
    async (request, reply) => {
      const actor = protectedAdmin(database, request, reply);
      if (actor === undefined) return;
      try {
        const query = parsePublic(FILE_QUERY_SCHEMA, request.query);
        const offset =
          query.offset === undefined
            ? undefined
            : parseBoundedInteger(query.offset, 0, Number.MAX_SAFE_INTEGER);
        const limit =
          query.limit === undefined ? undefined : parseBoundedInteger(query.limit, 1, 512 * 1024);
        if (
          (query.offset !== undefined && offset === undefined) ||
          (query.limit !== undefined && limit === undefined)
        )
          throw new Error('HOSTED_CONVERSATION_INPUT_INVALID');
        await authorizeExistingConversation(input, actor, request.params);
        const data = hostedConversationFileReadInputSchema.parse({
          conversationId: request.params.conversationId,
          fileId: request.params.fileId,
          ...(offset === undefined ? {} : { offset }),
          ...(limit === undefined ? {} : { limit })
        });
        return reply.send(
          await requestHostedConversationNode(
            nodeControl,
            actor,
            request.params.nodeId,
            'conversation.hosted.file.read',
            data
          )
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.delete<{
    Params: { nodeId: string; conversationId: string; fileId: string };
    Body: unknown;
  }>(
    '/api/nodes/:nodeId/hosted-conversations/:conversationId/files/:fileId',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        parsePublic(EMPTY_BODY_SCHEMA, request.body ?? {});
        const data = hostedConversationFileDeleteInputSchema.parse({
          conversationId: request.params.conversationId,
          fileId: request.params.fileId
        });
        await authorizeExistingConversation(input, actor, request.params);
        return reply.send(
          hostedConversationFileDeleteResultSchema.parse(
            await requestHostedConversationNode(
              nodeControl,
              actor,
              request.params.nodeId,
              'conversation.hosted.file.delete',
              data
            )
          )
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.post<{
    Params: { nodeId: string; conversationId: string };
    Body: unknown;
  }>(
    '/api/nodes/:nodeId/hosted-conversations/:conversationId/uploads/preflight',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        const data = parseBodyWithPath(hostedConversationUploadPreflightInputSchema, request.body, {
          conversationId: request.params.conversationId
        });
        await authorizeExistingConversation(input, actor, request.params);
        return reply.send(
          await requestHostedConversationNode(
            nodeControl,
            actor,
            request.params.nodeId,
            'conversation.hosted.files.upload.preflight',
            data
          )
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.post<{
    Params: { nodeId: string; conversationId: string };
    Body: unknown;
  }>('/api/nodes/:nodeId/hosted-conversations/:conversationId/uploads', async (request, reply) => {
    const actor = writableActor(database, request, reply, publicOrigin);
    if (actor === undefined) return;
    try {
      const data = parseBodyWithPath(hostedConversationUploadCreateInputSchema, request.body, {
        conversationId: request.params.conversationId
      });
      await authorizeExistingConversation(input, actor, request.params);
      return reply.send(
        await requestHostedConversationNode(
          nodeControl,
          actor,
          request.params.nodeId,
          'conversation.hosted.files.upload.create',
          data
        )
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.post<{
    Params: { nodeId: string; conversationId: string; uploadId: string };
    Body: unknown;
  }>(
    '/api/nodes/:nodeId/hosted-conversations/:conversationId/uploads/:uploadId/chunks',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        const data = parseBodyWithPath(hostedConversationUploadChunkInputSchema, request.body, {
          conversationId: request.params.conversationId,
          uploadId: request.params.uploadId
        });
        await authorizeExistingConversation(input, actor, request.params);
        return reply.send(
          await requestHostedConversationNode(
            nodeControl,
            actor,
            request.params.nodeId,
            'conversation.hosted.files.upload.chunk',
            data
          )
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.get<{
    Params: { nodeId: string; conversationId: string; uploadId: string };
  }>(
    '/api/nodes/:nodeId/hosted-conversations/:conversationId/uploads/:uploadId',
    async (request, reply) => {
      const actor = protectedAdmin(database, request, reply);
      if (actor === undefined) return;
      try {
        await authorizeExistingConversation(input, actor, request.params);
        const data = hostedConversationUploadControlInputSchema.parse({
          conversationId: request.params.conversationId,
          uploadId: request.params.uploadId
        });
        return reply.send(
          await requestHostedConversationNode(
            nodeControl,
            actor,
            request.params.nodeId,
            'conversation.hosted.files.upload.status',
            data
          )
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  for (const action of ['complete', 'cancel'] as const) {
    app.post<{
      Params: { nodeId: string; conversationId: string; uploadId: string };
      Body: unknown;
    }>(
      `/api/nodes/:nodeId/hosted-conversations/:conversationId/uploads/:uploadId/${action}`,
      async (request, reply) => {
        const actor = writableActor(database, request, reply, publicOrigin);
        if (actor === undefined) return;
        try {
          parsePublic(EMPTY_BODY_SCHEMA, request.body ?? {});
          await authorizeExistingConversation(input, actor, request.params);
          const data = hostedConversationUploadControlInputSchema.parse({
            conversationId: request.params.conversationId,
            uploadId: request.params.uploadId
          });
          return reply.send(
            await requestHostedConversationNode(
              nodeControl,
              actor,
              request.params.nodeId,
              `conversation.hosted.files.upload.${action}`,
              data
            )
          );
        } catch (error) {
          return databaseError(reply, error);
        }
      }
    );
  }

  app.delete<{
    Params: { nodeId: string; conversationId: string };
    Body: unknown;
  }>('/api/nodes/:nodeId/hosted-conversations/:conversationId', async (request, reply) => {
    const actor = writableActor(database, request, reply, publicOrigin);
    if (actor === undefined) return;
    try {
      parsePublic(EMPTY_BODY_SCHEMA, request.body ?? {});
      await authorizeExistingConversation(input, actor, request.params);
      return reply.send(
        hostedConversationDeleteResultSchema.parse(
          await requestHostedConversationNode(
            nodeControl,
            actor,
            request.params.nodeId,
            'conversation.hosted.delete',
            hostedConversationIdInputSchema.parse({
              conversationId: request.params.conversationId
            })
          )
        )
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });
}

async function readHostedFileContentChunk(input: {
  readonly nodeControl: HostedNodeControl;
  readonly actor: CurrentUserSession;
  readonly nodeId: string;
  readonly conversationId: string;
  readonly fileId: string;
  readonly offset: number;
  readonly limit: number;
}): Promise<HostedFileContentChunk> {
  const data = hostedConversationFileReadInputSchema.parse({
    conversationId: input.conversationId,
    fileId: input.fileId,
    offset: input.offset,
    limit: input.limit
  });
  const parsed = hostedConversationFileReadResultSchema.safeParse(
    await requestHostedConversationNode(
      input.nodeControl,
      input.actor,
      input.nodeId,
      'conversation.hosted.file.read',
      data
    )
  );
  if (
    !parsed.success ||
    parsed.data.file.id !== input.fileId ||
    parsed.data.file.conversationId !== input.conversationId ||
    parsed.data.offset !== input.offset
  )
    throw new Error('NODE_RESPONSE_INVALID');
  const contentLength = Buffer.from(parsed.data.content, 'base64').length;
  const nextOffset = input.offset + contentLength;
  if (
    contentLength > input.limit ||
    nextOffset > parsed.data.file.size ||
    (parsed.data.eof
      ? parsed.data.nextOffset !== null || nextOffset !== parsed.data.file.size
      : parsed.data.nextOffset !== nextOffset)
  )
    throw new Error('NODE_RESPONSE_INVALID');
  return {
    file: parsed.data.file,
    size: parsed.data.file.size,
    offset: parsed.data.offset,
    contentBase64: parsed.data.content
  };
}

function sameHostedFileProjection(
  left: ConversationFileProjection,
  right: ConversationFileProjection
): boolean {
  return (
    left.id === right.id &&
    left.conversationId === right.conversationId &&
    left.category === right.category &&
    left.relativePath === right.relativePath &&
    left.displayName === right.displayName &&
    left.mimeType === right.mimeType &&
    left.size === right.size &&
    left.source === right.source &&
    left.turnId === right.turnId &&
    left.itemId === right.itemId &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt
  );
}

function parseHostedConversationListQuery(queryInput: unknown): HostedConversationListInput {
  const query = parsePublic(LIST_QUERY_SCHEMA, queryInput);
  const limit = query.limit === undefined ? undefined : parseBoundedInteger(query.limit, 1, 100);
  if (query.limit !== undefined && limit === undefined)
    throw new Error('HOSTED_CONVERSATION_INPUT_INVALID');
  return hostedConversationListInputSchema.parse({
    ...(limit === undefined ? {} : { limit }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor })
  });
}

async function authorizeExistingConversation(
  input: HostedRouteDependencies,
  actor: CurrentUserSession,
  identifiers: { readonly nodeId: string; readonly conversationId: string }
): Promise<ExistingConversationAuthorization> {
  const conversation = hostedConversationIdInputSchema.parse({
    conversationId: identifiers.conversationId
  });
  let template: ConversationTemplateSummary;
  let workspaceId: string | undefined;
  let runtime: Awaited<ReturnType<typeof hostedRuntimeModels>>;
  if (input.marAgentRuntimeModels === undefined) {
    runtime = await hostedRuntimeModels({
      userId: actor.userId,
      nodeId: identifiers.nodeId,
      models: input.models
    });
  } else {
    const probe = hostedConversationSnapshotSchema.parse(
      await requestHostedConversationNode(
        input.nodeControl,
        actor,
        identifiers.nodeId,
        'conversation.hosted.get',
        {
          ...conversation,
          __marAgentModels: []
        }
      )
    );
    assertHostedSnapshotIdentity(probe, identifiers);
    const context = await input.templates.runtimeContext(
      actor.userId,
      probe.conversation.templateId
    );
    if (
      context.template.id !== probe.conversation.templateId ||
      context.nodeId !== identifiers.nodeId
    )
      throw new Error('CONVERSATION_TEMPLATE_NOT_AUTHORIZED');
    template = context.template;
    workspaceId = context.workspaceId;
    runtime = await hostedRuntimeModels({
      userId: actor.userId,
      nodeId: identifiers.nodeId,
      workspaceId,
      models: input.models,
      marAgentRuntimeModels: input.marAgentRuntimeModels
    });
  }
  const modelCatalog = runtime.modelCatalog;
  let snapshot = hostedConversationSnapshotSchema.parse(
    await requestHostedConversationNode(
      input.nodeControl,
      actor,
      identifiers.nodeId,
      'conversation.hosted.get',
      {
        ...conversation,
        ...hostedRuntimePayload(runtime)
      }
    )
  );
  assertHostedSnapshotIdentity(snapshot, identifiers);
  template ??= await input.templates.assertCanUse(actor.userId, snapshot.conversation.templateId);
  if (template.id !== snapshot.conversation.templateId || template.nodeId !== identifiers.nodeId)
    throw new Error('CONVERSATION_TEMPLATE_NOT_AUTHORIZED');
  if (template.status === 'DELETED' && snapshot.template.status !== 'DELETED') {
    snapshot = hostedConversationSnapshotSchema.parse(
      await requestHostedConversationNode(
        input.nodeControl,
        actor,
        identifiers.nodeId,
        'conversation.hosted.get',
        {
          ...conversation,
          ...hostedRuntimePayload(runtime),
          __templateDeleted: true
        }
      )
    );
    if (
      snapshot.conversation.id !== identifiers.conversationId ||
      snapshot.conversation.nodeId !== identifiers.nodeId ||
      snapshot.template.id !== snapshot.conversation.templateId ||
      snapshot.template.nodeId !== identifiers.nodeId ||
      snapshot.template.status !== 'DELETED'
    )
      throw new Error('HOSTED_CONVERSATION_NOT_AUTHORIZED');
  }
  return {
    snapshot,
    modelCatalog,
    runtime,
    ...(workspaceId === undefined ? {} : { workspaceId })
  };
}

function assertHostedSnapshotIdentity(
  snapshot: HostedConversationSnapshot,
  identifiers: { readonly nodeId: string; readonly conversationId: string }
): void {
  if (
    snapshot.conversation.id !== identifiers.conversationId ||
    snapshot.conversation.nodeId !== identifiers.nodeId ||
    snapshot.template.id !== snapshot.conversation.templateId ||
    snapshot.template.nodeId !== identifiers.nodeId
  )
    throw new Error('HOSTED_CONVERSATION_NOT_AUTHORIZED');
}

async function hostedRuntimeModels(input: {
  readonly userId: number;
  readonly nodeId: string;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly selectedModelId?: string;
  readonly models: MarAgentModelService;
  readonly marAgentRuntimeModels?: MarAgentRuntimeModelService;
}): Promise<{
  readonly compact?: import('@myagentroam/protocol').MarAgentRuntimeCompactConfiguration;
  readonly runtimeScopeId?: string;
  readonly model?: MarAgentRuntimeModelConfiguration;
  readonly modelCatalog: readonly MarAgentRuntimeModelConfiguration[];
}> {
  if (input.marAgentRuntimeModels !== undefined) {
    if (input.workspaceId === undefined) throw new Error('MAR_AGENT_RUNTIME_WORKSPACE_REQUIRED');
    const prepared = await input.marAgentRuntimeModels.prepare({
      userId: input.userId,
      nodeId: input.nodeId,
      workspaceId: input.workspaceId,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.selectedModelId === undefined ? {} : { selectedModelId: input.selectedModelId })
    });
    return {
      runtimeScopeId: prepared.runtimeScopeId,
      ...(prepared.compact === undefined ? {} : { compact: prepared.compact }),
      ...(prepared.model === undefined ? {} : { model: prepared.model }),
      modelCatalog: prepared.models
    };
  }
  const modelCatalog = await input.models.runtimeConfigurationsForUser(input.userId);
  return {
    ...(input.selectedModelId === undefined
      ? {}
      : {
          model: await input.models.runtimeForUser(input.userId, input.selectedModelId)
        }),
    modelCatalog
  };
}

function hostedRuntimePayload(runtime: {
  readonly compact?: import('@myagentroam/protocol').MarAgentRuntimeCompactConfiguration;
  readonly runtimeScopeId?: string;
  readonly model?: MarAgentRuntimeModelConfiguration;
  readonly modelCatalog: readonly MarAgentRuntimeModelConfiguration[];
}): object {
  return {
    ...(runtime.runtimeScopeId === undefined
      ? {}
      : { __marAgentRuntimeScopeId: runtime.runtimeScopeId }),
    ...(runtime.model === undefined ? {} : { __marAgentModel: runtime.model }),
    __marAgentModels: runtime.modelCatalog,
    ...(runtime.compact === undefined ? {} : { __marAgentCompact: runtime.compact })
  };
}

function writableActor(
  database: SessionLookup,
  request: FastifyRequest,
  reply: FastifyReply,
  publicOrigin: string | undefined
): CurrentUserSession | undefined {
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

function parseBodyWithPath<T>(
  schema: ZodType<T>,
  raw: unknown,
  pathFields: Readonly<Record<string, string>>
): T {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('HOSTED_CONVERSATION_INPUT_INVALID');
  if (Object.keys(pathFields).some((key) => Object.hasOwn(raw, key)))
    throw new Error('HOSTED_CONVERSATION_INPUT_INVALID');
  return parsePublic(schema, { ...raw, ...pathFields });
}

function parsePublic<T>(schema: ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error('HOSTED_CONVERSATION_INPUT_INVALID');
  return parsed.data;
}
