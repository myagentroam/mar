import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@myagentroam/agent';
import { conversationItemSchema, toolPresentationSchema } from '@myagentroam/protocol';
import { MarAgentConversationNormalizer } from '../../src/runner/mar-agent/conversation-normalizer.js';
import { formatReadEventOutput } from '../../../mar-agent/src/tools/local/read.js';
import { structuredToolEventData } from '../../../mar-agent/src/tools/output-projection.js';
import { mergeConversationPayload } from '../../../packages/web-core/src/util/conversation-history.js';
import { readFileDetail } from '../../../packages/web-core/src/util/tool-presentation.js';

function event(payload: Record<string, unknown>): AgentEvent {
  return {
    eventId: 'event',
    sequence: 1,
    timestamp: '2026-10-20T00:00:00.000Z',
    sessionId: 'session',
    executionId: 'execution',
    turnId: 'turn',
    ...payload
  } as AgentEvent;
}

describe('MAR tool presentation projection', () => {
  it('carries SDK source intervals through the public schema and snapshot reducer to file detail', () => {
    const contents = '  first 😀\r\n  second\r\n';
    const sdk = formatReadEventOutput([
      {
        path: 'src/a.ts',
        text: contents,
        content: 'numbered model output',
        encoding: 'utf-8',
        newline: 'crlf',
        startLine: 5,
        endLine: 6,
        eof: true,
        truncated: false
      }
    ]);
    const normalizer = new MarAgentConversationNormalizer();
    const [start] = normalizer.normalize(
      event({
        type: 'tool.started',
        callId: 'read-chain',
        toolName: 'read',
        input: { reads: [{ path: 'src/a.ts' }] }
      })
    );
    const [done] = normalizer.normalize(
      event({
        type: 'tool.completed',
        callId: 'read-chain',
        toolName: 'read',
        summary: sdk.summary,
        data: structuredToolEventData('read', { ...sdk.data })
      })
    );
    const publicItem = conversationItemSchema.parse({
      id: done!.itemId,
      kind: done!.kind,
      payload: done!.payload,
      sessionId: 'session',
      turnId: 'turn',
      runId: 'run',
      parentItemId: null,
      sourceSequence: 1,
      revision: 1,
      status: 'COMPLETED',
      startedAt: null,
      completedAt: null
    });
    const merged = mergeConversationPayload(
      start!.payload,
      publicItem.payload,
      undefined
    ) as Record<string, unknown>;
    expect(readFileDetail(merged, 'src/a.ts')).toContain(contents);
    expect(readFileDetail(merged, 'src/a.ts')).not.toContain('numbered model output');
    const replacement = mergeConversationPayload(
      merged,
      {
        output: { blocks: [{ channel: 'TEXT', text: 'replacement' }] },
        toolPresentation: { kind: 'READ', paths: ['src/a.ts'] }
      },
      undefined
    ) as Record<string, unknown>;
    expect(readFileDetail(replacement, 'src/a.ts')).toBeUndefined();
    expect(replacement.output).toEqual({ blocks: [{ channel: 'TEXT', text: 'replacement' }] });
  });
  it('preserves a source-owned sources-only search fact', () => {
    const normalizer = new MarAgentConversationNormalizer();
    normalizer.normalize(
      event({
        type: 'tool.started',
        callId: 'search-only',
        toolName: 'web_search',
        input: { query: 'fixture' }
      })
    );
    const [done] = normalizer.normalize(
      event({
        type: 'tool.completed',
        callId: 'search-only',
        toolName: 'web_search',
        summary: 'Search results',
        data: {
          query: 'fixture',
          sourcesOnly: true,
          sources: [{ title: 'One', url: 'https://example.test/' }]
        }
      })
    );
    expect(done?.payload.toolPresentation).toMatchObject({
      kind: 'WEB_SEARCH',
      sourcesOnly: true,
      sources: [{ title: 'One' }]
    });
  });
  it.each([
    [
      'view_image',
      { path: 'a.png', resize: { maxWidth: 400 } },
      { path: 'a.png', mimeType: 'image/png', width: 300, height: 200, sha256: 'private-hash' },
      {
        kind: 'IMAGE_VIEW',
        path: 'a.png',
        mimeType: 'image/png',
        width: 300,
        height: 200,
        resize: { maxWidth: 400 }
      }
    ],
    [
      'tool_search',
      { query: 'files' },
      { tools: ['mcp__files'], schemas: [{ private: true }] },
      { kind: 'TOOL_SEARCH', query: 'files', tools: ['mcp__files'] }
    ],
    ['smart_compact', {}, { status: 'accepted' }, { kind: 'COMPACT_REQUEST', accepted: true }]
  ])('projects only public %s detail facts', (name, input, data, expected) => {
    const normalizer = new MarAgentConversationNormalizer();
    normalizer.normalize(event({ type: 'tool.started', callId: name, toolName: name, input }));
    const [item] = normalizer.normalize(
      event({ type: 'tool.completed', callId: name, toolName: name, summary: 'done', data })
    );
    expect(item?.payload.toolPresentation).toEqual(expected);
    expect(item?.payload.toolCategory).not.toBe('IMAGE_GENERATION');
  });
  it('atomically projects read snapshots and adjusts associations to the bounded output', () => {
    const normalizer = new MarAgentConversationNormalizer();
    normalizer.normalize(
      event({
        type: 'tool.started',
        callId: 'r',
        toolName: 'read',
        input: { reads: [{ path: 'a' }, { path: 'b' }] }
      })
    );
    const summary = `${'x'.repeat(10_002)}😀keep`;
    const [done] = normalizer.normalize(
      event({
        type: 'tool.completed',
        callId: 'r',
        toolName: 'read',
        summary,
        data: {
          mode: 'batch',
          truncated: false,
          results: [
            { path: 'a', startLine: 1, endLine: 1, contentRange: { start: 0, end: 10_002 } },
            {
              path: 'b',
              startLine: 2,
              endLine: 2,
              contentRange: { start: 10_002, end: summary.length }
            }
          ]
        }
      })
    );
    const output = done!.payload.output as { blocks: Array<{ text: string }>; truncation?: string };
    const presentation = done!.payload.toolPresentation as {
      results: Array<{ contentRange?: { start: number; end: number } }>;
    };
    const range = presentation.results[1]!.contentRange!;
    expect(output.blocks[0]!.text.slice(range.start, range.end)).toBe('😀keep');
    expect(output.truncation).toBe('HEAD');
    const [next] = normalizer.normalize(
      event({
        type: 'tool.completed',
        callId: 'r',
        toolName: 'read',
        summary: 'new',
        data: { mode: 'batch', results: [{ path: 'a' }] }
      })
    );
    expect(next!.payload.output).toEqual({ blocks: [{ channel: 'TEXT', text: 'new' }] });
    expect(next!.payload.toolPresentation).toMatchObject({
      kind: 'READ',
      results: [{ path: 'a' }]
    });
    expect(
      (next!.payload.toolPresentation as { results: Array<{ contentRange?: unknown }> }).results[0]!
        .contentRange
    ).toBeUndefined();
  });
  it.each([undefined, 'cell'])(
    'retains Read paths, status and details on direct/nested replay (%s)',
    (parentCallId) => {
      const events = [
        event({
          type: 'tool.started',
          callId: 'read',
          toolName: 'read',
          parentCallId,
          input: { reads: [{ path: '目录/a.ts', offset: 2, limit: 8 }, { path: 'src/b.ts' }] }
        }),
        event({
          type: 'tool.failed',
          callId: 'read',
          toolName: 'read',
          parentCallId,
          code: 'READ_FAILED',
          message: 'File unavailable'
        })
      ];
      const replay = () => {
        const normalizer = new MarAgentConversationNormalizer();
        return events.flatMap((entry) => normalizer.normalize(entry));
      };
      const projected = replay();
      expect(projected).toHaveLength(2);
      expect(replay()).toEqual(projected);
      expect(projected.map((item) => item.status)).toEqual(['IN_PROGRESS', 'FAILED']);
      expect(projected[1]?.itemId).toBe(projected[0]?.itemId);
      for (const item of projected) {
        expect(item.payload.toolPresentation).toEqual({
          kind: 'READ',
          paths: ['目录/a.ts', 'src/b.ts']
        });
        expect(item.payload.inputSummary).toContain('offset');
      }
    }
  );
  it.each([
    [
      'read',
      { reads: [{ path: 'src/a.ts', offset: 3, limit: 20 }, { path: '目录/b.ts' }] },
      { results: [] },
      'READ'
    ],
    [
      'web_search',
      { query: '原始 query' },
      {
        sources: [{ url: 'https://source.example/', title: '来源', snippet: 'Summary' }],
        sourceCount: 1
      },
      'WEB_SEARCH'
    ],
    [
      'web_fetch',
      { url: 'https://request.example/', mode: 'browser' },
      { url: 'https://final.example/', title: '网页标题', mode: 'browser' },
      'WEB_FETCH'
    ],
    ['skill', { name: '原始 skill' }, { name: '原始 skill', source: 'Host-provided' }, 'SKILL'],
    [
      'sleep',
      { durationMs: 1800000 },
      { durationMs: 1800000, elapsedMs: 192000, wakeReason: 'subagent_message' },
      'SLEEP'
    ]
  ])('projects structured %s facts identically on replay', (toolName, input, data, kind) => {
    const events = [
      event({ type: 'tool.started', callId: 'call', toolName, input }),
      event({ type: 'tool.completed', callId: 'call', toolName, data, summary: 'Bounded output' })
    ];
    const replay = () => {
      const normalizer = new MarAgentConversationNormalizer();
      return events.flatMap((entry) => normalizer.normalize(entry));
    };
    const items = replay();
    expect(replay()).toEqual(items);
    for (const item of items) {
      expect(item.kind).toBe('tool_call');
      expect(item.payload.toolName).toBe(toolName);
      expect(toolPresentationSchema.parse(item.payload.toolPresentation).kind).toBe(kind);
    }
    if (kind === 'WEB_FETCH')
      expect(items.at(-1)?.payload.toolPresentation).toMatchObject({
        requestUrl: 'https://request.example/',
        url: 'https://final.example/',
        title: '网页标题'
      });
  });

  it('does not use tool dispatch time as the sleep start, and retains the real start on completion', () => {
    const normalizer = new MarAgentConversationNormalizer();
    const [queued] = normalizer.normalize(
      event({
        type: 'tool.started',
        callId: 'sleep',
        toolName: 'sleep',
        input: { durationMs: 1800000 }
      })
    );
    expect(queued?.payload.toolPresentation).toEqual({ kind: 'SLEEP', durationMs: 1800000 });
    const [started] = normalizer.normalize(
      event({
        type: 'sleep.started',
        callId: 'sleep',
        durationMs: 1800000,
        startedAt: '2026-10-20T15:50:00.000Z'
      })
    );
    expect(started?.itemId).toBe(queued?.itemId);
    expect(started?.payload.toolPresentation).toMatchObject({
      startedAt: '2026-10-20T15:50:00.000Z'
    });
    const [done] = normalizer.normalize(
      event({
        type: 'tool.completed',
        callId: 'sleep',
        toolName: 'sleep',
        summary: 'done',
        data: { durationMs: 1800000, elapsedMs: 1200, wakeReason: 'steer' }
      })
    );
    expect(done?.payload.toolPresentation).toEqual({
      kind: 'SLEEP',
      durationMs: 1800000,
      startedAt: '2026-10-20T15:50:00.000Z',
      elapsedMs: 1200,
      wakeReason: 'steer'
    });
  });

  it('uses SDK semantic facts for hosted page reads without renaming the native search tool', () => {
    const normalizer = new MarAgentConversationNormalizer();
    const [started] = normalizer.normalize(
      event({
        type: 'tool.started',
        callId: 'hosted',
        toolName: 'web_search',
        input: { url: 'https://example.com/' },
        data: { hostedToolKind: 'WEB_FETCH', url: 'https://example.com/' }
      })
    );
    expect(started?.payload).toMatchObject({
      toolName: 'web_search',
      toolPresentation: { kind: 'WEB_FETCH' }
    });
    const [failed] = normalizer.normalize(
      event({
        type: 'tool.failed',
        callId: 'hosted',
        toolName: 'web_search',
        code: 'HOSTED_TOOL_FAILED',
        message: 'Page unavailable.'
      })
    );
    expect(failed?.payload).toMatchObject({
      errorCode: 'HOSTED_TOOL_FAILED',
      toolPresentation: { kind: 'WEB_FETCH' }
    });
  });

  it.each(
    ['web_search', 'web_fetch', 'skill', 'sleep'].flatMap((toolName) =>
      [
        ['MAR_AGENT_CANCELLED', 'CANCELLED'],
        ['MAR_AGENT_EXECUTION_CANCELLED', 'CANCELLED'],
        ['MAR_AGENT_HOST_OPERATION_FAILED', 'FAILED']
      ].map(([code, status]) => [toolName, code, status] as const)
    )
  )('preserves %s cancellation and failure semantics for %s', (toolName, code, status) => {
    const events = [
      event({
        type: 'tool.started',
        callId: 'call',
        toolName,
        input: { durationMs: 1800000, query: 'query', url: 'https://example.com/', name: 'skill' }
      }),
      ...(toolName === 'sleep'
        ? [
            event({
              type: 'sleep.started',
              callId: 'call',
              durationMs: 1800000,
              startedAt: '2026-10-20T00:00:00.000Z'
            })
          ]
        : []),
      event({
        type: 'tool.failed',
        callId: 'call',
        toolName,
        code,
        message: 'Execution cancelled.'
      })
    ];
    const replay = () => {
      const normalizer = new MarAgentConversationNormalizer();
      return events.flatMap((entry) => normalizer.normalize(entry));
    };
    const items = replay();
    expect(replay()).toEqual(items);
    const terminal = items.at(-1);
    expect(terminal?.itemId).toBe(items[0]?.itemId);
    expect(terminal?.status).toBe(status);
    expect(terminal?.payload.errorCode).toBe(code);
    expect(terminal?.payload.toolPresentation).toBeDefined();
    if (toolName === 'sleep')
      expect(terminal?.payload.toolPresentation).toEqual({
        kind: 'SLEEP',
        durationMs: 1800000,
        startedAt: '2026-10-20T00:00:00.000Z'
      });
  });

  it.each(['web_search', 'web_fetch'])(
    'retains native %s events inside Code Mode without exposing other nested tools',
    (toolName) => {
      const normalizer = new MarAgentConversationNormalizer();
      const [started] = normalizer.normalize(
        event({
          type: 'tool.started',
          toolName,
          callId: 'nested-web',
          parentCallId: 'cell',
          input: { query: 'Original query', url: 'https://request.example/', mode: 'http' }
        })
      );
      expect(started).toMatchObject({ kind: 'tool_call', status: 'IN_PROGRESS' });
      const [done] = normalizer.normalize(
        event({
          type: 'tool.completed',
          toolName,
          callId: 'nested-web',
          parentCallId: 'cell',
          summary: 'Original output',
          data:
            toolName === 'web_fetch'
              ? { url: 'https://final.example/', title: 'Original title', mode: 'http' }
              : { sources: [], sourceCount: 0 }
        })
      );
      expect(done?.itemId).toBe(started?.itemId);
      expect(done).toMatchObject({ kind: 'tool_call', status: 'COMPLETED' });
      expect(done?.payload.toolPresentation).toMatchObject({
        kind: toolName === 'web_fetch' ? 'WEB_FETCH' : 'WEB_SEARCH'
      });
      expect(
        normalizer.normalize(
          event({
            type: 'tool.started',
            toolName: 'exec',
            callId: 'nested-exec',
            parentCallId: 'cell',
            input: {}
          })
        )
      ).toEqual([]);
      const outer = normalizer.normalize(
        event({
          type: 'tool.completed',
          toolName: 'code_exec',
          callId: 'cell',
          summary: 'Done',
          data: {
            cellId: 'cell',
            status: 'completed',
            calls: [
              {
                callId: 'nested-web',
                toolName,
                input: {},
                status: 'completed',
                result: { content: 'Original output', data: {} }
              }
            ]
          }
        })
      );
      expect(outer).toHaveLength(1);
      expect(outer[0]?.kind).toBe('command_execution');
    }
  );

  it('keeps unrelated tools generic and never derives sources from result text', () => {
    const normalizer = new MarAgentConversationNormalizer();
    const [generic] = normalizer.normalize(
      event({
        type: 'tool.started',
        callId: 'other',
        toolName: 'other',
        input: { query: 'search-like input' }
      })
    );
    expect(generic?.payload.toolPresentation).toBeUndefined();
    const [namedLikeObjectMember] = normalizer.normalize(
      event({ type: 'tool.started', callId: 'toString', toolName: 'toString', input: {} })
    );
    expect(namedLikeObjectMember?.payload.toolPresentation).toBeUndefined();
    const [search] = normalizer.normalize(
      event({
        type: 'tool.completed',
        callId: 'search',
        toolName: 'web_search',
        summary: '{"results":[]}'
      })
    );
    expect(search?.payload.toolPresentation).toEqual({ kind: 'WEB_SEARCH' });
  });
});
