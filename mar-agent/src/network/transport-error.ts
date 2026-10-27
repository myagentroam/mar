export class TransportFault extends Error {
  constructor(
    readonly kind: 'connection-timeout' | 'http2-negotiation' | 'invalid-proxy',
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

const RETRYABLE_TRANSPORT_CODES = new Set([
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET'
]);

export function isRetryableTransportError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth++) {
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === 'string' && RETRYABLE_TRANSPORT_CODES.has(record.code)) return true;
    current = record.cause;
  }
  return false;
}
