import { describe, expect, it, vi } from 'vitest';
import { probeSearchEndpoint } from '../../mar-server/src/quick-start/search-probe.js';

describe('Quick Start search probe', () => {
  it('accepts a valid empty JSON result and sends the JSON query', async () => {
    const request = vi.fn(
      async (_url: URL, _init?: RequestInit) => new Response(JSON.stringify({ results: [] }))
    );
    expect(await probeSearchEndpoint('https://search.example', request as typeof fetch)).toBe(true);
    const url = request.mock.calls[0]?.[0] as unknown as URL;
    expect(url.pathname).toBe('/search');
    expect(url.searchParams.get('format')).toBe('json');
  });
  it('rejects forbidden, invalid JSON, malformed payloads and network errors', async () => {
    for (const response of [
      new Response('', { status: 403 }),
      new Response('not json'),
      new Response('{}')
    ]) {
      expect(
        await probeSearchEndpoint(
          'https://search.example',
          vi.fn(async () => response) as typeof fetch
        )
      ).toBe(false);
    }
    expect(
      await probeSearchEndpoint(
        'https://search.example',
        vi.fn(async () => {
          throw new Error('offline');
        }) as typeof fetch
      )
    ).toBe(false);
  });
});
