import type { UserSession, UserSessionSummary } from '@myagentroam/server-core/auth-contracts';
export type { UserSession, UserSessionSummary } from '@myagentroam/server-core/auth-contracts';
import { hashOpaque } from '@myagentroam/server-core/session-token';
import type { CurrentUserSession } from '@myagentroam/server-core/session';
export { hashOpaque, csrfMatches } from '@myagentroam/server-core/session-token';
export type { CurrentUserSession } from '@myagentroam/server-core/session';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  assertPasswordPolicy,
  assertResetPasswordPolicy,
  hashPassword,
  INITIAL_ADMIN_PASSWORD,
  verifyPassword
} from '@myagentroam/server-core/password';
import { SERVER_MIGRATIONS } from './migrations/index.js';
import { AsyncAuditWriter, safeAuditMetadata } from '@myagentroam/server-core/audit';
import { auditsPersonalServerEvent } from './audit/audit-policy.js';

const ADMIN_USERNAME = 'admin';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ACTIVE_USER_SESSIONS = 5;
const SERVER_SCHEMA_VERSION = 18;

type SqlRow = Record<string, string | number | bigint | Uint8Array | null>;

import type { AuditEvent } from '@myagentroam/server-core/audit';

export interface ServerDatabaseOptions {
  readonly now?: () => number;
}

export type { StoredNode } from '@myagentroam/server-core/node-identity';
import type { StoredNode } from '@myagentroam/server-core/node-identity';

export class ServerDatabase {
  private readonly auditWriter = new AsyncAuditWriter((code) => console.warn(code));
  readonly raw: DatabaseSync;
  private readonly now: () => number;

  constructor(path: string, options: ServerDatabaseOptions = {}) {
    this.now = options.now ?? Date.now;
    const releaseMigrationLock = acquireMigrationLock(path);
    try {
      const database = new DatabaseSync(path, {
        enableForeignKeyConstraints: true,
        timeout: 5_000,
        defensive: true
      });
      this.raw = database;
      try {
        database.exec(
          'PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;'
        );
        runMigrations(database);
        this.initializeAdmin();
        restrictDatabaseFiles(path);
      } catch (error) {
        database.close();
        throw error;
      }
    } finally {
      releaseMigrationLock();
    }
  }

  close(): void {
    this.raw.close();
  }

  getAdmin(): {
    readonly id: number;
    readonly passwordHash: string;
    readonly mustChangePassword: boolean;
  } {
    const row = this.raw
      .prepare('SELECT id, password_hash, must_change_password FROM users WHERE is_admin = 1')
      .get() as SqlRow | undefined;
    if (row === undefined) throw new Error('ADMIN_NOT_INITIALIZED');
    return {
      id: numberValue(row, 'id'),
      passwordHash: stringValue(row, 'password_hash'),
      mustChangePassword: numberValue(row, 'must_change_password') === 1
    };
  }

  findUserForLogin(username: string):
    | {
        readonly id: number;
        readonly passwordHash: string;
        readonly mustChangePassword: boolean;
        readonly isAdmin: boolean;
      }
    | undefined {
    const row = this.raw
      .prepare(
        'SELECT id, password_hash, must_change_password, is_admin FROM users WHERE username = ?'
      )
      .get(username) as SqlRow | undefined;
    return row === undefined
      ? undefined
      : {
          id: numberValue(row, 'id'),
          passwordHash: stringValue(row, 'password_hash'),
          mustChangePassword: numberValue(row, 'must_change_password') === 1,
          isAdmin: numberValue(row, 'is_admin') === 1
        };
  }

  async userDisplayName(userId: number): Promise<string | undefined> {
    const row = this.raw
      .prepare('SELECT username, nickname FROM users WHERE id = ?')
      .get(userId) as SqlRow | undefined;
    if (row === undefined) return undefined;
    const nickname = row['nickname'];
    return typeof nickname === 'string' && nickname.trim().length > 0
      ? nickname.trim()
      : stringValue(row, 'username');
  }

