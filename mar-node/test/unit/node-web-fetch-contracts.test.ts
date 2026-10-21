import { describe, expect, it } from 'vitest';
import {
  webFetchRequestSchema,
  webFetchResultSchema,
  WEB_FETCH_MAX_BYTES
} from '../../src/service/web-fetch-contracts.js';

describe('Node web fetch contracts', () => {
  it('requires an explicit HTTP or browser mode and permits intranet HTTP URLs', () => {
    for (const mode of ['http', 'browser'])
      expect(
        webFetchRequestSchema.safeParse({ url: 'http://127.0.0.1:1234/page', mode }).success
      ).toBe(true);
    for (const input of [
      { url: 'https://example.test/' },
      { url: 'https://example.test/', mode: 'auto' },
      { url: 'file:///tmp/private', mode: 'browser' },
      { url: 'https://user:secret@example.test/', mode: 'http' }
    ])
      expect(webFetchRequestSchema.safeParse(input).success).toBe(false);
  });

  it('enforces the UTF-8 byte budget and rejects secret-bearing or unknown response fields', () => {
    const result = {
      content: 'ok',
      data: {
        url: 'https://example.test/',
        mode: 'browser',
        status: 200,
        contentType: 'text/html',
        title: 'Title'
      },
      truncated: false
    };
    expect(webFetchResultSchema.safeParse(result).success).toBe(true);
    expect(
      webFetchResultSchema.safeParse({
        ...result,
        content: '汉'.repeat(Math.ceil(WEB_FETCH_MAX_BYTES / 3))
      }).success
    ).toBe(false);
    expect(
      webFetchResultSchema.safeParse({ ...result, data: { ...result.data, cookies: 'private' } })
        .success
    ).toBe(false);
  });
});
