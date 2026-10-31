import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { runnerNameSchema } from '@myagentroam/protocol';
import { isAllowedOrigin } from './auth.js';
import { safeErrorCode, sendError } from './http-errors.js';
import { databaseError } from './domain-errors.js';
import type { MarctlUserCredentials } from './marctl-user-credentials.js';
import type { UserNodeAuthorization } from './node-access-contracts.js';
import type {
  PersonalInstructionReader,
  ProcessSecretResolver,
  MarAgentModelService,
  MarAgentRuntimeModelService
} from './session-run-contracts.js';
import { SessionInputService, type SessionExecutionOrigin } from './session-input-service.js';
import {
  recordSharedConversationAudit,
  sharedConversationFailureResult,
  type ConversationAuditObserver
} from './conversation-audit.js';
import { nodeModelSummary, prepareRunnerProfileContext } from './runner-profile-context.js';
import { prepareSessionExecutionContext } from './session-execution-context.js';
import { runtimeModelPayload } from './run-model-payload.js';

const id = z.string().min(1).max(512);
const page = {
  cursor: z.string().max(4096).optional(),
  limit: z.number().int().min(1).max(100).optional()
};
const message = {
  sourceSessionId: id.optional(),
  content: z.string().max(100_000)
};
const goal = z
  .union([
    z.object({ objective: z.string().trim().min(1).max(20_000) }).strict(),
    z.object({ clear: z.literal(true) }).strict(),
    z.null()
  ])
  .optional();
