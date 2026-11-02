import { describe, expect, it, vi } from 'vitest';
import { readWebSearchError } from '../../src/service/web-search-error.js';
import { WebToolService } from '../../src/service/web-tool-service.js';
import type { NodeConfig } from '../../src/config.js';
import { countModelTokens } from '@myagentroam/agent';

describe('Node web tool relay', () => {
  it.each(['closed', 'cancelled'] as const)(
    'does not read identity or send a search request once %s',
    async (state) => {
      const config = vi.fn(
        () =>
          ({ serverUrl: 'https://server.test', nodeId: 'n', credential: 'fixture' }) as NodeConfig
      );
      const request = vi.fn(
        async () => new Response(JSON.stringify({ query: 'query', results: [] }))
      );
      const tools = new WebToolService(config, request);
      const controller = new AbortController();
      try {
        if (state === 'closed') await tools.close();
        else controller.abort();
        const result = tools.webSearch({ query: 'query', maxResults: 1 }, controller.signal);
        if (state === 'closed')
          await expect(result).rejects.toMatchObject({ code: 'MAR_AGENT_WEB_SEARCH_FAILED' });
        else await expect(result).rejects.toBe(controller.signal.reason);
        expect(config).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
      } finally {
        await tools.close();
      }
    }
  );

  it('budgets snippets first and keeps every selected source and its complete URL', async () => {
    const results = Array.from({ length: 8 }, (_, index) => ({
      title: `Source ${index}`,
      url: `https://example.test/${index}`,
      snippet: '搜索摘要'.repeat(1000)
    }));
    const request = vi.fn(async () => new Response(JSON.stringify({ query: 'query', results })));
    const tools = new WebToolService(
      () =>
        ({ serverUrl: 'https://server.test', nodeId: 'n', credential: 'fixture' }) as NodeConfig,
      request
    );
    try {
      const result = await tools.webSearch(
        { query: 'query', maxResults: 8, maxTokens: 512 },
        new AbortController().signal
      );
      expect(countModelTokens(result.content)).toBeLessThanOrEqual(512);
      expect(result.truncated).toBe(true);
      const data = result.data as { results: typeof results };
      expect(data.results).toHaveLength(8);
      for (let index = 0; index < results.length; index++) {
        expect(result.content).toContain(results[index]!.url);
        expect(data.results[index]!.url).toBe(results[index]!.url);
        expect(data.results[index]!.snippet.length).toBeLessThan(results[index]!.snippet.length);
      }
    } finally {
      await tools.close();
    }
  });
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
