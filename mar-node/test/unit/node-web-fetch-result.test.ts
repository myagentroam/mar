import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebFetchError, WebFetchService } from '../../src/service/web-fetch-service.js';
import { WebToolService } from '../../src/service/web-tool-service.js';

const services: WebToolService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  vi.restoreAllMocks();
});

function read() {
  const service = new WebToolService(() => undefined);
  services.push(service);
  return service.webFetch(
    { action: 'open', url: 'https://example.test/', maxTokens: 512 },
    new AbortController().signal,
    'scope'
  );
}

describe('web fetch request outcomes', () => {
  it.each([
    ['MAR_AGENT_WEB_FETCH_UPSTREAM_FAILED', 502],
    ['MAR_AGENT_WEB_FETCH_TIMEOUT', 504],
    ['MAR_AGENT_WEB_FETCH_UNSUPPORTED_CONTENT', 415],
    ['MAR_AGENT_WEB_FETCH_EMPTY_CONTENT', 422]
  ] as const)(
    'returns %s as a request result rather than a rejected tool call',
    async (code, status) => {
      const error = new WebFetchError(code, status, 'The page could not be read.', {
        upstreamStatus: 401
      });
      error.cause = new Error('PRIVATE_UPSTREAM_DETAILS');
      vi.spyOn(WebFetchService.prototype, 'fetch').mockRejectedValue(error);
      const result = await read();
      expect(result.data).toEqual({
        error: code,
        message: 'The page could not be read.',
        details: { upstreamStatus: 401 }
      });
      expect(result.content).toBe(JSON.stringify(result.data));
      expect(result.eventData).toEqual(result.data);
      expect(JSON.stringify(result)).not.toContain('PRIVATE_UPSTREAM_DETAILS');
      expect(result.data).not.toHaveProperty('ref');
    }
  );

  it.each(['MAR_AGENT_WEB_FETCH_CANCELLED', 'MAR_AGENT_WEB_FETCH_BROWSER_UNAVAILABLE'])(
    'preserves %s as an execution error',
    async (code) => {
      vi.spyOn(WebFetchService.prototype, 'fetch').mockRejectedValue(
        new WebFetchError(code, 503, 'The execution cannot continue.')
      );
      await expect(read()).rejects.toMatchObject({ code });
    }
  );

  it('does not convert invalid backend results or unexpected bugs into request outcomes', async () => {
    const fetch = vi.spyOn(WebFetchService.prototype, 'fetch');
    fetch.mockResolvedValueOnce({} as never);
    await expect(read()).rejects.toMatchObject({ code: 'MAR_AGENT_WEB_FETCH_FAILED' });
    const error = new Error('Unexpected backend bug');
    fetch.mockRejectedValueOnce(error);
    await expect(read()).rejects.toBe(error);
  });
});
