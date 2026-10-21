import { readVisibleCatalog } from '../rbac/catalog-list-query.js';
import { SkillFavoriteService as Core } from '@myagentroam/server-core/skill-favorite-service';
import type { SkillFavoriteSummary } from '@myagentroam/server-core/skill-favorite-service';
export * from '@myagentroam/server-core/skill-favorite-service';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { lockOrganizationReference } from '../rbac/organization-reference.js';
export class SkillFavoriteService extends Core {
  protected override queryRows(actorUserId: number, query: Record<string, unknown>) {
    return readVisibleCatalog(this.database.raw, actorUserId, query, 'SKILL');
  }

  protected override async favoriteRows(actorUserId: number): Promise<RowDataPacket[]> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      `WITH RECURSIVE actor AS (
         SELECT organization_id FROM users WHERE id=? AND enabled=TRUE
       ), ancestors AS (
         SELECT organization_id AS id FROM actor
         UNION ALL SELECT parent.parent_organization_id FROM organizations parent
         JOIN ancestors child ON parent.id=child.id WHERE parent.parent_organization_id IS NOT NULL
       )
       SELECT favorite.id,favorite.source_id,favorite.scope,favorite.owner_organization_id,
              favorite.owner_user_id,favorite.normalized_name,favorite.featured,favorite.tags,
              favorite.repository_identity,
              favorite.skill_path,favorite.current_version_id,favorite.created_at,favorite.updated_at,
              version.commit_sha,version.content_hash,version.tls_verified,version.metadata
       FROM skill_favorites favorite
       JOIN skill_versions version ON version.id=favorite.current_version_id
       WHERE favorite.scope='ENTERPRISE' OR favorite.owner_user_id=?
          OR favorite.owner_organization_id IN (SELECT id FROM ancestors)
       ORDER BY favorite.featured DESC,favorite.normalized_name,favorite.id`,
      [actorUserId, actorUserId]
    );
    return rows;
  }
  protected override async lockOrganization(
    connection: PoolConnection,
    organizationId: number | null,
    exclusive = false,
    scope?: SkillFavoriteSummary['scope']
  ): Promise<void> {
    await lockOrganizationReference(
      connection,
      scope === 'ENTERPRISE' ? 1 : organizationId,
      exclusive
    );
  }
}
