import { MarAgentError } from '../error.js';
import { isRetryableModelHttpStatus } from './http.js';

const DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS = 300_000;
const streamEventObservedAt = new WeakMap<object, number>();

export function observeModelStreamEvent<const T>(value: T, observedAt: number | undefined): T {
  if (typeof value === 'object' && value !== null && observedAt !== undefined)
    streamEventObservedAt.set(value, observedAt);
  return value;
}

export function modelStreamEventObservedAt(value: unknown): number | undefined {
  return typeof value === 'object' && value !== null ? streamEventObservedAt.get(value) : undefined;
}

export async function* parseSse(
  response: Response,
  signal: AbortSignal,
  maxBytes = 16 * 1024 * 1024,
  idleTimeoutMs = DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS,
  sensitiveValues: readonly string[] = []
): AsyncIterable<unknown> {
  if (!response.ok) {
    const redact = responseRedactor(sensitiveValues);
    const body = redact(await readResponseText(response, signal, maxBytes, idleTimeoutMs));
    const header = (name: string, limit: number) => {
      const value = response.headers.get(name);
      return value === null ? null : redact(value).slice(0, limit);
    };
    const upstream = upstreamError(body);
    const code =
      upstream?.code ??
      (response.status === 401 || response.status === 403
        ? 'MAR_AGENT_MODEL_AUTH_FAILED'
        : response.status === 429
          ? 'MAR_AGENT_MODEL_RATE_LIMITED'
          : response.status === 408 || response.status === 504
            ? 'MAR_AGENT_MODEL_TIMEOUT'
            : 'MAR_AGENT_MODEL_PROTOCOL_ERROR');
    throw new MarAgentError(
      code,
      upstream?.message ?? `Model endpoint returned HTTP ${response.status}.`,
      {
        details: {
          status: response.status,
          body: body.slice(0, 4096),
          bodyTruncated: body.length > 4096,
          contentType: header('content-type', 256),
          requestId: header('x-request-id', 256) ?? header('request-id', 256),
          retryAfter: header('retry-after', 128)
        },
        retryable: isRetryableModelHttpStatus(response.status)
      }
    );
  }
  if (response.body === null)
    throw new MarAgentError('MAR_AGENT_MODEL_PROTOCOL_ERROR', 'Model response has no body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let total = 0;
  let streamCompleted = false;
  const receiverAbort = new AbortController();
  const receiverSignal = AbortSignal.any([signal, receiverAbort.signal]);
  const chunks: ({ value: Uint8Array; observedAt: number } | undefined)[] = [];
  let nextChunk = 0;
  let receivedAll = false;
  let receiverFailure: { error: unknown } | undefined;
  let wake: (() => void) | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  // Keep transport receipt independent of async SDK publication and persistence.
  // The cumulative response byte limit also bounds the pending raw chunk queue.
  const receive = (async () => {
    try {
      while (true) {
        const { value, done } = await readStreamChunk(reader, receiverSignal, idleTimeoutMs);
        const observedAt = performance.now();
        if (done) {
          streamCompleted = true;
          break;
        }
        total += value.byteLength;
        enforceResponseSize(total, maxBytes);
        if (value.byteLength === 0) continue;
        chunks.push({ value, observedAt });
        notify();
      }
    } catch (error) {
      receiverFailure = { error };
      await reader.cancel(error).catch(() => undefined);
    } finally {
      receivedAll = true;
      notify();
    }
  })();
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = chunks[nextChunk];
      if (chunk === undefined) {
        if (receivedAll) {
          if (receiverFailure !== undefined) throw receiverFailure.error;
          break;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      chunks[nextChunk++] = undefined;
      if (nextChunk >= 1_024 && nextChunk * 2 >= chunks.length) {
        chunks.splice(0, nextChunk);
        nextChunk = 0;
      }
      const { value, observedAt } = chunk;
      buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data.length === 0 || data === '[DONE]') continue;
        try {
          yield observeModelStreamEvent(JSON.parse(data), observedAt);
        } catch (cause) {
          throw new MarAgentError(
            'MAR_AGENT_MODEL_PROTOCOL_ERROR',
            'Model SSE contained invalid JSON.',
            { cause }
          );
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0)
      throw new MarAgentError(
        'MAR_AGENT_MODEL_PROTOCOL_ERROR',
        'Model SSE ended with an incomplete frame.'
      );
  } finally {
    receiverAbort.abort();
    await receive;
    await closeReader(reader, streamCompleted);
  }
}

async function readResponseText(
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
  idleTimeoutMs: number
): Promise<string> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  let total = 0;
  let streamCompleted = false;
  try {
    while (true) {
      const { value, done } = await readStreamChunk(reader, signal, idleTimeoutMs);
      if (done) {
        streamCompleted = true;
        break;
      }
      total += value.byteLength;
      enforceResponseSize(total, maxBytes);
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    await closeReader(reader, streamCompleted);
  }
}

function enforceResponseSize(total: number, maxBytes: number): void {
  if (total > maxBytes)
    throw new MarAgentError(
      'MAR_AGENT_MODEL_PROTOCOL_ERROR',
      'Model response exceeded the size limit.'
    );
}

async function closeReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  streamCompleted: boolean
): Promise<void> {
  if (!streamCompleted) await reader.cancel().catch(() => undefined);
  try {
    reader.releaseLock();
  } catch {
    // Preserve the original read failure if cancellation could not settle the reader.
  }
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  idleTimeoutMs: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    void reader.cancel(signal.reason).catch(() => undefined);
    throw signal.reason;
  }
  const timeoutError = new MarAgentError(
    'MAR_AGENT_MODEL_TIMEOUT',
    'Model stream was idle for too long.',
    {
      details: { reason: 'MODEL_STREAM_IDLE_TIMEOUT' },
      retryable: true
    }
  );
  return await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abortFromCaller);
    };
    const resolveOnce = (result: ReadableStreamReadResult<Uint8Array>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const rejectOnce = (reason: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(reason);
    };
    const interrupt = (reason: unknown) => {
      void reader.cancel(reason).catch(() => undefined);
      rejectOnce(reason);
    };
    const abortFromCaller = () => interrupt(signal.reason);
    signal.addEventListener('abort', abortFromCaller, { once: true });
    const timeout = setTimeout(() => interrupt(timeoutError), Math.max(1, idleTimeoutMs));
    reader.read().then(resolveOnce, (error) => {
      rejectOnce(signal.aborted ? (signal.reason ?? error) : error);
    });
  });
}

