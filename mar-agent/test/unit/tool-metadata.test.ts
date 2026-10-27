import { describe, expect, it } from 'vitest';
import { structuredToolEventData } from '../../src/tools/output-projection.js';
import { publicHostedToolEvents } from '../../src/runtime/event-projection.js';
import { TOOL_EXECUTION_LIMITS } from '../../src/tools/execution-limits.js';

describe('public tool metadata', () => {
  it('projects required image dimensions and only validated transform facts', () => {
    const result = structuredToolEventData('view_image', {
      path: 'capture.png',
      mimeType: 'image/png',
      bytes: 120,
      width: 2,
      height: 1,
      sourceWidth: 4,
      sourceHeight: 2,
      region: { x: 2, y: 0, width: 2, height: 2 },
      sha256: 'a'.repeat(64),
      dataBase64: 'must not be projected'
    });
    expect(result).toEqual({
      path: 'capture.png',
      mimeType: 'image/png',
      bytes: 120,
      width: 2,
      height: 1,
      sourceWidth: 4,
      sourceHeight: 2,
      region: { x: 2, y: 0, width: 2, height: 2 },
      sha256: 'a'.repeat(64)
    });
    expect(
      structuredToolEventData('view_image', {
        path: 'capture.png',
        mimeType: 'image/png',
        bytes: 120,
        width: 2,
        height: 1,
        sourceWidth: 4,
        sha256: 'a'.repeat(64)
      })
    ).toBeUndefined();
    expect(
      structuredToolEventData('view_image', {
        path: 'capture.png',
        mimeType: 'image/png',
        bytes: 120,
        width: 10,
        height: 10,
        sourceWidth: 10,
        sourceHeight: 10,
        region: { x: 0, y: 0, width: 2, height: 2 }
      })
    ).toBeUndefined();
    expect(
      structuredToolEventData('view_image', {
        path: 'capture.png',
        mimeType: 'image/png',
        bytes: TOOL_EXECUTION_LIMITS.viewImageMaxBytes + 1,
        width: 2,
        height: 1,
        sha256: 'a'.repeat(64)
      })
    ).toBeUndefined();
  });

  it('keeps search sources structured, bounded, and separate from unrelated output', () => {
    const data = structuredToolEventData('web_search', {
      query: '原始 query',
      results: Array.from({ length: 25 }, (_, i) => ({
        url: `https://example.com/${i}`,
        title: 'Original title',
        snippet: 'Summary',
        internal: 'private'
      })),
      internal: 'private'
    });
    expect(data).toMatchObject({ query: '原始 query', sourceCount: 25 });
    expect(data).not.toHaveProperty('kind');
    expect(JSON.stringify(data)).not.toContain('private');
    expect((data as { sources: unknown[] }).sources).toHaveLength(20);
  });
  it('distinguishes absent search results from an explicitly empty result', () => {
    expect(structuredToolEventData('web_search', {})).toEqual({});
    expect(structuredToolEventData('web_search', { results: [] })).toEqual({
      sources: [],
      sourceCount: 0
    });
    expect(structuredToolEventData('web_search', { sources: [], sourcesTruncated: true })).toEqual({
      sources: []
    });
  });
  it('projects fetch and skill metadata without the page body or skill instructions', () => {
    expect(
      structuredToolEventData('web_fetch', {
        url: 'https://final.example/',
        title: '原文',
        mode: 'http',
        status: 200,
        contentType: 'text/html',
        content: 'body'
      })
    ).toEqual({
      url: 'https://final.example/',
      title: '原文',
      mode: 'http',
      status: 200,
      contentType: 'text/html'
    });
    expect(
      structuredToolEventData('skill', {
        name: 'skill-name',
        description: 'Description',
        source: 'Host-provided',
        instructions: 'body'
      })
    ).toEqual({
      name: 'skill-name',
      description: 'Description',
      source: 'Host-provided'
    });
    expect(
      structuredToolEventData('unrelated', { kind: 'WEB_SEARCH', results: [] })
    ).toBeUndefined();
  });
  it.each(['WEB_SEARCH', 'WEB_FETCH'] as const)(
    'preserves hosted %s facts without changing the native tool name',
    (kind) => {
      const events = publicHostedToolEvents({
        type: 'hosted_tool',
        itemId: 'hosted-call',
        toolName: 'web_search',
        kind,
        status: 'COMPLETED',
        summary: {
          query: 'query',
          url: 'https://example.com/',
          title: 'Page title',
          sources: [{ url: 'https://example.com/', title: 'Source' }]
        }
      });
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        type: 'tool.started',
        toolName: 'web_search',
        data: { hostedToolKind: kind }
      });
      expect(events[1]).toMatchObject({
        type: 'tool.completed',
        toolName: 'web_search',
        data: { hostedToolKind: kind }
      });
    }
  );
});
