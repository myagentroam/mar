import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { HostedNodeControl } from './hosted-contracts.js';
import type { Pool } from 'mysql2/promise';
import { z } from 'zod';
import {
  nodeCapabilitiesSchema,
  promptCompletionTargetSchema,
  promptCompletionCancelSchema,
  promptCompletionContextInputSchema,
  promptCompletionGenerateInputSchema
} from '@myagentroam/protocol';
import { isAllowedOrigin } from './auth.js';
import { protectedAdmin, validCsrf, type SessionLookup } from './session.js';
import { sendError } from './http-errors.js';
import type { WorkspaceNodeControl } from './workspace-route-contracts.js';
import type { MarAgentModelService } from './mar-agent-model-service.js';
import type { MarAgentRuntimeModelService } from './mar-agent-runtime-model-service.js';
import { PromptCompletionSettings } from './prompt-completion-settings.js';
import {
  PromptCompletionAccessError,
  PromptCompletionRelayService
} from './prompt-completion-relay-service.js';

const cancelInput = z
  .object({
    target: promptCompletionTargetSchema,
    workbenchConnectionId: z.string().min(1).max(256),
    request: promptCompletionCancelSchema
  })
  .strict();

export function registerPromptCompletionRoutes(input: {
  readonly app: FastifyInstance;
  readonly database: SessionLookup & { readonly raw: Pool };
  readonly databaseError: (reply: FastifyReply, error: unknown) => FastifyReply;
  readonly models: MarAgentModelService;
  readonly runtimeModels: MarAgentRuntimeModelService;
  readonly resources: {
    assertCanUseWorkspace(userId: number, nodeId: string, workspaceId: string): Promise<unknown>;
  };
  readonly nodeControl: WorkspaceNodeControl & Pick<HostedNodeControl, 'listNodes'>;
  readonly publicOrigin?: string;
}): void {
  const { app, database, nodeControl, models, runtimeModels, resources } = input;
  const service = new PromptCompletionRelayService({
    settings: new PromptCompletionSettings(database.raw, models),
    runtimeModels,
    ownsConnection: (sessionHash, connectionId) =>
      nodeControl.ownsWorkbenchConnection(sessionHash, connectionId),
    available: async (nodeId, trigger) => {
      const node = (await nodeControl.listNodes()).find((candidate) => candidate.id === nodeId);
      if (!node || !node.connected || node.disabled) return false;
      let raw: unknown;
      try {
        raw = JSON.parse(node.metadata);
      } catch {
        return false;
      }
      const capabilities = nodeCapabilitiesSchema.safeParse(raw);
      if (!capabilities.success || capabilities.data.promptCompletion?.apiVersion !== 1)
        return false;
      if (trigger === 'AUTO' && capabilities.data.promptCompletion.automaticTriggers !== true)
        return false;
      return true;
    },
    authorize: async (actor, nodeId, target) => {
      const revalidate = async () => {
        await resources.assertCanUseWorkspace(actor.userId, nodeId, target.workspaceId);
      };
      await revalidate();
      return {
        workspaceId: target.workspaceId,
        authorizationView: digest([actor.userId, nodeId, target]),
        revalidate
      };
    },
    canUseModel: async (userId, modelId) =>
      (await models.storedConfigurationsForUser(userId)).some(
        (model) => model.id === modelId && model.enabled
      ),
    forward: (actor, nodeId, _target, operation, data, workspaceId) =>
      nodeControl.requestNode(
        nodeId,
        `prompt-completion.${operation}`,
        data,
        {
          userId: actor.userId,
          sessionHash: actor.sessionHash,
          ...(workspaceId ? { workspaceId } : {})
        },
        12_000
      )
  });
  app.addHook('onClose', async () => {
    service.dispose();
  });

  for (const action of ['context', 'generate', 'cancel'] as const) {
    app.post<{ Params: { nodeId: string }; Body: unknown }>(
      `/api/nodes/:nodeId/prompt-completion/${action}`,
      { bodyLimit: 32_768 },
      async (request, reply) => {
        if (!isAllowedOrigin(request, input.publicOrigin))
          return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
        const actor = protectedAdmin(database, request, reply);
        if (!actor) return;
        if (!validCsrf(request, actor)) return sendError(reply, 403, 'CSRF_INVALID');
        if (!request.params.nodeId || request.params.nodeId.length > 256)
          return sendError(reply, 400, 'MESSAGE_INVALID');
        reply.header('Cache-Control', 'private, no-store');
        try {
          if (action === 'context') {
            const parsed = promptCompletionContextInputSchema.safeParse(request.body);
            if (!parsed.success) return sendError(reply, 400, 'MESSAGE_INVALID');
            return await service.context(actor, request.params.nodeId, parsed.data);
          }
          if (action === 'cancel') {
            const parsed = cancelInput.safeParse(request.body);
            if (!parsed.success) return sendError(reply, 400, 'MESSAGE_INVALID');
            await service.cancel(
              actor,
              request.params.nodeId,
              parsed.data.target,
              parsed.data.workbenchConnectionId,
              parsed.data.request
            );
            return { cancelled: true };
          }
          const parsed = promptCompletionGenerateInputSchema.safeParse(request.body);
          if (!parsed.success) return sendError(reply, 400, 'MESSAGE_INVALID');
          const data = parsed.data;
          const abort = () => {
            if (reply.raw.writableEnded) return;
            void service
              .cancel(actor, request.params.nodeId, data.target, data.workbenchConnectionId, {
                requestId: data.request.requestId,
                pageEpoch: data.request.pageEpoch,
                intentSequence: data.request.intentSequence
              })
              .catch(() => undefined);
          };
          reply.raw.once('close', abort);
          try {
            return await service.generate(actor, request.params.nodeId, data);
          } finally {
            reply.raw.removeListener('close', abort);
          }
        } catch (error) {
          if (error instanceof PromptCompletionAccessError)
            return sendError(reply, error.statusCode, error.code, { message: error.message });
          return input.databaseError(reply, error);
        }
      }
    );
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
