import {
  commitMysqlAudits,
  discardMysqlAudits,
  AsyncAuditWriter,
  deferMysqlAudit,
  safeAuditMetadata
} from '@myagentroam/server-core/audit';

import { scopedAuditEvent } from '../audit/audit-policy.js';
import { MysqlNodeIdentityStorage } from '@myagentroam/server-core/mysql-node-identity';
import { MysqlAuthenticationStorage } from '@myagentroam/server-core/mysql-authentication';
import {
  lockMysqlUsers,
  withMysqlTransaction
} from '@myagentroam/server-core/mysql-reference-store';
import {
  ManagementQueryError,
  managementOrder,
  managementPageQuery,
  managementSearchPattern,
  managementText,
  readManagementPage
} from '@myagentroam/server-core/management-pagination';
import { lockOrganizationReference } from '../rbac/organization-reference.js';
import { initializeRootIdentity } from './community-root.js';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import {
  assertPasswordPolicy,
  assertResetPasswordPolicy,
  hashPassword
} from '@myagentroam/server-core/password';
import type {
  AuditInput,
  CurrentUserSession,
  SharedConversationAuditInput,
  UserSession,
  UserSessionSummary
} from '../database.js';
import type { ResourceOwnership } from '@myagentroam/protocol';

type ListedUser = {
  id: number;
  username: string;
  email: string | null;
  nickname: string | null;
  isAdmin: boolean;
  createdAt: number;
};

