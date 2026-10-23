import type { Ref } from 'vue';
import { apiErrorFromResponse } from '../util/api-error.js';

/** An obsolete identity result, not a user cancellation or a request timeout. */
export class AuthenticationContextChangedError extends DOMException {
  constructor() {
    super('The authentication context changed.', 'AbortError');
  }
}

export interface WorkbenchHttpService {
  request<T>(path: string, init?: RequestInit): Promise<T>;
  renewCsrfToken(): Promise<string>;
  invalidateAuthentication(): void;
}

interface WorkbenchHttpServiceOptions {
  readonly csrfToken: Ref<string>;
  readonly csrfStorageKey: string;
  readonly onUnauthenticated: () => void;
}

export function createWorkbenchHttpService(
  options: WorkbenchHttpServiceOptions
): WorkbenchHttpService {
  let csrfTokenRenewal: Promise<string> | undefined;
  let authenticationGeneration = 0;

  function invalidateAuthentication(): void {
    authenticationGeneration += 1;
    csrfTokenRenewal = undefined;
  }

  function assertCurrent(generation: number): void {
    if (generation !== authenticationGeneration) throw new AuthenticationContextChangedError();
  }

  async function request<T>(
    path: string,
    init: RequestInit = {},
    retriedAfterCsrfRenewal = false,
    generation = authenticationGeneration
  ): Promise<T> {
    const response = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers: {
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.method === undefined || init.method === 'GET'
          ? {}
          : { 'x-csrf-token': options.csrfToken.value }),
        ...init.headers
      }
    });
    assertCurrent(generation);
    if (!response.ok) {
      const error = apiErrorFromResponse(await response.json().catch(() => ({})), response.status);
      assertCurrent(generation);
      if (error.code === 'UNAUTHENTICATED') options.onUnauthenticated();
      if (error.code === 'CSRF_INVALID' && !retriedAfterCsrfRenewal && path !== '/api/auth/csrf') {
        await renewCsrfToken();
        assertCurrent(generation);
        return request<T>(path, init, true, generation);
      }
      throw error;
    }
    if (response.status === 204) return undefined as T;
    const result = (await response.json()) as T;
    assertCurrent(generation);
    return result;
  }

  async function renewCsrfToken(): Promise<string> {
    if (csrfTokenRenewal !== undefined) return csrfTokenRenewal;
    csrfTokenRenewal = renewCsrfTokenOnce(authenticationGeneration);
    const renewal = csrfTokenRenewal;
    try {
      return await renewal;
    } finally {
      if (csrfTokenRenewal === renewal) csrfTokenRenewal = undefined;
    }
  }

  async function renewCsrfTokenOnce(generation: number): Promise<string> {
    const response = await fetch('/api/auth/csrf', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    assertCurrent(generation);
    if (!response.ok) {
      const error = apiErrorFromResponse(await response.json().catch(() => ({})), response.status);
      assertCurrent(generation);
      if (error.code === 'UNAUTHENTICATED') options.onUnauthenticated();
      throw error;
    }
    const result = (await response.json()) as { csrfToken?: unknown };
    assertCurrent(generation);
    if (typeof result.csrfToken !== 'string' || result.csrfToken.length === 0)
      throw new Error('CSRF_TOKEN_INVALID');
    options.csrfToken.value = result.csrfToken;
    window.sessionStorage.setItem(options.csrfStorageKey, result.csrfToken);
    return result.csrfToken;
  }

  return { request, renewCsrfToken, invalidateAuthentication };
}
