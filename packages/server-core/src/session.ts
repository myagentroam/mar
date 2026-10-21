import type { FastifyReply, FastifyRequest } from 'fastify';
import { parseCookies, SESSION_COOKIE_NAME } from './auth.js';
import { csrfMatches } from './session-token.js';
import { sendError } from './http-errors.js';

export interface CurrentUserSession {
  readonly userId: number;
  readonly username: string;
  readonly isAdmin: boolean;
  /** Hash only: safe to bind a Node operation without disclosing the Cookie. */
  readonly sessionHash: string;
  readonly mustChangePassword: boolean;
  readonly csrfTokenHash: string;
}

export interface SessionLookup {
  findCurrentUserSession(sessionId: string): CurrentUserSession | undefined;
}

export function currentSession(
  database: SessionLookup,
  request: FastifyRequest
): CurrentUserSession | undefined {
  const sessionId = parseCookies(request)[SESSION_COOKIE_NAME];
  return sessionId === undefined ? undefined : database.findCurrentUserSession(sessionId);
}

export function protectedAdmin(
  database: SessionLookup,
  request: FastifyRequest,
  reply: FastifyReply
): CurrentUserSession | undefined {
  const current = currentSession(database, request);
  if (current === undefined) {
    void sendError(reply, 401, 'UNAUTHENTICATED');
    return undefined;
  }
  if (current.mustChangePassword) {
    void sendError(reply, 403, 'PASSWORD_CHANGE_REQUIRED');
    return undefined;
  }
  return current;
}

export function protectedManagementAdmin(
  database: SessionLookup,
  request: FastifyRequest,
  reply: FastifyReply
): CurrentUserSession | undefined {
  const current = protectedAdmin(database, request, reply);
  if (current === undefined) return undefined;
  if (!current.isAdmin) {
    void sendError(reply, 403, 'ADMIN_REQUIRED');
    return undefined;
  }
  return current;
}

export function validCsrf(
  request: FastifyRequest,
  current: Pick<CurrentUserSession, 'csrfTokenHash'>
): boolean {
  const header = request.headers['x-csrf-token'];
  return csrfMatches(current.csrfTokenHash, typeof header === 'string' ? header : undefined);
}
