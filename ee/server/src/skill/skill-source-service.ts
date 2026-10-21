import { SkillSourceService as Core } from '@myagentroam/server-core/skill-source-service';
export * from '@myagentroam/server-core/skill-source-service';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { lockOrganizationReference } from '../rbac/organization-reference.js';
export class SkillSourceService extends Core {
  protected override async sourceRows(actorUserId: number): Promise<RowDataPacket[]> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      `WITH RECURSIVE actor AS (
         SELECT organization_id FROM users WHERE id=? AND enabled=TRUE
       ), ancestors AS (
         SELECT organization_id AS id FROM actor
         UNION ALL
         SELECT parent.parent_organization_id FROM organizations parent
         JOIN ancestors child ON parent.id=child.id
         WHERE parent.parent_organization_id IS NOT NULL
       )
       SELECT id,kind,scope,owner_organization_id,owner_user_id,name,locator,enabled,built_in,
              status,last_error_code,created_at,updated_at
       FROM skill_sources
       WHERE scope='ENTERPRISE' OR owner_user_id=? OR owner_organization_id IN (SELECT id FROM ancestors)
       ORDER BY CASE scope WHEN 'ENTERPRISE' THEN 1 WHEN 'ORGANIZATION' THEN 2 ELSE 3 END,name,id`,
      [actorUserId, actorUserId]
    );
    return rows;
  }
  protected override async lockOrganization(
    connection: PoolConnection,
    organizationId: number | null,
    exclusive = false
  ): Promise<void> {
    await lockOrganizationReference(connection, organizationId, exclusive);
  }
}
