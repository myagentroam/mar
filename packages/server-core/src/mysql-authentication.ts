import { emitAuditAfterCommit, commitMysqlAudits, discardMysqlAudits } from './audit.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { hashPassword, verifyPassword, INITIAL_ADMIN_PASSWORD } from './password.js';
import type { CurrentUserSession } from './session.js';
import type {
  UserSession,
  UserSessionSummary,
  UserLocale,
  AuthenticationAuditEvent
} from './auth-contracts.js';

export interface MysqlAuthenticationOptions {
  readonly now?: () => number;
  readonly acceptsSession: (identity: {
    readonly userId: number;
    readonly isFixedAdmin: boolean;
  }) => boolean;
  readonly auditPasswordChange: (
    connection: Pick<PoolConnection, 'execute'>,
    event: {
      readonly eventType: 'password_changed';
      readonly actorUserId: number;
      readonly ipAddress?: string;
    }
  ) => Promise<void>;
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ACTIVE_USER_SESSIONS = 5;

export class MysqlAuthenticationStorage {
  private readonly sessionProjection = new Map<
    string,
    { readonly current: CurrentUserSession; readonly expiresAt: number }
  >();
  private readonly now: () => number;
  constructor(
    private readonly raw: Pool,
    private readonly options: MysqlAuthenticationOptions
  ) {
    this.now = options.now ?? Date.now;
  }

  async userDisplayName(userId: number): Promise<string | undefined> {
    const [rows] = await this.raw.execute<RowDataPacket[]>(
      'SELECT username,nickname FROM users WHERE id=?',
      [userId]
    );
    const user = rows[0];
    if (user === undefined) return undefined;
    const nickname = typeof user['nickname'] === 'string' ? user['nickname'].trim() : '';
    return nickname.length > 0 ? nickname : String(user['username']);
  }

  invalidateUserSessions(userId: number): void {
    for (const [hash, projection] of this.sessionProjection)
      if (projection.current.userId === userId) this.sessionProjection.delete(hash);
  }

  async initializeAdmin(): Promise<void> {
    const timestamp = this.now();
    await this.raw.execute(
      `INSERT INTO users
       (id, username, password_hash, must_change_password, enabled, is_fixed_admin, created_at, updated_at)
       VALUES (1, 'admin', ?, TRUE, TRUE, TRUE, ?, ?)
       ON DUPLICATE KEY UPDATE username=username`,
      [hashPassword(INITIAL_ADMIN_PASSWORD), timestamp, timestamp]
    );
  }

  async locale(userId: number): Promise<UserLocale> {
    return readMysqlUserLocale(this.raw, userId);
  }

  async setLocale(userId: number, locale: UserLocale): Promise<void> {
    await writeMysqlUserLocale(this.raw, userId, locale, this.now);
  }

  async verifyUserPassword(userId: number, password: string): Promise<boolean> {
    const [rows] = await this.raw.execute<RowDataPacket[]>(
      'SELECT password_hash FROM users WHERE id=? AND enabled=TRUE',
      [userId]
    );
    return typeof rows[0]?.['password_hash'] === 'string'
      ? verifyPassword(password, rows[0]['password_hash'])
      : false;
  }

