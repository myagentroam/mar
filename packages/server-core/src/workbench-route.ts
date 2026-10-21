import type {} from '@fastify/websocket';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { isAllowedOrigin } from './auth.js';
import { currentSession, type SessionLookup } from './session.js';
import type { UserNodeAuthorization } from './node-request-channel.js';

/** The host registers the WebSocket plugin before installing this route. */
export function registerWorkbenchRoute(input: {
  app: FastifyInstance;
  database: SessionLookup;
  publicOrigin: string | undefined;
  attach: (socket: WebSocket, user: UserNodeAuthorization) => void;
}): void {
  input.app.get('/api/workbench/live', { websocket: true }, (socket, request) => {
    const user = authorizeRealtimeConnection(socket, request, input.database, input.publicOrigin);
    if (user === undefined) return;
    input.attach(socket, { userId: user.userId, sessionHash: user.sessionHash });
  });
}

export function authorizeRealtimeConnection(
  socket: { close(code: number, reason: string): void },
  request: FastifyRequest,
  database: SessionLookup,
  publicOrigin: string | undefined
) {
  if (!isAllowedOrigin(request, publicOrigin)) {
    socket.close(4003, 'ORIGIN_NOT_ALLOWED');
    return undefined;
  }
  const user = currentSession(database, request);
  if (user === undefined || user.mustChangePassword) {
    socket.close(4001, 'UNAUTHENTICATED');
    return undefined;
  }
  return user;
}
