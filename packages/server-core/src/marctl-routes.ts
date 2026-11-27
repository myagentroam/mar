import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { terminalCopySchema } from '@myagentroam/protocol';
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
    readonly searchBackendAvailable?: () => boolean;
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
        user: UserNodeAuthorization,
        timeoutMs?: number,
        signal?: AbortSignal
      ): Promise<unknown>;
      createTerminalTicket(input: {
        readonly nodeId: string;
        readonly terminalId: string;
        readonly user: UserNodeAuthorization;
        readonly afterSequence?: number;
        readonly computer?: boolean;
        readonly cli?: boolean;
      }): { readonly ticket: string };
      attachCliTerminal(
        socket: WebSocket,
        ticket: unknown,
        user: UserNodeAuthorization,
        expiresAt: number
      ): void;
      attachCliMux?(
        socket: WebSocket,
        nodeId: string,
        user: UserNodeAuthorization,
        expiresAt: number
      ): void;
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
  attachMux(socket: WebSocket, request: FastifyRequest<{ Querystring: { node?: string } }>): void;
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

  // A separate route makes unsupported Servers fail instead of opening an interactive shell.
  app.post<{ Body: { nodeId?: unknown; copy?: unknown } }>(
    '/api/marctl/terminals/copy',
    async (request, reply) => {
      try {
        const user = await authenticated(request, reply);
        if (user === undefined) return;
        const { nodeId, copy } = request.body ?? {};
        const parsed = terminalCopySchema.safeParse(copy);
        if (
          typeof nodeId !== 'string' ||
          nodeId.length === 0 ||
          nodeId.length > 128 ||
          !parsed.success ||
          Object.keys(request.body ?? {}).some((key) => key !== 'nodeId' && key !== 'copy')
        )
          return sendError(reply, 400, 'SCP_OPEN_INVALID');
        if (!(await authorizedNode(user, nodeId)))
          return sendError(reply, 403, 'RESOURCE_ACCESS_DENIED');
        const opened = await nodeControl.requestNode(
          nodeId,
          'terminal.copy.open',
          { copy: parsed.data },
          user
        );
        const terminalId = (opened as { terminal?: { id?: unknown } } | null)?.terminal?.id;
        if (typeof terminalId !== 'string' || terminalId.length === 0)
          throw new Error('TERMINAL_OPEN_RESPONSE_INVALID');
        return reply.code(201).send({ terminalId });
      } catch (error) {
        return onError(reply, error);
      }
    }
  );

  app.post<{ Body: { nodeId?: unknown } }>('/api/marctl/computer', async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    let terminalId: string | undefined;
    let user: UserNodeAuthorization | undefined;
    const nodeId = request.body?.nodeId;
    try {
      user = await authenticated(request, reply);
      if (user === undefined) return;
      if (typeof nodeId !== 'string' || nodeId.length === 0 || nodeId.length > 128)
        return sendError(reply, 400, 'NODE_ID_REQUIRED');
      if (!(await authorizedNode(user, nodeId)))
        return sendError(reply, 403, 'RESOURCE_ACCESS_DENIED');
      const opened = await nodeControl.requestNode(nodeId, 'computer.use.open', {}, user);
      const terminal = (opened as { terminal?: { id?: unknown } } | null)?.terminal;
      if (typeof terminal?.id !== 'string') throw new Error('TERMINAL_OPEN_RESPONSE_INVALID');
      terminalId = terminal.id;
      const { ticket } = nodeControl.createTerminalTicket({
        nodeId,
        terminalId,
        user,
        computer: true,
        cli: true
      });
      return reply.code(201).send({ terminalId, ticket });
    } catch (error) {
      if (terminalId !== undefined && user !== undefined && typeof nodeId === 'string')
        await nodeControl
          .requestNode(nodeId, 'terminal.close', { terminalId }, user)
          .catch(() => undefined);
      return onError(reply, error);
    }
  });

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
    Body: { nodeId?: unknown; rows?: unknown; cols?: unknown; command?: unknown };
  }>('/api/marctl/terminals', async (request, reply) => {
    try {
      const user = await authenticated(request, reply);
      if (user === undefined) return;
      const body = request.body ?? {};
      const { nodeId, rows, cols, command } = body;
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
        Object.keys(body).some((key) => !['nodeId', 'rows', 'cols', 'command'].includes(key)) ||
        (command !== undefined &&
          (typeof command !== 'string' ||
            command.trim().length === 0 ||
            command.includes('\0') ||
            Buffer.byteLength(command, 'utf8') > TERMINAL_COMMAND_MAX_BYTES))
      )
        return sendError(reply, 400, 'TERMINAL_OPEN_INVALID');
      if (!(await authorizedNode(user, nodeId)))
        return sendError(reply, 403, 'RESOURCE_ACCESS_DENIED');
      const result = await nodeControl.requestNode(
        nodeId,
        command === undefined ? 'terminal.open' : 'terminal.command.open',
        {
          rows,
          cols,
          ...(command === undefined ? {} : { command }),
          secretEnvironment: {
            ...(await input.secrets.resolve(user.userId, nodeId)),
            ...(await userCredentials.environment(
              user,
              (await input.marctlServerUrlForNode?.(nodeId)) ?? publicOrigin
            ))
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
      return reply.code(201).send({ terminalId });
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
          cli: true,
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
    attachMux(socket, request) {
      const nodeId = request.query.node;
      if (
        !validOrigin(request) ||
        typeof nodeId !== 'string' ||
        !nodeId ||
        nodeId.length > 128 ||
        nodeControl.attachCliMux === undefined
      ) {
        socket.close(1008, 'TERMINAL_MUX_INVALID');
        return;
      }
      const header = request.headers.authorization;
      socket.pause();
      void userCredentials
        .authenticateContext(header)
        .then(async (context) => {
          if (context === undefined || !(await authorizedNode(context.user, nodeId))) {
            socket.close(1008, 'UNAUTHENTICATED');
            return;
          }
          nodeControl.attachCliMux?.(socket, nodeId, context.user, context.expiresAt);
        })
        .catch(() => socket.close(1011, 'USER_AUTHORIZATION_UNAVAILABLE'))
        .finally(() => socket.resume());
    },
    attachLive(socket, request) {
      if (!validOrigin(request)) {
        socket.close(1008, 'ORIGIN_NOT_ALLOWED');
        return;
      }
      // Preserve an immediate resume while user authentication is still in flight.
      socket.pause();
      void userCredentials
        .authenticateContext(request.headers.authorization)
        .then((context) => {
          if (context === undefined || context.expiresAt <= Date.now()) {
            socket.close(1008, 'UNAUTHENTICATED');
            return;
          }
          if (socket.readyState !== socket.OPEN) return;
          const expiry = setTimeout(() => socket.terminate(), context.expiresAt - Date.now());
          expiry.unref();
          socket.once('close', () => clearTimeout(expiry));
          nodeControl.attachWorkbench(socket, { ...context.user, cliTerminal: true });
        })
        .catch(() => socket.close(1011, 'USER_AUTHORIZATION_UNAVAILABLE'))
        .finally(() => socket.resume());
    },
    attach(socket, request) {
      if (!validOrigin(request)) {
        socket.close(1008, 'ORIGIN_NOT_ALLOWED');
        return;
      }
      void userCredentials
        .authenticateContext(request.headers.authorization)
        .then((context) => {
          if (context === undefined) socket.close(1008, 'UNAUTHENTICATED');
          else
            nodeControl.attachCliTerminal(
              socket,
              request.query.deferred === '1'
                ? { ticket: request.query.ticket, deferred: true }
                : request.query.ticket,
              context.user,
              context.expiresAt
            );
        })
        .catch(() => socket.close(1011, 'USER_AUTHORIZATION_UNAVAILABLE'));
    }
  };
}
