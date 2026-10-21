import type { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { SessionShareTarget } from '@myagentroam/protocol';
import type { StoredSessionShare, SessionShareStore } from './session-shares.js';
import {
  withMysqlTransaction,
  lockMysqlUsers,
  lockMysqlNode,
  lockMysqlWorkspace
} from './mysql-reference-store.js';

export class MysqlSessionShares implements SessionShareStore {
  private readonly encryptionKey: Buffer;
  constructor(
    private readonly database: { readonly raw: Pool },
    applicationKey: Buffer
  ) {
    if (applicationKey.length !== 32) throw new Error('SESSION_SHARE_ENCRYPTION_KEY_INVALID');
    this.encryptionKey = createHash('sha256')
      .update(applicationKey)
      .update('mar:session-share:encryption:v1')
      .digest();
  }

  async insert(share: StoredSessionShare): Promise<void> {
    await withMysqlTransaction(this.database.raw, async (connection) => {
      await lockMysqlUsers(connection, [share.userId]);
      await lockMysqlNode(connection, share.nodeId);
      await lockMysqlWorkspace(connection, share.workspaceId, share.nodeId);
      await connection.execute(
        'INSERT INTO session_shares (id,user_id,node_id,workspace_id,session_id,password_hash,access_credential,created_at,expires_at,encrypted_password) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [
          share.id,
          share.userId,
          share.nodeId,
          share.workspaceId,
          share.sessionId,
          share.passwordHash,
          share.credential,
          share.createdAt,
          share.expiresAt,
          share.password === null ? null : this.encrypt(share.password)
        ]
      );
    });
  }

  async get(id: string): Promise<StoredSessionShare | undefined> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT * FROM session_shares WHERE id=?',
      [id]
    );
    return rows[0] === undefined ? undefined : this.record(rows[0]);
  }

  async list(target: SessionShareTarget): Promise<readonly StoredSessionShare[]> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT * FROM session_shares WHERE node_id=? AND workspace_id=? AND session_id=? ORDER BY created_at DESC,id',
      [target.nodeId, target.workspaceId, target.sessionId]
    );
    return rows.map((row) => this.record(row));
  }

  async savePassword(id: string, password: string): Promise<boolean> {
    const [result] = await this.database.raw.execute<ResultSetHeader>(
      'UPDATE session_shares SET encrypted_password=? WHERE id=?',
      [this.encrypt(password), id]
    );
    return result.affectedRows > 0;
  }

  async delete(id: string): Promise<boolean> {
    const [result] = await this.database.raw.execute<ResultSetHeader>(
      'DELETE FROM session_shares WHERE id=?',
      [id]
    );
    return result.affectedRows > 0;
  }

  async executionUser(userId: number) {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT username,nickname FROM users WHERE id=? AND enabled=TRUE AND must_change_password=FALSE',
      [userId]
    );
    const row = rows[0];
    return row === undefined
      ? undefined
      : { username: String(row.username), displayName: String(row.nickname || row.username) };
  }

  async workspaceName(nodeId: string, workspaceId: string): Promise<string | undefined> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT display_name FROM workspaces WHERE node_id=? AND workspace_id=?',
      [nodeId, workspaceId]
    );
    return rows[0] === undefined ? undefined : String(rows[0].display_name);
  }
  private encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }

  private decrypt(value: string): string {
    try {
      const data = Buffer.from(value, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      const password = Buffer.concat([
        decipher.update(data.subarray(28)),
        decipher.final()
      ]).toString('utf8');
      if (!/^[0-9]{6}$/u.test(password)) throw new Error();
      return password;
    } catch {
      throw new Error('SESSION_SHARE_PASSWORD_CORRUPT');
    }
  }

  private record(row: RowDataPacket): StoredSessionShare {
    return {
      id: String(row.id),
      userId: Number(row.user_id),
      nodeId: String(row.node_id),
      workspaceId: String(row.workspace_id),
      sessionId: String(row.session_id),
      passwordHash: String(row.password_hash),
      password:
        row.encrypted_password == null ? null : this.decrypt(String(row.encrypted_password)),
      credential: String(row.access_credential),
      createdAt: Number(row.created_at),
      expiresAt: row.expires_at === null ? null : Number(row.expires_at)
    };
  }
}
