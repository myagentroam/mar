import { registerSessionShareRealtimeRoute } from '@myagentroam/server-core/session-share-routes';
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
import { DesktopWebSocketDispatcher } from '../service/desktop-websocket-dispatcher.js';
import { BROWSER_CONTROL_MAX_BYTES } from '@myagentroam/protocol';
import { registerBrowserFileRoutes } from './browser-file-routes.js';

export function registerRealtimeRoutes(input: {
  readonly app: FastifyInstance;
  readonly database: SessionLookup;
  readonly nodeControl: NodeControl;
  readonly publicOrigin: string | undefined;
  readonly sessionShares?: SessionShares;
  readonly attachMarctl?: (
    socket: WebSocket,
    request: FastifyRequest<{ Querystring: { ticket?: string } }>
  ) => void;
  readonly attachMarctlLive?: (socket: WebSocket, request: FastifyRequest) => void;
}): void {
  const { app, database, nodeControl, publicOrigin } = input;
  app.register(async (routes) => {
    await routes.register(websocket, {
      options: {
        perMessageDeflate: {
          clientNoContextTakeover: true,
          serverNoContextTakeover: true,
          threshold: 1024,
          zlibDeflateOptions: { level: 3 }
        }
      }
    });
    const desktopWebSockets = new DesktopWebSocketDispatcher(routes.websocketServer);
    const browserWebSockets = new DesktopWebSocketDispatcher(
      routes.websocketServer,
      BROWSER_CONTROL_MAX_BYTES
    );
    routes.addHook('preClose', async () => {
      await browserWebSockets.close();
      await desktopWebSockets.close();
    });
    const desktopWire = async (request: FastifyRequest) => desktopWebSockets.mark(request.raw);
    const browserWire = async (request: FastifyRequest) => browserWebSockets.mark(request.raw);
    if (input.sessionShares !== undefined)
      registerSessionShareRealtimeRoute({
        app: routes,
        database,
        shares: input.sessionShares,
        publicOrigin,
        attach: (socket, user, share) => nodeControl.attachBrowserWorkbench(socket, user, share)
      });
    routes.get('/api/node/connect', { websocket: true }, (socket) => nodeControl.attach(socket));
    routes.get('/api/node/terminal-connect', { websocket: true }, (socket) =>
      nodeControl.attachTerminal(socket)
    );
    routes.get(
      '/api/node/browser-relay',
      { websocket: true, preValidation: browserWire },
      (socket, request) => nodeControl.attachNodeBrowserRelay(socket, request.headers)
    );
    routes.get<{ Querystring: { connectionId?: string } }>(
      '/api/browser/relay',
      { websocket: true, preValidation: browserWire },
      (socket, request) => {
        const user = authorizeRealtimeConnection(socket, request, database, publicOrigin);
        if (!user) return;
        if (typeof request.query.connectionId !== 'string') return socket.terminate();
        nodeControl.attachBrowserRelay(
          socket,
          { userId: user.userId, sessionHash: user.sessionHash },
          request.query.connectionId
        );
      }
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
    routes.get<{ Params: { terminalId: string }; Querystring: { ticket?: string } }>(
      '/api/terminals/:terminalId/connect',
      { websocket: true },
      (socket, request) => {
        const admin = authorizeRealtimeConnection(socket, request, database, publicOrigin);
        if (admin !== undefined)
          nodeControl.attachBrowserTerminal(socket, request.query.ticket, {
            userId: admin.userId,
            sessionHash: admin.sessionHash
          });
      }
    );
    if (input.attachMarctl !== undefined)
      routes.get<{ Params: { terminalId: string }; Querystring: { ticket?: string } }>(
        '/api/marctl/terminals/:terminalId/connect',
        { websocket: true },
        (socket, request) => input.attachMarctl!(socket, request)
      );
    if (input.attachMarctlLive !== undefined)
      routes.get('/api/marctl/live', { websocket: true }, (socket, request) =>
        input.attachMarctlLive!(socket, request)
      );
  });
}