  async createUserSession(
    userId: number,
    metadata: { readonly ipAddress: string; readonly userAgent: string }
  ): Promise<UserSession> {
    const connection = await this.raw.getConnection();
    try {
      await connection.beginTransaction();
      const timestamp = this.now();
      const [identityRows] = await connection.execute<RowDataPacket[]>(
        'SELECT id,is_fixed_admin FROM users WHERE id=? AND enabled=TRUE FOR UPDATE',
        [userId]
      );
      const identity = identityRows[0];
      if (
        !identity ||
        !this.options.acceptsSession({ userId, isFixedAdmin: Boolean(identity['is_fixed_admin']) })
      )
        throw new Error('USER_NOT_FOUND');
      const [activeRows] = await connection.execute<RowDataPacket[]>(
        `SELECT session_hash FROM user_sessions
         WHERE user_id=? AND revoked_at IS NULL AND expires_at>?
         ORDER BY last_accessed_at, created_at, session_hash FOR UPDATE`,
        [userId, timestamp]
      );
      const evicted = activeRows
        .slice(0, Math.max(0, activeRows.length - MAX_ACTIVE_USER_SESSIONS + 1))
        .map((row) => String(row['session_hash']));
      if (evicted.length > 0) {
        await connection.query('UPDATE user_sessions SET revoked_at=? WHERE session_hash IN (?)', [
          timestamp,
          evicted
        ]);
      }
      const sessionId = randomToken();
      const csrfToken = randomToken();
      await connection.execute(
        `INSERT INTO user_sessions
         (session_hash, public_id, user_id, csrf_token_hash, created_at, last_accessed_at,
          expires_at, ip_address, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sha256(sessionId),
          randomUUID(),
          userId,
          sha256(csrfToken),
          timestamp,
          timestamp,
          timestamp + SESSION_TTL_MS,
          metadata.ipAddress,
          metadata.userAgent
        ]
      );
      const sessionHash = sha256(sessionId);
      const [userRows] = await connection.execute<RowDataPacket[]>(
        'SELECT username,role,is_fixed_admin,must_change_password FROM users WHERE id=?',
        [userId]
      );
      const user = userRows[0];
      if (!user) throw new Error('USER_NOT_FOUND');
      await connection.commit();
      commitMysqlAudits(connection);
      for (const hash of evicted) this.sessionProjection.delete(hash);
      this.sessionProjection.set(sessionHash, {
        expiresAt: timestamp + SESSION_TTL_MS,
        current: {
          userId,
          username: String(user['username']),
          isAdmin: Boolean(user['is_fixed_admin']) || user['role'] === 'ADMIN',
          sessionHash,
          mustChangePassword: Boolean(user['must_change_password']),
          csrfTokenHash: sha256(csrfToken)
        }
      });
      return {
        sessionId,
        csrfToken,
        expiresAt: timestamp + SESSION_TTL_MS,
        evictedSessionHashes: evicted
      };
    } catch (error) {
      discardMysqlAudits(connection);
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  findCurrentUserSession(sessionId: string): CurrentUserSession | undefined {
    const sessionHash = sha256(sessionId);
    const projection = this.sessionProjection.get(sessionHash);
    if (!projection) return undefined;
    if (projection.expiresAt <= this.now()) {
      this.sessionProjection.delete(sessionHash);
      return undefined;
    }
    void this.raw
      .execute('UPDATE user_sessions SET last_accessed_at=? WHERE session_hash=?', [
        this.now(),
        sessionHash
      ])
      .catch(() => {
        this.sessionProjection.delete(sessionHash);
      });
    return projection.current;
  }

  async listActiveUserSessions(
    userId: number,
    currentSessionId: string
  ): Promise<readonly UserSessionSummary[]> {
    const [rows] = await this.raw.execute<RowDataPacket[]>(
      `SELECT public_id, session_hash, created_at, expires_at, ip_address, user_agent
       FROM user_sessions WHERE user_id=? AND revoked_at IS NULL AND expires_at>?
       ORDER BY last_accessed_at DESC, created_at DESC`,
      [userId, this.now()]
    );
    const currentHash = sha256(currentSessionId);
    return rows.map((row) => ({
      id: String(row['public_id']),
      createdAt: Number(row['created_at']),
      expiresAt: Number(row['expires_at']),
      ipAddress: String(row['ip_address']),
      userAgent: String(row['user_agent']),
      current: row['session_hash'] === currentHash
    }));
  }

  async revokeSession(sessionId: string): Promise<void> {
    this.sessionProjection.delete(sha256(sessionId));
    await this.raw.execute(
      'UPDATE user_sessions SET revoked_at=? WHERE session_hash=? AND revoked_at IS NULL',
      [this.now(), sha256(sessionId)]
    );
  }

  async revokeUserSessionByPublicId(userId: number, publicId: string): Promise<string | undefined> {
    const [rows] = await this.raw.execute<RowDataPacket[]>(
      'SELECT session_hash FROM user_sessions WHERE user_id=? AND public_id=? AND revoked_at IS NULL',
      [userId, publicId]
    );
    const hash = rows[0]?.['session_hash'];
    if (typeof hash !== 'string') return undefined;
    this.sessionProjection.delete(hash);
    await this.raw.execute('UPDATE user_sessions SET revoked_at=? WHERE session_hash=?', [
      this.now(),
      hash
    ]);
    return hash;
  }

  async rotateCsrfToken(sessionId: string): Promise<string | undefined> {
    const token = randomToken();
    const [result] = await this.raw.execute<ResultSetHeader>(
      `UPDATE user_sessions SET csrf_token_hash=?
       WHERE session_hash=? AND revoked_at IS NULL AND expires_at>?`,
      [sha256(token), sha256(sessionId), this.now()]
    );
    if (result.affectedRows !== 1) return undefined;
    const hash = sha256(sessionId);
    const projection = this.sessionProjection.get(hash);
    if (projection)
      this.sessionProjection.set(hash, {
        ...projection,
        current: { ...projection.current, csrfTokenHash: sha256(token) }
      });
    return token;
  }

  async changePassword(
    userId: number,
    password: string,
    eventType: 'password_changed' = 'password_changed',
    ipAddress?: string
  ): Promise<void> {
    const connection = await this.raw.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        'UPDATE users SET password_hash=?, must_change_password=FALSE, updated_at=? WHERE id=?',
        [hashPassword(password), this.now(), userId]
      );
      await connection.execute(
        'UPDATE user_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL',
        [this.now(), userId]
      );
      const event = {
        eventType,
        actorUserId: userId,
        ...(ipAddress === undefined ? {} : { ipAddress })
      } as const;
      emitAuditAfterCommit(
        { audit: () => this.options.auditPasswordChange(connection, event) },
        connection,
        event
      );
      await connection.commit();
      commitMysqlAudits(connection);
      this.invalidateUserSessions(userId);
    } catch (error) {
      discardMysqlAudits(connection);
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async reloadSessions(): Promise<void> {
    const [rows] = await this.raw.execute<RowDataPacket[]>(
      `SELECT s.session_hash,s.csrf_token_hash,s.expires_at,u.id,u.username,u.role,u.is_fixed_admin,u.must_change_password
       FROM user_sessions s JOIN users u ON u.id=s.user_id
       WHERE s.revoked_at IS NULL AND s.expires_at>? AND u.enabled=TRUE`,
      [this.now()]
    );
    this.sessionProjection.clear();
    for (const row of rows) {
      if (
        !this.options.acceptsSession({
          userId: Number(row['id']),
          isFixedAdmin: Boolean(row['is_fixed_admin'])
        })
      )
        continue;
      const sessionHash = String(row['session_hash']);
      this.sessionProjection.set(sessionHash, {
        expiresAt: Number(row['expires_at']),
        current: {
          userId: Number(row['id']),
          username: String(row['username']),
          isAdmin: Boolean(row['is_fixed_admin']) || row['role'] === 'ADMIN',
          sessionHash,
          mustChangePassword: Boolean(row['must_change_password']),
          csrfTokenHash: String(row['csrf_token_hash'])
        }
      });
    }
  }
}
function randomToken(): string {
  return randomBytes(32).toString('base64url');
}
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

export async function readMysqlUserLocale(
  connection: Pick<PoolConnection, 'execute'>,
  userId: number
): Promise<UserLocale> {
  const [rows] = await connection.execute<RowDataPacket[]>('SELECT locale FROM users WHERE id=?', [
    userId
  ]);
  return rows[0]?.['locale'] === 'en-US' ? 'en-US' : 'zh-CN';
}

export async function writeMysqlUserLocale(
  connection: Pick<PoolConnection, 'execute'>,
  userId: number,
  locale: UserLocale,
  now: () => number = Date.now
): Promise<void> {
  await connection.execute('UPDATE users SET locale=?,updated_at=? WHERE id=?', [
    locale,
    now(),
    userId
  ]);
}

/** Authentication-only audit: never accepts credentials or arbitrary metadata. */
export async function recordMysqlAuthenticationAudit(
  connection: Pick<PoolConnection, 'execute'>,
  event: Omit<AuthenticationAuditEvent, 'ipAddress'> & { readonly ipAddress?: string },
  now: () => number = Date.now
): Promise<void> {
  await connection.execute(
    `INSERT INTO audit_events
     (id,event_type,occurred_at,result,actor_user_id,actor_username,authentication_method,actor_ip)
     VALUES (?,?,?,?,?,(SELECT username FROM users WHERE id=?),?,?)`,
    [
      randomUUID(),
      event.eventType,
      now(),
      event.eventType === 'login_failed' || event.eventType === 'login_rate_limited'
        ? 'FAILED'
        : 'SUCCESS',
      event.actorUserId ?? null,
      event.actorUserId ?? null,
      'PASSWORD',
      event.ipAddress ?? null
    ]
  );
}
