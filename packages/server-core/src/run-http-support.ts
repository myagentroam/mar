import { isUuid } from './workspace-http-support.js';
const WORKBENCH_PAGE_LIMIT = 500;

export function parseWorkbenchPage(query: {
  readonly cursor?: unknown;
  readonly after?: unknown;
  readonly limit?: unknown;
}): { readonly cursor?: string; readonly limit?: number } | undefined {
  if (
    (query.cursor !== undefined && typeof query.cursor !== 'string') ||
    (query.after !== undefined && typeof query.after !== 'string') ||
    (query.limit !== undefined && typeof query.limit !== 'string')
  ) {
    return undefined;
  }
  const cursor = query.cursor ?? query.after;
  if (
    (query.cursor !== undefined && query.after !== undefined && query.cursor !== query.after) ||
    (cursor !== undefined && (cursor.length === 0 || cursor.length > 1024))
  ) {
    return undefined;
  }
  if (query.limit === undefined) return cursor === undefined ? {} : { cursor };
  if (!/^[1-9][0-9]*$/.test(query.limit)) return undefined;
  const limit = Number(query.limit);
  if (!Number.isSafeInteger(limit) || limit > WORKBENCH_PAGE_LIMIT) return undefined;
  return cursor === undefined ? { limit } : { cursor, limit };
}

export function validSessionOption(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' && value.trim().length > 0 && value.length <= 120)
  );
}

export function validSessionEffort(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= 120);
}

export function validSessionTitle(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' && value.trim().length > 0 && value.length <= 160)
  );
}

export function validMessageAttachments(
  value: unknown
): value is
  | readonly { readonly name: string; readonly mime: string; readonly dataBase64: string }[]
  | undefined {
  if (value === undefined) return true;
  return (
    Array.isArray(value) &&
    value.length <= 5 &&
    value.every(
      (attachment) =>
        typeof attachment === 'object' &&
        attachment !== null &&
        typeof (attachment as Record<string, unknown>).name === 'string' &&
        typeof (attachment as Record<string, unknown>).mime === 'string' &&
        typeof (attachment as Record<string, unknown>).dataBase64 === 'string'
    )
  );
}

export function validComposerAttachmentIds(value: unknown): value is readonly string[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= 5 &&
      value.every((attachmentId) => typeof attachmentId === 'string' && isUuid(attachmentId)) &&
      new Set(value).size === value.length)
  );
}
