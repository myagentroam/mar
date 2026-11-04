import type { FastifyInstance, FastifyReply } from 'fastify';
import { toolResultResourceInputSchema, toolResultResourcePageSchema } from '@myagentroam/protocol';
import { isAllowedOrigin } from './auth.js';
import { protectedAdmin, validCsrf } from './session.js';
import { sendError } from './http-errors.js';
import { requestUserNode, isNonEmptyString, isPlainObject } from './workspace-http-support.js';
import {
  parseWorkbenchPage,
  validComposerAttachmentIds,
  validMessageAttachments,
  validSessionEffort,
  validSessionOption,
  validSessionTitle
} from './run-http-support.js';
import {
  recordSharedConversationAudit,
  type ConversationAuditObserver
} from './conversation-audit.js';
import type {
  SessionRunStore,
  SessionRunNodeControl,
  ProcessSecretResolver,
  PersonalInstructionReader,
  MarAgentModelService,
  MarAgentRuntimeModelService
} from './session-run-contracts.js';
import { runnerNameSchema, workspaceSessionCleanupResultSchema } from '@myagentroam/protocol';
import type { MarctlUserCredentials } from './marctl-user-credentials.js';
import { requireMarAgentAutoSupport } from './mar-agent-auto-support.js';
import { SessionInputService } from './session-input-service.js';
import { prepareRunnerProfileContext } from './runner-profile-context.js';
export function registerSessionRunRoutes(input: {
  readonly app: FastifyInstance;
  readonly databaseError: (reply: FastifyReply, error: unknown) => FastifyReply;
  readonly database: SessionRunStore;
  readonly nodeControl: SessionRunNodeControl;
  readonly secrets: ProcessSecretResolver;
  readonly userCredentials?: MarctlUserCredentials;
  readonly personalInstructions?: PersonalInstructionReader;
  readonly marAgentModels?: MarAgentModelService;
  readonly marAgentRuntimeModels?: MarAgentRuntimeModelService;
  readonly audits?: ConversationAuditObserver;
  readonly publicOrigin: string | undefined;
}): void {
  const { app, databaseError, database, nodeControl, secrets, audits, publicOrigin } = input;
  const sessionInputs = new SessionInputService(input);
  app.get<{
    Params: { sessionId: string; resourceRef: string };
    Querystring: { nodeId?: string; workspaceId?: string; cursor?: string; maxBytes?: string };
  }>('/api/agent-sessions/:sessionId/tool-resources/:resourceRef', async (request, reply) => {
    const actor = protectedAdmin(database, request, reply);
    if (actor === undefined) return;
    reply.header('cache-control', 'private, no-store');
    if (!isNonEmptyString(request.query.nodeId)) return sendError(reply, 400, 'NODE_ID_REQUIRED');
    if (!isNonEmptyString(request.query.workspaceId) || request.query.workspaceId.length > 128)
      return sendError(reply, 400, 'WORKSPACE_ID_REQUIRED');
    const parsed = toolResultResourceInputSchema.safeParse({
      resourceRef: request.params.resourceRef,
      ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
      ...(request.query.maxBytes === undefined ? {} : { maxBytes: Number(request.query.maxBytes) })
    });
    if (!parsed.success) return sendError(reply, 400, 'TOOL_RESOURCE_INPUT_INVALID');
    try {
      const result = await requestUserNode(
        nodeControl,
        actor,
        request.query.nodeId,
        'session.tool-resource.read',
        {
          workspaceId: request.query.workspaceId,
          sessionId: request.params.sessionId,
          ...parsed.data
        }
      );
      return reply.send(toolResultResourcePageSchema.parse(result));
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.get<{
    Params: { sessionId: string };
    Querystring: { nodeId?: string; workspaceId?: string; occurrencePage?: string };
  }>('/api/agent-sessions/:sessionId/schedule', async (request, reply) => {
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!isNonEmptyString(request.query.nodeId) || !isNonEmptyString(request.query.workspaceId))
      return sendError(reply, 400, 'SCHEDULE_INVALID');
    const rawPage = request.query.occurrencePage;
    if (
      rawPage !== undefined &&
      (typeof rawPage !== 'string' ||
        !/^[1-9][0-9]*$/.test(rawPage) ||
        !Number.isSafeInteger(Number(rawPage)))
    )
      return sendError(reply, 400, 'SCHEDULE_INVALID');
    try {
      const result = await requestUserNode(
        nodeControl,
        admin,
        request.query.nodeId,
        'session.schedule.get',
        {
          sessionId: request.params.sessionId,
          workspaceId: request.query.workspaceId,
          ...(rawPage === undefined ? {} : { occurrencePage: Number(rawPage) })
        },
        request.query.workspaceId
      );
      if (!isPlainObject(result)) return reply.send(result);
      const task = isPlainObject(result['task']) ? result['task'] : undefined;
      const ownerUserId = task?.['ownerUserId'];
      const currentUserName = (await database.userDisplayName(admin.userId)) ?? admin.username;
      const notifyUserName =
        typeof ownerUserId === 'number' && Number.isSafeInteger(ownerUserId) && ownerUserId > 0
          ? ownerUserId === admin.userId
            ? currentUserName
            : ((await database.userDisplayName(ownerUserId)) ?? null)
          : null;
      return reply.send({ ...result, currentUserName, notifyUserName });
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.put<{
    Params: { sessionId: string };
    Body: {
      nodeId?: unknown;
      workspaceId?: unknown;
      objective?: unknown;
      cron?: unknown;
      timezone?: unknown;
      enabled?: unknown;
      notifyOnTerminal?: unknown;
      expectedRevision?: unknown;
    };
  }>('/api/agent-sessions/:sessionId/schedule', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    const body = request.body ?? {};
    if (
      !isNonEmptyString(body.nodeId) ||
      !isNonEmptyString(body.workspaceId) ||
      (body.objective !== undefined &&
        (typeof body.objective !== 'string' || body.objective.length > 20_000)) ||
      (body.cron !== undefined && (typeof body.cron !== 'string' || body.cron.length > 64)) ||
      body.timezone !== undefined ||
      (body.enabled !== undefined && typeof body.enabled !== 'boolean') ||
      (body.notifyOnTerminal !== undefined && typeof body.notifyOnTerminal !== 'boolean') ||
      (body.expectedRevision !== undefined &&
        (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 1))
    )
      return sendError(reply, 400, 'SCHEDULE_INVALID');
    try {
      return reply.send(
        await requestUserNode(
          nodeControl,
          admin,
          body.nodeId,
          'session.schedule.save',
          {
            sessionId: request.params.sessionId,
            workspaceId: body.workspaceId,
            ...(body.objective === undefined ? {} : { objective: body.objective }),
            ...(body.cron === undefined ? {} : { cron: body.cron }),
            ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
            ...(body.notifyOnTerminal === undefined
              ? {}
              : { notifyOnTerminal: body.notifyOnTerminal }),
            ...(body.expectedRevision === undefined
              ? {}
              : { expectedRevision: body.expectedRevision })
          },
          body.workspaceId
        )
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.delete<{
    Params: { sessionId: string };
    Body: { nodeId?: unknown; workspaceId?: unknown; expectedRevision?: unknown };
  }>('/api/agent-sessions/:sessionId/schedule', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    const body = request.body ?? {};
    if (
      !isNonEmptyString(body.nodeId) ||
      !isNonEmptyString(body.workspaceId) ||
      !Number.isSafeInteger(body.expectedRevision) ||
      (body.expectedRevision as number) < 1
    )
      return sendError(reply, 400, 'SCHEDULE_INVALID');
    try {
      return reply.send(
        await requestUserNode(
          nodeControl,
          admin,
          body.nodeId,
          'session.schedule.remove',
          {
            sessionId: request.params.sessionId,
            workspaceId: body.workspaceId,
            expectedRevision: body.expectedRevision
          },
          body.workspaceId
        )
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.post<{
    Params: { sessionId: string; proposalId: string };
    Body: { nodeId?: unknown; workspaceId?: unknown; accept?: unknown };
  }>(
    '/api/agent-sessions/:sessionId/schedule/proposals/:proposalId/resolve',
    async (request, reply) => {
      if (!isAllowedOrigin(request, publicOrigin))
        return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
      const admin = protectedAdmin(database, request, reply);
      if (admin === undefined) return;
      if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
      const body = request.body ?? {};
      if (
        !isNonEmptyString(body.nodeId) ||
        !isNonEmptyString(body.workspaceId) ||
        typeof body.accept !== 'boolean' ||
        request.params.proposalId.length > 128
      )
        return sendError(reply, 400, 'SCHEDULE_PROPOSAL_INVALID');
      try {
        return reply.send(
          await requestUserNode(
            nodeControl,
            admin,
            body.nodeId,
            'session.schedule.proposal.resolve',
            {
              sessionId: request.params.sessionId,
              workspaceId: body.workspaceId,
              proposalId: request.params.proposalId,
              accept: body.accept
            },
            body.workspaceId
          )
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  app.post<{
    Body: {
      nodeId?: unknown;
      workspaceId?: unknown;
      runner?: unknown;
      cwd?: unknown;
      modelId?: unknown;
      effort?: unknown;
      access?: unknown;
      title?: unknown;
      clientMessageId?: unknown;
      content?: unknown;
      attachmentIds?: unknown;
      deferredCommands?: unknown;
      computerUse?: unknown;
    };
  }>('/api/agent-sessions/start', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    const body = request.body ?? {};
    if (
      typeof body.nodeId !== 'string' ||
      typeof body.workspaceId !== 'string' ||
      !runnerNameSchema.safeParse(body.runner).success ||
      typeof body.cwd !== 'string' ||
      body.cwd.length === 0 ||
      typeof body.clientMessageId !== 'string' ||
      body.clientMessageId.length === 0 ||
      typeof body.content !== 'string' ||
      (body.content.length === 0 &&
        !(Array.isArray(body.attachmentIds) && body.attachmentIds.length > 0)) ||
      !validSessionTitle(body.title) ||
      Object.hasOwn(body, 'model') ||
      !validSessionOption(body.modelId) ||
      !validSessionEffort(body.effort) ||
      !validSessionOption(body.access) ||
      (body.computerUse !== undefined && typeof body.computerUse !== 'boolean') ||
      (body.attachmentIds !== undefined &&
        (!Array.isArray(body.attachmentIds) ||
          body.attachmentIds.some((id) => typeof id !== 'string'))) ||
      (body.deferredCommands !== undefined &&
        (!Array.isArray(body.deferredCommands) ||
          body.deferredCommands.some(
            (value) =>
              typeof value !== 'object' ||
              value === null ||
              typeof (value as { commandId?: unknown }).commandId !== 'string' ||
              typeof (value as { input?: unknown }).input !== 'string'
          )))
    ) {
      if (typeof body.nodeId === 'string' && typeof body.workspaceId === 'string')
        await recordSharedConversationAudit({
          audits,
          eventType: 'shared_conversation_input_rejected',
          actorUserId: admin.userId,
          nodeId: body.nodeId,
          workspaceId: body.workspaceId,
          ...(typeof body.clientMessageId === 'string'
            ? { clientMessageId: body.clientMessageId }
            : {}),
          errorCode: 'SESSION_INVALID',
          result: 'DENIED',
          fallbackReceipt: { inputMode: 'NEW_SESSION' }
        });
      return sendError(reply, 400, 'SESSION_INVALID');
    }
    try {
      const result = await sessionInputs.startSession(
        { nodeId: body.nodeId, workspaceId: body.workspaceId, user: admin },
        {
          runner: body.runner as string,
          cwd: body.cwd,
          clientMessageId: body.clientMessageId,
          content: body.content,
          ...(typeof body.modelId === 'string' ? { modelId: body.modelId } : {}),
          ...(typeof body.effort === 'string' ? { effort: body.effort } : {}),
          ...(typeof body.access === 'string' ? { access: body.access } : {}),
          ...(typeof body.title === 'string' ? { title: body.title } : {}),
          ...(Array.isArray(body.attachmentIds)
            ? { attachmentIds: body.attachmentIds as string[] }
            : {}),
          ...(Array.isArray(body.deferredCommands)
            ? { deferredCommands: body.deferredCommands as { commandId: string; input: string }[] }
            : {}),
          ...(body.computerUse === undefined ? {} : { computerUse: body.computerUse as boolean })
        }
      );
      return reply.code(201).send(result);
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.patch<{
    Params: { sessionId: string };
    Body: {
      nodeId?: unknown;
      workspaceId?: unknown;
      modelId?: unknown;
      effort?: unknown;
      access?: unknown;
    };
  }>('/api/agent-sessions/:sessionId/config', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    const body = request.body ?? {};
    if (
      typeof body.nodeId !== 'string' ||
      body.nodeId.length === 0 ||
      (body.workspaceId !== undefined && !isNonEmptyString(body.workspaceId)) ||
      typeof body.modelId !== 'string' ||
      Object.hasOwn(body, 'model') ||
      typeof body.effort !== 'string' ||
      typeof body.access !== 'string' ||
      !validSessionOption(body.modelId) ||
      !validSessionEffort(body.effort) ||
      !validSessionOption(body.access)
    )
      return sendError(reply, 400, 'SESSION_INVALID');
    try {
      await requireMarAgentAutoSupport({
        access: body.access,
        sessionId: request.params.sessionId,
        request: (operation, data) =>
          requestUserNode(
            nodeControl,
            admin,
            body.nodeId as string,
            operation,
            data,
            typeof body.workspaceId === 'string' ? body.workspaceId : undefined
          )
      });
      return reply.send(
        await requestUserNode(
          nodeControl,
          admin,
          body.nodeId,
          'session.config.update',
          {
            sessionId: request.params.sessionId,
            modelId: body.modelId,
            effort: body.effort,
            access: body.access,
            ...(await prepareRunnerProfileContext({
              userId: admin.userId,
              nodeId: body.nodeId,
              ...(typeof body.workspaceId === 'string' ? { workspaceId: body.workspaceId } : {}),
              secrets,
              ...(input.marAgentModels === undefined ? {} : { models: input.marAgentModels })
            }))
          },
          typeof body.workspaceId === 'string' ? body.workspaceId : undefined
        )
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.patch<{
    Params: { sessionId: string };
    Body: { nodeId?: unknown; direction?: unknown; targetSessionId?: unknown; position?: unknown };
  }>('/api/agent-sessions/:sessionId/pin-order', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    const body = request.body ?? {};
    if (
      !isNonEmptyString(body.nodeId) ||
      (body.direction !== 'up' && body.direction !== 'down') ||
      (body.targetSessionId === undefined
        ? body.position !== undefined
        : !isNonEmptyString(body.targetSessionId) ||
          (body.position !== 'before' && body.position !== 'after'))
    )
      return sendError(reply, 400, 'SESSION_PIN_MOVE_INVALID');
    try {
      return reply.send(
        await requestUserNode(nodeControl, admin, body.nodeId, 'session.pin.move', {
          sessionId: request.params.sessionId,
          direction: body.direction,
          ...(body.targetSessionId === undefined
            ? {}
            : { targetSessionId: body.targetSessionId, position: body.position })
        })
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.get<{
    Querystring: {
      nodeId?: string;
      workspaceId?: string;
      cursor?: string;
      limit?: string;
      query?: string;
      sessionGroup?: string;
      registeredOnly?: string;
    };
  }>('/api/agent-sessions', async (request, reply) => {
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (typeof request.query.nodeId !== 'string' || request.query.nodeId.length === 0) {
      return sendError(reply, 400, 'NODE_ID_REQUIRED');
    }
    const limit = request.query.limit === undefined ? undefined : Number(request.query.limit);
    if (
      (request.query.workspaceId !== undefined &&
        (request.query.workspaceId.length === 0 || request.query.workspaceId.length > 128)) ||
      (request.query.cursor !== undefined && request.query.cursor.length > 512) ||
      (request.query.query !== undefined && request.query.query.trim().length > 160) ||
      (request.query.sessionGroup !== undefined &&
        request.query.sessionGroup !== 'MAIN' &&
        request.query.sessionGroup !== 'CHILD') ||
      (request.query.registeredOnly !== undefined &&
        (request.query.workspaceId === undefined ||
          (request.query.registeredOnly !== 'true' && request.query.registeredOnly !== 'false'))) ||
      (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100))
    )
      return sendError(reply, 400, 'SESSION_INVALID');
    try {
      return reply.send(
        await requestUserNode(nodeControl, admin, request.query.nodeId, 'session.list', {
          ...(request.query.sessionGroup === undefined
            ? {}
            : { sessionGroup: request.query.sessionGroup }),
          ...(request.query.workspaceId === undefined
            ? {}
            : { workspaceId: request.query.workspaceId }),
          ...(request.query.registeredOnly === undefined
            ? {}
            : { registeredOnly: request.query.registeredOnly === 'true' }),
          ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
          ...(request.query.query === undefined || request.query.query.trim().length === 0
            ? {}
            : { query: request.query.query.trim() }),
          ...(limit === undefined ? {} : { limit })
        })
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.post<{
    Body: { nodeId?: unknown; runner?: unknown; workspaceId?: unknown; cwd?: unknown };
  }>('/api/agent-sessions/discover', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    const body = request.body ?? {};
    if (
      typeof body.nodeId !== 'string' ||
      !runnerNameSchema.safeParse(body.runner).success ||
      (body.workspaceId !== undefined && typeof body.workspaceId !== 'string') ||
      (body.cwd !== undefined && typeof body.cwd !== 'string')
    ) {
      return sendError(reply, 400, 'SESSION_INVALID');
    }
    try {
      return reply.send(
        await requestUserNode(nodeControl, admin, body.nodeId, 'session.discover', {
          runner: body.runner,
          ...(typeof body.workspaceId === 'string' ? { workspaceId: body.workspaceId } : {}),
          ...(typeof body.cwd === 'string' ? { cwd: body.cwd } : {})
        })
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.patch<{
    Params: { sessionId: string };
    Body: {
      nodeId?: unknown;
      customTitle?: unknown;
      pinned?: unknown;
      sessionPrompt?: unknown;
      clearParent?: unknown;
      parentSessionId?: unknown;
    };
  }>('/api/agent-sessions/:sessionId/metadata', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    const body = request.body ?? {};
    if (
      !isNonEmptyString(body.nodeId) ||
      body.parentSessionId !== undefined ||
      (body.clearParent !== undefined &&
        (body.clearParent !== true ||
          Object.keys(body).some((key) => key !== 'nodeId' && key !== 'clearParent'))) ||
      (body.customTitle !== undefined &&
        body.customTitle !== null &&
        typeof body.customTitle !== 'string') ||
      (body.pinned !== undefined && typeof body.pinned !== 'boolean') ||
      (body.sessionPrompt !== undefined &&
        body.sessionPrompt !== null &&
        (typeof body.sessionPrompt !== 'string' || body.sessionPrompt.trim().length > 20_000)) ||
      (body.customTitle === undefined &&
        body.pinned === undefined &&
        body.sessionPrompt === undefined &&
        body.clearParent === undefined)
    ) {
      return sendError(reply, 400, 'SESSION_INVALID');
    }
    try {
      if (body.sessionPrompt !== undefined) {
        const current = (await requestUserNode(nodeControl, admin, body.nodeId, 'session.get', {
          sessionId: request.params.sessionId
        })) as { session?: { runtime?: { capabilities?: readonly string[] } } };
        if (!current.session?.runtime?.capabilities?.includes('session.prompt'))
          return sendError(reply, 400, 'NODE_OPERATION_UNSUPPORTED');
      }
      return reply.send(
        await requestUserNode(nodeControl, admin, body.nodeId, 'session.metadata.update', {
          sessionId: request.params.sessionId,
          ...(body.clearParent === true ? { clearParent: true } : {}),
          ...(body.customTitle === undefined ? {} : { customTitle: body.customTitle }),
          ...(body.pinned === undefined ? {} : { pinned: body.pinned }),
          ...(body.sessionPrompt === undefined ? {} : { sessionPrompt: body.sessionPrompt })
        })
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.delete<{
    Params: { sessionId: string };
    Querystring: { nodeId?: string };
  }>('/api/agent-sessions/:sessionId', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    if (!isNonEmptyString(request.query.nodeId)) return sendError(reply, 400, 'NODE_ID_REQUIRED');
    try {
      return reply.send(
        await requestUserNode(nodeControl, admin, request.query.nodeId, 'session.remove', {
          sessionId: request.params.sessionId
        })
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.post<{
    Params: { workspaceId: string };
    Body: { nodeId?: unknown; inactiveDays?: unknown };
  }>('/api/workspaces/:workspaceId/sessions/cleanup', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    const body = request.body ?? {};
    const inactiveDays = body.inactiveDays;
    if (
      !isNonEmptyString(body.nodeId) ||
      typeof inactiveDays !== 'number' ||
      !Number.isInteger(inactiveDays) ||
      inactiveDays < 1 ||
      inactiveDays > 365
    )
      return sendError(reply, 400, 'WORKSPACE_SESSION_CLEANUP_INVALID');
    try {
      const result = await requestUserNode(
        nodeControl,
        admin,
        body.nodeId,
        'workspace.sessions.cleanup',
        {
          workspaceId: request.params.workspaceId,
          inactiveDays
        },
        undefined,
        30_000
      );
      return reply.send(workspaceSessionCleanupResultSchema.parse(result));
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.post<{
    Params: { sessionId: string };
    Body: {
      nodeId?: unknown;
      turnId?: unknown;
      position?: unknown;
      boundary?: unknown;
    };
  }>('/api/agent-sessions/:sessionId/rewind', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    const body = request.body ?? {};
    if (
      !isNonEmptyString(request.params.sessionId) ||
      request.params.sessionId.length > 128 ||
      !isNonEmptyString(body.nodeId) ||
      !isNonEmptyString(body.turnId) ||
      body.turnId.length > 128 ||
      (body.position !== 'BEFORE' && body.position !== 'AFTER') ||
      (body.boundary !== null && (!isNonEmptyString(body.boundary) || body.boundary.length > 256))
    )
      return sendError(reply, 400, 'SESSION_REWIND_INVALID');
    try {
      return reply.code(201).send(
        await requestUserNode(nodeControl, admin, body.nodeId, 'session.rewind', {
          sessionId: request.params.sessionId,
          turnId: body.turnId,
          position: body.position,
          boundary: body.boundary
        })
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.post<{
    Params: { sessionId: string };
    Body: {
      nodeId?: unknown;
      turnId?: unknown;
      itemId?: unknown;
      boundary?: unknown;
    };
  }>('/api/agent-sessions/:sessionId/rollback', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    const body = request.body ?? {};
    if (
      !isNonEmptyString(request.params.sessionId) ||
      request.params.sessionId.length > 128 ||
      !isNonEmptyString(body.nodeId) ||
      !isNonEmptyString(body.turnId) ||
      body.turnId.length > 128 ||
      (body.itemId !== undefined && (!isNonEmptyString(body.itemId) || body.itemId.length > 128)) ||
      !Object.hasOwn(body, 'boundary') ||
      (body.boundary !== null && (!isNonEmptyString(body.boundary) || body.boundary.length > 256))
    )
      return sendError(reply, 400, 'SESSION_ROLLBACK_INVALID');
    try {
      return reply.send(
        await requestUserNode(nodeControl, admin, body.nodeId, 'session.rollback', {
          sessionId: request.params.sessionId,
          turnId: body.turnId,
          ...(body.itemId === undefined ? {} : { itemId: body.itemId }),
          boundary: body.boundary
        })
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.get<{
    Params: { sessionId: string };
    Querystring: {
      nodeId?: string;
      cursor?: string;
      after?: string;
      limit?: string;
      unit?: string;
    };
  }>('/api/agent-sessions/:sessionId/turns', async (request, reply) => {
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    const page = parseWorkbenchPage(request.query);
    if (!isNonEmptyString(request.query.nodeId)) return sendError(reply, 400, 'NODE_ID_REQUIRED');
    if (page === undefined) return sendError(reply, 400, 'EVENT_CURSOR_INVALID');
    if (request.query.unit !== undefined && request.query.unit !== 'SEGMENT')
      return sendError(reply, 400, 'EVENT_CURSOR_INVALID');
    try {
      return reply.send(
        await requestUserNode(nodeControl, admin, request.query.nodeId, 'session.turns.list', {
          sessionId: request.params.sessionId,
          ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
          ...(page.limit === undefined ? {} : { limit: page.limit }),
          ...(request.query.unit === undefined ? {} : { unit: request.query.unit })
        })
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.get<{
    Params: { sessionId: string };
    Querystring: { nodeId?: string; cursor?: string; after?: string; limit?: string };
  }>('/api/agent-sessions/:sessionId/events', async (request, reply) => {
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    const page = parseWorkbenchPage(request.query);
    if (!isNonEmptyString(request.query.nodeId)) return sendError(reply, 400, 'NODE_ID_REQUIRED');
    if (page === undefined) return sendError(reply, 400, 'EVENT_CURSOR_INVALID');
    try {
      return reply.send(
        await requestUserNode(nodeControl, admin, request.query.nodeId, 'session.events.read', {
          sessionId: request.params.sessionId,
          ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
          ...(page.limit === undefined ? {} : { limit: page.limit })
        })
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.get<{
    Params: { sessionId: string };
    Querystring: { nodeId?: string; workspaceId?: string };
  }>('/api/agent-sessions/:sessionId/tree', async (request, reply) => {
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!isNonEmptyString(request.query.nodeId)) return sendError(reply, 400, 'NODE_ID_REQUIRED');
    if (!isNonEmptyString(request.query.workspaceId) || request.query.workspaceId.length > 128)
      return sendError(reply, 400, 'WORKSPACE_ID_REQUIRED');
    reply.header('cache-control', 'private, no-store');
    try {
      return reply.send(
        await requestUserNode(nodeControl, admin, request.query.nodeId, 'session.graph', {
          workspaceId: request.query.workspaceId,
          sessionId: request.params.sessionId,
          includeAncestors: true,
          limit: 100
        })
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.get<{ Params: { sessionId: string }; Querystring: { nodeId?: string } }>(
    '/api/agent-sessions/:sessionId',
    async (request, reply) => {
      const admin = protectedAdmin(database, request, reply);
      if (admin === undefined) return;
      if (typeof request.query.nodeId !== 'string' || request.query.nodeId.length === 0) {
        return sendError(reply, 400, 'NODE_ID_REQUIRED');
      }
      try {
        return reply.send(
          await requestUserNode(nodeControl, admin, request.query.nodeId, 'session.get', {
            sessionId: request.params.sessionId
          })
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.get<{ Params: { sessionId: string }; Querystring: { nodeId?: string } }>(
    '/api/agent-sessions/:sessionId/runs',
    async (request, reply) => {
      const admin = protectedAdmin(database, request, reply);
      if (admin === undefined) return;
      if (typeof request.query.nodeId !== 'string' || request.query.nodeId.length === 0) {
        return sendError(reply, 400, 'NODE_ID_REQUIRED');
      }
      try {
        return reply.send(
          await requestUserNode(nodeControl, admin, request.query.nodeId, 'session.runs', {
            sessionId: request.params.sessionId
          })
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.post<{
    Params: { sessionId: string };
    Body: {
      nodeId?: unknown;
      workspaceId?: unknown;
      workbenchConnectionId?: unknown;
      watchId?: unknown;
      mode?: unknown;
      unit?: unknown;
      position?: unknown;
    };
  }>('/api/agent-sessions/:sessionId/watch', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    if (
      typeof request.body?.nodeId !== 'string' ||
      request.body.nodeId.length === 0 ||
      typeof request.body.workspaceId !== 'string' ||
      typeof request.body.workbenchConnectionId !== 'string' ||
      !nodeControl.ownsWorkbenchConnection(admin.sessionHash, request.body.workbenchConnectionId) ||
      typeof request.body.watchId !== 'string' ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(request.body.watchId) ||
      (request.body.mode !== 'initial' && request.body.mode !== 'renew') ||
      (request.body.unit !== undefined && request.body.unit !== 'SEGMENT') ||
      (request.body.position !== undefined &&
        request.body.position !== 'primary' &&
        request.body.position !== 'secondary')
    )
      return sendError(reply, 400, 'SESSION_WATCH_INVALID');
    request.log.info(
      {
        event: 'session.watch.requested',
        sessionId: request.params.sessionId,
        workspaceId: request.body.workspaceId,
        nodeId: request.body.nodeId,
        workbenchConnectionId: request.body.workbenchConnectionId,
        watchId: request.body.watchId,
        mode: request.body.mode
      },
      'session_watch_requested'
    );
    try {
      const result = await requestUserNode(
        nodeControl,
        admin,
        request.body.nodeId,
        'session.watch',
        {
          sessionId: request.params.sessionId,
          workspaceId: request.body.workspaceId,
          workbenchConnectionId: request.body.workbenchConnectionId,
          watchId: request.body.watchId,
          mode: request.body.mode,
          ...(request.body.unit === undefined ? {} : { unit: request.body.unit }),
          ...(request.body.position === undefined ? {} : { position: request.body.position })
        }
      );
      return request.body.mode === 'renew' ? reply.code(204).send() : reply.send(result);
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.delete<{
    Params: { sessionId: string };
    Body: {
      nodeId?: unknown;
      workspaceId?: unknown;
      workbenchConnectionId?: unknown;
      watchId?: unknown;
      position?: unknown;
    };
  }>('/api/agent-sessions/:sessionId/watch', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    if (
      typeof request.body?.nodeId !== 'string' ||
      typeof request.body.workspaceId !== 'string' ||
      typeof request.body.workbenchConnectionId !== 'string' ||
      !nodeControl.ownsWorkbenchConnection(admin.sessionHash, request.body.workbenchConnectionId) ||
      typeof request.body.watchId !== 'string' ||
      (request.body.position !== undefined &&
        request.body.position !== 'primary' &&
        request.body.position !== 'secondary')
    )
      return sendError(reply, 400, 'SESSION_WATCH_INVALID');
    request.log.info(
      {
        event: 'session.watch.requested',
        sessionId: request.params.sessionId,
        workspaceId: request.body.workspaceId,
        nodeId: request.body.nodeId,
        workbenchConnectionId: request.body.workbenchConnectionId,
        watchId: request.body.watchId,
        mode: 'stop'
      },
      'session_watch_requested'
    );
    try {
      return reply.send(
        await requestUserNode(nodeControl, admin, request.body.nodeId, 'session.unwatch', {
          sessionId: request.params.sessionId,
          workspaceId: request.body.workspaceId,
          workbenchConnectionId: request.body.workbenchConnectionId,
          watchId: request.body.watchId,
          ...(request.body.position === undefined ? {} : { position: request.body.position })
        })
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.get<{ Params: { sessionId: string }; Querystring: { nodeId?: string } }>(
    '/api/agent-sessions/:sessionId/context',
    async (request, reply) => {
      const admin = protectedAdmin(database, request, reply);
      if (admin === undefined) return;
      if (typeof request.query.nodeId !== 'string' || request.query.nodeId.length === 0) {
        return sendError(reply, 400, 'NODE_ID_REQUIRED');
      }
      try {
        return reply.send(
          await requestUserNode(nodeControl, admin, request.query.nodeId, 'session.context.read', {
            sessionId: request.params.sessionId
          })
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.get<{ Params: { sessionId: string }; Querystring: { nodeId?: string } }>(
    '/api/agent-sessions/:sessionId/channel-token',
    async (request, reply) => {
      const admin = protectedAdmin(database, request, reply);
      if (admin === undefined) return;
      if (typeof request.query.nodeId !== 'string' || request.query.nodeId.length === 0) {
        return sendError(reply, 400, 'NODE_ID_REQUIRED');
      }
      try {
        return reply.send(
          await requestUserNode(nodeControl, admin, request.query.nodeId, 'session.channel.token', {
            sessionId: request.params.sessionId
          })
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.post<{
    Params: { sessionId: string };
    Body: { nodeId?: unknown; token?: unknown; content?: unknown; clientMessageId?: unknown };
  }>('/api/agent-sessions/:sessionId/channel-messages', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    const { nodeId, token, content, clientMessageId } = request.body ?? {};
    if (
      typeof nodeId !== 'string' ||
      typeof token !== 'string' ||
      typeof content !== 'string' ||
      content.length === 0 ||
      typeof clientMessageId !== 'string' ||
      clientMessageId.length === 0
    ) {
      return sendError(reply, 400, 'MESSAGE_INVALID');
    }
    try {
      return reply.code(202).send(
        await requestUserNode(nodeControl, admin, nodeId, 'session.channel.message', {
          sessionId: request.params.sessionId,
          token,
          content,
          clientMessageId
        })
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.post<{
    Params: { sessionId: string };
    Body: {
      nodeId?: unknown;
      workspaceId?: unknown;
      clientMessageId?: unknown;
      content?: unknown;
      attachments?: unknown;
      attachmentIds?: unknown;
      deliveryIntent?: unknown;
      modelId?: unknown;
      computerUse?: unknown;
    };
  }>('/api/agent-sessions/:sessionId/messages', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    const body = request.body ?? {};
    if (
      typeof body.nodeId !== 'string' ||
      typeof body.workspaceId !== 'string' ||
      typeof body.clientMessageId !== 'string' ||
      body.clientMessageId.length === 0 ||
      typeof body.content !== 'string' ||
      (body.content.length === 0 &&
        !(Array.isArray(body.attachmentIds) && body.attachmentIds.length > 0) &&
        !(Array.isArray(body.attachments) && body.attachments.length > 0)) ||
      (body.deliveryIntent !== undefined &&
        body.deliveryIntent !== 'SEND' &&
        body.deliveryIntent !== 'QUEUE' &&
        body.deliveryIntent !== 'REPLACE_CURRENT') ||
      !validMessageAttachments(body.attachments) ||
      Object.hasOwn(body, 'model') ||
      !validComposerAttachmentIds(body.attachmentIds) ||
      (body.computerUse !== undefined && typeof body.computerUse !== 'boolean') ||
      (body.attachments !== undefined && body.attachmentIds !== undefined)
    ) {
      if (typeof body.nodeId === 'string' && typeof body.workspaceId === 'string')
        await recordSharedConversationAudit({
          audits,
          eventType: 'shared_conversation_input_rejected',
          actorUserId: admin.userId,
          nodeId: body.nodeId,
          workspaceId: body.workspaceId,
          ...(typeof body.clientMessageId === 'string'
            ? { clientMessageId: body.clientMessageId }
            : {}),
          errorCode: 'MESSAGE_INVALID',
          result: 'DENIED',
          fallbackReceipt: {
            sessionId: request.params.sessionId,
            inputMode:
              body.deliveryIntent === 'QUEUE'
                ? 'QUEUE'
                : body.deliveryIntent === 'REPLACE_CURRENT'
                  ? 'REPLACE_CURRENT'
                  : 'SEND'
          }
        });
      return sendError(reply, 400, 'MESSAGE_INVALID');
    }
    try {
      const result = await sessionInputs.submitMessage(
        {
          nodeId: body.nodeId,
          workspaceId: body.workspaceId,
          sessionId: request.params.sessionId,
          user: admin
        },
        {
          clientMessageId: body.clientMessageId,
          content: body.content,
          ...(body.deliveryIntent === undefined ? {} : { deliveryIntent: body.deliveryIntent }),
          ...(body.attachments === undefined ? {} : { attachments: body.attachments }),
          ...(body.attachmentIds === undefined ? {} : { attachmentIds: body.attachmentIds }),
          ...(body.computerUse === undefined ? {} : { computerUse: body.computerUse }),
          ...(typeof body.modelId === 'string' ? { modelId: body.modelId } : {})
        }
      );
      return reply.code(202).send(result);
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.get<{
    Params: { workspaceId: string };
    Querystring: { nodeId?: string; sessionId?: string };
  }>('/api/workspaces/:workspaceId/queue', async (request, reply) => {
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (typeof request.query.nodeId !== 'string') return sendError(reply, 400, 'NODE_ID_REQUIRED');
    if (typeof request.query.sessionId !== 'string')
      return sendError(reply, 400, 'SESSION_ID_REQUIRED');
    try {
      return reply.send(
        await requestUserNode(nodeControl, admin, request.query.nodeId, 'workspace.queue.get', {
          workspaceId: request.params.workspaceId,
          sessionId: request.query.sessionId
        })
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });
}
