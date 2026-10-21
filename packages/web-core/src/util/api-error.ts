import { isPublicErrorCode, publicErrorMessage } from '@myagentroam/protocol';

export class ApiError extends Error {
  readonly code: string;
  readonly parameters: Readonly<Record<string, string | number>>;
  readonly details: string | undefined;
  readonly requestId: string | undefined;
  readonly upstreamRequestId: string | undefined;

  constructor(
    code: string,
    message: string,
    parameters: Readonly<Record<string, string | number>> = {},
    details?: string,
    requestId?: string,
    upstreamRequestId?: string
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.parameters = parameters;
    this.details = details;
    this.requestId = requestId;
    this.upstreamRequestId = upstreamRequestId;
  }
}

export function apiErrorFromResponse(body: unknown, status: number): ApiError {
  const fallbackCode = `REQUEST_FAILED_${status}`;
  const fallbackMessage = `The request failed with HTTP status ${status}.`;
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return new ApiError(fallbackCode, fallbackMessage);
  const error = (body as { readonly error?: unknown }).error;
  if (typeof error === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/u.test(error))
    return new ApiError(error, publicErrorMessage(error));
  if (typeof error !== 'object' || error === null || Array.isArray(error))
    return new ApiError(fallbackCode, fallbackMessage);
  const record = error as Record<string, unknown>;
  const code = isPublicErrorCode(record.code) ? record.code : fallbackCode;
  const message =
    boundedText(record.message, 1_000) ??
    (code === fallbackCode ? fallbackMessage : publicErrorMessage(code));
  const details = boundedText(record.details, 1_000);
  const requestId = boundedText(record.requestId, 128);
  const upstreamRequestId = boundedText(record.upstreamRequestId, 128);
  const parameters =
    typeof record.parameters === 'object' && record.parameters !== null
      ? Object.fromEntries(
          Object.entries(record.parameters)
            .flatMap(([key, value]): Array<[string, string | number]> => {
              if (key.trim().length === 0 || key.length > 128 || key.includes('\0')) return [];
              if (typeof value === 'number' && Number.isFinite(value)) return [[key, value]];
              const text = boundedText(value, 1_000);
              return text === undefined ? [] : [[key, text]];
            })
            .slice(0, 32)
        )
      : {};
  return new ApiError(code, message, parameters, details, requestId, upstreamRequestId);
}

export function errorCode(error: unknown): string | undefined {
  if (error instanceof ApiError) return error.code;
  return error instanceof Error && /^[A-Z][A-Z0-9_]+$/u.test(error.message)
    ? error.message
    : undefined;
}

function boundedText(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximumLength ? normalized : undefined;
}
