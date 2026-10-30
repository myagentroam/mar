import { describe, expect, it } from 'vitest';
import {
  publicOutputTruncation,
  structuredToolEventData
} from '../../src/tools/output-projection.js';

it('distinguishes source truncation from local observation head clipping', () => {
  const value = (id: string, text: string, truncated = false) => ({
    type: 'value',
    id,
    format: 'text',
    value: text,
    truncated
  });
  const output = (observations: unknown[]) =>
    structuredToolEventData('code_exec', {
      cellId: 'cell',
      status: 'completed',
      observations
    });
  expect(publicOutputTruncation('code_exec', output([value('a', 'x'.repeat(10001))]))).toBe('HEAD');
  expect(publicOutputTruncation('code_exec', output([value('a', 'short', true)]))).toBe('SOURCE');
  expect(
    publicOutputTruncation(
      'code_exec',
      output([value('a', 'source', true), value('b', 'x'.repeat(10001))])
    )
  ).toBe('SOURCE');
  expect(publicOutputTruncation('code_exec', output([value('a', 'complete')]))).toBeUndefined();
});

it('does not infer collaboration events from tool names or arbitrary result objects', () => {
  for (const name of [
    'agent_start',
    'agent_send',
    'agent_wait',
    'agent_stop',
    'agent_message',
    'agent_cancel'
  ])
    expect(
      structuredToolEventData(name, {
        agentId: 'child',
        description: 'task',
        status: 'completed',
        privateField: 'not-public'
      })
    ).toBeUndefined();
});
import { publicHostedToolEvents } from '../../src/runtime/event-projection.js';
import { TOOL_EXECUTION_LIMITS } from '../../src/tools/execution-limits.js';

describe('public tool metadata', () => {
  it.each(['code_exec', 'code_exec_wait'])('keeps bounded %s failure facts public', (toolName) => {
    const result = structuredToolEventData(toolName, {
      cellId: 'cell',
      status: 'failed',
      observations: [],
      error: { code: 'x'.repeat(79) + '😀', message: 'm'.repeat(999) + '😀', private: 'hidden' }
    });
    expect(result).toMatchObject({
      truncated: true,
      error: { code: 'x'.repeat(79), message: 'm'.repeat(999) }
    });
    expect(JSON.stringify(result)).not.toContain('hidden');
  });
  it('keeps existing observation kinds while excluding unknown tool results', () => {
    const observation = (toolName: string) => ({
      type: 'tool_result',
      id: toolName,
      source: { callId: toolName, toolName, input: {} },
      outcome: 'completed',
      result: { content: 'existing result' }
    });
    const existing = ['apply_patch', 'todo_read', 'todo_write'].map(observation);
    const result = structuredToolEventData('code_exec', {
      cellId: 'cell',
      status: 'completed',
      observations: [...existing, observation('unknown_tool')]
    });
    expect(result).toMatchObject({ observations: existing });
    expect(JSON.stringify(result)).not.toContain('unknown_tool');
  });
  it.each(['code_exec', 'code_exec_wait'])(
    'publishes bounded explicit %s observations without private result fields',
    (name) => {
      const observation = {
        type: 'tool_result',
        id: 'one',
        source: { callId: 'child', toolName: 'exec', input: { command: 'secret input' } },
        outcome: 'completed',
        result: {
          content: '{"stdout":"wrapped"}',
          data: { stdout: 'hello', stderr: 'warning', private: 'hidden' }
        }
      };
      const result = structuredToolEventData(name, {
        cellId: 'cell',
        status: 'completed',
        observations: [
          observation,
          { type: 'value', id: 'two', format: 'json', value: '{"hello":1}' }
        ]
      });
      expect(result).toMatchObject({
        observations: [
          {
            source: { callId: 'child', toolName: 'exec', input: null },
            result: { content: '', data: { stdout: 'hello', stderr: 'warning' } }
          },
          { type: 'value', value: '{"hello":1}' }
        ]
      });
      expect(JSON.stringify(result)).not.toContain('hidden');
      const long = structuredToolEventData(name, {
        cellId: 'cell',
        status: 'completed',
        observations: [
          { type: 'value', id: 'long', format: 'text', value: 'a'.repeat(9999) + '😀' }
        ]
      });
      expect(long).toMatchObject({
        truncated: true,
        outputHeadTruncated: true,
        observations: [{ value: 'a'.repeat(9998) + '😀', truncated: true }]
      });
      const sourceTruncated = structuredToolEventData(name, {
        cellId: 'cell',
        status: 'completed',
        observations: [{ ...observation, result: { ...observation.result, truncated: true } }]
      });
      expect(sourceTruncated).toMatchObject({
        truncated: true,
        observations: [{ result: { truncated: true } }]
      });
      expect(sourceTruncated).not.toHaveProperty('outputHeadTruncated');
      const valueTruncated = structuredToolEventData(name, {
        cellId: 'cell',
        status: 'completed',
        observations: [
          { type: 'value', id: 'value', format: 'text', value: 'partial', truncated: true }
        ]
      });
      expect(valueTruncated).toMatchObject({ truncated: true });
      expect(valueTruncated).not.toHaveProperty('outputHeadTruncated');
    }
  );
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
