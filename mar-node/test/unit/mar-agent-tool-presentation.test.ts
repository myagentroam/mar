import { describe, expect, it } from 'vitest';
import type { MarAgentEvent } from '@myagentroam/agent';
import { toolPresentationSchema } from '@myagentroam/protocol';
import { MarAgentConversationNormalizer } from '../../src/runner/mar-agent/conversation-normalizer.js';

function event(payload: Record<string, unknown>): MarAgentEvent {
  return {
    eventId: 'event',
    sequence: 1,
    timestamp: '2026-10-20T00:00:00.000Z',
    sessionId: 'session',
    executionId: 'execution',
    turnId: 'turn',
    ...payload
  } as MarAgentEvent;
}

describe('MAR tool presentation projection', () => {
  it.each([
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
            toolName: 'read',
            callId: 'nested-read',
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
