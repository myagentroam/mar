export class AgentError extends Error {
  readonly code: string;
  readonly publicMessage: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    options: {
      details?: Readonly<Record<string, unknown>>;
      retryable?: boolean;
      cause?: unknown;
    } = {}
  ) {
    super(`${code}: ${message}`, { cause: options.cause });
    this.name = 'MarAgentError';
    this.code = code;
    this.publicMessage = message;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }
}

/** Cache stack text before retaining a failure, rather than its lazy callback/receiver frames. */
export function materializeErrorStack(error: unknown): void {
  try {
    if (error instanceof Error) void error.stack;
  } catch {
    // A caller's custom stack formatter must not replace the original failure.
  }
}

const MAX_ERROR_MESSAGE_CHARACTERS = 1_000;

export function describeAgentError(
  error: unknown,
  fallbackCode: string,
  fallbackMessage = 'MAR Agent operation failed.',
  includeCauses = true
): { code: string; message: string } {
  const code = diagnosticCode(error) ?? fallbackCode;
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && current !== null && !seen.has(current) && messages.length < 4) {
    seen.add(current);
    const currentCode = diagnosticCode(current);
    const message = diagnosticMessage(current, currentCode);
    const summary =
      message && currentCode !== undefined && currentCode !== code
        ? `${currentCode}: ${message}`
        : message;
    if (summary && !messages.includes(summary)) messages.push(summary);
    if (!includeCauses) break;
    current = diagnosticCause(current);
  }
  return {
    code,
    message: truncateErrorMessage(messages.join(' Caused by: ') || fallbackMessage)
  };
}

function diagnosticCode(value: unknown): string | undefined {
  if (value instanceof AgentError) return value.code;
  if (value === null || typeof value !== 'object' || !('code' in value)) return undefined;
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' && code.trim().length > 0 ? code.trim().slice(0, 80) : undefined;
}

function diagnosticMessage(value: unknown, code: string | undefined): string | undefined {
  const message =
    value instanceof AgentError
      ? value.publicMessage
      : value instanceof Error
        ? value.message
        : value !== null &&
            typeof value === 'object' &&
            'message' in value &&
            typeof (value as { message?: unknown }).message === 'string'
          ? (value as { message: string }).message
          : typeof value === 'string'
            ? value
            : undefined;
  const normalized = message?.trim();
  if (!normalized) return undefined;
  return code !== undefined && normalized.startsWith(`${code}: `)
    ? normalized.slice(code.length + 2)
    : normalized;
}

function diagnosticCause(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || !('cause' in value)) return undefined;
  return (value as { cause?: unknown }).cause;
}

function truncateErrorMessage(value: string): string {
  return [...value].slice(0, MAX_ERROR_MESSAGE_CHARACTERS).join('');
}
