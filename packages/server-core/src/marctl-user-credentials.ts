import { createHash, randomBytes } from 'node:crypto';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { UserNodeAuthorization } from './node-request-channel.js';

const TOKEN_PATTERN = /^marctl_user_[A-Za-z0-9_-]{43}$/u;
const TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_ACTIVE_TOKENS = 4096;

export interface MarctlExecutionScope {
  readonly nodeId: string;
  readonly workspaceId: string;
}

interface ScopedUser {
  readonly userId: number;
  readonly sessionHash: string;
  readonly expiresAt: number;
  readonly scheduled: boolean;
  readonly channel: boolean;
  readonly scope?: MarctlExecutionScope;
}

/** Ephemeral, user-scoped CLI credentials. No browser session secret leaves Server. */
export class MarctlUserCredentials {
  private readonly credentials = new Map<string, ScopedUser>();

  constructor(
    private readonly pool: Pool,
    private readonly now: () => number = Date.now
  ) {}

  issue(
    user: {
      readonly userId: number;
      readonly sessionHash?: string;
      readonly scheduled?: boolean;
      readonly channel?: boolean;
    },
    scope?: MarctlExecutionScope
  ): string {
    if (!Number.isSafeInteger(user.userId) || user.userId <= 0)
      throw new Error('USER_AUTHORIZATION_REQUIRED');
    if (user.sessionHash !== undefined && !/^[A-Za-z0-9_-]{43}$/u.test(user.sessionHash))
      throw new Error('USER_AUTHORIZATION_REQUIRED');
    for (const [hash, credential] of this.credentials) {
      if (credential.expiresAt <= this.now()) this.credentials.delete(hash);
    }
    if (this.credentials.size >= MAX_ACTIVE_TOKENS) throw new Error('MARCTL_USER_CREDENTIAL_LIMIT');
    const token = `marctl_user_${randomBytes(32).toString('base64url')}`;
    this.credentials.set(digest(token), {
      userId: user.userId,
      sessionHash: user.sessionHash ?? createHash('sha256').update(token).digest('base64url'),
      expiresAt: this.now() + TOKEN_LIFETIME_MS,
      scheduled: user.scheduled === true || user.sessionHash === undefined,
      channel: user.channel === true,
      ...(scope === undefined ? {} : { scope: { ...scope } })
    });
    return token;
  }

  async userEnvironment(user: {
    readonly userId: number;
    readonly username?: string;
  }): Promise<Readonly<Record<string, string>>> {
    if (!Number.isSafeInteger(user.userId) || user.userId <= 0)
      throw new Error('USER_AUTHORIZATION_REQUIRED');
    let username = user.username;
    if (username === undefined) {
      const [rows] = await this.pool.execute<RowDataPacket[]>(
        `SELECT username FROM users WHERE id=? AND enabled=TRUE AND must_change_password=FALSE`,
        [user.userId]
      );
      username = rows[0]?.['username'];
    }
    if (
      typeof username !== 'string' ||
      username.length === 0 ||
      username.length > 128 ||
      /[\r\n\0]/u.test(username)
    )
      throw new Error('USER_AUTHORIZATION_REQUIRED');
    return { MAR_USERNAME: username };
  }

  async environment(
    user: {
      readonly userId: number;
      readonly sessionHash?: string;
      readonly username?: string;
      readonly scheduled?: boolean;
      readonly channel?: boolean;
    },
    serverUrl: string | undefined,
    scope?: MarctlExecutionScope
  ): Promise<Readonly<Record<string, string>>> {
    const identity = await this.userEnvironment(user);
    if (serverUrl === undefined) return { ...identity, MAR_CTL_CONTEXT_REQUIRED: '1' };
    const origin = new URL(serverUrl);
    if (
      (origin.protocol !== 'https:' &&
        !(
          origin.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
        )) ||
      origin.origin !== serverUrl
    )
      throw new Error('MARCTL_SERVER_URL_INVALID');
    return {
      ...identity,
      MAR_CTL_CONTEXT_REQUIRED: '1',
      MAR_CTL_SERVER_URL: origin.origin,
      MAR_CTL_USER_TOKEN: this.issue(user, scope)
    };
  }

  async authenticate(header: unknown): Promise<UserNodeAuthorization | undefined> {
    return (await this.authenticateContext(header))?.user;
  }

  async authenticateContext(header: unknown): Promise<
    | {
        readonly user: UserNodeAuthorization;
        readonly scheduled: boolean;
        readonly channel?: boolean;
        readonly scope?: MarctlExecutionScope;
      }
    | undefined
  > {
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined;
    const token = header.slice(7);
    if (!TOKEN_PATTERN.test(token)) return undefined;
    const hash = digest(token);
    const credential = this.credentials.get(hash);
    if (credential === undefined) return undefined;
    if (credential.expiresAt <= this.now()) {
      this.credentials.delete(hash);
      return undefined;
    }
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      credential.scheduled || credential.channel
        ? `SELECT u.id FROM users u WHERE u.id=? AND u.enabled=TRUE
             AND u.must_change_password=FALSE`
        : `SELECT u.id FROM user_sessions s JOIN users u ON u.id=s.user_id
             WHERE s.session_hash=? AND s.user_id=? AND s.revoked_at IS NULL
             AND s.expires_at>? AND u.enabled=TRUE AND u.must_change_password=FALSE`,
      credential.scheduled || credential.channel
        ? [credential.userId]
        : [credential.sessionHash, credential.userId, this.now()]
    );
    if (rows.length === 0) return undefined;
    return {
      user: { userId: credential.userId, sessionHash: credential.sessionHash },
      scheduled: credential.scheduled,
      ...(credential.channel ? { channel: true } : {}),
      ...(credential.scope === undefined ? {} : { scope: { ...credential.scope } })
    };
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
