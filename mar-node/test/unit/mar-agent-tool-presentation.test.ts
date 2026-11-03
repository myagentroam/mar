import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { countModelTokens, createAgent, SecretValue } from '@myagentroam/agent';
import type { AgentEvent, AgentModelConfiguration } from '@myagentroam/agent';
import { LocalAgentHost } from '@myagentroam/agent/host';
import { conversationItemSchema, toolPresentationSchema } from '@myagentroam/protocol';
import type { NodeConfig } from '../../src/config.js';
import { MarAgentConversationNormalizer } from '../../src/runner/mar-agent/conversation-normalizer.js';
import { createWebToolsExtensions } from '../../src/runner/mar-agent/web-tools-extensions.js';
import { WebToolService } from '../../src/service/web-tool-service.js';
import { formatReadEventOutput } from '../../../mar-agent/src/tools/local/read.js';
import { structuredToolEventData } from '../../../mar-agent/src/tools/output-projection.js';
import { mergeConversationPayload } from '@myagentroam/web-core/conversation-history';
import { conversationItemDetail } from '@myagentroam/web-core/conversation-presentation';
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
  it('shows truncated Search output and keeps source links through live and history projection', async () => {
    const url = 'https://example.test/original-source';
    const source = {
      title: 'Original title',
      url,
      snippet: 'Search summary '.repeat(1000)
    };
    const request = vi.fn(
      async () => new Response(JSON.stringify({ query: 'fixture', results: [source] }))
    );
    const service = new WebToolService(
      () =>
        ({ serverUrl: 'https://server.test', nodeId: 'n', credential: 'fixture' }) as NodeConfig,
      request
    );
    const home = await mkdtemp(join(tmpdir(), 'mar-web-search-truncation-'));
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const modelRequests: Record<string, unknown>[] = [];
    const assistantMessage = {
      type: 'message',
      id: 'search-answer',
      role: 'assistant',
      phase: 'final_answer',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Search complete.' }]
    };
    const modelServer = createServer((incoming, outgoing) => {
      let body = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk) => (body += chunk));
      incoming.on('end', () => {
        modelRequests.push(JSON.parse(body) as Record<string, unknown>);
        const firstRequest = modelRequests.length === 1;
        const functionCall = {
          type: 'function_call',
          id: 'search-call-item',
          call_id: 'search-call',
          name: 'web_search',
          arguments: JSON.stringify({ query: 'fixture', maxResults: 1, maxTokens: 512 })
        };
        const events = firstRequest
          ? [
              { type: 'response.created', response: { id: 'search-response' } },
              { type: 'response.output_item.done', item: functionCall },
              {
                type: 'response.completed',
                response: {
                  id: 'search-response',
                  output: [functionCall],
                  usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: {} }
                }
              }
            ]
          : [
              { type: 'response.created', response: { id: 'answer-response' } },
              {
                type: 'response.output_item.done',
                item: assistantMessage
              },
              {
                type: 'response.completed',
                response: {
                  id: 'answer-response',
                  output: [assistantMessage],
                  usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: {} }
                }
              }
            ];
        outgoing.writeHead(200, { 'content-type': 'text/event-stream' });
        outgoing.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
      });
    });
    await new Promise<void>((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
    const address = modelServer.address();
    if (!address || typeof address === 'string') throw new Error('No fake model server address');
    let searchResult: Awaited<ReturnType<WebToolService['webSearch']>> | undefined;
    const host = new LocalAgentHost({
      homeDirectory: home,
      workspace,
      extensions: createWebToolsExtensions({
        enabled: true,
        hostedWebSearch: false,
        webSearch: async (input, signal) => {
          searchResult = await service.webSearch(input, signal);
          return searchResult;
        }
      })
    });
    const agent = await createAgent({
      mode: 'normal',
      host,
      models: [
        {
          id: 'responses',
          name: 'Responses',
          protocol: 'OPENAI_RESPONSES',
          baseUrl: `http://127.0.0.1:${address.port}`,
          apiKey: new SecretValue('fake-test-key'),
          modelId: 'test-model',
          contextWindowTokens: 200_000,
          maxOutputTokens: 4096,
          inputCapabilities: ['TEXT'],
          outputCapabilities: ['TEXT'],
          reasoningEfforts: ['medium'],
          defaultReasoningEffort: 'medium',
          titleGeneration: false,
          codeMode: false,
          responsesTransport: { transport: 'HTTP', httpVersion: '1.1' },
          responsesPreviousResponseId: false,
          hostedWebSearch: false,
          enabled: true
        } satisfies AgentModelConfiguration
      ]
    });

    try {
      const session = await agent.createSession({ workspace, title: 'Web Search truncation' });
      const execution = session.run({ prompt: 'Search for the fixture.' });
      const events: AgentEvent[] = [];
      for await (const publicEvent of execution) events.push(publicEvent);
      await expect(execution.result()).resolves.toMatchObject({ status: 'completed' });

      if (!searchResult) throw new Error('WebToolService was not called.');
      expect(countModelTokens(searchResult.content)).toBeLessThanOrEqual(512);
      expect(searchResult.truncated).toBe(true);
      expect(searchResult.content).toContain('Search results (truncated):');
      expect((searchResult.data as { results: (typeof source)[] }).results[0]!.url).toBe(url);
      expect(modelRequests).toHaveLength(2);
      expect(modelRequests[0]?.tools).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'web_search' })])
      );
      expect(modelRequests[1]?.input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'function_call_output', call_id: 'search-call' })
        ])
      );

      const completedEvent = events.find(
        (publicEvent): publicEvent is Extract<AgentEvent, { type: 'tool.completed' }> =>
          publicEvent.type === 'tool.completed' && publicEvent.toolName === 'web_search'
      );
      expect(completedEvent?.truncated).toBe(true);

      const render = (sourceEvents: readonly AgentEvent[]) => {
        const normalizer = new MarAgentConversationNormalizer();
        let started: ReturnType<typeof normalizer.normalize>[number] | undefined;
        let completed: ReturnType<typeof normalizer.normalize>[number] | undefined;
        for (const publicEvent of sourceEvents) {
          const [item] = normalizer.normalize(publicEvent);
          if (publicEvent.type === 'tool.started' && publicEvent.toolName === 'web_search')
            started = item;
          if (publicEvent.type === 'tool.completed' && publicEvent.toolName === 'web_search')
            completed = item;
        }
        if (!started || !completed) throw new Error('Search lifecycle was not normalized.');
        const payload = mergeConversationPayload(started.payload, completed.payload, undefined);
        const publicItem = conversationItemSchema.parse({
          id: completed.itemId,
          kind: completed.kind,
          payload,
          sessionId: session.id,
          turnId: completedEvent?.turnId ?? 'turn',
          runId: completedEvent?.executionId ?? 'run',
          parentItemId: null,
          sourceSequence: completedEvent?.sequence ?? 1,
          revision: 1,
          status: 'COMPLETED',
          startedAt: null,
          completedAt: null
        });
        if (publicItem.kind !== 'tool_call') throw new Error('Search item was not a tool call.');
        const presentation = toolPresentationSchema.parse(publicItem.payload.toolPresentation);
        expect(presentation).toMatchObject({
          kind: 'WEB_SEARCH',
          sources: [{ url, title: source.title }]
        });
        return conversationItemDetail('tool_call', publicItem.payload);
      };

      const liveDetail = render(events);
      const history = await agent.sessionHistory(session.id);
      const historyEvents = history.entries.flatMap((entry) =>
        entry.kind === 'event' ? [entry.event] : []
      );
      const historyDetail = render(historyEvents);
      for (const detail of [liveDetail, historyDetail]) {
        expect(detail).toContain('Search results (truncated):');
        expect(detail).toContain('URL: https://example.test/original-source');
        expect(detail).toContain('Search snippet:');
      }
      expect(historyDetail).toBe(liveDetail);
      expect(completedEvent?.data).toMatchObject({ sources: [{ url }], sourceCount: 1 });
      expect(completedEvent?.data).not.toHaveProperty('sourcesOnly');
    } finally {
      await agent.dispose();
      await service.close();
      await new Promise<void>((resolve, reject) =>
        modelServer.close((error) => (error ? reject(error) : resolve()))
      );
      await rm(home, { recursive: true, force: true });
    }
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
