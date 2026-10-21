import { apiErrorFromResponse } from '../util/api-error.js';

export interface ScopedHttpService {
  request<T>(path: string, init?: RequestInit): Promise<T>;
}

interface ScopedHttpServiceOptions {
  readonly csrfToken?: () => string;
  readonly renewCsrfToken?: () => Promise<string>;
}

export function createScopedHttpService(options: ScopedHttpServiceOptions = {}): ScopedHttpService {
  async function request<T>(
    path: string,
    init: RequestInit = {},
    retriedAfterCsrfRenewal = false,
    csrfTokenOverride?: string
  ): Promise<T> {
    const mutating = init.method !== undefined && init.method !== 'GET';
    const response = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers: {
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(mutating && options.csrfToken !== undefined
          ? { 'x-csrf-token': csrfTokenOverride ?? options.csrfToken() }
          : {}),
        ...init.headers
      }
    });
    if (response.ok) {
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    }
    const error = apiErrorFromResponse(await response.json().catch(() => ({})), response.status);
    if (
      error.code === 'CSRF_INVALID' &&
      !retriedAfterCsrfRenewal &&
      options.renewCsrfToken !== undefined
    )
      return request<T>(path, init, true, await options.renewCsrfToken());
    throw error;
  }

  return { request };
}
