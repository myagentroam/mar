import type { Pool, RowDataPacket } from 'mysql2/promise';
import {
  managementPageQuery,
  managementText,
  managementSearchPattern,
  managementOrder,
  ManagementQueryError,
  readManagementPage
} from '@myagentroam/server-core/management-pagination';
import type { ManagementPageMetadata } from '@myagentroam/protocol';

export interface CatalogRows {
  readonly rows: RowDataPacket[];
  readonly metadata?: ManagementPageMetadata;
  readonly facets?: { readonly tags: readonly string[] };
}

/** Visibility is shared by directory pages, facets and bounded installation lookups. */
export async function readVisibleCatalog(
  pool: Pool,
  actorUserId: number,
  query: Record<string, unknown>,
  kind: 'SKILL' | 'MCP'
): Promise<CatalogRows> {
  const skill = kind === 'SKILL';
  const name = skill ? 'entry.normalized_name' : 'entry.display_name';
  const description = skill
    ? "JSON_UNQUOTE(JSON_EXTRACT(version.metadata,'$.description'))"
    : 'entry.description';
  const cte = `WITH RECURSIVE actor AS (
    SELECT organization_id FROM users WHERE id=? AND enabled=TRUE
  ), ancestors AS (
    SELECT organization_id AS id FROM actor
    UNION ALL SELECT parent.parent_organization_id FROM organizations parent
    JOIN ancestors child ON parent.id=child.id WHERE parent.parent_organization_id IS NOT NULL
  ) `;
  const from = skill
    ? 'FROM skill_favorites entry JOIN skill_versions version ON version.id=entry.current_version_id'
    : 'FROM mcp_catalog_entries entry';
  const select = skill
    ? 'entry.*,version.commit_sha,version.content_hash,version.tls_verified,version.metadata'
    : 'entry.*';
  const visible =
    "(entry.scope='ENTERPRISE' OR entry.owner_user_id=? OR entry.owner_organization_id IN (SELECT id FROM ancestors))";
  const predicates = [visible];
  const params: unknown[] = [actorUserId, actorUserId];
  const references: string[] = [];
  for (const key of ['ids', 'names'] as const) {
    const raw = query[key];
    if (raw === undefined) continue;
    if (typeof raw !== 'string' || raw.length > 40000) throw new ManagementQueryError();
    let values: unknown;
    try {
      values = JSON.parse(raw);
    } catch {
      throw new ManagementQueryError();
    }
    if (
      !Array.isArray(values) ||
      values.length > 128 ||
      values.some(
        (value) => typeof value !== 'string' || !value || value.length > 256 || value.includes('\0')
      )
    )
      throw new ManagementQueryError();
    references.push(
      values.length
        ? `${key === 'ids' ? 'entry.id' : skill ? 'entry.normalized_name' : 'entry.server_name'} IN (?)`
        : 'FALSE'
    );
    if (values.length) params.push(values);
  }
  if (references.length) predicates.push(`(${references.join(' OR ')})`);
  const keyword = managementText(query, 'keyword');
  if (keyword) {
    predicates.push(
      `(${name} LIKE ? ESCAPE '!' OR ${description} LIKE ? ESCAPE '!' OR CAST(entry.tags AS CHAR) LIKE ? ESCAPE '!')`
    );
    params.push(...Array.from({ length: 3 }, () => managementSearchPattern(keyword)));
  }
  const category = managementText(query, 'category');
  if (category) {
    predicates.push('JSON_CONTAINS(entry.tags, ?)');
    params.push(JSON.stringify(category));
  }
  const sourceId = managementText(query, 'sourceId');
  if (sourceId) {
    predicates.push('entry.source_id=?');
    params.push(sourceId);
  }
  const scope = managementText(query, 'scope');
  if (scope) {
    if (!['PERSONAL', 'ORGANIZATION', 'ENTERPRISE'].includes(scope))
      throw new ManagementQueryError();
    predicates.push('entry.scope=?');
    params.push(scope);
  }
  const where = ` WHERE ${predicates.join(' AND ')}`;
  const order = managementOrder(
    query,
    {
      normalizedName: name,
      displayName: name,
      serverName: skill ? name : 'entry.server_name',
      updatedAt: 'entry.updated_at',
      featured: 'entry.featured',
      scope: 'entry.scope'
    },
    `entry.featured DESC,${name}`
  );
  const rowsSql = `${cte}SELECT ${select} ${from}${where} ORDER BY ${order},entry.id`;
  const paging = managementPageQuery(query);
  if (paging === undefined)
    return { rows: (await pool.query<RowDataPacket[]>(rowsSql, params))[0] };
  const { rows, facets, ...metadata } = await readManagementPage(pool, paging, {
    countSql: `${cte}SELECT COUNT(*) AS total ${from}${where}`,
    rowsSql,
    params,
    facetsSql: `${cte}SELECT DISTINCT tags.tag ${from} JOIN JSON_TABLE(COALESCE(entry.tags,JSON_ARRAY()), '$[*]' COLUMNS(tag VARCHAR(256) PATH '$')) tags WHERE ${visible} ORDER BY tags.tag`,
    facetsParams: [actorUserId, actorUserId]
  });
  return { rows, metadata, ...(facets === undefined ? {} : { facets }) };
}
