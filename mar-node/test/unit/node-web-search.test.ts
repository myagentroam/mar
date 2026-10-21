import { describe, expect, it, vi } from 'vitest';
import { readWebSearchError } from '../../src/service/web-search-error.js';
import { WebToolService } from '../../src/service/web-tool-service.js';
import type { NodeConfig } from '../../src/config.js';

describe('Node web tool relay', () => {
  it('searches through Server with the Node identity and preserves upstream errors', async () => {
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'WEB_SEARCH_UPSTREAM_FAILED',
              message: 'Search upstream failed.',
              requestId: 'server-request'
            }
          }),
          { status: 502 }
        )
    );
    const tools = new WebToolService(
      () =>
        ({
          serverUrl: 'https://server.test/',
          nodeId: 'fixture-node',
          credential: 'fixture-node-token'
        }) as NodeConfig,
      request
    );
    const signal = new AbortController().signal;
    try {
      await expect(
        tools.webSearch({ query: 'query', maxResults: 3 }, signal)
      ).rejects.toMatchObject({
        code: 'WEB_SEARCH_UPSTREAM_FAILED',
        details: expect.objectContaining({ requestId: 'server-request' })
      });
      expect(request).toHaveBeenCalledWith(
        'https://server.test/api/node-tools/web-search',
        expect.objectContaining({
          signal,
          headers: {
            'content-type': 'application/json',
            'x-mar-node-id': 'fixture-node',
            authorization: 'Bearer fixture-node-token'
          },
          body: JSON.stringify({ query: 'query', maxResults: 3 })
        })
      );
    } finally {
      await tools.close();
    }
  });
  it('keeps the Server error and correlation identifiers without nested fallback codes', async () => {
    const error = await readWebSearchError(
      new Response(
        JSON.stringify({
          error: {
            code: 'WEB_SEARCH_UPSTREAM_FAILED',
            message: 'Web search upstream failed.',
            details: 'fetch failed Caused by: getaddrinfo ENOTFOUND searxng',
            parameters: { upstreamStatus: 502 },
            requestId: 'server-request-1',
            upstreamRequestId: 'upstream-request-1'
          }
        }),
        { status: 502 }
      )
    );

    expect(error.code).toBe('WEB_SEARCH_UPSTREAM_FAILED');
    expect(error.message).toContain('getaddrinfo ENOTFOUND searxng');
    expect(error.message).toContain('requestId: server-request-1');
    expect(error.message).toContain('upstreamRequestId: upstream-request-1');
    expect(error.details).toMatchObject({
      requestId: 'server-request-1',
      upstreamRequestId: 'upstream-request-1',
      serverParameters: { upstreamStatus: 502 }
    });
  });

  it('falls back to the local error when Server returns an invalid error body', async () => {
    const error = await readWebSearchError(new Response('not-json', { status: 502 }));

    expect(error.code).toBe('MAR_AGENT_WEB_SEARCH_FAILED');
    expect(error.details).toEqual({ status: 502 });
  });

  it('appends correlation identifiers without a leading separator when details are absent', async () => {
    const error = await readWebSearchError(
      new Response(
        JSON.stringify({
          error: {
            code: 'WEB_SEARCH_UPSTREAM_FAILED',
            message: 'Web search upstream failed.',
            requestId: 'server-request-2'
          }
        }),
        { status: 502 }
      )
    );

    expect(error.message).toBe(
      'WEB_SEARCH_UPSTREAM_FAILED: Web search upstream failed. (requestId: server-request-2)'
    );
  });
});
