import { fetchModelResponse, type ModelRequestInit } from '../model/http.js';

/** A single non-replayed request using the Host's selected HTTP version and proxy. */
export function requestHttp(
  url: string,
  init: ModelRequestInit,
  signal: AbortSignal,
  responseTimeoutMs: number
): Promise<Response> {
  return fetchModelResponse(url, init, signal, 1, responseTimeoutMs);
}

export {
  acquireModelCredential as acquireCredential,
  appendModelCredentialHeaders as appendCredentialHeaders
} from '../model/runtime-credential.js';
