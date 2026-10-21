import { emitAudit, resourceAuditEvent } from './audit.js';
import { lockMysqlUsers } from './mysql-reference-store.js';
import { randomUUID } from 'node:crypto';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { skillSourceInputSchema, type SkillSourceInput } from '@myagentroam/protocol';
import type {
  CatalogScopeContext as AuthorizationContext,
  CatalogAuthorization,
  CatalogDatabase
} from './catalog-policy.js';

export interface SkillSourceSummary extends SkillSourceInput {
  readonly id: string;
  readonly ownerUserId?: number;
  readonly builtIn: boolean;
  readonly status: 'READY' | 'DEGRADED' | 'DISABLED';
  readonly lastErrorCode: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly manageable: boolean;
}

export interface VisibleSkillSource {
  readonly id: string;
  readonly kind: 'SKILLS_SH' | 'REPOSITORY';
  readonly locator: string;
  readonly enabled: boolean;
}

export abstract class SkillSourceService {
  protected abstract sourceRows(actorUserId: number): Promise<RowDataPacket[]>;
  protected abstract lockOrganization(
    connection: PoolConnection,
    organizationId: number | null,
    exclusive?: boolean
  ): Promise<void>;
  constructor(
    protected readonly database: CatalogDatabase,
    private readonly authorization: CatalogAuthorization,
    private readonly now: () => number = Date.now
  ) {}

  async list(actorUserId: number): Promise<readonly SkillSourceSummary[]> {
    const rows = await this.sourceRows(actorUserId);
    return Promise.all(
      rows.map(async (row) => {
        const summary = sourceSummary(row);
        const authorization = await this.authorization.authorize(
          actorUserId,
          'SKILL_SOURCE_MANAGE',
          scopeContext(summary.scope, summary.ownerUserId ?? actorUserId, summary.organizationId)
        );
        return { ...summary, manageable: authorization.allowed };
      })
    );
  }