  verifyUserPassword(userId: number, password: string): boolean {
    const row = this.raw.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as
      SqlRow | undefined;
    return row !== undefined && verifyPassword(password, stringValue(row, 'password_hash'));
  }

  listUsers(): readonly {
    readonly id: number;
    readonly username: string;
    readonly email: string | null;
    readonly nickname: string | null;
    readonly isAdmin: boolean;
    readonly createdAt: number;
  }[] {
    return (
      this.raw
        .prepare(
          'SELECT id, username, email, nickname, is_admin, created_at FROM users ORDER BY created_at ASC, id ASC'
        )
        .all() as SqlRow[]
    ).map((row) => ({
      id: numberValue(row, 'id'),
      username: stringValue(row, 'username'),
      email: row['email'] === null ? null : stringValue(row, 'email'),
      nickname: row['nickname'] === null ? null : stringValue(row, 'nickname'),
      isAdmin: numberValue(row, 'is_admin') === 1,
      createdAt: numberValue(row, 'created_at')
    }));
  }

  createUser(input: {
    readonly username: string;
    readonly email: string | null;
    readonly nickname: string | null;
    readonly password: string;
  }): number {
    assertPasswordPolicy(input.password);
    const timestamp = this.now();
    const result = this.raw
      .prepare(
        'INSERT INTO users (username, email, nickname, is_admin, password_hash, must_change_password, created_at, updated_at) VALUES (?, ?, ?, 0, ?, 1, ?, ?)'
      )
      .run(
        input.username,
        input.email,
        input.nickname,
        hashPassword(input.password),
        timestamp,
        timestamp
      );
    const id = Number(result.lastInsertRowid);
    this.audit({ eventType: 'user_created', actorUserId: id });
    return id;
  }

