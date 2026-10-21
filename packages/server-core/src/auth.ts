import type { FastifyRequest } from 'fastify';

export const SESSION_COOKIE_NAME = 'mar_user_session';

export function parseCookies(request: FastifyRequest): Record<string, string> {
  const cookieHeader = request.headers.cookie;
  if (cookieHeader === undefined) {
    return {};
  }
  return cookieHeader.split(';').reduce<Record<string, string>>((cookies, part) => {
    const separator = part.indexOf('=');
    if (separator <= 0) {
      return cookies;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      // Ignore a malformed cookie instead of failing unrelated requests.
    }
    return cookies;
  }, {});
}

export function serializeSessionCookie(sessionId: string, secure: boolean): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function requestIp(request: FastifyRequest): string {
  return request.ip || 'unknown';
}

export function isAllowedOrigin(request: FastifyRequest, configuredPublicOrigin?: string): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) {
    return true;
  }
  const host = request.headers.host;
  if (host === undefined) {
    return false;
  }
  const expected = configuredPublicOrigin ?? `${request.protocol}://${host}`;
  return origin === expected;
}

export function boundedUserAgent(value: string | undefined): string {
  return value === undefined || value.length === 0 ? 'unknown' : value.slice(0, 512);
}
