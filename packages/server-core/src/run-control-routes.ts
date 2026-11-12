import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isAllowedOrigin } from './auth.js';
import { protectedAdmin, validCsrf } from './session.js';
import { sendError, safeErrorCode } from './http-errors.js';
import { requestUserNode } from './workspace-http-support.js';
import { SessionInputService } from './session-input-service.js';
import type { NodeRequestAuthorization } from './node-access-contracts.js';
import {
  recordSharedConversationAudit,
  sharedConversationFailureResult,
  type ConversationAuditObserver
} from './conversation-audit.js';
import type {
  SessionRunStore,
  SessionRunNodeControl,
  ProcessSecretResolver,
  MarAgentModelService,
  MarAgentRuntimeModelService
} from './session-run-contracts.js';
import { createHash } from 'node:crypto';
import { modelResourceReadInputSchema, runImageReadInputSchema } from '@myagentroam/protocol';
import type { ImagePreviewOptions } from '@myagentroam/protocol';
import {
  parseImagePreviewQuery,
  sendImageResource,
  type ImagePreviewQuery,
  type ImageResourceResponse
} from './image-resource-response.js';
import type { MarctlServerUrlForNode, MarctlUserCredentials } from './marctl-user-credentials.js';
export function registerRunControlRoutes(input: {
  readonly app: FastifyInstance;
  readonly databaseError: (reply: FastifyReply, error: unknown) => FastifyReply;
  readonly database: SessionRunStore;
  readonly authorizeNodeRequest: NodeRequestAuthorization;
  readonly nodeControl: SessionRunNodeControl;
  readonly secrets: ProcessSecretResolver;
  readonly userCredentials?: MarctlUserCredentials;
  readonly marctlServerUrlForNode?: MarctlServerUrlForNode;
  readonly marAgentModels?: MarAgentModelService;
  readonly marAgentRuntimeModels?: MarAgentRuntimeModelService;
  readonly searchBackendAvailable?: () => boolean;
  readonly audits?: ConversationAuditObserver;
  readonly publicOrigin: string | undefined;
}): void {
  const sessionInputs = new SessionInputService({ ...input, commandWorkspaceInPayload: false });
  const { app, databaseError, database, nodeControl, marAgentRuntimeModels, audits, publicOrigin } =
    input;
  const mutateWorkspaceQueue =
    (operation: 'workspace.queue.pause' | 'workspace.queue.resume' | 'workspace.queue.reorder') =>
    async (
      request: FastifyRequest<{
        Params: { workspaceId: string };
        Body: {
          nodeId?: unknown;
          sessionId?: unknown;
          expectedVersion?: unknown;
          queueItemIds?: unknown;
        };
      }>,
      reply: FastifyReply
    ) => {
      if (!isAllowedOrigin(request, publicOrigin))
        return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
      const admin = protectedAdmin(database, request, reply);
      if (admin === undefined) return;
      if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
      const body = request.body ?? {};
      if (typeof body.nodeId !== 'string') return sendError(reply, 400, 'NODE_ID_REQUIRED');
      if (typeof body.sessionId !== 'string') return sendError(reply, 400, 'SESSION_ID_REQUIRED');
      if (
        operation === 'workspace.queue.reorder' &&
        (!Number.isInteger(body.expectedVersion) ||
          !Array.isArray(body.queueItemIds) ||
          body.queueItemIds.some((id) => typeof id !== 'string'))
      ) {
        await recordSharedConversationAudit({
          audits,
          eventType: 'shared_conversation_queue_reordered',
          actorUserId: admin.userId,
          nodeId: body.nodeId,
          workspaceId: request.params.workspaceId,
          errorCode: 'QUEUE_INVALID',
          result: 'DENIED',
          fallbackReceipt: { sessionId: body.sessionId, inputMode: 'REORDER_QUEUE' }
        });
        return sendError(reply, 400, 'QUEUE_INVALID');
      }
      let result: unknown;
      try {
        result = await requestUserNode(nodeControl, admin, body.nodeId, operation, {
          workspaceId: request.params.workspaceId,
          sessionId: body.sessionId,
          ...(operation === 'workspace.queue.reorder'
            ? { expectedVersion: body.expectedVersion, queueItemIds: body.queueItemIds }
            : {})
        });
      } catch (error) {
        const errorCode = safeErrorCode(error);
        await recordSharedConversationAudit({
          audits,
          eventType:
            operation === 'workspace.queue.reorder'
              ? 'shared_conversation_queue_reordered'
              : 'shared_conversation_queue_updated',
          actorUserId: admin.userId,
          nodeId: body.nodeId,
          workspaceId: request.params.workspaceId,
          errorCode,
          result: sharedConversationFailureResult(errorCode),
          fallbackReceipt: {
            sessionId: body.sessionId,
            inputMode:
              operation === 'workspace.queue.pause'
                ? 'PAUSE_QUEUE'
                : operation === 'workspace.queue.resume'
                  ? 'RESUME_QUEUE'
                  : 'REORDER_QUEUE'
          }
        });
        return databaseError(reply, error);
      }
      await recordSharedConversationAudit({
        audits,
        eventType:
          operation === 'workspace.queue.reorder'
            ? 'shared_conversation_queue_reordered'
            : 'shared_conversation_queue_updated',
        actorUserId: admin.userId,
        nodeId: body.nodeId,
        workspaceId: request.params.workspaceId,
        nodeResult: result
      });
      return reply.code(202).send(result);
    };
  const serveModelResource = async (nodeId: string, value: unknown, reply: FastifyReply) => {
    const parsed = modelResourceReadInputSchema.safeParse(value);
    if (!parsed.success) return sendError(reply, 400, 'RUN_IMAGE_INVALID');
    reply.header('cache-control', 'private, no-store');
    try {
      const result = (await nodeControl.requestNode(nodeId, 'model.resource.read', parsed.data, {
        userId: 0,
        sessionHash: 'model-resource'
      })) as { image?: { mimeType?: unknown; dataBase64?: unknown } };
      if (
        typeof result.image?.mimeType !== 'string' ||
        !result.image.mimeType.startsWith('image/') ||
        typeof result.image.dataBase64 !== 'string'
      )
        return sendError(reply, 502, 'RUN_IMAGE_INVALID');
      return reply.type(result.image.mimeType).send(Buffer.from(result.image.dataBase64, 'base64'));
    } catch (error) {
      return databaseError(reply, error);
    }
  };
  const serveResource = (
    request: FastifyRequest<{
      Params: {
        nodeId: string;
        workspaceId?: string;
        conversationId?: string;
        sessionId: string;
        resourceId: string;
      };
      Querystring: { expiresAt?: string; signature?: string };
    }>,
    reply: FastifyReply
  ) =>
    serveModelResource(
      request.params.nodeId,
      {
        ...(request.params.workspaceId === undefined
          ? { conversationId: request.params.conversationId }
          : { workspaceId: request.params.workspaceId }),
        sessionId: request.params.sessionId,
        resourceId: request.params.resourceId,
        expiresAt:
          request.query.expiresAt !== undefined && /^\d+$/u.test(request.query.expiresAt)
            ? Number(request.query.expiresAt)
            : undefined,
        signature: request.query.signature
      },
      reply
    );
  app.get(
    '/api/nodes/:nodeId/workspaces/:workspaceId/sessions/:sessionId/resources/:resourceId',
    serveResource
  );
  app.get(
    '/api/nodes/:nodeId/conversations/:conversationId/sessions/:sessionId/resources/:resourceId',
    serveResource
  );
  app.post<{
    Params: { workspaceId: string };
    Body: { nodeId?: unknown; sessionId?: unknown };
  }>('/api/workspaces/:workspaceId/queue/pause', mutateWorkspaceQueue('workspace.queue.pause'));
  app.post<{
    Params: { workspaceId: string };
    Body: { nodeId?: unknown; sessionId?: unknown };
  }>('/api/workspaces/:workspaceId/queue/resume', mutateWorkspaceQueue('workspace.queue.resume'));
  app.put<{
    Params: { workspaceId: string };
    Body: {
      nodeId?: unknown;
      sessionId?: unknown;
      expectedVersion?: unknown;
      queueItemIds?: unknown;
    };
  }>('/api/workspaces/:workspaceId/queue', mutateWorkspaceQueue('workspace.queue.reorder'));

  app.patch<{
    Params: { queueItemId: string };
    Body: { nodeId?: unknown; workspaceId?: unknown; sessionId?: unknown; content?: unknown };
  }>('/api/queue-items/:queueItemId', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    if (
      typeof request.body?.nodeId !== 'string' ||
      typeof request.body.workspaceId !== 'string' ||
      typeof request.body.sessionId !== 'string' ||
      typeof request.body.content !== 'string'
    ) {
      if (typeof request.body?.nodeId === 'string' && typeof request.body.workspaceId === 'string')
        await recordSharedConversationAudit({
          audits,
          eventType: 'shared_conversation_queue_updated',
          actorUserId: admin.userId,
          nodeId: request.body.nodeId,
          workspaceId: request.body.workspaceId,
          errorCode: 'QUEUE_INVALID',
          result: 'DENIED',
          fallbackReceipt: {
            ...(typeof request.body.sessionId === 'string'
              ? { sessionId: request.body.sessionId }
              : {}),
            queueItemId: request.params.queueItemId,
            inputMode: 'EDIT_QUEUE'
          }
        });
      return sendError(reply, 400, 'QUEUE_INVALID');
    }
    let result: unknown;
    try {
      result = await requestUserNode(
        nodeControl,
        admin,
        request.body.nodeId,
        'workspace.queue.message.update',
        {
          queueItemId: request.params.queueItemId,
          workspaceId: request.body.workspaceId,
          content: request.body.content
        },
        request.body.workspaceId
      );
    } catch (error) {
      const errorCode = safeErrorCode(error);
      await recordSharedConversationAudit({
        audits,
        eventType: 'shared_conversation_queue_updated',
        actorUserId: admin.userId,
        nodeId: request.body.nodeId,
        workspaceId: request.body.workspaceId,
        errorCode,
        result: sharedConversationFailureResult(errorCode),
        fallbackReceipt: {
          sessionId: request.body.sessionId,
          queueItemId: request.params.queueItemId,
          inputMode: 'EDIT_QUEUE'
        }
      });
      return databaseError(reply, error);
    }
    await recordSharedConversationAudit({
      audits,
      eventType: 'shared_conversation_queue_updated',
      actorUserId: admin.userId,
      nodeId: request.body.nodeId,
      workspaceId: request.body.workspaceId,
      userMessage: request.body.content,
      nodeResult: result
    });
    return reply.code(202).send(result);
  });
  app.delete<{
    Params: { queueItemId: string };
    Body: { nodeId?: unknown; workspaceId?: unknown };
  }>('/api/queue-items/:queueItemId', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    if (typeof request.body?.nodeId !== 'string' || typeof request.body.workspaceId !== 'string')
      return sendError(reply, 400, 'NODE_ID_REQUIRED');
    let result: unknown;
    try {
      result = await requestUserNode(
        nodeControl,
        admin,
        request.body.nodeId,
        'workspace.queue.message.delete',
        {
          queueItemId: request.params.queueItemId,
          workspaceId: request.body.workspaceId
        },
        request.body.workspaceId
      );
    } catch (error) {
      const errorCode = safeErrorCode(error);
      await recordSharedConversationAudit({
        audits,
        eventType: 'shared_conversation_queue_deleted',
        actorUserId: admin.userId,
        nodeId: request.body.nodeId,
        workspaceId: request.body.workspaceId,
        errorCode,
        result: sharedConversationFailureResult(errorCode),
        fallbackReceipt: {
          queueItemId: request.params.queueItemId,
          inputMode: 'DELETE_QUEUE'
        }
      });
      return databaseError(reply, error);
    }
    await recordSharedConversationAudit({
      audits,
      eventType: 'shared_conversation_queue_deleted',
      actorUserId: admin.userId,
      nodeId: request.body.nodeId,
      workspaceId: request.body.workspaceId,
      nodeResult: result
    });
    return reply.code(202).send(result);
  });

  app.post<{
    Params: { queueItemId: string };
    Body: { nodeId?: unknown; workspaceId?: unknown };
  }>('/api/queue-items/:queueItemId/execute', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    if (typeof request.body?.nodeId !== 'string' || typeof request.body.workspaceId !== 'string')
      return sendError(reply, 400, 'NODE_ID_REQUIRED');
    let result: unknown;
    try {
      result = await requestUserNode(
        nodeControl,
        admin,
        request.body.nodeId,
        'workspace.queue.message.execute',
        {
          queueItemId: request.params.queueItemId,
          workspaceId: request.body.workspaceId
        },
        request.body.workspaceId
      );
    } catch (error) {
      const errorCode = safeErrorCode(error);
      await recordSharedConversationAudit({
        audits,
        eventType: 'shared_conversation_queue_execute_requested',
        actorUserId: admin.userId,
        nodeId: request.body.nodeId,
        workspaceId: request.body.workspaceId,
        errorCode,
        result: sharedConversationFailureResult(errorCode),
        fallbackReceipt: {
          queueItemId: request.params.queueItemId,
          inputMode: 'EXECUTE_QUEUE'
        }
      });
      return databaseError(reply, error);
    }
    await recordSharedConversationAudit({
      audits,
      eventType: 'shared_conversation_queue_execute_requested',
      actorUserId: admin.userId,
      nodeId: request.body.nodeId,
      workspaceId: request.body.workspaceId,
      nodeResult: result
    });
    return reply.code(202).send(result);
  });

  app.post<{
    Params: { sessionId: string };
    Body: {
      nodeId?: unknown;
      workspaceId?: unknown;
      commandId?: unknown;
      input?: unknown;
      modelId?: unknown;
    };
  }>('/api/agent-sessions/:sessionId/commands', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    const body = request.body ?? {};
    if (
      typeof body.nodeId !== 'string' ||
      typeof body.commandId !== 'string' ||
      body.commandId.length === 0 ||
      typeof body.input !== 'string' ||
      body.input.length < 2 ||
      body.input.length > 20_000 ||
      Object.hasOwn(body, 'model') ||
      (typeof body.modelId === 'string' &&
        marAgentRuntimeModels !== undefined &&
        typeof body.workspaceId !== 'string')
    )
      return sendError(reply, 400, 'RUNNER_COMMAND_INVALID');
    try {
      return reply.code(202).send(
        await sessionInputs.executeCommand(
          {
            nodeId: body.nodeId,
            sessionId: request.params.sessionId,
            user: admin,
            ...(typeof body.workspaceId === 'string' ? { workspaceId: body.workspaceId } : {})
          },
          {
            commandId: body.commandId,
            input: body.input,
            ...(typeof body.modelId === 'string' ? { modelId: body.modelId } : {})
          }
        )
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.post<{ Body: { nodeId?: unknown; runner?: unknown; commandId?: unknown; input?: unknown } }>(
    '/api/runner-commands',
    async (request, reply) => {
      if (!isAllowedOrigin(request, publicOrigin))
        return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
      const admin = protectedAdmin(database, request, reply);
      if (admin === undefined) return;
      if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
      const body = request.body ?? {};
      if (
        typeof body.nodeId !== 'string' ||
        typeof body.runner !== 'string' ||
        typeof body.commandId !== 'string' ||
        typeof body.input !== 'string'
      )
        return sendError(reply, 400, 'RUNNER_COMMAND_INVALID');
      try {
        return reply.code(202).send(
          await requestUserNode(nodeControl, admin, body.nodeId, 'runner.command.execute', {
            runner: body.runner,
            commandId: body.commandId,
            input: body.input
          })
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.get<{ Params: { runId: string }; Querystring: { nodeId?: string } }>(
    '/api/agent-runs/:runId',
    async (request, reply) => {
      const admin = protectedAdmin(database, request, reply);
      if (admin === undefined) return;
      if (typeof request.query.nodeId !== 'string')
        return sendError(reply, 400, 'NODE_ID_REQUIRED');
      try {
        return reply.send(
          await requestUserNode(nodeControl, admin, request.query.nodeId, 'run.get', {
            runId: request.params.runId
          })
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.get<{
    Params: { runId: string; imageSelector: string };
    Querystring: { nodeId?: string } & ImagePreviewQuery;
  }>('/api/agent-runs/:runId/images/:imageSelector', async (request, reply) => {
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (typeof request.query.nodeId !== 'string') return sendError(reply, 400, 'NODE_ID_REQUIRED');
    if (request.params.runId.startsWith('native-history:hosted:'))
      return sendError(reply, 400, 'RUN_IMAGE_INVALID');
    const native = request.params.runId.startsWith('native-history:');
    if (native) reply.header('cache-control', 'private, no-store');
    const preview = parseImagePreviewQuery(request.query);
    if (!preview.success) return sendError(reply, 400, 'RUN_IMAGE_INVALID');
    const parsed = runImageReadInputSchema.safeParse({
      runId: request.params.runId,
      ...(preview.data === undefined ? {} : { preview: preview.data }),
      ...(native
        ? { imageRef: request.params.imageSelector }
        : { imageIndex: Number(request.params.imageSelector) })
    });
    if (!parsed.success) return sendError(reply, 400, 'RUN_IMAGE_INVALID');
    const requestData = parsed.data;
    const etag =
      'imageIndex' in requestData
        ? runImageEtag(
            request.query.nodeId,
            request.params.runId,
            requestData.imageIndex,
            requestData.preview
          )
        : undefined;
    try {
      if (
        etag !== undefined &&
        request.headers['if-none-match']?.split(',').some((value) => value.trim() === etag)
      ) {
        const allowed = await input.authorizeNodeRequest(
          admin.userId,
          request.query.nodeId,
          'run.image.read',
          requestData
        );
        if (!allowed) throw new Error('NODE_ACCESS_DENIED');
        return reply
          .header('cache-control', 'private, max-age=3600, must-revalidate')
          .header('etag', etag)
          .code(304)
          .send();
      }
      const result = (await requestUserNode(
        nodeControl,
        admin,
        request.query.nodeId,
        'run.image.read',
        requestData
      )) as ImageResourceResponse;
      if (etag !== undefined) {
        reply
          .header('cache-control', 'private, max-age=3600, must-revalidate')
          .header('etag', etag);
      }
      return sendImageResource(reply, result, preview.data !== undefined);
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.post<{
    Params: { runId: string; requestId: string };
    Body: { nodeId?: unknown; answers?: unknown };
  }>('/api/agent-runs/:runId/user-input/:requestId', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    if (
      typeof request.body?.nodeId !== 'string' ||
      typeof request.body.answers !== 'object' ||
      request.body.answers === null
    )
      return sendError(reply, 400, 'USER_INPUT_INVALID');
    try {
      const result = await requestUserNode(
        nodeControl,
        admin,
        request.body.nodeId,
        'run.user-input.respond',
        {
          runId: request.params.runId,
          requestId: request.params.requestId,
          answers: request.body.answers
        }
      );
      return reply.send(result);
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  const mutateRun =
    (action: 'run.cancel' | 'run.interrupt') =>
    async (
      request: FastifyRequest<{ Params: { runId: string }; Body: { nodeId?: unknown } }>,
      reply: FastifyReply
    ) => {
      if (!isAllowedOrigin(request, publicOrigin))
        return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
      const admin = protectedAdmin(database, request, reply);
      if (admin === undefined) return;
      if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
      const nodeId = request.body?.nodeId;
      if (typeof nodeId !== 'string') return sendError(reply, 400, 'NODE_ID_REQUIRED');
      try {
        const result = await requestUserNode(nodeControl, admin, nodeId, action, {
          runId: request.params.runId
        });
        return reply.code(202).send(result);
      } catch (error) {
        return databaseError(reply, error);
      }
    };
  app.post<{ Params: { runId: string }; Body: { nodeId?: unknown } }>(
    '/api/agent-runs/:runId/cancel',
    mutateRun('run.cancel')
  );
  app.post<{ Params: { runId: string }; Body: { nodeId?: unknown } }>(
    '/api/agent-runs/:runId/interrupt',
    mutateRun('run.interrupt')
  );
  app.post<{ Params: { sessionId: string }; Body: { nodeId?: unknown } }>(
    '/api/agent-sessions/:sessionId/interrupt',
    async (request, reply) => {
      if (!isAllowedOrigin(request, publicOrigin))
        return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
      const admin = protectedAdmin(database, request, reply);
      if (admin === undefined) return;
      if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
      const nodeId = request.body?.nodeId;
      if (typeof nodeId !== 'string') return sendError(reply, 400, 'NODE_ID_REQUIRED');
      try {
        const result = await sessionInputs.interrupt({
          nodeId,
          sessionId: request.params.sessionId,
          user: admin
        });
        return reply.code(202).send(result);
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.post<{
    Params: { runId: string; approvalId: string };
    Body: { nodeId?: unknown; decision?: unknown };
  }>('/api/agent-runs/:runId/approvals/:approvalId/decision', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    const decision = request.body?.decision;
    if (decision !== 'APPROVED' && decision !== 'REJECTED') {
      return sendError(reply, 400, 'APPROVAL_DECISION_INVALID');
    }
    const nodeId = request.body?.nodeId;
    if (typeof nodeId !== 'string') return sendError(reply, 400, 'NODE_ID_REQUIRED');
    try {
      const result = await requestUserNode(nodeControl, admin, nodeId, 'run.approval.decide', {
        runId: request.params.runId,
        approvalId: request.params.approvalId,
        decision
      });
      return reply.send(result);
    } catch (error) {
      return databaseError(reply, error);
    }
  });
}

function runImageEtag(
  nodeId: string,
  runId: string,
  imageIndex: number,
  preview?: ImagePreviewOptions
): string {
  const digest = createHash('sha256')
    .update(
      `${nodeId}\0${runId}\0${imageIndex}${preview === undefined ? '' : `\0preview-v1:${preview.maxWidth}x${preview.maxHeight}`}`
    )
    .digest('base64url');
  return `"${digest}"`;
}
