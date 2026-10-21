import type { CurrentUserSession } from './session.js';
import type { WorkspaceNodeControl } from './workspace-route-contracts.js';
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function parseResourcePage(query: {
  readonly cursor?: unknown;
  readonly limit?: unknown;
}): { readonly cursor?: string; readonly limit?: number } | undefined {
  if (
    (query.cursor !== undefined && !isSafeResourceText(query.cursor)) ||
    (query.limit !== undefined && typeof query.limit !== 'string')
  ) {
    return undefined;
  }
  if (query.limit === undefined) return query.cursor === undefined ? {} : { cursor: query.cursor };
  if (!/^[1-9][0-9]*$/.test(query.limit)) return undefined;
  const limit = Number(query.limit);
  if (!Number.isSafeInteger(limit) || limit > 200) return undefined;
  return query.cursor === undefined ? { limit } : { cursor: query.cursor, limit };
}

export function parseFileRange(query: {
  readonly offset?: unknown;
  readonly limit?: unknown;
}): { readonly offset?: number; readonly limit?: number } | undefined {
  if (
    (query.offset !== undefined && typeof query.offset !== 'string') ||
    (query.limit !== undefined && typeof query.limit !== 'string')
  ) {
    return undefined;
  }
  const offset =
    query.offset === undefined ? undefined : parseBoundedInteger(query.offset, 0, 2 ** 31 - 1);
  const limit =
    query.limit === undefined ? undefined : parseBoundedInteger(query.limit, 1, 512 * 1024);
  if (
    (query.offset !== undefined && offset === undefined) ||
    (query.limit !== undefined && limit === undefined)
  )
    return undefined;
  return {
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit })
  };
}

export function parseBoundedInteger(
  value: string,
  minimum: number,
  maximum: number
): number | undefined {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : undefined;
}

export function isSafeResourceText(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0')
  );
}

export function requestUserNode(
  nodeControl: Pick<WorkspaceNodeControl, 'requestNode'>,
  admin: CurrentUserSession,
  nodeId: string,
  operation: string,
  data: unknown,
  workspaceId?: string,
  timeoutMs?: number
): Promise<unknown> {
  return nodeControl.requestNode(
    nodeId,
    operation,
    data,
    {
      userId: admin.userId,
      sessionHash: admin.sessionHash,
      ...(workspaceId === undefined ? workspaceAuthorizationContext(data) : { workspaceId })
    },
    timeoutMs
  );
}

function workspaceAuthorizationContext(data: unknown): { readonly workspaceId?: string } {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return {};
  const workspaceId = (data as Record<string, unknown>)['workspaceId'];
  return typeof workspaceId === 'string' && workspaceId.length > 0 ? { workspaceId } : {};
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