function responseRedactor(sensitiveValues: readonly string[]): (value: string) => string {
  const secrets = [
    ...new Set(
      sensitiveValues.flatMap((value) =>
        value ? [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)] : []
      )
    )
  ].sort((left, right) => right.length - left.length);
  return (value) => secrets.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), value);
}

function upstreamError(body: string): { code?: string; message: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const root = record(parsed);
  if (typeof root.error === 'string') {
    const message = bounded(root.error, 1_000);
    return message === undefined ? undefined : { message };
  }
  const error = record(root.error);
  // K3-compatible gateways can put the error discriminator in `type` and omit `code`.
  const code = bounded(text(error.code) ?? text(error.type), 80);
  const message = bounded(text(error.message), 1_000);
  return message === undefined ? undefined : { ...(code === undefined ? {} : { code }), message };
}

const RETRYABLE_UPSTREAM_OVERLOAD_CODES = new Set([
  'rate_limit_error',
  'overloaded_error',
  'api_overloaded',
  'server_is_overloaded',
  'system_cpu_overloaded',
  'resource_exhausted',
  'temporarily_unavailable',
  'service_unavailable'
]);

// Closed set of transient upstream capacity/overload error codes; never grows into a
// vendor-specific or free-text error classification table.
export function isRetryableUpstreamOverloadCode(code: string | undefined): boolean {
  return code !== undefined && RETRYABLE_UPSTREAM_OVERLOAD_CODES.has(code.toLowerCase());
}

function bounded(value: string | undefined, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  return [...normalized].slice(0, maximum).join('');
}

export function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
export function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