type ListedUserPage = {
  readonly users: readonly ListedUser[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly hasMore: boolean;
};

export class MysqlServerDatabase {
  private readonly auditWriter = new AsyncAuditWriter((code) => console.warn(code));

  dispatchAudit(task: () => Promise<void>): void {
    this.auditWriter.dispatch(task);
  }
  private readonly nodeIdentities: MysqlNodeIdentityStorage;
  private readonly authentication: MysqlAuthenticationStorage;
  private nodeAccessResolver?: (userId: number, nodeId: string) => Promise<boolean>;
  private nodeRequestAccessResolver?: (
    userId: number,
    nodeId: string,
    operation: string,
    data: unknown,
    workspaceId?: string
  ) => Promise<boolean>;
  constructor(
    readonly raw: Pool,
    private readonly now: () => number = Date.now,
    readonly auditRaw: Pool = raw
  ) {
    this.nodeIdentities = new MysqlNodeIdentityStorage(raw, {
      now,
      lockOwnership: (connection, ownership) =>
        lockOrganizationReference(
          connection,
          ownership.ownerType === 'ORGANIZATION' ? ownership.ownerOrganizationId : null
        ),
      cleanupNodeResources: async (connection, nodeId) => {
        await connection.execute(
          `DELETE FROM resource_grants
           WHERE (resource_type='NODE' AND node_id=?)
              OR (resource_type='WORKSPACE' AND node_id=?)`,
          [nodeId, nodeId]
        );
      },
      audit: (connection, event) =>
        this.audit({
          ...event,
          ...(event.nodeId === undefined
            ? {}
            : {
                targetType: 'NODE',
                targetId: event.nodeId,
                metadata: event.metadata ?? JSON.stringify({ nodeId: event.nodeId })
              })
        })
    });
    this.authentication = new MysqlAuthenticationStorage(raw, {
      now,
      acceptsSession: () => true,
      auditPasswordChange: (_connection, input) => this.audit(input)
    });
  }

  async initialize(): Promise<void> {
    const timestamp = this.now();
    await this.raw.execute(
      `INSERT INTO license_state
       (singleton_id,current_document,ever_activated,trusted_time_high_watermark,updated_at)
       VALUES (1,NULL,FALSE,?,?) ON DUPLICATE KEY UPDATE singleton_id=singleton_id`,
      [timestamp, timestamp]
    );
    await this.authentication.initializeAdmin();
    await withMysqlTransaction(this.raw, (connection) =>
      initializeRootIdentity(connection, timestamp)
    );
    await this.raw.execute(
      `INSERT INTO skill_sources
       (id,kind,scope,owner_organization_id,owner_user_id,name,locator,enabled,built_in,status,
        last_error_code,created_by_user_id,created_at,updated_at,owner_key)
       VALUES ('skills-sh','SKILLS_SH','ENTERPRISE',NULL,NULL,'skills.sh','skills.sh',TRUE,TRUE,
               'READY',NULL,1,?,?, 'ENTERPRISE::')
       ON DUPLICATE KEY UPDATE built_in=TRUE`,
      [timestamp, timestamp]
    );
    await this.authentication.reloadSessions();
  }

  async close(): Promise<void> {
    if (this.auditRaw !== this.raw) await this.auditRaw.end();
    await this.raw.end();
  }

  async getAdmin(): Promise<{ id: number; passwordHash: string; mustChangePassword: boolean }> {
    const [rows] = await this.raw.execute<RowDataPacket[]>(
      'SELECT id, password_hash, must_change_password FROM users WHERE is_fixed_admin=TRUE'
    );
    const row = rows[0];
    if (!row) throw new Error('ADMIN_NOT_INITIALIZED');
    return {
      id: Number(row['id']),
      passwordHash: String(row['password_hash']),
      mustChangePassword: Boolean(row['must_change_password'])
    };
  }

  async findUserForLogin(
    username: string
  ): Promise<
    { id: number; passwordHash: string; mustChangePassword: boolean; isAdmin: boolean } | undefined
  > {
    const [rows] = await this.raw.execute<RowDataPacket[]>(
      `SELECT id, password_hash, must_change_password, is_fixed_admin, role
       FROM users WHERE username=? AND enabled=TRUE
       AND (is_fixed_admin=TRUE OR EXISTS (
         SELECT 1 FROM license_state WHERE singleton_id=1 AND ever_activated=TRUE
       ))`,
      [username]
    );
    const row = rows[0];
    if (!row || typeof row['password_hash'] !== 'string') return undefined;
    return {
      id: Number(row['id']),
      passwordHash: row['password_hash'],
      mustChangePassword: Boolean(row['must_change_password']),
      isAdmin: Boolean(row['is_fixed_admin']) || row['role'] === 'ADMIN'
    };
  }

  verifyUserPassword(userId: number, password: string): Promise<boolean> {
    return this.authentication.verifyUserPassword(userId, password);
  }

  async listUsers(): Promise<readonly ListedUser[]>;
  async listUsers(query: Record<string, unknown>): Promise<readonly ListedUser[] | ListedUserPage>;
  async listUsers(
    query: Record<string, unknown> = {}
  ): Promise<readonly ListedUser[] | ListedUserPage> {
    const pageQuery = managementPageQuery(query);
    const conditions: string[] = [];
    const params: unknown[] = [];
    const role = managementText(query, 'role');
    if (role !== undefined && role !== '') {
      if (role !== 'ADMIN' && role !== 'ORG_ADMIN' && role !== 'MEMBER')
        throw new ManagementQueryError();
      conditions.push('role=?');
      params.push(role);
    }
    const organizationId = managementText(query, 'organizationId');
    if (organizationId !== undefined && organizationId !== '') {
      if (!/^[1-9]\d*$/u.test(organizationId) || !Number.isSafeInteger(Number(organizationId)))
        throw new ManagementQueryError();
      conditions.push('organization_id=?');
      params.push(Number(organizationId));
    }
    const status = managementText(query, 'status');
    if (status !== undefined && status !== '') {
      if (status !== 'enabled' && status !== 'disabled') throw new ManagementQueryError();
      conditions.push('enabled=?');
      params.push(status === 'enabled');
    }
    const keyword = managementText(query, 'keyword');
    if (keyword !== undefined && keyword !== '') {
      const pattern = managementSearchPattern(keyword);
      conditions.push(
        "(username LIKE ? ESCAPE '!' OR email LIKE ? ESCAPE '!' OR nickname LIKE ? ESCAPE '!')"
      );
      params.push(pattern, pattern, pattern);
    }
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    const order = managementOrder(
      query,
      {
        username: 'username',
        email: 'email',
        nickname: 'nickname',
        role: 'role',
        createdAt: 'created_at'
      },
      'created_at ASC'
    );
    const columns = 'SELECT id,username,email,nickname,role,is_fixed_admin,created_at';
    const rowsSql = `${columns} FROM users ${where} ORDER BY ${order}, id ASC`;
    const mapUser = (row: RowDataPacket): ListedUser => ({
      id: Number(row['id']),
      username: String(row['username']),
      email: row['email'] === null ? null : String(row['email']),
      nickname: row['nickname'] === null ? null : String(row['nickname']),
      isAdmin: Boolean(row['is_fixed_admin']) || row['role'] === 'ADMIN',
      createdAt: Number(row['created_at'])
    });
    if (pageQuery !== undefined) {
      const page = await readManagementPage(this.raw, pageQuery, {
        countSql: `SELECT COUNT(*) AS total FROM users ${where}`,
        rowsSql,
        params
      });
      return {
        users: page.rows.map(mapUser),
        page: page.page,
        pageSize: page.pageSize,
        total: page.total,
        hasMore: page.hasMore
      };
    }

    const [rows] = await this.raw.query<RowDataPacket[]>(rowsSql, params);
    return rows.map(mapUser);
  }

  async createUser(input: {
    readonly username: string;
    readonly email: string | null;
    readonly nickname: string | null;
    readonly password: string;
  }): Promise<number> {
    assertPasswordPolicy(input.password);
    const timestamp = this.now();
    const [result] = await this.raw.execute<ResultSetHeader>(
      `INSERT INTO users
       (username,email,nickname,password_hash,must_change_password,enabled,created_at,updated_at)
       VALUES (?,?,?,?,TRUE,TRUE,?,?)`,
      [
        input.username,
        input.email,
        input.nickname,
        hashPassword(input.password),
        timestamp,
        timestamp
      ]
    );
    return result.insertId;
  }

  async resetUserPassword(userId: number, password: string, actorUserId?: number): Promise<void> {
    assertPasswordPolicy(password);
    const connection = await this.raw.getConnection();
    try {
      await connection.beginTransaction();
      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE users SET password_hash=?,must_change_password=TRUE,updated_at=?
         WHERE id=? AND is_fixed_admin=FALSE`,
        [hashPassword(password), this.now(), userId]
      );
      if (result.affectedRows !== 1) throw new Error('USER_NOT_FOUND_OR_PROTECTED');
      await connection.execute(
        'UPDATE user_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL',
        [this.now(), userId]
      );
      await connection.commit();
      commitMysqlAudits(connection);
      void this.audit({
        eventType: 'user_password_reset',
        ...(actorUserId === undefined ? {} : { actorUserId }),
        targetType: 'USER',
        targetId: String(userId)
      });
      this.authentication.invalidateUserSessions(userId);
    } catch (error) {
      discardMysqlAudits(connection);
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async resetPassword(password: string, ipAddress?: string): Promise<void> {
    assertResetPasswordPolicy(password);
    const connection = await this.raw.getConnection();
    try {
      await connection.beginTransaction();
      const [adminRows] = await connection.execute<RowDataPacket[]>(
        'SELECT id FROM users WHERE is_fixed_admin=TRUE FOR UPDATE'
      );
      const adminId = Number(adminRows[0]?.['id']);
      if (!Number.isSafeInteger(adminId)) throw new Error('ADMIN_NOT_INITIALIZED');
      const timestamp = this.now();
      await connection.execute(
        `UPDATE users SET password_hash=?,must_change_password=TRUE,updated_at=? WHERE id=?`,
        [hashPassword(password), timestamp, adminId]
      );
      await connection.execute(
        'UPDATE user_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL',
        [timestamp, adminId]
      );
      await this.auditWithConnection(connection, {
        eventType: 'password_reset',
        actorUserId: adminId,
        ...(ipAddress === undefined ? {} : { ipAddress })
      });
      await connection.commit();
      commitMysqlAudits(connection);
      this.authentication.invalidateUserSessions(adminId);
    } catch (error) {
      discardMysqlAudits(connection);
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async deleteUser(userId: number, actorUserId?: number): Promise<readonly string[] | undefined> {
    const nodeIds = await withMysqlTransaction(this.raw, async (connection) => {
      const [userRows] = await connection.execute<RowDataPacket[]>(
        'SELECT username,organization_id,is_fixed_admin FROM users WHERE id=? FOR UPDATE',
        [userId]
      );
      const user = Array.isArray(userRows) ? userRows[0] : undefined;
      if (user === undefined) return undefined;
      if (user['is_fixed_admin']) throw new Error('ADMIN_USER_PROTECTED');
      if (actorUserId !== undefined && actorUserId !== userId)
        await lockMysqlUsers(connection, [actorUserId]);

      await assertUserNotReferencedAsNonPersonalCreator(connection, userId);
      const [nodeRows] = await connection.execute<RowDataPacket[]>(
        "SELECT id FROM nodes WHERE owner_type='PERSONAL' AND owner_user_id=? FOR UPDATE",
        [userId]
      );
      const personalNodeIds = Array.isArray(nodeRows)
        ? nodeRows.map((row) => String(row['id']))
        : [];
      await assertPersonalNodeSourceReferences(connection, personalNodeIds);

      const personalResources = await lockPersonalResources(connection, userId);
      await assertPersonalSourcesAreNotUsedBySharedFavorites(
        connection,
        userId,
        personalResources.skillSourceIds
      );

      await deletePersonalModels(connection, personalResources.modelIds);
      await deletePersonalImageModels(connection, personalResources.imageModelIds);
      await deletePersonalSkillResources(
        connection,
        personalResources.skillFavoriteIds,
        personalResources.skillSourceIds
      );
      await deletePersonalMcpResources(
        connection,
        personalResources.mcpCatalogEntryIds,
        personalResources.mcpSourceIds
      );

      await connection.execute(
        'UPDATE nodes SET registered_by_user_id=NULL WHERE registered_by_user_id=?',
        [userId]
      );
      await connection.execute(
        'DELETE FROM node_registration_tokens WHERE created_by_user_id=? OR owner_user_id=?',
        [userId, userId]
      );
      for (const nodeId of personalNodeIds)
        await this.nodeIdentities.deleteNodeWithConnection(connection, nodeId, actorUserId);

      await deleteRemainingPersonalWorkspaces(connection, userId, this.now);
      await connection.execute(
        "DELETE FROM environment_secrets WHERE scope='PERSONAL' AND owner_user_id=?",
        [userId]
      );
      await connection.execute('DELETE FROM user_mar_agent_model_orders WHERE user_id=?', [userId]);
      await connection.execute('DELETE FROM user_mar_agent_image_model_orders WHERE user_id=?', [
        userId
      ]);
      await connection.execute('DELETE FROM user_quick_prompts WHERE user_id=?', [userId]);
      await connection.execute('DELETE FROM user_prompt_completion_preferences WHERE user_id=?', [
        userId
      ]);
      await connection.execute('DELETE FROM user_personal_instructions WHERE user_id=?', [userId]);
      await connection.execute('DELETE FROM user_git_configurations WHERE user_id=?', [userId]);
      await connection.execute('DELETE FROM web_push_clients WHERE user_id=?', [userId]);
      await connection.execute('DELETE FROM session_shares WHERE user_id=?', [userId]);
      await connection.execute('DELETE FROM user_sessions WHERE user_id=?', [userId]);
      await connection.execute('DELETE FROM model_usage_records WHERE user_id=?', [userId]);
      await connection.execute('DELETE FROM workbench_notifications WHERE user_id=?', [userId]);
      await connection.execute('DELETE FROM mail_deliveries WHERE user_id=?', [userId]);
      await connection.execute('DELETE FROM external_identities WHERE user_id=?', [userId]);
      await connection.execute('DELETE FROM resource_grants WHERE target_user_id=?', [userId]);

      if (actorUserId !== undefined)
        await this.auditWithConnection(connection, {
          eventType: 'user_deleted_by_admin',
          actorUserId,
          targetType: 'USER',
          targetId: String(userId),
          organizationId: Number(user['organization_id']),
          targetName: String(user['username']),
          metadata: JSON.stringify({ name: String(user['username']) })
        });
      await connection.execute('DELETE FROM users WHERE id=?', [userId]);
      return personalNodeIds;
    });
    if (nodeIds === undefined) return undefined;
    this.authentication.invalidateUserSessions(userId);
    return nodeIds;
  }

  async userDeletionSummary(userId: number): Promise<
    | {
        readonly organizationId: number | null;
        readonly role: string | null;
        readonly sessions: number;
        readonly externalIdentities: number;
        readonly grants: number;
        readonly personalNodes: number;
        readonly personalWorkspaces: number;
      }
    | undefined
  > {
    const [rows] = await this.raw.execute<RowDataPacket[]>(
      `SELECT u.organization_id,u.role,
        (SELECT COUNT(*) FROM user_sessions s WHERE s.user_id=u.id AND s.revoked_at IS NULL) sessions,
        (SELECT COUNT(*) FROM external_identities e WHERE e.user_id=u.id) external_identities,
        (SELECT COUNT(*) FROM resource_grants g WHERE g.target_type='USER' AND g.target_user_id=u.id) grants,
        (SELECT COUNT(*) FROM nodes n WHERE n.owner_type='PERSONAL' AND n.owner_user_id=u.id) personal_nodes,
        (SELECT COUNT(*) FROM workspaces w WHERE w.owner_type='PERSONAL' AND w.owner_user_id=u.id) personal_workspaces
       FROM users u WHERE u.id=? AND u.is_fixed_admin=FALSE`,
      [userId]
    );
    const row = rows[0];
    return row === undefined
      ? undefined
      : {
          organizationId: row['organization_id'] === null ? null : Number(row['organization_id']),
          role: row['role'] === null ? null : String(row['role']),
          sessions: Number(row['sessions']),
          externalIdentities: Number(row['external_identities']),
          grants: Number(row['grants']),
          personalNodes: Number(row['personal_nodes']),
          personalWorkspaces: Number(row['personal_workspaces'])
        };
  }

  createUserSession(
    userId: number,
    metadata: { readonly ipAddress: string; readonly userAgent: string }
  ): Promise<UserSession> {
    return this.authentication.createUserSession(userId, metadata);
  }
  findCurrentUserSession(sessionId: string): CurrentUserSession | undefined {
    return this.authentication.findCurrentUserSession(sessionId);
  }
  userDisplayName(userId: number): Promise<string | undefined> {
    return this.authentication.userDisplayName(userId);
  }
  listActiveUserSessions(
    userId: number,
    currentSessionId: string
  ): Promise<readonly UserSessionSummary[]> {
    return this.authentication.listActiveUserSessions(userId, currentSessionId);
  }
  revokeSession(sessionId: string): Promise<void> {
    return this.authentication.revokeSession(sessionId);
  }
  revokeUserSessionByPublicId(userId: number, publicId: string): Promise<string | undefined> {
    return this.authentication.revokeUserSessionByPublicId(userId, publicId);
  }
  rotateCsrfToken(sessionId: string): Promise<string | undefined> {
    return this.authentication.rotateCsrfToken(sessionId);
  }
  changePassword(
    userId: number,
    password: string,
    eventType: 'password_changed' = 'password_changed',
    ipAddress?: string
  ): Promise<void> {
    return this.authentication.changePassword(userId, password, eventType, ipAddress);
  }

  createNodeRegistrationToken(
    userId: number,
    ttlMs = 10 * 60 * 1000,
    ownership: ResourceOwnership = { ownerType: 'PERSONAL', ownerUserId: userId },
    displayName: string | null = null,
    connection?: PoolConnection
  ) {
    return this.nodeIdentities.createNodeRegistrationToken(
      userId,
      ttlMs,
      ownership,
      displayName,
      connection
    );
  }
  registerNode(token: string, input: { readonly metadata: string }, registeredAddress = 'unknown') {
    return this.nodeIdentities.registerNode(token, input, registeredAddress);
  }
  authenticateNode(nodeId: string, credential: string) {
    return this.nodeIdentities.authenticateNode(nodeId, credential);
  }
  updateNodeHeartbeat(nodeId: string, capabilities?: { readonly metadata: string }) {
    return this.nodeIdentities.updateNodeHeartbeat(nodeId, capabilities);
  }
  listNodes() {
    return this.nodeIdentities.listNodes();
  }
  listNodesForUser(userId: number) {
    return this.nodeIdentities.listNodesForUser(userId);
  }

  async userOwnsNode(userId: number, nodeId: string): Promise<boolean> {
    if (this.nodeAccessResolver !== undefined) return this.nodeAccessResolver(userId, nodeId);
    const [rows] = await this.raw.execute<RowDataPacket[]>(
      "SELECT 1 FROM nodes WHERE id=? AND owner_type='PERSONAL' AND owner_user_id=? AND disabled=FALSE",
      [nodeId, userId]
    );
    return rows.length === 1;
  }

  setNodeAccessResolver(resolver: (userId: number, nodeId: string) => Promise<boolean>): void {
    this.nodeAccessResolver = resolver;
  }

  async userCanRequestNode(
    userId: number,
    nodeId: string,
    operation: string,
    data: unknown,
    workspaceId?: string
  ): Promise<boolean> {
    if (this.nodeRequestAccessResolver !== undefined)
      return this.nodeRequestAccessResolver(userId, nodeId, operation, data, workspaceId);
    return this.userOwnsNode(userId, nodeId);
  }

  setNodeRequestAccessResolver(
    resolver: (
      userId: number,
      nodeId: string,
      operation: string,
      data: unknown,
      workspaceId?: string
    ) => Promise<boolean>
  ): void {
    this.nodeRequestAccessResolver = resolver;
  }

  updateNodeDisplayName(nodeId: string, displayName: string | null, actorUserId?: number) {
    return this.nodeIdentities.updateNodeDisplayName(nodeId, displayName, actorUserId);
  }
  revokeNode(nodeId: string, actorUserId?: number) {
    return this.nodeIdentities.revokeNode(nodeId, actorUserId);
  }
  deleteNode(nodeId: string, actorUserId?: number) {
    return this.nodeIdentities.deleteNode(nodeId, actorUserId);
  }

  async audit(input: AuditInput): Promise<void> {
    const event = {
      ...input,
      occurredAt: input.occurredAt ?? this.now(),
      metadata: safeAuditMetadata(input.metadata)
    };
    this.dispatchAudit(async () => {
      const scoped = await scopedAuditEvent(this.auditRaw, event);
      if (scoped) await this.persistAudit(scoped);
    });
  }

  async auditWithConnection(
    connection: Pick<PoolConnection, 'execute'>,
    input: AuditInput
  ): Promise<void> {
    const event = {
      ...input,
      occurredAt: input.occurredAt ?? this.now(),
      metadata: safeAuditMetadata(input.metadata)
    };
    deferMysqlAudit(connection, () => {
      void this.audit(event);
    });
  }

  private async persistAudit(input: AuditInput): Promise<void> {
    const connection = this.auditRaw;
    await connection.execute(
      `INSERT INTO audit_events
       (id,event_type,occurred_at,result,actor_user_id,actor_username,authentication_method,
        provider_id,actor_ip,request_id,operation_id,session_public_id,target_type,target_id,target_name,
        organization_id,node_id,workspace_id,agent_session_id,run_id,client_message_id,queue_item_id,input_mode,
        error_code,metadata)
       VALUES (?,?,?,?,?,COALESCE(?,(SELECT username FROM users WHERE id=?)),?,?,?,?,?,?,?,?,?,
        ?,?,?,?,?,?,?,?,?,CAST(? AS JSON))`,
      [
        randomUUID(),
        normalizeEventType(input.eventType),
        input.occurredAt ?? this.now(),
        input.result ?? 'SUCCESS',
        input.actorUserId ?? null,
        input.actorUsername ?? null,
        input.actorUserId ?? null,
        input.authenticationMethod ?? (input.actorUserId === undefined ? 'SYSTEM' : 'PASSWORD'),
        input.providerId ?? null,
        input.ipAddress ?? null,
        input.requestId ?? null,
        input.operationId ?? null,
        input.sessionPublicId ?? null,
        input.targetType ?? null,
        input.targetId ?? null,
        input.targetName ?? null,
        input.organizationId ?? null,
        input.nodeId ?? null,
        input.workspaceId ?? null,
        input.agentSessionId ?? null,
        input.runId ?? null,
        input.clientMessageId ?? null,
        input.queueItemId ?? null,
        input.inputMode ?? null,
        input.errorCode ?? null,
        safeAuditMetadata(input.metadata)
      ]
    );
  }

  async recordConversationAudit(input: SharedConversationAuditInput): Promise<void> {
    const connection = await this.auditRaw.getConnection();
    try {
      await connection.beginTransaction();
      const id = randomUUID();
      await connection.execute<ResultSetHeader>(
        `INSERT INTO audit_events
         (id,event_type,occurred_at,result,actor_user_id,actor_username,authentication_method,
          provider_id,actor_ip,request_id,operation_id,session_public_id,target_type,target_id,target_name,
          organization_id,node_id,workspace_id,agent_session_id,run_id,client_message_id,queue_item_id,input_mode,
          error_code,metadata,idempotency_key)
         VALUES (?,?,?,?,?,COALESCE(?,(SELECT username FROM users WHERE id=?)),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
          CAST(? AS JSON),?)
         ON DUPLICATE KEY UPDATE id=id`,
        [
          id,
          normalizeEventType(input.eventType),
          input.occurredAt ?? this.now(),
          input.result ?? 'SUCCESS',
          input.actorUserId ?? null,
          input.actorUsername ?? null,
          input.actorUserId ?? null,
          input.authenticationMethod ?? (input.actorUserId === undefined ? 'SYSTEM' : 'PASSWORD'),
          input.providerId ?? null,
          input.ipAddress ?? null,
          input.requestId ?? null,
          input.operationId ?? null,
          input.sessionPublicId ?? null,
          input.targetType ?? null,
          input.targetId ?? null,
          input.targetName ?? null,
          input.organizationId,
          input.nodeId ?? null,
          input.workspaceId ?? null,
          input.agentSessionId ?? null,
          input.runId ?? null,
          input.clientMessageId ?? null,
          input.queueItemId ?? null,
          input.inputMode ?? null,
          input.errorCode ?? null,
          safeAuditMetadata(input.metadata),
          input.idempotencyKey
        ]
      );
      const [rows] = await connection.execute<RowDataPacket[]>(
        'SELECT id FROM audit_events WHERE idempotency_key=? FOR UPDATE',
        [input.idempotencyKey]
      );
      const auditEventId = String(rows[0]?.['id'] ?? '');
      if (auditEventId.length === 0) throw new Error('AUDIT_CONVERSATION_IDEMPOTENCY_FAILED');
      if (
        input.userMessage !== undefined &&
        (input.result ?? 'SUCCESS') === 'SUCCESS' &&
        input.errorCode === undefined &&
        (input.eventType === 'shared_conversation_input_accepted' ||
          input.eventType === 'shared_conversation_queue_updated')
      ) {
        await connection.execute(
          `INSERT INTO audit_conversation_payloads
           (audit_event_id,conversation_id,conversation_title,user_message,queue_item_id)
           VALUES (?,?,?,?,?)
           ON DUPLICATE KEY UPDATE audit_event_id=audit_event_id`,
          [
            auditEventId,
            input.conversationId ?? null,
            input.conversationTitle ?? input.targetName ?? input.targetId ?? 'Untitled session',
            input.userMessage,
            input.queueItemId ?? null
          ]
        );
      }
      await connection.commit();
      commitMysqlAudits(connection);
    } catch (error) {
      discardMysqlAudits(connection);
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}

async function assertUserNotReferencedAsNonPersonalCreator(
  connection: PoolConnection,
  userId: number
): Promise<void> {
  const checks: readonly (readonly [string, string, readonly number[]])[] = [
    [
      'a shared Model',
      `SELECT id FROM mar_agent_models
       WHERE created_by=?
         AND (owner_type='ORGANIZATION' OR owner_user_id IS NULL OR owner_user_id<>?)
       LIMIT 1 FOR SHARE`,
      [userId, userId]
    ],
    [
      'a shared Image model',
      `SELECT id FROM mar_agent_image_models
       WHERE created_by=?
         AND (owner_type='ORGANIZATION' OR owner_user_id IS NULL OR owner_user_id<>?)
       LIMIT 1 FOR SHARE`,
      [userId, userId]
    ],
    [
      'a shared Skill source',
      `SELECT id FROM skill_sources
       WHERE created_by_user_id=?
         AND (scope<>'PERSONAL' OR owner_user_id IS NULL OR owner_user_id<>?)
       LIMIT 1 FOR SHARE`,
      [userId, userId]
    ],
    [
      'a shared Skill favorite',
      `SELECT id FROM skill_favorites
       WHERE created_by_user_id=?
         AND (scope<>'PERSONAL' OR owner_user_id IS NULL OR owner_user_id<>?)
       LIMIT 1 FOR SHARE`,
      [userId, userId]
    ],
    [
      'a conversation template as creator or updater',
      `SELECT id FROM conversation_templates
       WHERE created_by_user_id=? OR updated_by_user_id=?
       LIMIT 1 FOR SHARE`,
      [userId, userId]
    ],
    [
      'a published conversation template version',
      `SELECT id FROM conversation_template_versions
       WHERE published_by_user_id=?
       LIMIT 1 FOR SHARE`,
      [userId]
    ],
    [
      'a conversation template publish job as requester',
      `SELECT id FROM conversation_template_publish_jobs
       WHERE requested_by_user_id=?
       LIMIT 1 FOR SHARE`,
      [userId]
    ]
  ];
  for (const [reference, sql, params] of checks) {
    const [rows] = await connection.execute<RowDataPacket[]>(sql, [...params]);
    if (Array.isArray(rows) && rows.length > 0) throw userInUseError(reference);
  }
}

async function assertPersonalNodeSourceReferences(
  connection: PoolConnection,
  nodeIds: readonly string[]
): Promise<void> {
  if (nodeIds.length === 0) return;
  const marks = sqlPlaceholders(nodeIds);
  const checks = [
    `SELECT id FROM conversation_templates
     WHERE source_node_id IN (${marks})
        OR source_workspace_id IN (
          SELECT workspace_id FROM workspaces WHERE node_id IN (${marks})
        )
     LIMIT 1 FOR SHARE`
  ];
  for (const sql of checks) {
    const [rows] = await connection.execute<RowDataPacket[]>(sql, [...nodeIds, ...nodeIds]);
    if (Array.isArray(rows) && rows.length > 0) throw new Error('NODE_IN_USE');
  }
}

async function lockPersonalResources(
  connection: PoolConnection,
  userId: number
): Promise<PersonalResourceIds> {
  return {
    modelIds: await lockedIds(
      connection,
      "SELECT id FROM mar_agent_models WHERE owner_type='PERSONAL' AND owner_user_id=? FOR UPDATE",
      userId
    ),
    imageModelIds: await lockedIds(
      connection,
      "SELECT id FROM mar_agent_image_models WHERE owner_type='PERSONAL' AND owner_user_id=? FOR UPDATE",
      userId
    ),
    skillFavoriteIds: await lockedIds(
      connection,
      "SELECT id FROM skill_favorites WHERE scope='PERSONAL' AND owner_user_id=? FOR UPDATE",
      userId
    ),
    skillSourceIds: await lockedIds(
      connection,
      "SELECT id FROM skill_sources WHERE scope='PERSONAL' AND owner_user_id=? FOR UPDATE",
      userId
    ),
    mcpCatalogEntryIds: await lockedIds(
      connection,
      "SELECT id FROM mcp_catalog_entries WHERE scope='PERSONAL' AND owner_user_id=? FOR UPDATE",
      userId
    ),
    mcpSourceIds: await lockedIds(
      connection,
      "SELECT id FROM mcp_sources WHERE scope='PERSONAL' AND owner_user_id=? FOR UPDATE",
      userId
    )
  };
}

async function lockedIds(
  connection: PoolConnection,
  sql: string,
  userId: number
): Promise<readonly string[]> {
  const [rows] = await connection.execute<RowDataPacket[]>(sql, [userId]);
  return Array.isArray(rows) ? rows.map((row) => String(row['id'])) : [];
}

async function assertPersonalSourcesAreNotUsedBySharedFavorites(
  connection: PoolConnection,
  userId: number,
  sourceIds: readonly string[]
): Promise<void> {
  if (sourceIds.length === 0) return;
  const [rows] = await connection.execute<RowDataPacket[]>(
    `SELECT id FROM skill_favorites
     WHERE source_id IN (${sqlPlaceholders(sourceIds)})
       AND (owner_user_id IS NULL OR owner_user_id<>?)
     LIMIT 1 FOR UPDATE`,
    [...sourceIds, userId]
  );
  if (Array.isArray(rows) && rows.length > 0)
    throw userInUseError('a personal Skill source favorited by another user');
}

async function deletePersonalModels(
  connection: PoolConnection,
  modelIds: readonly string[]
): Promise<void> {
  if (modelIds.length === 0) return;
  const marks = sqlPlaceholders(modelIds);
  await connection.execute(
    `DELETE FROM resource_grants WHERE resource_type='MODEL' AND model_id IN (${marks})`,
    [...modelIds]
  );
  await connection.execute(`DELETE FROM user_mar_agent_model_orders WHERE model_id IN (${marks})`, [
    ...modelIds
  ]);
  await connection.execute(`DELETE FROM mar_agent_models WHERE id IN (${marks})`, [...modelIds]);
}

async function deletePersonalImageModels(
  connection: PoolConnection,
  imageModelIds: readonly string[]
): Promise<void> {
  if (imageModelIds.length === 0) return;
  const marks = sqlPlaceholders(imageModelIds);
  await connection.execute(
    `DELETE FROM resource_grants WHERE resource_type='IMAGE_MODEL' AND image_model_id IN (${marks})`,
    [...imageModelIds]
  );
  await connection.execute(
    `DELETE FROM user_mar_agent_image_model_orders WHERE image_model_id IN (${marks})`,
    [...imageModelIds]
  );
  await connection.execute(`DELETE FROM mar_agent_image_models WHERE id IN (${marks})`, [
    ...imageModelIds
  ]);
}

async function deletePersonalSkillResources(
  connection: PoolConnection,
  favoriteIds: readonly string[],
  sourceIds: readonly string[]
): Promise<void> {
  if (favoriteIds.length > 0) {
    const marks = sqlPlaceholders(favoriteIds);
    await connection.execute(`DELETE FROM skill_versions WHERE favorite_id IN (${marks})`, [
      ...favoriteIds
    ]);
    await connection.execute(`DELETE FROM skill_favorites WHERE id IN (${marks})`, [
      ...favoriteIds
    ]);
  }
  if (sourceIds.length > 0) {
    const marks = sqlPlaceholders(sourceIds);
    await connection.execute(`DELETE FROM skill_sources WHERE id IN (${marks})`, [...sourceIds]);
  }
}

async function deletePersonalMcpResources(
  connection: PoolConnection,
  catalogEntryIds: readonly string[],
  sourceIds: readonly string[]
): Promise<void> {
  if (catalogEntryIds.length > 0) {
    const marks = sqlPlaceholders(catalogEntryIds);
    await connection.execute(`DELETE FROM mcp_catalog_entries WHERE id IN (${marks})`, [
      ...catalogEntryIds
    ]);
  }
  if (sourceIds.length > 0) {
    const marks = sqlPlaceholders(sourceIds);
    await connection.execute(`DELETE FROM mcp_sources WHERE id IN (${marks})`, [...sourceIds]);
  }
}

interface PersonalResourceIds {
  readonly modelIds: readonly string[];
  readonly imageModelIds: readonly string[];
  readonly skillFavoriteIds: readonly string[];
  readonly skillSourceIds: readonly string[];
  readonly mcpCatalogEntryIds: readonly string[];
  readonly mcpSourceIds: readonly string[];
}

function userInUseError(reference: string): Error & { readonly publicDetails: string } {
  return Object.assign(new Error('USER_IN_USE'), {
    publicDetails: `The user cannot be deleted because ${reference} is still in use or protected.`
  });
}

function sqlPlaceholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(',');
}

async function deleteRemainingPersonalWorkspaces(
  connection: PoolConnection,
  userId: number,
  now: () => number
): Promise<void> {
  const [workspaceRows] = await connection.execute<RowDataPacket[]>(
    "SELECT workspace_id,node_id FROM workspaces WHERE owner_type='PERSONAL' AND owner_user_id=? FOR UPDATE",
    [userId]
  );
  if (!Array.isArray(workspaceRows)) return;
  for (const row of workspaceRows) {
    const workspaceId = String(row['workspace_id']);
    const nodeId = String(row['node_id']);
    const [templates] = await connection.execute<RowDataPacket[]>(
      'SELECT id FROM conversation_templates WHERE source_workspace_id=? LIMIT 1 FOR SHARE',
      [workspaceId]
    );
    if (Array.isArray(templates) && templates.length > 0)
      throw new Error('WORKSPACE_CONVERSATION_TEMPLATE_REFERENCE_EXISTS');
    await connection.execute(
      "DELETE FROM environment_secrets WHERE scope='WORKSPACE' AND node_id=? AND workspace_id=?",
      [nodeId, workspaceId]
    );
    await connection.execute(
      "DELETE FROM resource_grants WHERE resource_type='WORKSPACE' AND node_id=? AND workspace_id=?",
      [nodeId, workspaceId]
    );
    await connection.execute(
      `INSERT INTO workspace_tombstones (workspace_id,deleted_at) VALUES (?,?)
       ON DUPLICATE KEY UPDATE deleted_at=VALUES(deleted_at)`,
      [workspaceId, now()]
    );
    await connection.execute('DELETE FROM session_shares WHERE workspace_id=? AND node_id=?', [
      workspaceId,
      nodeId
    ]);
    await connection.execute('DELETE FROM workspaces WHERE workspace_id=? AND node_id=?', [
      workspaceId,
      nodeId
    ]);
  }
}

function normalizeEventType(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/gu, '_')
    .slice(0, 80);
}