  deleteUser(userId: number, actorUserId: number): readonly string[] | undefined {
    const user = this.raw.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId) as
      SqlRow | undefined;
    if (user === undefined) return undefined;
    if (numberValue(user, 'is_admin') === 1) throw new Error('ADMIN_USER_PROTECTED');
    const nodeIds = (
      this.raw.prepare('SELECT id FROM nodes WHERE owner_user_id = ?').all(userId) as SqlRow[]
    ).map((row) => stringValue(row, 'id'));
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      this.raw
        .prepare(
          'DELETE FROM node_credentials WHERE node_id IN (SELECT id FROM nodes WHERE owner_user_id = ?)'
        )
        .run(userId);
      this.raw
        .prepare('DELETE FROM node_registration_tokens WHERE created_by_user_id = ?')
        .run(userId);
      // Preserve audit history while removing an account referenced by its own events.
      this.raw
        .prepare('UPDATE audit_events SET actor_user_id = NULL WHERE actor_user_id = ?')
        .run(userId);
      this.raw.prepare('DELETE FROM users WHERE id = ?').run(userId);
      this.audit({ eventType: 'user_deleted', actorUserId, metadata: JSON.stringify({ userId }) });
      this.raw.exec('COMMIT');
      return nodeIds;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }

  resetUserPassword(userId: number, password: string, actorUserId: number): void {
    assertPasswordPolicy(password);
    const result = this.raw
      .prepare(
        'UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ? AND is_admin = 0'
      )
      .run(hashPassword(password), this.now(), userId);
    if (Number(result.changes) !== 1) throw new Error('USER_NOT_FOUND_OR_PROTECTED');
    this.raw
      .prepare('UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .run(this.now(), userId);
    this.audit({
      eventType: 'user_password_reset',
      actorUserId,
      metadata: JSON.stringify({ userId })
    });
  }

  createUserSession(
    userId: number,
    metadata: { readonly ipAddress: string; readonly userAgent: string } = {
      ipAddress: 'unknown',
      userAgent: 'unknown'
    }
  ): UserSession {
    const sessionId = randomToken();
    const csrfToken = randomToken();
    const timestamp = this.now();
    const expiresAt = timestamp + SESSION_TTL_MS;
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const active = this.raw
        .prepare(
          'SELECT COUNT(*) AS count FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?'
        )
        .get(userId, timestamp) as SqlRow;
      const evictionCount = Math.max(
        0,
        numberValue(active, 'count') - MAX_ACTIVE_USER_SESSIONS + 1
      );
      const evictedSessionHashes =
        evictionCount === 0
          ? []
          : (
              this.raw
                .prepare(
                  `SELECT session_hash FROM user_sessions
                   WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
                   ORDER BY last_accessed_at ASC, created_at ASC, session_hash ASC
                   LIMIT ?`
                )
                .all(userId, timestamp, evictionCount) as SqlRow[]
            ).map((row) => stringValue(row, 'session_hash'));
      const revoke = this.raw.prepare(
        'UPDATE user_sessions SET revoked_at = ? WHERE session_hash = ? AND revoked_at IS NULL'
      );
      for (const sessionHash of evictedSessionHashes) revoke.run(timestamp, sessionHash);
      this.raw
        .prepare(
          `INSERT INTO user_sessions (session_hash, public_id, user_id, csrf_token_hash, ip_address, user_agent, created_at, last_accessed_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          hashOpaque(sessionId),
          randomToken(),
          userId,
          hashOpaque(csrfToken),
          metadata.ipAddress,
          metadata.userAgent,
          timestamp,
          timestamp,
          expiresAt
        );
      this.raw.exec('COMMIT');
      return { sessionId, csrfToken, expiresAt, evictedSessionHashes };
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }

  listActiveUserSessions(userId: number, currentSessionId: string): readonly UserSessionSummary[] {
    const currentSessionHash = hashOpaque(currentSessionId);
    return (
      this.raw
        .prepare(
          `SELECT session_hash, public_id, ip_address, user_agent, created_at, expires_at
         FROM user_sessions
         WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
         ORDER BY last_accessed_at DESC, created_at DESC, session_hash DESC`
        )
        .all(userId, this.now()) as SqlRow[]
    ).map((row) => ({
      id: stringValue(row, 'public_id'),
      createdAt: numberValue(row, 'created_at'),
      expiresAt: numberValue(row, 'expires_at'),
      ipAddress: stringValue(row, 'ip_address'),
      userAgent: stringValue(row, 'user_agent'),
      current: timingSafeEqual(
        Buffer.from(stringValue(row, 'session_hash')),
        Buffer.from(currentSessionHash)
      )
    }));
  }

  findCurrentUserSession(sessionId: string): CurrentUserSession | undefined {
    const timestamp = this.now();
    const sessionHash = hashOpaque(sessionId);
    const row = this.raw
      .prepare(
        `SELECT s.user_id, s.csrf_token_hash, u.must_change_password, u.username, u.is_admin
         FROM user_sessions s JOIN users u ON u.id = s.user_id
         WHERE s.session_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`
      )
      .get(sessionHash, timestamp) as SqlRow | undefined;
    if (row === undefined) return undefined;
    this.raw
      .prepare(
        'UPDATE user_sessions SET last_accessed_at = ? WHERE session_hash = ? AND revoked_at IS NULL'
      )
      .run(timestamp, sessionHash);
    return {
      userId: numberValue(row, 'user_id'),
      username: stringValue(row, 'username'),
      isAdmin: numberValue(row, 'is_admin') === 1,
      sessionHash,
      csrfTokenHash: stringValue(row, 'csrf_token_hash'),
      mustChangePassword: numberValue(row, 'must_change_password') === 1
    };
  }

  revokeSession(sessionId: string): void {
    this.raw
      .prepare(
        'UPDATE user_sessions SET revoked_at = ? WHERE session_hash = ? AND revoked_at IS NULL'
      )
      .run(this.now(), hashOpaque(sessionId));
  }

  revokeUserSessionByPublicId(userId: number, publicId: string): string | undefined {
    const row = this.raw
      .prepare(
        `SELECT session_hash FROM user_sessions
         WHERE public_id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?`
      )
      .get(publicId, userId, this.now()) as SqlRow | undefined;
    if (row === undefined) return undefined;
    const sessionHash = stringValue(row, 'session_hash');
    this.raw
      .prepare(
        'UPDATE user_sessions SET revoked_at = ? WHERE session_hash = ? AND revoked_at IS NULL'
      )
      .run(this.now(), sessionHash);
    return sessionHash;
  }

  rotateCsrfToken(sessionId: string): string | undefined {
    const current = this.findCurrentUserSession(sessionId);
    if (current === undefined) return undefined;
    const csrfToken = randomToken();
    const result = this.raw
      .prepare(
        'UPDATE user_sessions SET csrf_token_hash = ? WHERE session_hash = ? AND revoked_at IS NULL'
      )
      .run(hashOpaque(csrfToken), hashOpaque(sessionId));
    return Number(result.changes) === 1 ? csrfToken : undefined;
  }

  changePassword(
    userId: number,
    password: string,
    eventType: 'password_changed' | 'password_reset',
    ipAddress?: string
  ): void {
    assertPasswordPolicy(password);
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const timestamp = this.now();
      this.raw
        .prepare(
          'UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?'
        )
        .run(hashPassword(password), timestamp, userId);
      this.raw
        .prepare('UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
        .run(timestamp, userId);
      this.audit({
        eventType,
        actorUserId: userId,
        ...(ipAddress === undefined ? {} : { ipAddress })
      });
      this.raw.exec('COMMIT');
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }

  resetPassword(password: string, ipAddress?: string): void {
    assertResetPasswordPolicy(password);
    const admin = this.getAdmin();
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const timestamp = this.now();
      this.raw
        .prepare(
          'UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?'
        )
        .run(hashPassword(password), timestamp, admin.id);
      this.raw
        .prepare('UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
        .run(timestamp, admin.id);
      this.audit({
        eventType: 'password_reset',
        actorUserId: admin.id,
        ...(ipAddress === undefined ? {} : { ipAddress })
      });
      this.raw.exec('COMMIT');
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }

  createNodeRegistrationToken(
    createdByUserId: number,
    ttlMs = 15 * 60 * 1000
  ): { readonly id: string; readonly token: string; readonly expiresAt: number } {
    const id = randomToken();
    const token = randomToken();
    const expiresAt = this.now() + ttlMs;
    this.raw
      .prepare(
        `INSERT INTO node_registration_tokens (id, token_hash, created_by_user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, hashOpaque(token), createdByUserId, this.now(), expiresAt);
    this.audit({ eventType: 'node_registration_token_created', actorUserId: createdByUserId });
    return { id, token, expiresAt };
  }

  registerNode(
    token: string,
    capabilities: {
      readonly metadata: string;
    },
    registeredAddress = 'unknown'
  ): { readonly nodeId: string; readonly credential: string } | undefined {
    const timestamp = this.now();
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const found = this.raw
        .prepare(
          `SELECT id, created_by_user_id FROM node_registration_tokens
           WHERE token_hash = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`
        )
        .get(hashOpaque(token), timestamp) as SqlRow | undefined;
      if (found === undefined) {
        this.raw.exec('COMMIT');
        return undefined;
      }
      const nodeId = randomToken();
      const credential = randomToken();
      this.raw
        .prepare('UPDATE node_registration_tokens SET consumed_at = ? WHERE id = ?')
        .run(timestamp, stringValue(found, 'id'));
      this.raw
        .prepare(
          'INSERT INTO node_credentials (node_id, credential_hash, issued_at) VALUES (?, ?, ?)'
        )
        .run(nodeId, hashOpaque(credential), timestamp);
      this.raw
        .prepare(
          `INSERT INTO nodes (id, owner_user_id, display_name, registered_address, metadata, disabled, last_heartbeat_at, created_at, updated_at)
           VALUES (?, ?, NULL, ?, ?, 0, ?, ?, ?)`
        )
        .run(
          nodeId,
          numberValue(found, 'created_by_user_id'),
          registeredAddress,
          capabilities.metadata,
          timestamp,
          timestamp,
          timestamp
        );
      this.audit({ eventType: 'node_registered', metadata: JSON.stringify({ nodeId }) });
      this.raw.exec('COMMIT');
      return { nodeId, credential };
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }

  authenticateNode(nodeId: string, credential: string): StoredNode | undefined {
    const row = this.raw
      .prepare(
        `SELECT n.id, n.owner_user_id, n.display_name, n.registered_address, n.metadata, n.disabled, n.last_heartbeat_at
         FROM nodes n JOIN node_credentials c ON c.node_id = n.id
         WHERE n.id = ? AND c.credential_hash = ? AND c.revoked_at IS NULL`
      )
      .get(nodeId, hashOpaque(credential)) as SqlRow | undefined;
    return row === undefined ? undefined : storedNode(row);
  }

  updateNodeHeartbeat(
    nodeId: string,
    capabilities?: {
      readonly metadata: string;
    }
  ): void {
    const timestamp = this.now();
    if (capabilities === undefined) {
      this.raw
        .prepare('UPDATE nodes SET last_heartbeat_at = ?, updated_at = ? WHERE id = ?')
        .run(timestamp, timestamp, nodeId);
      return;
    }
    this.raw
      .prepare(
        `UPDATE nodes SET metadata = ?,
         last_heartbeat_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(capabilities.metadata, timestamp, timestamp, nodeId);
  }

  revokeNode(nodeId: string, actorUserId: number): boolean {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const timestamp = this.now();
      const result = this.raw
        .prepare('UPDATE nodes SET disabled = 1, updated_at = ? WHERE id = ?')
        .run(timestamp, nodeId);
      if (Number(result.changes) === 0) {
        this.raw.exec('COMMIT');
        return false;
      }
      this.raw
        .prepare(
          'UPDATE node_credentials SET revoked_at = ? WHERE node_id = ? AND revoked_at IS NULL'
        )
        .run(timestamp, nodeId);
      this.audit({ eventType: 'node_revoked', actorUserId, metadata: JSON.stringify({ nodeId }) });
      this.raw.exec('COMMIT');
      return true;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }

  deleteNode(nodeId: string, actorUserId: number): boolean {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = this.raw.prepare('DELETE FROM nodes WHERE id = ?').run(nodeId);
      if (Number(result.changes) === 0) {
        this.raw.exec('COMMIT');
        return false;
      }
      this.raw.prepare('DELETE FROM node_credentials WHERE node_id = ?').run(nodeId);
      this.audit({ eventType: 'node_deleted', actorUserId, metadata: JSON.stringify({ nodeId }) });
      this.raw.exec('COMMIT');
      return true;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }

  listNodes(): readonly StoredNode[] {
    return this.raw
      .prepare(
        `SELECT id, owner_user_id, display_name, registered_address, metadata, disabled, last_heartbeat_at
       FROM nodes ORDER BY created_at ASC`
      )
      .all()
      .map((row) => storedNode(row as SqlRow));
  }

  listNodesForUser(userId: number): readonly StoredNode[] {
    return this.listNodes().filter((node) => node.ownerUserId === userId);
  }

  userOwnsNode(userId: number, nodeId: string): boolean {
    return (
      this.raw
        .prepare('SELECT 1 FROM nodes WHERE id = ? AND owner_user_id = ?')
        .get(nodeId, userId) !== undefined
    );
  }

  updateNodeDisplayName(
    nodeId: string,
    displayName: string | null,
    actorUserId: number
  ): StoredNode | undefined {
    const value = displayName === null ? null : displayName.trim();
    if (value !== null && (value.length === 0 || value.length > 80))
      throw new Error('NODE_DISPLAY_NAME_INVALID');
    const result = this.raw
      .prepare('UPDATE nodes SET display_name = ?, updated_at = ? WHERE id = ?')
      .run(value, this.now(), nodeId);
    if (Number(result.changes) === 0) return undefined;
    this.audit({
      eventType: value === null ? 'node_display_name_cleared' : 'node_display_name_updated',
      actorUserId,
      metadata: JSON.stringify({ nodeId })
    });
    return this.listNodes().find((node) => node.id === nodeId);
  }

  audit(input: AuditEvent): void {
    if (!auditsPersonalServerEvent(input.eventType)) return;
    const event = {
      ...input,
      occurredAt: input.occurredAt ?? this.now(),
      metadata: safeAuditMetadata(input.metadata)
    };
    this.auditWriter.dispatch(async () => {
      this.raw
        .prepare(
          `INSERT INTO audit_events (event_type, actor_user_id, ip_address, metadata, created_at)
         VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          event.eventType,
          event.actorUserId ?? null,
          event.ipAddress ?? null,
          event.metadata,
          event.occurredAt
        );
    });
  }

  private initializeAdmin(): void {
    if (this.raw.prepare('SELECT id FROM users WHERE is_admin = 1').get() !== undefined) return;
    const timestamp = this.now();
    this.raw
      .prepare(
        `INSERT INTO users (id, username, email, nickname, is_admin, password_hash, must_change_password, created_at, updated_at)
         VALUES (1, ?, NULL, NULL, 1, ?, 1, ?, ?)`
      )
      .run(ADMIN_USERNAME, hashPassword(INITIAL_ADMIN_PASSWORD), timestamp, timestamp);
    this.audit({ eventType: 'admin_initialized', actorUserId: 1 });
  }
}

