import { isRetryableTransportError, TransportFault } from '../network/transport-error.js';
export { isRetryableTransportError as isRetryableModelTransportError } from '../network/transport-error.js';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentError } from '../error.js';
import {
  connectSocks5Target as connectTransportSocks5Target,
  fetchWithConnectionTimeout,
  hasErrorCode,
  isModelHttpAttempt,
  type HttpRequestInit
} from '../network/http.js';
import type { ModelRetryState } from './contracts.js';

export const MAX_MODEL_ATTEMPTS = 8;

export function modelRetryMaxAttempts(state: ModelRetryState): number {
  const maximum = state.maxAttempts ?? MAX_MODEL_ATTEMPTS;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > MAX_MODEL_ATTEMPTS)
    throw new AgentError(
      'MAR_AGENT_MODEL_CONFIG_INVALID',
      `Model attempts must be between 1 and ${MAX_MODEL_ATTEMPTS}.`
    );
  return maximum;
}

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);
const DEFAULT_MODEL_CONNECTION_TIMEOUT_MS = 30_000;
export type { HttpAttempt, HttpRequestInit } from '../network/http.js';

export async function connectSocks5Target(
  input: Parameters<typeof connectTransportSocks5Target>[0]
): ReturnType<typeof connectTransportSocks5Target> {
  try {
    return await connectTransportSocks5Target(input);
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason;
    if (error instanceof TransportFault && error.kind === 'invalid-proxy')
      throw projectTransportFault(error);
    throw error;
  }
}

function projectTransportFault(error: TransportFault): AgentError {
  if (error.kind === 'connection-timeout')
    return new AgentError('MAR_AGENT_MODEL_TIMEOUT', 'Model connection timed out.', {
      details: { reason: 'MODEL_CONNECTION_TIMEOUT' },
      retryable: true
    });
  if (error.kind === 'http2-negotiation')
    return new AgentError(
      'MAR_AGENT_MODEL_CONNECTION_FAILED',
      'Model endpoint did not negotiate HTTP/2.',
      { cause: error.cause }
    );
  return new AgentError(
    'MAR_AGENT_MODEL_CONFIG_INVALID',
    'SOCKS5 proxy URL is invalid.',
    error.cause === undefined ? undefined : { cause: error.cause }
  );
}

function modelTransportFailure(error: unknown, attempts: number): AgentError {
  return new AgentError(
    hasErrorCode(error, 'ETIMEDOUT') ||
      hasErrorCode(error, 'UND_ERR_CONNECT_TIMEOUT') ||
      hasErrorCode(error, 'UND_ERR_HEADERS_TIMEOUT')
      ? 'MAR_AGENT_MODEL_TIMEOUT'
      : 'MAR_AGENT_MODEL_CONNECTION_FAILED',
    attempts === 1
      ? 'Model transport request failed.'
      : 'Model transport request failed after retries.',
    { retryable: true, details: { reason: 'MODEL_TRANSPORT_FAILURE' }, cause: error }
  );
}

export async function fetchModelResponse(
  url: string,
  init: HttpRequestInit,
  signal: AbortSignal,
  attempts = MAX_MODEL_ATTEMPTS,
  connectionTimeoutMs = DEFAULT_MODEL_CONNECTION_TIMEOUT_MS
): Promise<Response> {
  let response: Response | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const resolved = typeof init === 'function' ? await init() : init;
      const attempt = isModelHttpAttempt(resolved)
        ? resolved
        : { request: resolved, httpVersion: '1.1' as const };
      response = await fetchWithConnectionTimeout(url, attempt, signal, connectionTimeoutMs);
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (
        error instanceof Error &&
        error.cause instanceof TransportFault &&
        error.cause.kind === 'invalid-proxy'
      ) {
        error.cause = projectTransportFault(error.cause);
        throw error;
      }
      if (error instanceof TransportFault && error.kind !== 'connection-timeout')
        throw projectTransportFault(error);
      if (
        (error instanceof TransportFault && error.kind === 'connection-timeout') ||
        (error instanceof AgentError &&
          error.code === 'MAR_AGENT_MODEL_TIMEOUT' &&
          error.details?.reason === 'MODEL_CONNECTION_TIMEOUT')
      ) {
        if (attempt + 1 >= attempts)
          throw error instanceof TransportFault ? projectTransportFault(error) : error;
        await waitForModelRetry(null, attempt, signal);
        continue;
      }
      if (!isRetryableTransportError(error)) throw error;
      if (attempt + 1 >= attempts) throw modelTransportFailure(error, attempts);
      await waitForModelRetry(null, attempt, signal);
      continue;
    }
    if (!RETRYABLE_STATUS.has(response.status) || attempt + 1 >= attempts) return response;
    const retryAfter = response.headers.get('retry-after');
    await response.body?.cancel().catch(() => undefined);
    await waitForModelRetry(retryAfter, attempt, signal);
  }
  return response!;
}

export function modelRetryDelay(retryAfter: string | null, attempt: number): number {
  return retryAfterDelay(retryAfter) ?? (attempt + 1) * 5_000 + Math.floor(Math.random() * 3_001);
}

export async function waitForModelRetry(
  retryAfter: string | null,
  attempt: number,
  signal: AbortSignal,
  delayMs = modelRetryDelay(retryAfter, attempt)
): Promise<void> {
  await delay(delayMs, undefined, { signal });
}

export function isRetryableModelHttpStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

export function isRetryableModelRequestError(error: unknown): error is AgentError {
  return (
    error instanceof AgentError &&
    error.retryable &&
    (error.details?.reason === 'MODEL_PROGRESS_TIMEOUT' ||
      error.details?.reason === 'MODEL_CONNECTION_TIMEOUT' ||
      error.details?.reason === 'MODEL_TRANSPORT_FAILURE' ||
      (typeof error.details?.status === 'number' &&
        isRetryableModelHttpStatus(error.details.status)))
  );
}

function retryAfterDelay(value: string | null): number | undefined {
  if (value !== null) {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.min(30_000, Math.max(0, seconds * 1000));
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.min(30_000, Math.max(0, date - Date.now()));
  }
  return undefined;
}
