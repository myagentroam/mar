import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  computerUseDisableInputSchema,
  computerUseEnableInputSchema,
  computerUseEnableResultSchema
} from '@myagentroam/protocol';
import { isAllowedOrigin } from './auth.js';
import { protectedManagementAdmin, validCsrf, type SessionLookup } from './session.js';
import { databaseError } from './domain-errors.js';
import { sendError } from './http-errors.js';
import { requestUserNode } from './workspace-http-support.js';
import type { SessionRunNodeControl } from './session-run-contracts.js';
import { publicNode } from './node-projection.js';

export function registerComputerUseRoutes(input: {
  readonly app: FastifyInstance;
  readonly database: SessionLookup;
  readonly nodeControl: Pick<SessionRunNodeControl, 'requestNode'> & {
    listNodes():
      | readonly Parameters<typeof publicNode>[0][]
      | Promise<readonly Parameters<typeof publicNode>[0][]>;
  };
  readonly publicOrigin: string | undefined;
  authorizeNode(userId: number, nodeId: string): Promise<void>;
}): void {
  const { app, database, nodeControl, publicOrigin, authorizeNode } = input;
  const register = (
    action: 'enable' | 'disable',
    schema: typeof computerUseEnableInputSchema | typeof computerUseDisableInputSchema
  ) => {
    app.post<{ Params: { nodeId: string }; Body: unknown }>(
      `/api/management/nodes/:nodeId/computer-use/${action}`,
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
        const parsed = schema.safeParse(request.body);
        if (!parsed.success)
          return sendError(
            reply,
            400,
            action === 'enable'
              ? 'COMPUTER_USE_ENABLE_INPUT_INVALID'
              : 'COMPUTER_USE_DISABLE_INPUT_INVALID'
          );
        const node = (await nodeControl.listNodes()).find(
          (candidate) => candidate.id === request.params.nodeId
        );
        if (node === undefined) return sendError(reply, 404, 'NODE_NOT_FOUND');
        if (!node.connected || node.disabled) return sendError(reply, 409, 'NODE_OFFLINE');
        const projection = publicNode(node) as {
          readonly capabilities?: { readonly computerUse?: unknown };
        };
        if (projection.capabilities?.computerUse === undefined)
          return sendError(reply, 409, 'COMPUTER_USE_NODE_VERSION_UNSUPPORTED');
        try {
          const result = computerUseEnableResultSchema.parse(
            await requestUserNode(
              nodeControl,
              admin,
              node.id,
              `computer.use.${action}`,
              parsed.data
            )
          );
          return reply.send(result);
        } catch (error) {
          return routeError(reply, error, action);
        }
      }
    );
  };
  register('enable', computerUseEnableInputSchema);
  register('disable', computerUseDisableInputSchema);
}

function routeError(
  reply: FastifyReply,
  error: unknown,
  action: 'enable' | 'disable'
): FastifyReply {
  if (error instanceof Error && error.name === 'ZodError')
    return sendError(
      reply,
      502,
      action === 'enable'
        ? 'COMPUTER_USE_ENABLE_RESPONSE_INVALID'
        : 'COMPUTER_USE_DISABLE_RESPONSE_INVALID'
    );
  return databaseError(reply, error);
}
