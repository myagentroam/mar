import {
  fetchWithConnectionTimeout,
  hasErrorCode,
  isModelHttpAttempt,
  type HttpRequestInit
} from '../network/http.js';
import { isRetryableTransportError, TransportFault } from '../network/transport-error.js';
import { AgentError } from '../error.js';

export type { HttpAttempt, HttpRequestInit } from '../network/http.js';

/** A single non-replayed request using the Host's selected HTTP version and proxy. */
export async function requestHttp(
  url: string,
  init: HttpRequestInit,
  signal: AbortSignal,
  responseTimeoutMs: number
): Promise<Response> {
  try {
    const resolved = typeof init === 'function' ? await init() : init;
    const attempt = isModelHttpAttempt(resolved)
      ? resolved
      : { request: resolved, httpVersion: '1.1' as const };
    return await fetchWithConnectionTimeout(url, attempt, signal, responseTimeoutMs);
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    if (
      error instanceof Error &&
      error.cause instanceof TransportFault &&
      error.cause.kind === 'invalid-proxy'
    ) {
      const fault = error.cause;
      error.cause = new AgentError(
        'MAR_AGENT_MODEL_CONFIG_INVALID',
        'SOCKS5 proxy URL is invalid.',
        fault.cause === undefined ? undefined : { cause: fault.cause }
      );
      throw error;
    }
    if (error instanceof TransportFault) {
      if (error.kind === 'connection-timeout')
        throw new AgentError('MAR_AGENT_MODEL_TIMEOUT', 'Model connection timed out.', {
          details: { reason: 'MODEL_CONNECTION_TIMEOUT' },
          retryable: true
        });
      if (error.kind === 'http2-negotiation')
        throw new AgentError(
          'MAR_AGENT_MODEL_CONNECTION_FAILED',
          'Model endpoint did not negotiate HTTP/2.',
          { cause: error.cause }
        );
      throw new AgentError(
        'MAR_AGENT_MODEL_CONFIG_INVALID',
        'SOCKS5 proxy URL is invalid.',
        error.cause === undefined ? undefined : { cause: error.cause }
      );
    }
    if (!isRetryableTransportError(error)) throw error;
    throw new AgentError(
      hasErrorCode(error, 'ETIMEDOUT') ||
        hasErrorCode(error, 'UND_ERR_CONNECT_TIMEOUT') ||
        hasErrorCode(error, 'UND_ERR_HEADERS_TIMEOUT')
        ? 'MAR_AGENT_MODEL_TIMEOUT'
        : 'MAR_AGENT_MODEL_CONNECTION_FAILED',
      'Model transport request failed.',
      { retryable: true, details: { reason: 'MODEL_TRANSPORT_FAILURE' }, cause: error }
    );
  }
}

export {
  acquireModelCredential as acquireCredential,
  appendModelCredentialHeaders as appendCredentialHeaders
} from '../network/credential-runtime.js';
