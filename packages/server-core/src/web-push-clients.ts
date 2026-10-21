import { createHash, randomUUID } from 'node:crypto';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import {
  webPushRegistrationSchema,
  type WebPushBinding,
  type WebPushSubscription
} from '@myagentroam/protocol';
import { lockMysqlUsers, withMysqlTransaction } from './mysql-reference-store.js';

type Actor = { readonly userId: number; readonly sessionHash: string };

export interface StoredWebPushClient extends WebPushBinding {
  readonly userId: number;
  readonly sessionHash: string;
  readonly subscription: WebPushSubscription;
}

const MAX_CLIENTS = 32;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Validate endpoint syntax without restricting push providers, addresses or ports. */
export function validWebPushEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

export class WebPushClients {
  constructor(
    private readonly database: { readonly raw: Pool },
    private readonly now = Date.now
  ) {}

  async register(actor: Actor, raw: unknown): Promise<WebPushBinding> {
    const parsed = webPushRegistrationSchema.safeParse(raw);
    if (!parsed.success || !validWebPushEndpoint(parsed.data.subscription.endpoint))
      throw new Error('WEB_PUSH_INPUT_INVALID');
    const input = parsed.data;
    if (
      input.enabled &&
      input.subscription.expirationTime != null &&
      input.subscription.expirationTime <= this.now()
    )
      throw new Error('WEB_PUSH_INPUT_INVALID');
    const tokenHash = hash(input.clientToken);
    const endpointHash = hash(input.subscription.endpoint);
    return withMysqlTransaction(this.database.raw, async (connection) => {
      await lockMysqlUsers(connection, [actor.userId]);
      const [sessions] = await connection.execute<RowDataPacket[]>(
        `SELECT s.user_id FROM user_sessions s JOIN users u ON u.id=s.user_id
         WHERE s.session_hash=? AND s.user_id=? AND s.revoked_at IS NULL
         AND s.expires_at>? AND u.enabled=TRUE AND u.must_change_password=FALSE FOR UPDATE`,
        [actor.sessionHash, actor.userId, this.now()]
      );
      if (sessions.length !== 1) throw new Error('WEB_PUSH_SESSION_INVALID');
      const [existing] = await connection.execute<RowDataPacket[]>(
        'SELECT * FROM web_push_clients WHERE token_hash=? FOR UPDATE',
        [tokenHash]
      );
      const row = existing[0];
      const endpoint = input.subscription.endpoint;
      const { p256dh, auth } = input.subscription.keys;
      const expiration = input.subscription.expirationTime ?? null;
      if (row !== undefined && input.bindingVersion === undefined) {
        if (
          Number(row.user_id) !== actor.userId ||
          row.endpoint !== endpoint ||
          row.p256dh !== p256dh ||
          row.auth_secret !== auth ||
          row.expiration_time !== expiration
        )
          throw new Error('WEB_PUSH_CLIENT_CONFLICT');
        if (row.session_hash !== actor.sessionHash) throw new Error('WEB_PUSH_BINDING_STALE');
        // An unversioned replay must never reverse a user's later disable operation.
        if (!input.enabled && Boolean(row.enabled)) {
          if (Number(row.binding_version) !== 1) throw new Error('WEB_PUSH_BINDING_STALE');
          const version = Number(row.binding_version) + 1;
          await connection.execute(
            `UPDATE web_push_clients SET user_id=?,session_hash=?,endpoint_hash=?,endpoint=?,p256dh=?,auth_secret=?,expiration_time=?,enabled=?,binding_version=?,updated_at=? WHERE id=?`,
            [
              actor.userId,
              actor.sessionHash,
              endpointHash,
              endpoint,
              p256dh,
              auth,
              expiration,
              false,
              version,
              this.now(),
              row.id
            ]
          );
          return { subscriptionId: String(row.id), bindingVersion: version, enabled: false };
        }
        return binding(row);
      }
      // Unchanged synchronization and lost-response replay preserve the confirmed generation.
      if (
        row !== undefined &&
        Number(row.user_id) === actor.userId &&
        row.session_hash === actor.sessionHash &&
        row.endpoint === endpoint &&
        row.p256dh === p256dh &&
        row.auth_secret === auth &&
        row.expiration_time === expiration &&
        Boolean(row.enabled) === input.enabled
      )
        return binding(row);
      if (
        input.bindingVersion !== undefined &&
        (row === undefined || Number(row.binding_version) !== input.bindingVersion)
      ) {
        throw new Error('WEB_PUSH_BINDING_STALE');
      }
      const [endpoints] = await connection.execute<RowDataPacket[]>(
        'SELECT id FROM web_push_clients WHERE endpoint_hash=? FOR UPDATE',
        [endpointHash]
      );
      if (endpoints.some((other) => other.id !== row?.id))
        throw new Error('WEB_PUSH_CLIENT_CONFLICT');
      if (row === undefined || Number(row.user_id) !== actor.userId) {
        await connection.execute(
          `DELETE FROM web_push_clients WHERE user_id=? AND token_hash<>? AND session_hash IN
           (SELECT session_hash FROM user_sessions WHERE revoked_at IS NOT NULL OR expires_at<=?)`,
          [actor.userId, tokenHash, this.now()]
        );
        const [counts] = await connection.execute<RowDataPacket[]>(
          `SELECT COUNT(*) AS count FROM web_push_clients p JOIN user_sessions s ON s.session_hash=p.session_hash
           WHERE p.user_id=? AND s.revoked_at IS NULL AND s.expires_at>?`,
          [actor.userId, this.now()]
        );
        if (Number(counts[0]?.count) >= MAX_CLIENTS) throw new Error('WEB_PUSH_CLIENT_LIMIT');
      }
      const id = row === undefined ? randomUUID() : String(row.id);
      const version = row === undefined ? 1 : Number(row.binding_version) + 1;
      const material = [
        actor.userId,
        actor.sessionHash,
        tokenHash,
        endpointHash,
        endpoint,
        p256dh,
        auth,
        expiration,
        input.enabled,
        version,
        this.now(),
        this.now()
      ];
      if (row === undefined) {
        await connection.execute(
          `INSERT INTO web_push_clients (id,user_id,session_hash,token_hash,endpoint_hash,endpoint,p256dh,auth_secret,expiration_time,enabled,binding_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [id, ...material]
        );
      } else {
        await connection.execute(
          `UPDATE web_push_clients SET user_id=?,session_hash=?,endpoint_hash=?,endpoint=?,p256dh=?,auth_secret=?,expiration_time=?,enabled=?,binding_version=?,updated_at=? WHERE id=?`,
          [
            actor.userId,
            actor.sessionHash,
            endpointHash,
            endpoint,
            p256dh,
            auth,
            expiration,
            input.enabled,
            version,
            this.now(),
            id
          ]
        );
      }
      return { subscriptionId: id, bindingVersion: version, enabled: input.enabled };
    });
  }

  async inspect(actor: Actor, token: string): Promise<WebPushBinding | undefined> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT id,binding_version,enabled FROM web_push_clients WHERE token_hash=? AND user_id=?',
      [hash(token), actor.userId]
    );
    return rows[0] === undefined ? undefined : binding(rows[0]);
  }

  /** Never delete the new binding when an old endpoint reports a late 404 or 410. */
  async expire(snapshot: {
    readonly subscriptionId: string;
    readonly bindingVersion: number;
    readonly endpoint: string;
  }): Promise<boolean> {
    const [result] = await this.database.raw.execute<import('mysql2/promise').ResultSetHeader>(
      'DELETE FROM web_push_clients WHERE id=? AND binding_version=? AND endpoint_hash=?',
      [snapshot.subscriptionId, snapshot.bindingVersion, hash(snapshot.endpoint)]
    );
    return result.affectedRows === 1;
  }

  async eligible(userId: number, subscriptionId?: string): Promise<readonly StoredWebPushClient[]> {
    const timestamp = this.now();
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      `SELECT p.* FROM web_push_clients p JOIN user_sessions s ON s.session_hash=p.session_hash AND s.user_id=p.user_id
       JOIN users u ON u.id=p.user_id WHERE p.user_id=? AND p.enabled=TRUE
       AND s.revoked_at IS NULL AND s.expires_at>? AND u.enabled=TRUE AND u.must_change_password=FALSE
       AND (p.expiration_time IS NULL OR p.expiration_time>?)${subscriptionId === undefined ? '' : ' AND p.id=?'} ORDER BY p.id LIMIT 32`,
      [userId, timestamp, timestamp, ...(subscriptionId === undefined ? [] : [subscriptionId])]
    );
    return rows.map((row) => ({
      ...binding(row),
      userId: Number(row.user_id),
      sessionHash: String(row.session_hash),
      subscription: {
        endpoint: String(row.endpoint),
        expirationTime: row.expiration_time == null ? null : Number(row.expiration_time),
        keys: { p256dh: String(row.p256dh), auth: String(row.auth_secret) }
      }
    }));
  }
}

function binding(row: RowDataPacket): WebPushBinding {
  return {
    subscriptionId: String(row.id),
    bindingVersion: Number(row.binding_version),
    enabled: Boolean(row.enabled)
  };
}
