import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkbenchHttpService } from '../../src/service/workbench-http-service';
import { createScopedHttpService } from '../../src/service/scoped-http-service';
import { apiErrorFromResponse, errorCode } from '../../src/util/api-error';

describe('Web Workbench Request Service', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renews CSRF once after expiration and retries the write with the new token', async () => {
    const csrfToken = { value: 'expired' };
    const storage = new Map<string, string>();
    vi.stubGlobal('window', {
      sessionStorage: { setItem: (key: string, value: string) => storage.set(key, value) }
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 'CSRF_INVALID' } }), { status: 403 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ csrfToken: 'renewed' }), { status: 200 })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const service = createWorkbenchHttpService({
      csrfToken: csrfToken as never,
      csrfStorageKey: 'csrf-key',
      onUnauthenticated: vi.fn()
    });

    await expect(
      service.request<{ ok: boolean }>('/api/action', { method: 'POST', body: '{}' })
    ).resolves.toEqual({ ok: true });
    expect(csrfToken.value).toBe('renewed');
    expect(storage.get('csrf-key')).toBe('renewed');
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toMatchObject({
      'x-csrf-token': 'renewed'
    });
  });

  it('Notifies authentication on an unauthenticated response and preserves the error code', async () => {
    const onUnauthenticated = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: 'UNAUTHENTICATED' }), { status: 401 })
        )
    );
    const service = createWorkbenchHttpService({
      csrfToken: { value: 'token' } as never,
      csrfStorageKey: 'csrf-key',
      onUnauthenticated
    });

    await expect(service.request('/api/nodes')).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === 'UNAUTHENTICATED'
    );
    expect(onUnauthenticated).toHaveBeenCalledOnce();
  });
});

describe('Web API Error Contract', () => {
  it('does not infer structured upstream codes from unstructured lowercase text', () => {
    expect(apiErrorFromResponse({ error: 'unavailable' }, 502).code).toBe('REQUEST_FAILED_502');
    expect(apiErrorFromResponse({ error: 'NODE_OFFLINE' }, 502).code).toBe('NODE_OFFLINE');
  });

  it('preserves upstream capacity errors without falling back to a generic HTTP error', () => {
    const error = apiErrorFromResponse(
      {
        error: {
          code: 'service_unavailable_error',
          message: 'The model service is too busy.',
          details: 'Provider request ID: provider-request-1',
          requestId: 'server-request-1',
          upstreamRequestId: 'node-request-1'
        }
      },
      502
    );
    expect(error).toMatchObject({
      code: 'service_unavailable_error',
      message: 'The model service is too busy.',
      details: 'Provider request ID: provider-request-1',
      requestId: 'server-request-1',
      upstreamRequestId: 'node-request-1'
    });
    expect(errorCode(error)).toBe('service_unavailable_error');
  });

  it('Preserves structured error codes, English fallbacks, and safe parameters', () => {
    const error = apiErrorFromResponse(
      {
        error: {
          code: 'QUOTA_EXCEEDED',
          message: 'The quota has been exceeded.',
          details: 'The workspace currently contains 6 active uploads.',
          parameters: { limit: 5, scope: 'workspace', ignored: true },
          requestId: 'server-request-1',
          upstreamRequestId: 'node-request-1'
        }
      },
      409
    );

    expect(error).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      message: 'The quota has been exceeded.',
      details: 'The workspace currently contains 6 active uploads.',
      parameters: { limit: 5, scope: 'workspace' },
      requestId: 'server-request-1',
      upstreamRequestId: 'node-request-1'
    });
  });
});

describe('Web Domain Request Service', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Does not add CSRF to read requests and retries a failed write once with the renewed token', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 'CSRF_INVALID' } }), { status: 403 })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ saved: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const renewCsrfToken = vi.fn().mockResolvedValue('renewed');
    const service = createScopedHttpService({
      csrfToken: () => 'expired',
      renewCsrfToken
    });

    await expect(service.request('/api/files')).resolves.toEqual({ ok: true });
    await expect(service.request('/api/files', { method: 'POST', body: '{}' })).resolves.toEqual({
      saved: true
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty('x-csrf-token');
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toMatchObject({
      'x-csrf-token': 'renewed'
    });
    expect(renewCsrfToken).toHaveBeenCalledOnce();
  });
});
