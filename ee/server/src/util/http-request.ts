export {
  parseWorkbenchPage,
  validSessionOption,
  validSessionEffort,
  validSessionTitle,
  validMessageAttachments,
  validComposerAttachmentIds
} from '@myagentroam/server-core/run-http-support';
export {
  isNonEmptyString,
  parseResourcePage,
  parseFileRange,
  parseBoundedInteger,
  isSafeResourceText,
  isUuid,
  isPlainObject,
  requestUserNode
} from '@myagentroam/server-core/workspace-http-support';
export {
  sendError,
  safePublicError,
  safeErrorCode,
  errorResponseOptions,
  type SafePublicError
} from '@myagentroam/server-core/http-errors';
export {
  currentSession,
  protectedAdmin,
  protectedManagementAdmin,
  validCsrf
} from '@myagentroam/server-core/session';
export {
  hashLoginUsername,
  isRateLimited,
  registerFailedLogin,
  pruneRateRecords,
  type LoginRateRecord
} from '@myagentroam/server-core/login-rate';

export { boundedUserAgent } from '@myagentroam/server-core/auth';

export function normalizedOptionalText(
  value: unknown,
  maxLength: number
): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  return normalized.length > maxLength ? undefined : normalized;
}

export function positiveId(value: string): number | undefined {
  return /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : undefined;
}

/** File browsing has a smaller, closed pagination contract than event cursors. */

export { requestHostedConversationNode } from '@myagentroam/server-core/hosted-http-support';

export function logCorrelation(params: unknown): Record<string, string> {
  if (params === null || typeof params !== 'object') return {};
  const input = params as Record<string, unknown>;
  const keys = ['nodeId', 'workspaceId', 'sessionId', 'runId'];
  return Object.fromEntries(
    keys.flatMap((key) => (typeof input[key] === 'string' ? [[key, input[key]]] : []))
  );
}

export { databaseError } from '@myagentroam/server-core/domain-errors';

export { publicNode } from '@myagentroam/server-core/node-projection';
