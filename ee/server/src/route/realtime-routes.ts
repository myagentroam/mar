import {
  registerSessionShareRealtimeRoute,
  SESSION_SHARE_COOKIE
} from '@myagentroam/server-core/session-share-routes';
import type { SessionShares } from '@myagentroam/server-core/session-shares';
import {
  registerWorkbenchRoute,
  authorizeRealtimeConnection
} from '@myagentroam/server-core/workbench-route';
import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import { type SessionLookup } from '@myagentroam/server-core/session';
import type { NodeControl } from '../node-control.js';
import type { WebSocket } from 'ws';
import type { FastifyRequest } from 'fastify';
import { FILE_RELAY_MAX_FRAME_BYTES } from '@myagentroam/protocol';
import { DesktopWebSocketDispatcher } from '../service/desktop-websocket-dispatcher.js';
import { registerBrowserFileRoutes } from './browser-file-routes.js';
import { MAX_NODE_STREAM_FRAME_BYTES } from '@myagentroam/protocol/node-stream-wire';
import { isAllowedOrigin, parseCookies } from '@myagentroam/server-core/auth';
import type { MarctlUserCredentials } from '@myagentroam/server-core/marctl-user-credentials';
import type { UserNodeAuthorization } from '@myagentroam/server-core/node-access-contracts';

