import { readonly, ref, type InjectionKey, type Ref } from 'vue';
import { ApiError, apiErrorFromResponse } from '../util/api-error.js';

/** An obsolete identity result, not a user cancellation or a request timeout. */
export class AuthenticationContextChangedError extends DOMException {
  constructor() {
    super('The authentication context changed.', 'AbortError');
  }
}

export interface WorkbenchHttpService {
  readonly networkUnavailable: Readonly<Ref<boolean>>;
  request<T>(path: string, init?: RequestInit): Promise<T>;
  renewCsrfToken(): Promise<string>;
  invalidateAuthentication(): void;
}

/** Local tools share the application's HTTP owner, not a second reachability state. */
export const WORKBENCH_HTTP_KEY: InjectionKey<
  Pick<WorkbenchHttpService, 'request' | 'networkUnavailable'>
> = Symbol('workbench-http');

interface WorkbenchHttpServiceOptions {
  readonly csrfToken: Ref<string>;
  readonly csrfStorageKey: string;
  readonly onUnauthenticated: () => void;
}

/** Owns authenticated HTTP and observed Server reachability, never Node connection facts. */
export function createWorkbenchHttpService(
  options: WorkbenchHttpServiceOptions
): WorkbenchHttpService {
  let csrfTokenRenewal: Promise<string> | undefined;
  let authenticationGeneration = 0;
  const networkUnavailable = ref(false);
  let networkRequest = 0;
  let networkObservation = 0;

  function invalidateAuthentication(): void {
    authenticationGeneration += 1;
    csrfTokenRenewal = undefined;
    networkUnavailable.value = false;
  }

  function assertCurrent(generation: number): void {
    if (generation !== authenticationGeneration) throw new AuthenticationContextChangedError();
  }

  function observeNetwork(requestId: number, unavailable: boolean): void {
    if (requestId < networkObservation) return;
    networkObservation = requestId;
    networkUnavailable.value = unavailable;
  }

  // HTTP errors prove reachability; only a rejected fetch denotes a transport failure.
  async function fetchResponse(
    path: string,
    init: RequestInit,
    generation: number
  ): Promise<Response> {
    const requestId = ++networkRequest;
    try {
      const response = await fetch(path, init);
      assertCurrent(generation);
      observeNetwork(requestId, false);
      return response;
    } catch (error) {
      assertCurrent(generation);
      if (error instanceof TypeError && !init.signal?.aborted) {
        observeNetwork(requestId, true);
        throw new ApiError('NETWORK_UNAVAILABLE', 'The network connection is unavailable.');
      }
      throw error;
    }
  }

  async function request<T>(
    path: string,
    init: RequestInit = {},
    retriedAfterCsrfRenewal = false,
    generation = authenticationGeneration
  ): Promise<T> {
    const response = await fetchResponse(
      path,
      {
        credentials: 'same-origin',
        ...init,
        headers: {
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(init.method === undefined || init.method === 'GET'
            ? {}
            : { 'x-csrf-token': options.csrfToken.value }),
          ...init.headers
        }
      },
      generation
    );
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
    const response = await fetchResponse(
      '/api/auth/csrf',
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      },
      generation
    );
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

  return {
    request,
    renewCsrfToken,
    invalidateAuthentication,
    networkUnavailable: readonly(networkUnavailable)
  };
}