function restrictDatabaseFiles(path: string): void {
  if (path === ':memory:') return;
  for (const candidate of [path, `${path}-wal`, `${path}-shm`])
    if (existsSync(candidate)) chmodSync(candidate, 0o600);
}

export function openServerDatabase(
  path: string,
  options: ServerDatabaseOptions = {}
): ServerDatabase {
  return new ServerDatabase(path, options);
}

function runMigrations(database: DatabaseSync): void {
  database.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT;'
  );
  const appliedVersions = database
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all() as readonly SqlRow[];
  const versions = appliedVersions.map((row) => numberValue(row, 'version'));
  if (versions.some((value) => value > SERVER_SCHEMA_VERSION))
    throw new Error('SERVER_DATABASE_VERSION_UNSUPPORTED');
  if (versions.some((value, index) => value !== index + 1))
    throw new Error('SERVER_DATABASE_MIGRATION_HISTORY_INVALID');
  let current = versions.at(-1) ?? 0;
  for (const migration of SERVER_MIGRATIONS) {
    if (current >= migration.version) continue;
    migration.up(database);
    current = migration.version;
  }
}
function acquireMigrationLock(databasePath: string): () => void {
  if (databasePath === ':memory:') return () => undefined;
  mkdirSync(dirname(databasePath), { recursive: true });
  const lockPath = `${databasePath}.migration.lock`;
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      const descriptor = openSync(lockPath, 'wx', 0o600);
      return () => {
        closeSync(descriptor);
        if (existsSync(lockPath)) rmSync(lockPath);
      };
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code !== 'EEXIST' || Date.now() >= deadline)
        throw new Error('DATABASE_MIGRATION_LOCK_UNAVAILABLE');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}
function stringValue(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`DATABASE_VALUE_INVALID:${key}`);
  return value;
}
function numberValue(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== 'number') throw new Error(`DATABASE_VALUE_INVALID:${key}`);
  return value;
}
function storedNode(row: SqlRow): StoredNode {
  const metadata = parseJsonObject(row['metadata']);
  return {
    id: stringValue(row, 'id'),
    ownerUserId: numberValue(row, 'owner_user_id'),
    displayName: row['display_name'] === null ? null : stringValue(row, 'display_name'),
    registeredAddress:
      row['registered_address'] === null ? 'unknown' : stringValue(row, 'registered_address'),
    metadata: JSON.stringify(metadata),
    disabled: numberValue(row, 'disabled') === 1,
    lastHeartbeatAt:
      row['last_heartbeat_at'] === null ? null : numberValue(row, 'last_heartbeat_at')
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
