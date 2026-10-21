import type { SessionLookup } from './session.js';

type Awaitable<T> = T | Promise<T>;

export type UserLocale = 'zh-CN' | 'en-US';

export interface PasswordLoginIdentity {
  readonly id: number;
  readonly passwordHash: string;
  readonly mustChangePassword: boolean;
  readonly isAdmin: boolean;
}

export interface UserSession {
  readonly sessionId: string;
  readonly csrfToken: string;
  readonly expiresAt: number;
  /** Hashes only: callers close connections without exposing revoked Cookie values. */
  readonly evictedSessionHashes: readonly string[];
}

export interface UserSessionSummary {
  readonly id: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly ipAddress: string;
  readonly userAgent: string;
  readonly current: boolean;
}

export interface AuthenticationStore extends SessionLookup {
  /** Return only identities that the active product permits to log in. */
  findUserForLogin(username: string): Awaitable<PasswordLoginIdentity | undefined>;
  verifyUserPassword(userId: number, password: string): Awaitable<boolean>;
  createUserSession(
    userId: number,
    metadata: { readonly ipAddress: string; readonly userAgent: string }
  ): Awaitable<UserSession>;
  listActiveUserSessions(
    userId: number,
    currentSessionId: string
  ): Awaitable<readonly UserSessionSummary[]>;
  revokeUserSessionByPublicId(userId: number, publicId: string): Awaitable<string | undefined>;
  revokeSession(sessionId: string): Awaitable<void>;
  rotateCsrfToken(sessionId: string): Awaitable<string | undefined>;
  /** Commit password and session revocation; audit is a non-blocking observer. */
  changePassword(
    userId: number,
    password: string,
    eventType: 'password_changed',
    ipAddress: string
  ): Awaitable<void>;
}

export interface AuthenticationAuditEvent {
  readonly eventType:
    | 'login_failed'
    | 'login_rate_limited'
    | 'login_succeeded'
    | 'login_session_lru_evicted'
    | 'user_session_revoked'
    | 'logout'
    | 'password_changed';
  readonly actorUserId?: number;
  readonly ipAddress: string;
}

export interface AuthenticationAuditSink {
  record(event: AuthenticationAuditEvent): Awaitable<void>;
}

export interface AuthenticationSessionLifecycle {
  closeSessionConnections(sessionHash: string): Awaitable<void>;
  closeAllConnections(): Awaitable<void>;
}

export interface UserLocalePreferences {
  locale(userId: number): Awaitable<UserLocale>;
  setLocale(userId: number, locale: UserLocale): Awaitable<void>;
}
