import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  runnerDefaultConfigurationSchema,
  type ServerWorkbenchCapabilities
} from '@myagentroam/protocol';
import { isAllowedOrigin } from './auth.js';
import { protectedAdmin, validCsrf, type SessionLookup } from './session.js';
import { sendError } from './http-errors.js';
import { requestUserNode, isNonEmptyString } from './workspace-http-support.js';
import type { SessionRunNodeControl, ProcessSecretResolver } from './session-run-contracts.js';
import type { MarAgentModelService } from './mar-agent-model-service.js';
import { requireMarAgentAutoSupport } from './mar-agent-auto-support.js';
import { prepareRunnerProfileContext } from './runner-profile-context.js';

export function registerRunnerRoutes(input: {
  app: FastifyInstance;
  database: SessionLookup;
  nodeControl: Pick<SessionRunNodeControl, 'requestNode'>;
  secrets: ProcessSecretResolver;
  marAgentModels?: Pick<MarAgentModelService, 'listForUser'>;
  publicOrigin: string | undefined;
  capabilities: ServerWorkbenchCapabilities;
  databaseError: (reply: FastifyReply, error: unknown) => FastifyReply;
}): void {
  const { app, database, nodeControl, secrets, marAgentModels, publicOrigin, databaseError } =
    input;
  const SERVER_WORKBENCH_CAPABILITIES = input.capabilities;
  app.get('/api/workbench-capabilities', async (request, reply) => {
    if (protectedAdmin(database, request, reply) === undefined) return;
    return reply.send(SERVER_WORKBENCH_CAPABILITIES);
  });

  app.get<{ Params: { nodeId: string } }>(
    '/api/nodes/:nodeId/workbench-capabilities',
    async (request, reply) => {
      const admin = protectedAdmin(database, request, reply);
      if (admin === undefined) return;
      try {
        return reply.send(
          await requestUserNode(
            nodeControl,
            admin,
            request.params.nodeId,
            'node.workbench.capabilities',
            {}
          )
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.get<{
    Querystring: {
      nodeId?: string;
      workspaceId?: string;
      cacheOnly?: string;
      waitForRefresh?: string;
    };
  }>('/api/runner-profiles', async (request, reply) => {
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!isNonEmptyString(request.query.nodeId)) return sendError(reply, 400, 'NODE_ID_REQUIRED');
    if (request.query.workspaceId !== undefined && !isNonEmptyString(request.query.workspaceId))
      return sendError(reply, 400, 'MESSAGE_INVALID');
    try {
      return reply.send(
        await requestUserNode(
          nodeControl,
          admin,
          request.query.nodeId,
          'runner.profiles.list',
          {
            ...(await prepareRunnerProfileContext({
              userId: admin.userId,
              nodeId: request.query.nodeId,
              ...(request.query.workspaceId === undefined
                ? {}
                : { workspaceId: request.query.workspaceId }),
              secrets,
              ...(marAgentModels === undefined ? {} : { models: marAgentModels })
            })),
            ...(request.query.cacheOnly === 'true'
              ? { waitForRefresh: false }
              : request.query.waitForRefresh === 'true'
                ? { waitForRefresh: true }
                : {})
          },
          request.query.workspaceId,
          request.query.waitForRefresh === 'true' ? 120_000 : undefined
        )
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.get<{ Querystring: { nodeId?: string } }>(
    '/api/runner-usage/status',
    async (request, reply) => {
      const admin = protectedAdmin(database, request, reply);
      if (admin === undefined) return;
      if (!isNonEmptyString(request.query.nodeId)) return sendError(reply, 400, 'NODE_ID_REQUIRED');
      try {
        return reply.send(
          await requestUserNode(nodeControl, admin, request.query.nodeId, 'runner.usage.status', {})
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.get<{ Querystring: { nodeId?: string; runner?: string } }>(
    '/api/runner-usage',
    async (request, reply) => {
      const admin = protectedAdmin(database, request, reply);
      if (admin === undefined) return;
      if (!isNonEmptyString(request.query.nodeId)) return sendError(reply, 400, 'NODE_ID_REQUIRED');
      if (request.query.runner !== 'codex' && request.query.runner !== 'claude-code')
        return sendError(reply, 400, 'RUNNER_USAGE_INVALID');
      try {
        return reply.send(
          await requestUserNode(nodeControl, admin, request.query.nodeId, 'runner.usage.read', {
            runner: request.query.runner
          })
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.put<{
    Body: {
      nodeId?: unknown;
      runner?: unknown;
      modelId?: unknown;
      effort?: unknown;
      access?: unknown;
    };
  }>('/api/runner-defaults', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    const body = request.body ?? {};
    const parsed = runnerDefaultConfigurationSchema.safeParse({
      runner: body.runner,
      modelId: body.modelId,
      effort: body.effort,
      access: body.access
    });
    if (Object.hasOwn(body, 'model') || !isNonEmptyString(body.nodeId) || !parsed.success)
      return sendError(reply, 400, 'RUNNER_DEFAULT_INVALID');
    try {
      await requireMarAgentAutoSupport({
        access: parsed.data.access,
        runner: parsed.data.runner,
        request: (operation, data) =>
          requestUserNode(nodeControl, admin, body.nodeId as string, operation, data)
      });
      return reply.send(
        await requestUserNode(nodeControl, admin, body.nodeId, 'runner.defaults.save', parsed.data)
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });
}
