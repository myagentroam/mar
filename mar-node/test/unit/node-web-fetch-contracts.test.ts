import { describe, expect, it } from 'vitest';
import {
  webFetchRequestSchema,
  browserFetchResultSchema,
  WEB_FETCH_MAX_BYTES
} from '../../src/service/web-fetch-contracts.js';

describe('Node web fetch contracts', () => {
  it('accepts open and find and rejects unsafe or ambiguous requests', () => {
    for (const input of [
      { action: 'open', url: 'http://127.0.0.1:1234/page' },
      { action: 'open', ref: 'ref', cursor: '0:1' },
      { action: 'find', ref: 'ref', pattern: 'text' }
    ])
      expect(webFetchRequestSchema.safeParse(input).success).toBe(true);
    for (const input of [
      { url: 'https://example.test/', mode: 'browser' },
      { action: 'open', url: 'file:///tmp/private' },
      { action: 'open', url: 'https://user:secret@example.test/' },
      { action: 'open', ref: 'ref', line: 1, cursor: '0:1' },
      { action: 'find', ref: 'ref', pattern: '' },
      { action: 'open', url: 'https://example.test/', maxTokens: 4001 }
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
    expect(browserFetchResultSchema.safeParse(result).success).toBe(true);
    expect(
      browserFetchResultSchema.safeParse({
        ...result,
        content: '汉'.repeat(Math.ceil(WEB_FETCH_MAX_BYTES / 3))
      }).success
    ).toBe(false);
    expect(
      browserFetchResultSchema.safeParse({
        ...result,
        data: { ...result.data, cookies: 'private' }
      }).success
    ).toBe(false);
  });
});