export function registerRealtimeRoutes(input: {
  readonly app: FastifyInstance;
  readonly database: SessionLookup;
  readonly nodeControl: NodeControl;
  readonly publicOrigin: string | undefined;
  readonly sessionShares?: SessionShares;
  readonly relayAccess?: {
    readonly credentials: Pick<MarctlUserCredentials, 'authenticateContext'>;
    readonly canUseNode: (userId: number, nodeId: string) => Promise<boolean>;
    readonly canAccessNodeContainer: (userId: number, nodeId: string) => Promise<boolean>;
    readonly canAccessHostedConversation?: (
      user: UserNodeAuthorization,
      nodeId: string,
      conversationId: string
    ) => Promise<boolean>;
  };
  readonly attachMarctlLive?: (socket: WebSocket, request: FastifyRequest) => void;
}): void {
  const { app, database, nodeControl, publicOrigin } = input;
  app.register(async (routes) => {
    const perMessageDeflate = {
      clientNoContextTakeover: true,
      serverNoContextTakeover: true,
      threshold: 1024,
      zlibDeflateOptions: { level: 3 }
    };
    await routes.register(websocket, {
      options: { perMessageDeflate }
    });
    const desktopWebSockets = new DesktopWebSocketDispatcher(routes.websocketServer);
    const nodeRelayWebSockets = new DesktopWebSocketDispatcher(
      routes.websocketServer,
      MAX_NODE_STREAM_FRAME_BYTES,
      perMessageDeflate
    );
    const fileWebSockets = new DesktopWebSocketDispatcher(
      routes.websocketServer,
      FILE_RELAY_MAX_FRAME_BYTES,
      perMessageDeflate
    );
    routes.addHook('preClose', async () => {
      await fileWebSockets.close();
      await nodeRelayWebSockets.close();
      await desktopWebSockets.close();
    });
    const desktopWire = async (request: FastifyRequest) => desktopWebSockets.mark(request.raw);
    if (input.sessionShares !== undefined)
      registerSessionShareRealtimeRoute({
        app: routes,
        database,
        shares: input.sessionShares,
        publicOrigin,
        attach: (socket, user, share) => nodeControl.attachBrowserWorkbench(socket, user, share)
      });
    const shares = input.sessionShares;
    if (shares !== undefined) {
      const access = new WeakMap<FastifyRequest, Awaited<ReturnType<typeof shares.resolve>>>();
      routes.get<{ Params: { shareId: string } }>(
        '/api/session-shares/:shareId/relay',
        {
          websocket: true,
          preValidation: async (request, reply) => {
            if (!isAllowedOrigin(request, publicOrigin)) return reply.code(403).send();
            try {
              access.set(
                request,
                await shares.resolve(
                  request.params.shareId,
                  parseCookies(request)[SESSION_SHARE_COOKIE]
                )
              );
              nodeRelayWebSockets.mark(request.raw);
            } catch {
              return reply.code(403).send();
            }
          }
        },
        (socket, request) => {
          const { record, context } = access.get(request)!;
          nodeControl.attachShareFileRelay(socket, {
            shareId: record.id,
            expiresAt: record.expiresAt,
            nodeId: context.nodeId,
            user: context.user
          });
        }
      );
    }
    routes.get('/api/node/connect', { websocket: true }, (socket) => nodeControl.attach(socket));
    routes.get(
      '/api/node/relay',
      {
        websocket: true,
        preValidation: async (request) => nodeRelayWebSockets.mark(request.raw)
      },
      (socket) => nodeControl.attachNodeRelay(socket)
    );
    const relayAccess = input.relayAccess;
    if (relayAccess !== undefined)
      routes.get<{ Params: { nodeId: string }; Querystring: { hostedConversationId?: string } }>(
        '/api/relay/:nodeId',
        {
          websocket: true,
          preValidation: async (request) => nodeRelayWebSockets.mark(request.raw)
        },
        (socket, request) => {
          const nodeId = request.params.nodeId;
          if (
            !nodeId ||
            nodeId.length > 128 ||
            (request.headers.origin !== undefined && !isAllowedOrigin(request, publicOrigin))
          ) {
            socket.close(1008, 'NODE_RELAY_AUTH_INVALID');
            return;
          }
          const header = request.headers.authorization;
          socket.on('error', () => socket.terminate());
          socket.pause();
          void (async () => {
            const bearer =
              header === undefined
                ? undefined
                : await relayAccess.credentials.authenticateContext(header);
            const user =
              header === undefined
                ? authorizeRealtimeConnection(socket, request, database, publicOrigin)
                : bearer?.user;
            if (user === undefined) {
              if (header !== undefined) socket.close(1008, 'NODE_RELAY_AUTH_INVALID');
              return;
            }
            const admit =
              header === undefined ? relayAccess.canAccessNodeContainer : relayAccess.canUseNode;
            const normalAccess = await admit(user.userId, nodeId);
            const conversationId = request.query.hostedConversationId;
            // A template-only session may use this same endpoint, but only Hosted grants.
            if (
              !normalAccess &&
              !(
                header === undefined &&
                typeof conversationId === 'string' &&
                (await relayAccess.canAccessHostedConversation?.(user, nodeId, conversationId))
              )
            ) {
              socket.close(1008, 'NODE_RELAY_AUTH_INVALID');
              return;
            }
            // The login can end while Node access is checked, before the carrier is registered.
            if (header === undefined) {
              if (
                authorizeRealtimeConnection(socket, request, database, publicOrigin)
                  ?.sessionHash !== user.sessionHash
              )
                return;
            } else if ((await relayAccess.credentials.authenticateContext(header)) === undefined) {
              socket.close(1008, 'NODE_RELAY_AUTH_INVALID');
              return;
            }
            nodeControl.attachClientRelay(
              socket,
              nodeId,
              { userId: user.userId, sessionHash: user.sessionHash },
              bearer?.expiresAt,
              !normalAccess,
              bearer === undefined
                ? undefined
                : async () => {
                    // A carrier can outlive the credentials that admitted it. Check only the
                    // forwarding lease, not each TCP connection underneath it.
                    return (
                      (await relayAccess.canUseNode(user.userId, nodeId)) &&
                      (await relayAccess.credentials.authenticateContext(header)) !== undefined
                    );
                  }
            );
          })()
            .catch(() => socket.close(1011, 'USER_AUTHORIZATION_UNAVAILABLE'))
            .finally(() => socket.resume());
        }
      );
    routes.get(
      '/api/node/file-connect',
      {
        websocket: true,
        preValidation: async (request) => fileWebSockets.mark(request.raw)
      },
      (socket) => nodeControl.attachFileRelay(socket)
    );
    registerBrowserFileRoutes(routes, database, publicOrigin, nodeControl);
    routes.get(
      '/api/node/desktop-relay',
      { websocket: true, preValidation: desktopWire },
      (socket) => nodeControl.attachNodeDesktopRelay(socket)
    );
    routes.get(
      '/api/desktop/relay',
      { websocket: true, preValidation: desktopWire },
      (socket, request) => {
        const admin = authorizeRealtimeConnection(socket, request, database, publicOrigin);
        if (admin !== undefined)
          nodeControl.attachBrowserDesktopRelay(socket, {
            userId: admin.userId,
            sessionHash: admin.sessionHash
          });
      }
    );
    registerWorkbenchRoute({
      app: routes,
      database,
      publicOrigin,
      attach: (socket, user) => nodeControl.attachBrowserWorkbench(socket, user)
    });
    if (input.attachMarctlLive !== undefined)
      routes.get('/api/marctl/live', { websocket: true }, (socket, request) =>
        input.attachMarctlLive!(socket, request)
      );
  });
}