  async create(actorUserId: number, rawInput: unknown): Promise<SkillSourceSummary> {
    const input = skillSourceInputSchema.parse(rawInput);
    await this.assertManage(actorUserId, input);
    const id = randomUUID();
    const timestamp = this.now();
    const ownerUserId = input.scope === 'PERSONAL' ? actorUserId : null;
    const organizationId = input.scope === 'ORGANIZATION' ? input.organizationId! : null;
    const key = ownerKey(input.scope, organizationId, ownerUserId);
    const [countRows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS total FROM skill_sources WHERE owner_key=?',
      [key]
    );
    if (Number(countRows[0]?.['total'] ?? 0) >= 20) throw new Error('SKILL_SOURCE_LIMIT_EXCEEDED');
    const enabled = input.enabled ?? true;
    const status = enabled ? 'READY' : 'DISABLED';
    const connection = await this.database.raw.getConnection();
    try {
      await connection.beginTransaction();
      // Match organization deletion: organization, users, then dependent resources.
      await this.lockOrganization(connection, organizationId, true);
      await lockMysqlUsers(connection, [actorUserId, ownerUserId], ownerUserId !== null);
      // No snapshot reads precede the owner lock, including after waiting for another writer.
      const [countRows] = await connection.execute<RowDataPacket[]>(
        'SELECT COUNT(*) AS total FROM skill_sources WHERE owner_key=?',
        [key]
      );
      if (Number(countRows[0]?.['total'] ?? 0) >= 20)
        throw new Error('SKILL_SOURCE_LIMIT_EXCEEDED');
      await connection.execute(
        `INSERT INTO skill_sources
         (id,kind,scope,owner_organization_id,owner_user_id,name,locator,enabled,built_in,status,
          last_error_code,created_by_user_id,created_at,updated_at,owner_key)
         VALUES (?,?,?,?,?,?,?,?,FALSE,?,NULL,?,?,?,?)`,
        [
          id,
          input.kind,
          input.scope,
          organizationId,
          ownerUserId,
          input.name,
          input.locator,
          enabled,
          status,
          actorUserId,
          timestamp,
          timestamp,
          key
        ]
      );
      await connection.commit();
      emitAudit(
        this.database,
        resourceAuditEvent(
          {
            eventType: 'skill.source.created',
            actorUserId: actorUserId,
            targetType: 'SKILL_SOURCE',
            targetId: id
          },
          { ...input, organizationId },
          {}
        )
      );
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    return {
      ...input,
      id,
      ...(ownerUserId === null ? {} : { ownerUserId }),
      enabled,
      builtIn: false,
      status,
      lastErrorCode: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      manageable: true
    };
  }

  async getVisible(actorUserId: number, sourceId: string): Promise<VisibleSkillSource> {
    const visible = await this.list(actorUserId);
    const source = visible.find((candidate) => candidate.id === sourceId);
    if (source === undefined) throw new Error('SKILL_SOURCE_NOT_FOUND');
    if (!source.enabled) throw new Error('SKILL_SOURCE_DISABLED');
    return { id: source.id, kind: source.kind, locator: source.locator, enabled: source.enabled };
  }

  async remove(actorUserId: number, sourceId: string): Promise<void> {
    const connection = await this.database.raw.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT name,built_in,scope,owner_organization_id,owner_user_id
         FROM skill_sources WHERE id=? FOR UPDATE`,
        [sourceId]
      );
      const row = rows[0];
      if (row === undefined) throw new Error('SKILL_SOURCE_NOT_FOUND');
      if (row['built_in']) throw new Error('SKILL_SOURCE_BUILT_IN');
      await this.assertManageRow(actorUserId, row);
      const [favorites] = await connection.execute<RowDataPacket[]>(
        'SELECT id FROM skill_favorites WHERE source_id=? LIMIT 1',
        [sourceId]
      );
      if (favorites.length > 0) throw new Error('SKILL_SOURCE_IN_USE');
      await connection.execute('DELETE FROM skill_sources WHERE id=?', [sourceId]);
      await connection.commit();
      emitAudit(
        this.database,
        resourceAuditEvent(
          {
            eventType: 'skill.source.deleted',
            actorUserId: actorUserId,
            targetType: 'SKILL_SOURCE',
            targetId: sourceId
          },
          row,
          {}
        )
      );
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async setEnabled(actorUserId: number, sourceId: string, enabled: boolean): Promise<void> {
    const connection = await this.database.raw.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT name,built_in,scope,owner_organization_id,owner_user_id
         FROM skill_sources WHERE id=? FOR UPDATE`,
        [sourceId]
      );
      const row = rows[0];
      if (row === undefined) throw new Error('SKILL_SOURCE_NOT_FOUND');
      await this.assertManageRow(actorUserId, row);
      await connection.execute(
        `UPDATE skill_sources SET enabled=?,status=?,last_error_code=NULL,updated_at=? WHERE id=?`,
        [enabled, enabled ? 'READY' : 'DISABLED', this.now(), sourceId]
      );
      await connection.commit();
      emitAudit(
        this.database,
        resourceAuditEvent(
          {
            eventType: 'skill.source.updated',
            actorUserId: actorUserId,
            targetType: 'SKILL_SOURCE',
            targetId: sourceId
          },
          row,
          { after: { enabled }, before: { enabled: row['enabled'] } }
        )
      );
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  private async assertManage(actorUserId: number, input: SkillSourceInput): Promise<void> {
    const context = scopeContext(input.scope, actorUserId, input.organizationId);
    const result = await this.authorization.authorize(actorUserId, 'SKILL_SOURCE_MANAGE', context);
    if (!result.allowed) throw new Error('SKILL_SOURCE_FORBIDDEN');
  }

  private async assertManageRow(actorUserId: number, row: RowDataPacket): Promise<void> {
    const scope = row['scope'];
    if (scope !== 'ENTERPRISE' && scope !== 'ORGANIZATION' && scope !== 'PERSONAL')
      throw new Error('SKILL_SOURCE_INVALID');
    const result = await this.authorization.authorize(
      actorUserId,
      'SKILL_SOURCE_MANAGE',
      scopeContext(scope, Number(row['owner_user_id']), Number(row['owner_organization_id']))
    );
    if (!result.allowed) throw new Error('SKILL_SOURCE_FORBIDDEN');
  }
}

function scopeContext(
  scope: SkillSourceInput['scope'],
  actorUserId: number,
  organizationId?: number
): AuthorizationContext {
  if (scope === 'PERSONAL') return { ownerType: 'PERSONAL', ownerUserId: actorUserId };
  if (scope === 'ORGANIZATION') {
    if (!Number.isSafeInteger(organizationId)) throw new Error('SKILL_SOURCE_INVALID');
    return { ownerType: 'ORGANIZATION', organizationId: organizationId! };
  }
  return {};
}

function ownerKey(
  scope: 'ENTERPRISE' | SkillSourceInput['scope'],
  organizationId: number | null,
  userId: number | null
): string {
  if (scope === 'ENTERPRISE') return 'ENTERPRISE::';
  if (scope === 'ORGANIZATION') return `ORGANIZATION:${organizationId}:`;
  return `PERSONAL:${userId}:`;
}

function sourceSummary(row: RowDataPacket): SkillSourceSummary {
  const scope = String(row['scope']) as SkillSourceInput['scope'];
  return {
    id: String(row['id']),
    kind: String(row['kind']) as SkillSourceInput['kind'],
    scope,
    ...(row['owner_organization_id'] === null
      ? {}
      : { organizationId: Number(row['owner_organization_id']) }),
    ...(row['owner_user_id'] === null ? {} : { ownerUserId: Number(row['owner_user_id']) }),
    name: String(row['name']),
    locator: String(row['locator']),
    enabled: Boolean(row['enabled']),
    builtIn: Boolean(row['built_in']),
    status: String(row['status']) as SkillSourceSummary['status'],
    lastErrorCode: row['last_error_code'] === null ? null : String(row['last_error_code']),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
    manageable: false
  };
}
