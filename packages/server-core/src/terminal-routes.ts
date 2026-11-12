import type { FastifyInstance, FastifyReply } from 'fastify';
import { isAllowedOrigin } from './auth.js';
import { protectedAdmin, validCsrf, type SessionLookup } from './session.js';
import { sendError } from './http-errors.js';
import { isNonEmptyString, requestUserNode } from './workspace-http-support.js';
import type { WorkspaceNodeControl } from './workspace-route-contracts.js';
import type { TerminalRelayService } from './terminal-relay-service.js';
import type { MarctlServerUrlForNode, MarctlUserCredentials } from './marctl-user-credentials.js';

export function registerTerminalRoutes(input: {
  app: FastifyInstance;
  database: SessionLookup;
  publicOrigin: string | undefined;
  databaseError: (reply: FastifyReply, error: unknown) => FastifyReply;
  secrets: {
    resolve(
      userId: number,
      nodeId: string,
      workspaceId?: string
    ): Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;
  };
  userCredentials?: MarctlUserCredentials;
  marctlServerUrlForNode?: MarctlServerUrlForNode;
  nodeControl: Pick<WorkspaceNodeControl, 'requestNode'> & {
    createTerminalTicket: TerminalRelayService['createTicket'];
    closeTerminal: TerminalRelayService['closeTerminal'];
  };
}): void {
  const { app, database, nodeControl, secrets, publicOrigin, databaseError } = input;
  app.post<{
    Body: {
      nodeId?: unknown;
      workspaceId?: unknown;
      profileId?: unknown;
      rows?: unknown;
      cols?: unknown;
    };
  }>('/api/terminals', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    const body = request.body ?? {};
    if (
      !isNonEmptyString(body.nodeId) ||
      (body.workspaceId !== undefined && !isNonEmptyString(body.workspaceId)) ||
      (body.profileId !== undefined && typeof body.profileId !== 'string') ||
      (body.rows !== undefined && typeof body.rows !== 'number') ||
      (body.cols !== undefined && typeof body.cols !== 'number')
    ) {
      return sendError(reply, 400, 'TERMINAL_OPEN_INVALID');
    }
    try {
      const serverUrl = (await input.marctlServerUrlForNode?.(body.nodeId)) ?? publicOrigin;
      return reply.code(201).send(
        await requestUserNode(nodeControl, admin, body.nodeId, 'terminal.open', {
          ...(typeof body.profileId === 'string' ? { profileId: body.profileId } : {}),
          ...(typeof body.workspaceId === 'string' ? { workspaceId: body.workspaceId } : {}),
          ...(typeof body.rows === 'number' ? { rows: body.rows } : {}),
          ...(typeof body.cols === 'number' ? { cols: body.cols } : {}),
          secretEnvironment: {
            ...(await secrets.resolve(
              admin.userId,
              body.nodeId,
              typeof body.workspaceId === 'string' ? body.workspaceId : undefined
            )),
            MAR_USERNAME: admin.username,
            ...(await input.userCredentials?.environment(
              admin,
              serverUrl,
              typeof body.workspaceId === 'string'
                ? { nodeId: body.nodeId, workspaceId: body.workspaceId }
                : undefined
            ))
          }
        })
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.get<{ Querystring: { nodeId?: string } }>('/api/terminals', async (request, reply) => {
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!isNonEmptyString(request.query.nodeId)) return sendError(reply, 400, 'NODE_ID_REQUIRED');
    try {
      return reply.send(
        await requestUserNode(nodeControl, admin, request.query.nodeId, 'terminal.list', {})
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.post<{
    Params: { terminalId: string };
    Body: {
      nodeId?: unknown;
      workspaceId?: unknown;
      afterSequence?: unknown;
      readonly?: unknown;
      takeover?: unknown;
    };
  }>('/api/terminals/:terminalId/attach-ticket', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    const body = request.body ?? {};
    if (body.takeover !== undefined) return sendError(reply, 400, 'TERMINAL_TICKET_INVALID');
    if (
      !isNonEmptyString(body.nodeId) ||
      (body.workspaceId !== undefined && !isNonEmptyString(body.workspaceId))
    )
      return sendError(reply, 400, 'NODE_ID_REQUIRED');
    try {
      return reply.code(201).send(
        nodeControl.createTerminalTicket({
          nodeId: body.nodeId,
          terminalId: request.params.terminalId,
          user: { userId: admin.userId, sessionHash: admin.sessionHash },
          ...(typeof body.workspaceId === 'string' ? { workspaceId: body.workspaceId } : {}),
          ...(body.afterSequence === undefined ? {} : { afterSequence: body.afterSequence }),
          ...(body.readonly === undefined ? {} : { readonly: body.readonly })
        })
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.delete<{
    Params: { terminalId: string };
    Body: { nodeId?: unknown };
  }>('/api/terminals/:terminalId', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    if (!isNonEmptyString(request.body?.nodeId)) return sendError(reply, 400, 'NODE_ID_REQUIRED');
    try {
      const result = await requestUserNode(
        nodeControl,
        admin,
        request.body.nodeId,
        'terminal.close',
        { terminalId: request.params.terminalId }
      );
      nodeControl.closeTerminal(request.body.nodeId, request.params.terminalId);
      return reply.send(result);
    } catch (error) {
      return databaseError(reply, error);
    }
  });
}
