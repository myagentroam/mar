const MAX_RUNNER_ERROR_MESSAGE = 1000;
const MAX_RUNNER_ERROR_CODE = 80;

export interface RunnerErrorProjection {
  readonly code: string;
  readonly message: string;
  readonly httpStatus: number | null;
}

export function runnerErrorProjection(error: unknown, fallbackCode: string): RunnerErrorProjection {
  const httpStatus = findHttpStatus(error);
  const publicError = findPublicError(error);
  const providerCode = publicError?.code ?? findCode(error);
  const message = publicError?.message ?? findMessage(error) ?? fallbackCode;
  return {
    code: providerCode ?? (httpStatus === null ? fallbackCode : `HTTP_${httpStatus}`),
    message: message.slice(0, MAX_RUNNER_ERROR_MESSAGE),
    httpStatus
  };
}

function findPublicError(
  value: unknown,
  depth = 0
): { readonly code: string; readonly message: string } | undefined {
  if (depth > 3 || value === null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const code = normalizeCode(record.code);
  const message = record.publicMessage;
  if (code !== undefined && typeof message === 'string' && message.trim())
    return { code, message: message.trim() };
  for (const key of ['error', 'data', 'response', 'cause']) {
    const nested = findPublicError(record[key], depth + 1);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function findCode(value: unknown, depth = 0): string | undefined {
  if (depth > 3 || value === null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['error', 'data', 'response', 'cause']) {
    const nested = findCode(record[key], depth + 1);
    if (nested !== undefined) return nested;
  }
  for (const key of ['code', 'errorCode', 'error_code']) {
    const candidate = normalizeCode(record[key]);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

function normalizeCode(candidate: unknown): string | undefined {
  if (typeof candidate === 'string' && candidate.trim())
    return [...candidate.trim()].slice(0, MAX_RUNNER_ERROR_CODE).join('');
  if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate);
  return undefined;
}

function findHttpStatus(value: unknown, depth = 0): number | null {
  if (depth > 3 || value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of ['status', 'statusCode', 'status_code', 'httpStatus', 'http_status']) {
    const candidate = record[key];
    if (
      ((typeof candidate === 'number' && Number.isInteger(candidate)) ||
        (typeof candidate === 'string' && /^\d{3}$/u.test(candidate))) &&
      Number(candidate) >= 100 &&
      Number(candidate) <= 599
    )
      return Number(candidate);
  }
  const match = findMessage(value)?.match(
    /(?:^|\b(?:http(?:\s+status)?|status(?:\s+code)?|error)\s*[:=_-]?\s*)([1-5]\d{2})\b/iu
  );
  if (match !== null && match !== undefined) return Number(match[1]);
  for (const key of ['error', 'cause', 'response', 'data']) {
    const nested = findHttpStatus(record[key], depth + 1);
    if (nested !== null) return nested;
  }
  return null;
}

function findMessage(value: unknown, depth = 0): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (depth > 3 || value === null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['error', 'data', 'response', 'cause']) {
    const nested = findMessage(record[key], depth + 1);
    if (nested !== undefined) return nested;
  }
  for (const key of ['message', 'error_description', 'detail', 'result']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}