const networkCommand = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('start'),
      input: z
        .object({
          content: z.string().max(100_000).optional(),
          clientMessageId: id.optional(),
          runner: runnerNameSchema.optional(),
          modelId: id.optional(),
          effort: z.string().max(120).optional(),
          title: z.string().min(1).max(160).optional(),
          parentSessionId: id.optional(),
          goal
        })
        .strict()
    })
    .strict(),
  z
    .object({
      operation: z.literal('send'),
      input: z
        .object({
          agentId: id,
          content: z.string().max(100_000).optional(),
          clientMessageId: id.optional(),
          deliveryIntent: z.enum(['SEND', 'QUEUE', 'REPLACE_CURRENT']).optional(),
          approval: z
            .object({ approvalId: id, decision: z.enum(['approve', 'reject']) })
            .strict()
            .optional(),
          goal
        })
        .strict()
    })
    .strict(),
  z
    .object({
      operation: z.literal('stop'),
      input: z.object({ agentId: id, executionId: id }).strict()
    })
    .strict(),
  z
    .object({
      operation: z.literal('wait'),
      input: z
        .object({
          agentId: id.optional(),
          agentIds: z.array(id).min(1).max(8).optional(),
          mode: z.enum(['any', 'all']).optional(),
          waitFor: z.enum(['message', 'completion']).optional(),
          waitMs: z.number().int().min(0).max(300_000).optional()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      operation: z.literal('list'),
      input: z
        .object({
          scope: z.enum(['tree', 'active']).optional(),
          query: z.string().max(160).optional(),
          limit: z.number().int().min(1).max(100).optional()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      operation: z.literal('view'),
      input: z
        .object({
          agentId: id,
          includeHistory: z.boolean().optional(),
          ...page
        })
        .strict()
    })
    .strict()
]);
const commandSchema = z
  .discriminatedUnion('action', [
    z.object({ action: z.literal('network'), command: networkCommand }).strict(),
    z.object({ action: z.literal('current'), sessionId: id.optional() }).strict(),
    z
      .object({
        action: z.literal('list'),
        query: z.string().max(160).optional(),
        parentSessionId: id.optional(),
        ...page
      })
      .strict(),
    z.object({ action: z.literal('show'), sessionId: id }).strict(),
    z.object({ action: z.literal('prompt.get'), sessionId: id }).strict(),
    z
      .object({
        action: z.literal('prompt.set'),
        sessionId: id,
        content: z.string().trim().min(1).max(20_000)
      })
      .strict(),
    z.object({ action: z.literal('prompt.clear'), sessionId: id }).strict(),
    z
      .object({
        action: z.literal('approval.decide'),
        sessionId: id,
        runId: id,
        approvalId: id,
        decision: z.enum(['APPROVED', 'REJECTED'])
      })
      .strict(),
    z
      .object({
        action: z.literal('rename'),
        sessionId: id,
        title: z.string().trim().min(1).max(160)
      })
      .strict(),
    z.object({ action: z.literal('schedule.list'), ...page }).strict(),
    z.object({ action: z.literal('schedule.get'), sessionId: id }).strict(),
    z
      .object({
        action: z.literal('schedule.create'),
        sessionId: id,
        cron: z.string().min(1).max(512),
        content: z.string().trim().min(1).max(20_000)
      })
      .strict(),
    z
      .object({
        action: z.literal('schedule.update'),
        sessionId: id,
        expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
        cron: z.string().min(1).max(512).optional(),
        content: z.string().trim().min(1).max(20_000).optional()
      })
      .strict(),
    z.object({ action: z.literal('graph'), sessionId: id, limit: page.limit }).strict(),
    z.object({ action: z.literal('history'), sessionId: id, ...page }).strict(),
    z
      .object({
        action: z.literal('start'),
        runner: runnerNameSchema,
        ...message,
        clientMessageId: id,
        modelId: id.optional(),
        effort: z.string().max(120).optional(),
        parentSessionId: id.optional(),
        title: z.string().min(1).max(160).optional()
      })
      .strict(),
    z
      .object({
        action: z.literal('send'),
        sessionId: id,
        ...message,
        clientMessageId: id,
        deliveryIntent: z.enum(['SEND', 'QUEUE', 'REPLACE_CURRENT'])
      })
      .strict(),
    z.object({ action: z.literal('stop'), sessionId: id, runId: id.optional() }).strict(),
    z
      .object({
        action: z.literal('config'),
        sessionId: id,
        modelId: z
          .string()
          .min(1)
          .max(120)
          .refine((value) => value.trim().length > 0)
          .optional(),
        effort: z.string().max(120).optional()
      })
      .strict(),
    z.object({ action: z.literal('goal.get'), sessionId: id }).strict(),
    z
      .object({
        action: z.literal('goal.set'),
        sessionId: id,
        content: z
          .string()
          .trim()
          .min(1)
          .max(20_000)
          .refine((value) => value !== '--clear')
      })
      .strict(),
    z.object({ action: z.literal('goal.clear'), sessionId: id }).strict(),
    z
      .object({
        action: z.literal('watch'),
        sessionId: id,
        workbenchConnectionId: id,
        watchId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u),
        mode: z.enum(['initial', 'renew', 'stop'])
      })
      .strict()
  ])
  .refine(
    (value) =>
      (value.action !== 'start' && value.action !== 'send') ||
      ('content' in value && value.content.trim().length > 0)
  )
  .refine(
    (value) =>
      value.action !== 'config' || value.modelId !== undefined || value.effort !== undefined
  )
  .refine(
    (value) =>
      value.action !== 'schedule.update' || value.cron !== undefined || value.content !== undefined
  );

export interface MarctlSessionDependencies {
  readonly audits?: ConversationAuditObserver;
  readonly personalInstructions?: PersonalInstructionReader;
  readonly marAgentModels?: MarAgentModelService;
  readonly marAgentRuntimeModels?: MarAgentRuntimeModelService;
  readonly ownsWorkbenchConnection?: (sessionHash: string, connectionId: string) => boolean;
}

export function registerMarctlSessionRoutes(
  input: MarctlSessionDependencies & {
    readonly app: FastifyInstance;
    readonly credentials: MarctlUserCredentials;
    readonly publicOrigin: string | undefined;
    readonly authorizedNode: (user: UserNodeAuthorization, nodeId: string) => Promise<boolean>;
    readonly requestNode: (
      nodeId: string,
      operation: string,
      data: Record<string, unknown>,
      user: UserNodeAuthorization,
      timeoutMs?: number,
      signal?: AbortSignal
    ) => Promise<unknown>;
    readonly secrets: ProcessSecretResolver;
    readonly onError?: (reply: FastifyReply, error: unknown) => FastifyReply;
  }
): void {
  const sessionInputs = new SessionInputService({
    ...input,
    userCredentials: input.credentials,
    nodeControl: {
      requestNode: (nodeId, operation, data, user) =>
        input.requestNode(nodeId, operation, data as Record<string, unknown>, user)
    }
  });
  input.app.post(
    '/api/marctl/sessions',
    { bodyLimit: 15 * 1024 * 1024 },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      if (request.headers.origin !== undefined && !isAllowedOrigin(request, input.publicOrigin))
        return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
      try {
        const authenticated = await input.credentials.authenticateContext(
          request.headers.authorization
        );
        if (authenticated === undefined) return sendError(reply, 401, 'UNAUTHENTICATED');
        const command = commandSchema.safeParse(request.body);
        if (!command.success)
          return sendError(reply, 400, 'MARCTL_SESSION_INPUT_INVALID', {
            details: command.error.issues
              .slice(0, 4)
              .map(
                (issue) =>
                  `${issue.path.join('.') || 'command'}: ${issue.code === 'unrecognized_keys' ? 'Unexpected fields; use only documented options.' : issue.message}`
              )
              .join(' ')
              .slice(0, 2000)
          });
        const { scope, scheduled, channel } = authenticated;
        const caller = authenticated.source;
        if (caller.type === 'delegation')
          return sendError(reply, 403, 'MARCTL_EXECUTION_CREDENTIAL_REQUIRED');
        const user = {
          ...authenticated.user,
          marctlCaller: caller,
          marctlExpiresAt: authenticated.expiresAt
        };
        if (scope === undefined) return sendError(reply, 403, 'MARCTL_SESSION_CONTEXT_REQUIRED');
        if (!(await input.authorizedNode(user, scope.nodeId)))
          return sendError(reply, 403, 'RESOURCE_ACCESS_DENIED');
        const call = async (
          operation: string,
          data: Record<string, unknown> = {},
          timeoutMs?: number,
          signal?: AbortSignal,
          marctlExecutionResources?: Readonly<Record<string, unknown>>
        ) => {
          const nodeData = {
            ...data,
            workspaceId: scope.workspaceId,
            ...([
              'session.cli.context',
              'session.get',
              'session.list',
              'session.graph',
              'session.runs',
              'session.goal.get',
              'session.turns.list',
              'workspace.queue.get'
            ].includes(operation)
              ? { registeredOnly: true }
              : {})
          };
          const authorization = {
            ...user,
            workspaceId: scope.workspaceId,
            ...(marctlExecutionResources === undefined ? {} : { marctlExecutionResources })
          };
          return timeoutMs === undefined
            ? input.requestNode(scope.nodeId, operation, nodeData, authorization)
            : signal === undefined
              ? input.requestNode(scope.nodeId, operation, nodeData, authorization, timeoutMs)
              : input.requestNode(
                  scope.nodeId,
                  operation,
                  nodeData,
                  authorization,
                  timeoutMs,
                  signal
                );
        };
        const originalBody = command.data;
        // Normalize Goal aliases before preparing resources for the shared network path.
        const body: typeof command.data =
          caller.type === 'execution' &&
          (originalBody.action === 'goal.clear' || originalBody.action === 'goal.set')
            ? {
                action: 'network',
                command: {
                  operation: 'send',
                  input: {
                    agentId: originalBody.sessionId,
                    goal:
                      originalBody.action === 'goal.clear'
                        ? { clear: true }
                        : { objective: originalBody.content }
                  }
                }
              }
            : originalBody;
        // Legacy Run-based writes cannot identify the current target Execution safely.
        if (caller.type === 'execution' && ['start', 'send', 'stop'].includes(body.action))
          return sendError(reply, 409, 'MARCTL_AGENT_NETWORK_REQUIRED');
        if (body.action === 'network') {
          const { operation, input: arguments_ } = body.command;
          const networkInput: Record<string, unknown> = { ...arguments_ };
          const messageInput =
            operation === 'start' || operation === 'send' ? arguments_ : undefined;
          const hasMessage = messageInput !== undefined && !!messageInput.content?.trim();
          if (
            (operation === 'start' || (operation === 'send' && hasMessage)) &&
            networkInput.clientMessageId === undefined
          )
            networkInput.clientMessageId = randomUUID();
          const requiresExecutionResources =
            operation === 'start' ||
            (operation === 'send' &&
              (hasMessage || (isObject(arguments_.goal) && 'objective' in arguments_.goal)));
          const resources: Record<string, unknown> = {};
          let executionResources: Record<string, unknown> | undefined;
          if (caller.type === 'terminal' && requiresExecutionResources) {
            const profileContext = await prepareRunnerProfileContext({
              userId: user.userId,
              nodeId: scope.nodeId,
              workspaceId: scope.workspaceId,
              secrets: input.secrets,
              ...(input.marAgentModels === undefined ? {} : { models: input.marAgentModels })
            });
            Object.assign(resources, profileContext);
            if (requiresExecutionResources) {
              let runner: unknown = operation === 'start' ? arguments_.runner : undefined;
              let model: unknown = operation === 'start' ? arguments_.modelId : undefined;
              const sessionId =
                operation === 'send' ? arguments_.agentId : arguments_.parentSessionId;
              if (sessionId !== undefined) {
                const session = object(object(await call('session.get', { sessionId })).session);
                if (session.workspaceId !== scope.workspaceId)
                  return sendError(reply, 403, 'RESOURCE_ACCESS_DENIED');
                runner ??= session.runner;
                if (operation === 'send') model = session.modelId;
              }
              if (operation === 'start' && runner === undefined)
                return sendError(reply, 400, 'RUNNER_REQUIRED');
              if (runner === 'mar-agent') {
                const profiles = object(
                  await call('runner.profiles.list', {
                    ...profileContext,
                    waitForRefresh: true
                  })
                );
                if (typeof model !== 'string') {
                  const defaults = Array.isArray(profiles.defaults)
                    ? profiles.defaults.find((value) => isObject(value) && value.runner === runner)
                    : undefined;
                  const profile = Array.isArray(profiles.profiles)
                    ? profiles.profiles.find((value) => isObject(value) && value.runner === runner)
                    : undefined;
                  const models =
                    isObject(profile) && Array.isArray(profile.models) ? profile.models : [];
                  const preferred = models.find(
                    (value) => isObject(value) && value.isDefault === true
                  );
                  model =
                    (isObject(defaults) ? defaults.modelId : undefined) ??
                    (isObject(preferred) ? preferred.id : undefined);
                }
              }
              if (runner === 'mar-agent' && typeof model !== 'string')
                return sendError(reply, 400, 'MODEL_ID_REQUIRED');
              if (operation === 'start' && typeof model === 'string') networkInput.modelId = model;
              Object.assign(
                resources,
                await prepareSessionExecutionContext({
                  user: { ...user, scheduled, ...(channel === undefined ? {} : { channel }) },
                  nodeId: scope.nodeId,
                  workspaceId: scope.workspaceId,
                  serverUrl: input.publicOrigin,
                  credentials: input.credentials,
                  instructions: input.personalInstructions,
                  secrets: input.secrets
                })
              );
              if (runner === 'mar-agent' && typeof model === 'string')
                Object.assign(
                  resources,
                  await runtimeModelPayload({
                    userId: user.userId,
                    nodeId: scope.nodeId,
                    workspaceId: scope.workspaceId,
                    ...(operation === 'send' ? { sessionId: arguments_.agentId } : {}),
                    selectedModelId: model,
                    ...(input.marAgentModels === undefined
                      ? {}
                      : { marAgentModels: input.marAgentModels }),
                    ...(input.marAgentRuntimeModels === undefined
                      ? {}
                      : { marAgentRuntimeModels: input.marAgentRuntimeModels })
                  })
                );
            }
          } else if (
            caller.type === 'execution' &&
            requiresExecutionResources &&
            (operation !== 'start' ||
              arguments_.parentSessionId === undefined ||
              arguments_.parentSessionId === caller.sessionId)
          ) {
            const sessionId = operation === 'start' ? caller.sessionId : arguments_.agentId;
            const session = object(object(await call('session.get', { sessionId })).session);
            if (session.workspaceId !== scope.workspaceId)
              return sendError(reply, 403, 'RESOURCE_ACCESS_DENIED');
            // Provision for the authorized target; Node rechecks identity and Run ownership.
            const runner =
              operation === 'start' ? (arguments_.runner ?? session.runner) : session.runner;
            let model: unknown = operation === 'start' ? arguments_.modelId : session.modelId;
            if (runner === 'mar-agent') {
              const profileContext = await prepareRunnerProfileContext({
                userId: user.userId,
                nodeId: scope.nodeId,
                workspaceId: scope.workspaceId,
                secrets: input.secrets,
                ...(input.marAgentModels === undefined ? {} : { models: input.marAgentModels })
              });
              const profiles = object(
                await call('runner.profiles.list', { ...profileContext, waitForRefresh: true })
              );
              if (typeof model !== 'string') {
                const defaults = Array.isArray(profiles.defaults)
                  ? profiles.defaults.find((value) => isObject(value) && value.runner === runner)
                  : undefined;
                const profile = Array.isArray(profiles.profiles)
                  ? profiles.profiles.find((value) => isObject(value) && value.runner === runner)
                  : undefined;
                const models =
                  isObject(profile) && Array.isArray(profile.models) ? profile.models : [];
                const preferred = models.find(
                  (value) => isObject(value) && value.isDefault === true
                );
                model =
                  (isObject(defaults) ? defaults.modelId : undefined) ??
                  (isObject(preferred) ? preferred.id : undefined);
              }
            }
            if (runner === 'mar-agent' && typeof model !== 'string')
              return sendError(reply, 400, 'MODEL_ID_REQUIRED');
            if (runner === 'mar-agent' && typeof model === 'string') {
              if (operation === 'start') networkInput.modelId = model;
              executionResources = await runtimeModelPayload({
                userId: user.userId,
                nodeId: scope.nodeId,
                workspaceId: scope.workspaceId,
                ...(operation === 'send' ? { sessionId: arguments_.agentId } : {}),
                selectedModelId: model,
                ...(input.marAgentModels === undefined
                  ? {}
                  : { marAgentModels: input.marAgentModels }),
                ...(input.marAgentRuntimeModels === undefined
                  ? {}
                  : { marAgentRuntimeModels: input.marAgentRuntimeModels })
              });
            }
          }
          const receipt =
            operation === 'start'
              ? { inputMode: 'NEW_SESSION' as const }
              : operation === 'send'
                ? {
                    sessionId: arguments_.agentId,
                    inputMode: arguments_.deliveryIntent ?? ('SEND' as const)
                  }
                : undefined;
          const controller = operation === 'wait' ? new AbortController() : undefined;
          const onDisconnect = () => {
            if (!reply.raw.writableFinished) controller?.abort();
          };
          if (controller) {
            request.raw.once('aborted', onDisconnect);
            reply.raw.once('close', onDisconnect);
          }
          try {
            const requestedWait = operation === 'wait' ? (arguments_.waitMs ?? 30_000) : undefined;
            const effectiveWait =
              requestedWait === undefined || requestedWait === 0
                ? requestedWait
                : Math.max(10_000, requestedWait);
            const timeoutMs = effectiveWait === undefined ? undefined : effectiveWait + 5_000;
            const result = await call(
              'agent.network',
              { action: operation, input: networkInput, ...resources },
              timeoutMs,
              controller?.signal,
              executionResources
            );
            if (hasMessage && receipt) {
              const outer = object(result);
              const messageResult =
                operation === 'send' && isObject(outer.message) ? outer.message : undefined;
              const nested =
                operation === 'start' && isObject(outer.start)
                  ? outer.start
                  : messageResult && isObject(messageResult.result)
                    ? messageResult.result
                    : {};
              const accepted = operation === 'start' || messageResult?.status === 'accepted';
              await recordSharedConversationAudit({
                audits: input.audits,
                eventType: accepted
                  ? 'shared_conversation_input_accepted'
                  : 'shared_conversation_input_rejected',
                actorUserId: user.userId,
                nodeId: scope.nodeId,
                workspaceId: scope.workspaceId,
                clientMessageId: networkInput.clientMessageId as string,
                ...(accepted
                  ? { userMessage: messageInput.content ?? '', nodeResult: nested }
                  : {
                      errorCode:
                        typeof messageResult?.code === 'string'
                          ? messageResult.code
                          : 'AGENT_SEND_FAILED',
                      result: 'FAILED' as const
                    }),
                fallbackReceipt: {
                  ...receipt,
                  ...(operation === 'start' && typeof outer.agentId === 'string'
                    ? { sessionId: outer.agentId }
                    : {})
                }
              });
            }
            return reply.send(result);
          } catch (error) {
            if (hasMessage && receipt) {
              const errorCode = safeErrorCode(error);
              await recordSharedConversationAudit({
                audits: input.audits,
                eventType: 'shared_conversation_input_rejected',
                actorUserId: user.userId,
                nodeId: scope.nodeId,
                workspaceId: scope.workspaceId,
                clientMessageId: networkInput.clientMessageId as string,
                errorCode,
                result: sharedConversationFailureResult(errorCode),
                fallbackReceipt: receipt
              });
            }
            throw error;
          } finally {
            if (controller) {
              request.raw.removeListener('aborted', onDisconnect);
              reply.raw.removeListener('close', onDisconnect);
            }
          }
        }
        const context = object(
          await call(
            'session.cli.context',
            body.action === 'current' && caller.type === 'execution'
              ? { sessionId: caller.sessionId }
              : {}
          )
        );
        if (body.action === 'current')
          return reply.send({ nodeId: scope.nodeId, workspaceId: scope.workspaceId, ...context });
        if (body.action === 'list') {
          const result = object(
            await call('session.list', {
              view: 'marctl',
              cursor: body.cursor,
              limit: body.limit ?? 20,
              ...(body.query === undefined ? {} : { query: body.query }),
              ...(body.parentSessionId === undefined
                ? {}
                : { parentSessionId: body.parentSessionId })
            })
          );
          if (result.view !== 'marctl')
            return sendError(reply, 409, 'CAPABILITY_VERSION_UNSUPPORTED');
          return reply.send({ sessions: result.sessions, nextCursor: result.nextCursor });
        }

        if (body.action === 'schedule.list')
          return reply.send(
            await call('session.schedule.list', {
              limit: body.limit ?? 20,
              ...(body.cursor === undefined ? {} : { cursor: body.cursor })
            })
          );

        let session: Record<string, unknown> | undefined;
        if ('sessionId' in body) {
          const result = object(
            await call('session.get', {
              sessionId: body.sessionId,
              ...(body.action === 'show' ? { view: 'marctl' } : {})
            })
          );
          if (body.action === 'show') {
            if (result.view !== 'marctl')
              return sendError(reply, 409, 'CAPABILITY_VERSION_UNSUPPORTED');
            if (result.workspaceId !== scope.workspaceId)
              return sendError(reply, 403, 'RESOURCE_ACCESS_DENIED');
            return reply.send({ session: object(result.session) });
          }
          session = object(result.session);
          if (session.workspaceId !== scope.workspaceId)
            return sendError(reply, 403, 'RESOURCE_ACCESS_DENIED');
        }
        const sessionId = session?.id;
        if (
          body.action === 'prompt.get' ||
          body.action === 'prompt.set' ||
          body.action === 'prompt.clear'
        ) {
          const capabilities = object(session?.runtime).capabilities;
          if (!Array.isArray(capabilities) || !capabilities.includes('session.prompt'))
            return sendError(reply, 400, 'NODE_OPERATION_UNSUPPORTED');
          const saved =
            body.action === 'prompt.get'
              ? session
              : object(
                  object(
                    await call('session.metadata.update', {
                      sessionId,
                      sessionPrompt: body.action === 'prompt.clear' ? null : body.content
                    })
                  ).session
                );
          return reply.send({ sessionId, sessionPrompt: saved?.sessionPrompt ?? null });
        }
        if (body.action === 'approval.decide') {
          const capabilities = object(session?.runtime).capabilities;
          if (!Array.isArray(capabilities) || !capabilities.includes('approval.respond'))
            return sendError(reply, 400, 'NODE_OPERATION_UNSUPPORTED');
          const runs = object(await call('session.runs', { sessionId })).runs;
          const run = Array.isArray(runs)
            ? runs.find(
                (value) =>
                  isObject(value) && value.id === body.runId && value.sessionId === sessionId
              )
            : undefined;
          if (!isObject(run)) return sendError(reply, 404, 'RUN_NOT_FOUND');
          const approval = object(
            object(
              await call('run.approval.decide', {
                runId: body.runId,
                approvalId: body.approvalId,
                decision: body.decision
              })
            ).approval
          );
          return reply.send({
            sessionId,
            runId: body.runId,
            approvalId: approval.id,
            decision: approval.status
          });
        }
        if (body.action === 'rename')
          return reply.send(
            await call('session.metadata.update', { sessionId, customTitle: body.title })
          );
        if (body.action === 'schedule.get')
          return reply.send(await call('session.schedule.get', { sessionId }));
        if (body.action === 'schedule.create' || body.action === 'schedule.update')
          return reply.send(
            await call('session.schedule.agent.save', {
              sessionId,
              mode: body.action === 'schedule.create' ? 'create' : 'update',
              ...('expectedRevision' in body ? { expectedRevision: body.expectedRevision } : {}),
              ...(body.cron === undefined ? {} : { cron: body.cron }),
              ...(body.content === undefined ? {} : { objective: body.content })
            })
          );
        if (body.action === 'config') {
          const models =
            session?.runner === 'mar-agent' && body.modelId !== undefined
              ? ((await input.marAgentModels?.listForUser?.(user.userId)) ?? [])
              : undefined;
          return reply.send(
            await call('session.config.update', {
              sessionId,
              ...(body.modelId === undefined ? {} : { modelId: body.modelId }),
              ...(body.effort === undefined ? {} : { effort: body.effort }),
              ...(models === undefined ? {} : { marAgentModels: models.map(nodeModelSummary) })
            })
          );
        }
        if (body.action === 'graph')
          return reply.send(await call('session.graph', { sessionId, limit: body.limit ?? 100 }));
        if (body.action === 'history')
          return reply.send(
            await call('session.turns.list', {
              sessionId,
              unit: 'SEGMENT',
              cursor: body.cursor,
              limit: body.limit ?? 10
            })
          );
        if (body.action === 'goal.get')
          return reply.send(await call('session.goal.get', { sessionId }));
        if (body.action === 'goal.clear')
          return reply.send(
            await call('session.command.execute', {
              sessionId,
              commandId: 'goal',
              input: '/goal --clear'
            })
          );
        if (body.action === 'stop') {
          const runs = object(await call('session.runs', { sessionId })).runs;
          const run = Array.isArray(runs)
            ? runs.find(
                (value) =>
                  isObject(value) &&
                  (body.runId === undefined
                    ? ['STARTING', 'RUNNING', 'CANCELLING'].includes(String(value.status))
                    : value.id === body.runId)
              )
            : undefined;
          if (!isObject(run) || run.sessionId !== sessionId)
            return sendError(reply, 404, 'RUN_NOT_FOUND');
          if (!['STARTING', 'RUNNING', 'CANCELLING'].includes(String(run.status)))
            return sendError(reply, 409, 'RUN_STATE_CONFLICT', {
              message: 'The specified Run is no longer active.'
            });
          return reply.send(await call('run.cancel', { runId: run.id }));
        }
        if (body.action === 'watch') {
          if (
            input.ownsWorkbenchConnection?.(user.sessionHash, body.workbenchConnectionId) !== true
          )
            return sendError(reply, 403, 'RESOURCE_ACCESS_DENIED');
          return reply.send(
            (await call(body.mode === 'stop' ? 'session.unwatch' : 'session.watch', {
              sessionId,
              workbenchConnectionId: body.workbenchConnectionId,
              watchId: body.watchId,
              ...(body.mode === 'stop' ? {} : { mode: body.mode, unit: 'SEGMENT' })
            })) ?? { accepted: true }
          );
        }

        let runner = session?.runner;
        let model = session?.modelId;
        if (body.action === 'start') {
          runner = body.runner;
          const profiles = object(
            await call('runner.profiles.list', {
              ...(await prepareRunnerProfileContext({
                userId: user.userId,
                nodeId: scope.nodeId,
                workspaceId: scope.workspaceId,
                secrets: input.secrets,
                ...(input.marAgentModels === undefined ? {} : { models: input.marAgentModels })
              })),
              waitForRefresh: true
            })
          );
          const defaults = Array.isArray(profiles.defaults)
            ? profiles.defaults.find((value) => isObject(value) && value.runner === runner)
            : undefined;
          const profile = Array.isArray(profiles.profiles)
            ? profiles.profiles.find((value) => isObject(value) && value.runner === runner)
            : undefined;
          const models = isObject(profile) && Array.isArray(profile.models) ? profile.models : [];
          const preferred = models.find((value) => isObject(value) && value.isDefault === true);
          model =
            body.modelId ??
            (isObject(defaults) ? defaults.modelId : undefined) ??
            (isObject(preferred) ? preferred.id : undefined);
        }
        if (runner === 'mar-agent' && typeof model !== 'string')
          return sendError(reply, 400, 'MODEL_ID_REQUIRED');
        const claimedSource = 'sourceSessionId' in body ? body.sourceSessionId : undefined;
        if (
          caller.type === 'execution' &&
          claimedSource !== undefined &&
          claimedSource !== caller.sessionId
        )
          return sendError(reply, 403, 'MARCTL_EXECUTION_SOURCE_MISMATCH');
        if (
          caller.type === 'execution' &&
          body.action === 'start' &&
          body.parentSessionId !== undefined &&
          body.parentSessionId !== caller.sessionId
        )
          return sendError(reply, 403, 'MARCTL_EXECUTION_SOURCE_MISMATCH');
        const sourceSessionId = caller.type === 'execution' ? caller.sessionId : undefined;
        const sourceSession =
          sourceSessionId === undefined
            ? undefined
            : sourceSessionId === sessionId
              ? session
              : object(object(await call('session.get', { sessionId: sourceSessionId })).session);
        if (sourceSession !== undefined && sourceSession.workspaceId !== scope.workspaceId)
          return sendError(reply, 403, 'RESOURCE_ACCESS_DENIED');
        const origin: SessionExecutionOrigin = {
          ...(['start', 'send'].includes(body.action)
            ? {
                marctlOrigin:
                  sourceSession === undefined
                    ? {}
                    : {
                        sessionId: sourceSession.id as string,
                        name:
                          [sourceSession.customTitle, sourceSession.runnerTitle]
                            .find(
                              (title): title is string =>
                                typeof title === 'string' && title.trim().length > 0
                            )
                            ?.trim() ?? (sourceSession.id as string)
                      }
              }
            : {}),
          suppressNotifications: true
        };
        const executionContext = {
          nodeId: scope.nodeId,
          workspaceId: scope.workspaceId,
          user: { ...user, scheduled, ...(channel === undefined ? {} : { channel }) }
        };
        const runtimeModel =
          runner === 'mar-agent' && typeof model === 'string' ? { modelId: model } : {};
        const parentSessionId =
          body.action === 'start'
            ? caller.type === 'execution'
              ? caller.sessionId
              : body.parentSessionId
            : undefined;
        if (body.action === 'start')
          return reply.send(
            await sessionInputs.startSession(
              executionContext,
              {
                runner: body.runner,
                cwd: object(context.workspace).path as string,
                content: body.content,
                clientMessageId: body.clientMessageId,
                ...(typeof model === 'string' ? { modelId: model } : {}),
                ...(body.effort === undefined ? {} : { effort: body.effort }),
                ...(body.title === undefined ? {} : { customTitle: body.title }),
                ...(parentSessionId === undefined ? {} : { parentSessionId })
              },
              origin
            )
          );
        if (body.action === 'send')
          return reply.send(
            await sessionInputs.submitMessage(
              { ...executionContext, sessionId: sessionId as string },
              {
                content: body.content,
                clientMessageId: body.clientMessageId,
                deliveryIntent: body.deliveryIntent,
                ...runtimeModel
              },
              origin
            )
          );
        return reply.send(
          await sessionInputs.executeCommand(
            { ...executionContext, sessionId: sessionId as string },
            {
              commandId: 'goal',
              input: '/goal ' + body.content,
              ...runtimeModel
            },
            origin
          )
        );
      } catch (error) {
        return (input.onError ?? databaseError)(reply, error);
      }
    }
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new Error('NODE_RESPONSE_INVALID');
  return value;
}
