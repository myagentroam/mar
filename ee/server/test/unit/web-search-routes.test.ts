import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerWebSearchRoutes } from '../../src/route/web-search-routes.js';

describe('Server web search proxy', () => {
  it('authenticates Nodes and normalizes SearXNG results', async () => {
    const app = Fastify();
    registerWebSearchRoutes({
      app,
      database: {
        authenticateNode: async (id: string, credential: string) =>
          id === 'node-1' && credential === 'secret' ? ({ id } as never) : undefined
      } as never,
      endpoint: 'http://searxng:8080',
      request: async (url) => {
        expect(String(url)).toContain('/search?q=MAR+Agent&format=json');
        return new Response(
          JSON.stringify({
            results: [{ title: 'MAR', url: 'https://example.test/page', content: 'summary' }]
          }),
          { status: 200 }
        );
      }
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/node-tools/web-search',
          payload: { query: 'MAR Agent' }
        })
      ).statusCode
    ).toBe(401);
    const response = await app.inject({
      method: 'POST',
      url: '/api/node-tools/web-search',
      headers: { 'x-mar-node-id': 'node-1', authorization: 'Bearer secret' },
      payload: { query: 'MAR Agent', maxResults: 1 }
    });
    expect(response.json()).toEqual({
      query: 'MAR Agent',
      results: [{ title: 'MAR', url: 'https://example.test/page', snippet: 'summary' }]
    });
    await app.close();
  });

  it('rejects a missing request body without calling SearXNG', async () => {
    const app = Fastify();
    let requested = false;
    registerWebSearchRoutes({
      app,
      database: { authenticateNode: async () => ({ id: 'node-1' }) } as never,
      endpoint: 'http://searxng:8080',
      request: async () => {
        requested = true;
        return new Response('{}');
      }
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/node-tools/web-search',
      headers: { 'x-mar-node-id': 'node-1', authorization: 'Bearer secret' }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'WEB_SEARCH_INVALID' } });
    expect(requested).toBe(false);
    await app.close();
  });

  it('preserves upstream status when SearXNG returns a failure', async () => {
    const app = Fastify();
    registerWebSearchRoutes({
      app,
      database: { authenticateNode: async () => ({ id: 'node-1' }) } as never,
      endpoint: 'http://searxng:8080',
      request: async () => new Response('unavailable', { status: 503 })
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/node-tools/web-search',
      headers: { 'x-mar-node-id': 'node-1', authorization: 'Bearer secret' },
      payload: { query: 'MAR Agent' }
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: { code: 'WEB_SEARCH_UPSTREAM_FAILED', parameters: { upstreamStatus: 503 } }
    });
    await app.close();
  });

  it('preserves bounded upstream network failure details', async () => {
    const app = Fastify();
    registerWebSearchRoutes({
      app,
      database: { authenticateNode: async () => ({ id: 'node-1' }) } as never,
      endpoint: 'http://searxng:8080',
      request: async () =>
        Promise.reject(
          Object.assign(new Error('fetch failed'), {
            cause: new Error('getaddrinfo ENOTFOUND searxng')
          })
        )
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/node-tools/web-search',
      headers: { 'x-mar-node-id': 'node-1', authorization: 'Bearer secret' },
      payload: { query: 'MAR Agent' }
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: {
        code: 'WEB_SEARCH_UPSTREAM_FAILED',
        details: 'fetch failed Caused by: getaddrinfo ENOTFOUND searxng'
      }
    });
    await app.close();
  });
});
