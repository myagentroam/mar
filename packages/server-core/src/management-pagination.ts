import type { Pool, RowDataPacket } from 'mysql2/promise';
import {
  MANAGEMENT_DEFAULT_LIMIT,
  MANAGEMENT_MAX_LIMIT,
  type ManagementPageMetadata,
  type ManagementPageQuery
} from '@myagentroam/protocol';

export class ManagementQueryError extends Error {
  readonly code = 'MANAGEMENT_QUERY_INVALID';
  readonly publicMessage = 'The management list query is invalid.';
  constructor() {
    super('The management list query is invalid.');
  }
}

export function managementPageQuery(
  query: Record<string, unknown>
): ManagementPageQuery | undefined {
  if (query['page'] === undefined && query['limit'] === undefined) return undefined;
  const integer = (value: unknown, fallback: number): number => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) throw new ManagementQueryError();
    const result = Number(value);
    if (!Number.isSafeInteger(result)) throw new ManagementQueryError();
    return result;
  };
  const page = integer(query['page'], 1);
  const limit = integer(query['limit'], MANAGEMENT_DEFAULT_LIMIT);
  if (limit > MANAGEMENT_MAX_LIMIT) throw new ManagementQueryError();
  return { page, limit };
}

export function managementText(query: Record<string, unknown>, key: string): string | undefined {
  const value = query[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 256 || value.includes('\0'))
    throw new ManagementQueryError();
  return value.trim();
}

export function managementSearchPattern(value: string): string {
  return `%${value.replace(/[!%_]/gu, '!$&')}%`;
}

export function managementOrder(
  query: Record<string, unknown>,
  fields: Readonly<Record<string, string>>,
  fallback: string
): string {
  const sortBy = managementText(query, 'sortBy');
  const direction = managementText(query, 'sortOrder') ?? 'asc';
  if (direction !== 'asc' && direction !== 'desc') throw new ManagementQueryError();
  if (sortBy === undefined || sortBy === '') return fallback;
  const field = Object.hasOwn(fields, sortBy) ? fields[sortBy] : undefined;
  if (field === undefined) throw new ManagementQueryError();
  return `${field} ${direction.toUpperCase()}`;
}

/** Domain callers supply the same scoped predicates for both statements. */
export async function readManagementPage(
  pool: Pool,
  query: ManagementPageQuery,
  statements: {
    readonly countSql: string;
    readonly rowsSql: string;
    readonly params: readonly unknown[];
    readonly facetsSql?: string;
    readonly facetsParams?: readonly unknown[];
  }
): Promise<
  ManagementPageMetadata & {
    readonly rows: RowDataPacket[];
    readonly facets?: { readonly tags: readonly string[] };
  }
> {
  const connection = await pool.getConnection();
  try {
    // Do not depend on a deployment's session isolation level for count/page consistency.
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.beginTransaction();
    const [counts] = await connection.query<RowDataPacket[]>(statements.countSql, [
      ...statements.params
    ]);
    const total = Number(counts[0]?.['total'] ?? 0);
    const page = Math.min(query.page, Math.max(1, Math.ceil(total / query.limit)));
    const [rows] = await connection.query<RowDataPacket[]>(
      `${statements.rowsSql} LIMIT ${query.limit} OFFSET ${(page - 1) * query.limit}`,
      [...statements.params]
    );
    const tags =
      statements.facetsSql === undefined
        ? undefined
        : (
            await connection.query<RowDataPacket[]>(statements.facetsSql, [
              ...(statements.facetsParams ?? statements.params)
            ])
          )[0].map((row) => String(row['tag']));
    await connection.commit();
    return {
      rows,
      page,
      pageSize: query.limit,
      total,
      hasMore: page * query.limit < total,
      ...(tags === undefined ? {} : { facets: { tags } })
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
