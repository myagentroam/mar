import { readVisibleCatalog } from '../rbac/catalog-list-query.js';
import { McpService as Core } from '@myagentroam/server-core/mcp-service';
export * from '@myagentroam/server-core/mcp-service';
import type { RowDataPacket } from 'mysql2/promise';
export class McpService extends Core {
  protected override queryRows(actorUserId: number, query: Record<string, unknown>) {
    return readVisibleCatalog(this.database.raw, actorUserId, query, 'MCP');
  }

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
       SELECT id,scope,owner_organization_id,owner_user_id,name,locator,enabled,built_in,
              status,last_error_code,created_at,updated_at
       FROM mcp_sources
       WHERE scope='ENTERPRISE' OR owner_user_id=? OR owner_organization_id IN (SELECT id FROM ancestors)
       ORDER BY CASE scope WHEN 'ENTERPRISE' THEN 1 WHEN 'ORGANIZATION' THEN 2 ELSE 3 END,name,id`,
      [actorUserId, actorUserId]
    );
    return rows;
  }
  protected override async catalogRows(actorUserId: number): Promise<RowDataPacket[]> {
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
       SELECT * FROM mcp_catalog_entries
       WHERE scope='ENTERPRISE' OR owner_user_id=? OR owner_organization_id IN (SELECT id FROM ancestors)
       ORDER BY featured DESC,display_name,id`,
      [actorUserId, actorUserId]
    );
    return rows;
  }
}
