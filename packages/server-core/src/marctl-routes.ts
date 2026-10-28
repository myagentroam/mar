import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { isAllowedOrigin } from './auth.js';
import { sendError } from './http-errors.js';

const TERMINAL_COMMAND_MAX_BYTES = 64 * 1024;
import { databaseError as defaultDatabaseError } from './domain-errors.js';
import { publicNode } from './node-projection.js';
import { MarctlUserCredentials } from './marctl-user-credentials.js';
import type { UserNodeAuthorization } from './node-access-contracts.js';
import {
  registerMarctlSessionRoutes,
  type MarctlSessionDependencies
} from './marctl-session-routes.js';

interface OperationalNode {
  readonly id: string;
  readonly displayName?: string | null;
  readonly connected: boolean;
  readonly disabled: boolean;
  readonly metadata: string;
  readonly lastHeartbeatAt: number | null;
}

export function registerMarctlRoutes(
  input: MarctlSessionDependencies & {
    readonly app: FastifyInstance;
    readonly userCredentials: MarctlUserCredentials;
    readonly publicOrigin: string | undefined;
    readonly listNodes: () => Promise<readonly OperationalNode[]>;
    readonly canUseNode: (userId: number, nodeId: string) => Promise<boolean>;
    readonly secrets: {
      resolve(
        userId: number,
        nodeId: string
      ): Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;
    };
    readonly nodeControl: {
      requestNode(
        nodeId: string,
        operation: string,
        data: unknown,
        user: UserNodeAuthorization
      ): Promise<unknown>;
      createTerminalTicket(input: {
        readonly nodeId: string;
        readonly terminalId: string;
        readonly user: UserNodeAuthorization;
        readonly afterSequence?: number;
      }): { readonly ticket: string };
      attachBrowserTerminal(socket: WebSocket, ticket: unknown, user: UserNodeAuthorization): void;
      closeTerminal(nodeId: string, terminalId: string): void;
      attachWorkbench(socket: WebSocket, user: UserNodeAuthorization): void;
    };
    readonly onError?: (reply: FastifyReply, error: unknown) => FastifyReply;
  }
): {
  attach(
    socket: WebSocket,
    request: FastifyRequest<{ Querystring: { ticket?: string; deferred?: string } }>
  ): void;
  attachLive(socket: WebSocket, request: FastifyRequest): void;
} {
  const { app, userCredentials, nodeControl, publicOrigin } = input;
  const onError = input.onError ?? defaultDatabaseError;
  const validOrigin = (request: FastifyRequest) =>
    request.headers.origin === undefined || isAllowedOrigin(request, publicOrigin);
  const authenticated = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!validOrigin(request)) {
      sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
      return undefined;
    }
    const user = await userCredentials.authenticate(request.headers.authorization);
    if (user === undefined) sendError(reply, 401, 'UNAUTHENTICATED');
    return user;
  };
  const authorizedNode = async (user: UserNodeAuthorization, nodeId: string) =>
    (await input.canUseNode(user.userId, nodeId)) &&
    (await input.listNodes()).some((node) => node.id === nodeId && !node.disabled);

  registerMarctlSessionRoutes({
    ...input,
    credentials: userCredentials,
    authorizedNode,
    requestNode: (...args) => nodeControl.requestNode(...args),
    onError
  });

  app.get('/api/marctl/nodes', async (request, reply) => {
    try {
      const user = await authenticated(request, reply);
      if (user === undefined) return;
      const nodes = await input.listNodes();
      const visible = await Promise.all(
        nodes
          .filter((node) => !node.disabled)
          .map(async (node) => {
            if (!(await input.canUseNode(user.userId, node.id))) return undefined;
            return {
              id: node.id,
              displayName: node.displayName ?? node.id,
              connected: node.connected,
              platform: (publicNode(node) as { platform: string }).platform
            };
          })
      );
      return reply.send({ nodes: visible.filter((node) => node !== undefined) });
    } catch (error) {
      return onError(reply, error);
    }
  });
  app.get<{ Params: { nodeId: string } }>(
    '/api/marctl/nodes/:nodeId/manifest',
    async (request, reply) => {
      try {
        const user = await authenticated(request, reply);
        if (user === undefined) return;
        if (!(await authorizedNode(user, request.params.nodeId)))
          return sendError(reply, 403, 'RESOURCE_ACCESS_DENIED');
        const capabilities = await nodeControl.requestNode(
          request.params.nodeId,
          'node.workbench.capabilities',
          {},
          user
        );
        if (capabilities === null || typeof capabilities !== 'object')
          return reply.send(capabilities);
        return reply.send({ ...capabilities, deferredRelay: true });
      } catch (error) {
        return onError(reply, error);
      }
    }
  );
  app.post<{
    Body: { nodeId?: unknown; rows?: unknown; cols?: unknown; command?: unknown; binary?: unknown };
  }>('/api/marctl/terminals', async (request, reply) => {
    try {
      const user = await authenticated(request, reply);
      if (user === undefined) return;
      const { nodeId, rows, cols, command, binary } = request.body ?? {};
      if (
        typeof nodeId !== 'string' ||
        nodeId.length === 0 ||
        typeof rows !== 'number' ||
        !Number.isInteger(rows) ||
        rows < 1 ||
        rows > 1000 ||
        typeof cols !== 'number' ||
        !Number.isInteger(cols) ||
        cols < 1 ||
        cols > 1000 ||
        (binary !== undefined && (binary !== true || command === undefined)) ||
        (command !== undefined &&
          (typeof command !== 'string' ||
            command.trim().length === 0 ||
            command.includes('\0') ||
            Buffer.byteLength(command, 'utf8') > TERMINAL_COMMAND_MAX_BYTES))
      )
        return sendError(reply, 400, 'TERMINAL_OPEN_INVALID');
      if (!(await authorizedNode(user, nodeId)))
        return sendError(reply, 403, 'RESOURCE_ACCESS_DENIED');
      if (binary === true) {
        const capabilities = await nodeControl.requestNode(
          nodeId,
          'node.workbench.capabilities',
          {},
          user
        );
        if (
          capabilities === null ||
          typeof capabilities !== 'object' ||
          !('binaryTerminal' in capabilities) ||
          capabilities.binaryTerminal !== true
        )
          return sendError(reply, 409, 'TERMINAL_BINARY_UNAVAILABLE');
      }
      const result = await nodeControl.requestNode(
        nodeId,
        command === undefined ? 'terminal.open' : 'terminal.command.open',
        {
          rows,
          cols,
          ...(command === undefined ? {} : { command }),
          ...(binary === true ? { binary: true } : {}),
          secretEnvironment: {
            ...(await input.secrets.resolve(user.userId, nodeId)),
            ...(await userCredentials.environment(user, publicOrigin))
          }
        },
        user
      );
      const terminal =
        result !== null && typeof result === 'object' && 'terminal' in result
          ? result.terminal
          : undefined;
      const terminalId =
        terminal !== null && typeof terminal === 'object' && 'id' in terminal
          ? terminal.id
          : undefined;
      if (typeof terminalId !== 'string' || terminalId.length === 0)
        throw new Error('TERMINAL_OPEN_RESPONSE_INVALID');
      request.log.info({ event: 'marctl.terminal.open', nodeId }, 'marctl terminal opened');
      return reply.code(201).send({ terminalId, ...(binary === true ? { binary: true } : {}) });
    } catch (error) {
      return onError(reply, error);
    }
  });
  app.post<{
    Params: { terminalId: string };
    Body: { nodeId?: unknown; afterSequence?: unknown };
  }>('/api/marctl/terminals/:terminalId/attach-ticket', async (request, reply) => {
    try {
      const user = await authenticated(request, reply);
      if (user === undefined) return;
      const nodeId = request.body?.nodeId;
      const afterSequence = request.body?.afterSequence;
      if (
        typeof nodeId !== 'string' ||
        nodeId.length === 0 ||
        (afterSequence !== undefined &&
          (typeof afterSequence !== 'number' ||
            !Number.isSafeInteger(afterSequence) ||
            afterSequence < 0))
      )
        return sendError(reply, 400, 'TERMINAL_TICKET_INVALID');
      if (!(await authorizedNode(user, nodeId)))
        return sendError(reply, 403, 'RESOURCE_ACCESS_DENIED');
      return reply.code(201).send(
        nodeControl.createTerminalTicket({
          nodeId,
          terminalId: request.params.terminalId,
          user,
          ...(afterSequence === undefined ? {} : { afterSequence: afterSequence as number })
        })
      );
    } catch (error) {
      return onError(reply, error);
    }
  });
  app.delete<{ Params: { terminalId: string }; Body: { nodeId?: unknown } }>(
    '/api/marctl/terminals/:terminalId',
    async (request, reply) => {
      try {
        const user = await authenticated(request, reply);
        if (user === undefined) return;
        const nodeId = request.body?.nodeId;
        if (typeof nodeId !== 'string' || nodeId.length === 0)
          return sendError(reply, 400, 'NODE_ID_REQUIRED');
        if (!(await authorizedNode(user, nodeId)))
          return sendError(reply, 403, 'RESOURCE_ACCESS_DENIED');
        const result = await nodeControl.requestNode(
          nodeId,
          'terminal.close',
          { terminalId: request.params.terminalId },
          user
        );
        nodeControl.closeTerminal(nodeId, request.params.terminalId);
        request.log.info({ event: 'marctl.terminal.close', nodeId }, 'marctl terminal closed');
        return reply.send(result);
      } catch (error) {
        return onError(reply, error);
      }
    }
  );
  return {
    attachLive(socket, request) {
      if (!validOrigin(request)) {
        socket.close(1008, 'ORIGIN_NOT_ALLOWED');
        return;
      }
      // Preserve an immediate resume while user authentication is still in flight.
      socket.pause();
      void authenticatedSocket(request.headers.authorization)
        .then((user) => {
          if (user === undefined) socket.close(1008, 'UNAUTHENTICATED');
          else nodeControl.attachWorkbench(socket, user);
        })
        .catch(() => socket.close(1011, 'USER_AUTHORIZATION_UNAVAILABLE'))
        .finally(() => socket.resume());
    },
    attach(socket, request) {
      if (!validOrigin(request)) {
        socket.close(1008, 'ORIGIN_NOT_ALLOWED');
        return;
      }
      void authenticatedSocket(request.headers.authorization)
        .then((user) => {
          if (user === undefined) socket.close(1008, 'UNAUTHENTICATED');
          else
            nodeControl.attachBrowserTerminal(
              socket,
              request.query.deferred === '1'
                ? { ticket: request.query.ticket, deferred: true }
                : request.query.ticket,
              user
            );
        })
        .catch(() => socket.close(1011, 'USER_AUTHORIZATION_UNAVAILABLE'));
    }
  };

  async function authenticatedSocket(header: unknown) {
    return userCredentials.authenticate(header);
  }
}
