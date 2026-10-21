import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LocalAgentHost,
  SecretValue,
  type MarAgentEvent,
  type MarAgentHistoryEntry,
  type MarAgentModelConfiguration
} from '../../../mar-agent/src/index.js';
import { createMarAgentWithAdapter as createMarAgent } from '../../../mar-agent/src/agent-core/sdk/agent.js';
import type {
  ModelAdapter,
  ModelEvent
} from '../../../mar-agent/src/agent-core/model/contracts.js';
import { openMarAgentSessionCatalog } from '../../../mar-agent/src/agent-core/session/catalog.js';
import type { NodeAgentSession } from '../../src/database.js';
import {
  codexLiveConversationItem,
  codexOfficialConversationPage
} from '../../src/runner/codex/conversation-parser.js';
import { normalizeCodexTool } from '../../src/runner/codex/tool-normalizer.js';
import { MarAgentConversationNormalizer } from '../../src/runner/mar-agent/conversation-normalizer.js';
import { createWebToolsExtensions } from '../../src/runner/mar-agent/web-tools-extensions.js';
import { projectMarAgentHistory } from '../../src/runner/mar-agent/history-projection.js';

describe('Code Mode conversation projection', () => {
  it('projects non-text evidence to the public unavailable reason instead of rejecting the item', () => {
    const normalizer = new MarAgentConversationNormalizer();
    const event = {
      type: 'tool.completed',
      eventId: 'event',
      sessionId: 'session',
      executionId: 'execution',
      turnId: 'turn',
      sequence: 1,
      timestamp: new Date().toISOString(),
      toolName: 'apply_patch',
      summary: 'Deleted binary file.',
      callId: 'call',
      resultExtensions: [
        {
          type: 'file_changes',
          version: 1,
          entries: [
            {
              changeId: 'c10a59dd-680f-46f6-9b75-31bfbd520506',
              path: 'binary.bin',
              change: 'deleted',
              additions: null,
              deletions: null,
              diff: { status: 'unavailable', reason: 'unsupported-content' }
            }
          ]
        }
      ]
    } as MarAgentEvent;
    expect(normalizer.normalize(event)).toEqual([
      expect.objectContaining({
        kind: 'file_change',
        payload: {
          changes: [
            expect.objectContaining({
              path: 'binary.bin',
              change: 'DELETED',
              additions: null,
              deletions: null,
              diff: { status: 'unavailable', reason: 'binary' }
            })
          ]
        }
      })
    ]);
  });

  it.each([
    'out.text(1 + 2);',
    'const results = await Promise.all([tools.exec_command({cmd:"pwd"}), tools.read({path:"README.md"})]); out.text(results);',
    'const patch = "*** Begin Patch\\n*** Add File: new.ts\\n+new\\n*** End Patch"; out.text(await tools.apply_patch(patch));',
    '// tools.exec_command({cmd:"not a real call"})\nout.text("tools.spawn_agent({task: \\"not a call\\"})");'
  ])('keeps the whole Codex cell as one ordinary tool: %s', (code) => {
    const call = {
      type: 'custom_tool_call',
      id: 'input-item',
      call_id: 'cell',
      name: 'exec',
      input: code
    };
    const output = {
      type: 'custom_tool_call_output',
      id: 'output-item',
      call_id: 'cell',
      output: [{ type: 'input_text', text: 'cell output' }]
    };
    const started = codexLiveConversationItem(call, false);
    const completed = codexLiveConversationItem(output, true);
    expect(started).toMatchObject({
      itemId: 'codex:cell',
      kind: 'tool_call',
      status: 'IN_PROGRESS',
      payload: { toolName: 'exec', inputSummary: code, outputSummary: null }
    });
    expect(started?.payload).not.toHaveProperty('subagentOperation');
    expect(completed).toMatchObject({
      itemId: started?.itemId,
      kind: 'tool_call',
      status: 'COMPLETED',
      payload: { outputSummary: 'cell output' },
      merge: true
    });
    expect(completed?.payload).not.toHaveProperty('inputSummary');
    const page = codexOfficialConversationPage(
      { id: 'session', runner: 'codex', externalSessionId: 'thread' } as NodeAgentSession,
      { thread: { id: 'thread', turns: [{ id: 'turn', items: [call, output] }] } },
      {},
      () => undefined
    );
    expect(page?.turns[0]?.items).toHaveLength(1);
    expect(page?.turns[0]?.items[0]).toMatchObject({
      kind: 'tool_call',
      payload: { toolName: 'exec', inputSummary: code, outputSummary: 'cell output' }
    });
  });

  it('keeps direct Codex shell calls as commands without parsing Code Mode source', () => {
    expect(
      normalizeCodexTool({
        name: 'exec_command',
        rawInput: { cmd: 'git status --short', cwd: '/workspace' }
      })
    ).toMatchObject({
      kind: 'command_execution',
      payload: { command: 'git status --short', cwd: '/workspace' }
    });
  });

  it.each(
    (['calls', 'observations'] as const).flatMap((source) =>
      (['code_exec', 'code_exec_wait'] as const).flatMap((toolName) =>
        (['tool.completed', 'tool.failed'] as const).map((type) => ({ source, toolName, type }))
      )
    )
  )(
    'keeps Todo snapshots out of task cards for $source / $toolName / $type',
    ({ source, toolName, type }) => {
      const normalizer = new MarAgentConversationNormalizer();
      const base = {
        timestamp: '2026-10-03T00:00:00.000Z',
        sessionId: 'session',
        executionId: 'execution',
        turnId: 'turn'
      };
      const todo = {
        revision: 2,
        items: [{ id: 'task', step: 'Verify', status: 'pending' as const }]
      };
      const calls = [
        { callId: 'todo-read', toolName: 'todo_read', input: {}, data: todo },
        {
          callId: 'empty-todo-read',
          toolName: 'todo_read',
          input: {},
          data: { revision: 0, items: [] }
        },
        {
          callId: 'todo-write',
          toolName: 'todo_write',
          input: { expectedRevision: 1, items: todo.items },
          data: todo
        }
      ];
      const started: MarAgentEvent = {
        ...base,
        eventId: 'outer-started',
        sequence: 1,
        type: 'tool.started',
        toolName,
        callId: 'outer',
        input: toolName === 'code_exec' ? 'await tools.todo_read({});' : { cellId: 'cell' }
      };
      const terminal: MarAgentEvent =
        type === 'tool.completed'
          ? {
              ...base,
              eventId: 'outer-terminal',
              sequence: 2,
              type,
              toolName,
              callId: 'outer',
              summary: 'Done.'
            }
          : {
              ...base,
              eventId: 'outer-terminal',
              sequence: 2,
              type,
              toolName,
              callId: 'outer',
              code: 'MAR_AGENT_CODE_EXEC_FAILED',
              message: 'Failed after reading Todo.'
            };
      Object.assign(terminal, {
        data: {
          cellId: 'cell',
          status: type === 'tool.completed' ? 'completed' : 'failed',
          cached: toolName === 'code_exec_wait',
          [source]: calls.map(({ callId, toolName: nestedToolName, input, data }) => {
            const result = { content: JSON.stringify(data), data };
            return source === 'calls'
              ? { callId, toolName: nestedToolName, input, status: 'completed', result }
              : {
                  type: 'tool_result',
                  id: callId,
                  source: { callId, toolName: nestedToolName, input },
                  outcome: 'completed',
                  result
                };
          })
        }
      });
      const events = [started, terminal];
      expect(events.flatMap((event) => normalizer.normalize(event))).toMatchObject([
        { itemId: 'mar-agent-tool:outer', status: 'IN_PROGRESS' },
        {
          itemId: 'mar-agent-tool:outer',
          status: type === 'tool.completed' ? 'COMPLETED' : 'FAILED'
        }
      ]);

      const updates: MarAgentEvent[] = [1, 2].map((revision) => ({
        ...base,
        eventId: `native-todo-${revision}`,
        sequence: revision + 2,
        type: 'todo.updated',
        revision,
        items: todo.items
      }));
      expect(updates.flatMap((event) => normalizer.normalize(event))).toMatchObject([
        { itemId: 'mar-agent-todo-list:native-todo-1', kind: 'todo_list' },
        { itemId: 'mar-agent-todo-list:native-todo-2', kind: 'todo_list' }
      ]);
      expect(normalizer.normalize(terminal).some((item) => item.kind === 'todo_list')).toBe(false);

      const history = (input: MarAgentEvent[]) =>
        projectMarAgentHistory(
          { id: 'node-session', runner: 'mar-agent' } as NodeAgentSession,
          input.map((event): MarAgentHistoryEntry => ({
            kind: 'event',
            sequence: event.sequence,
            event
          }))
        ).flatMap((turn) => turn.items);
      expect(history(events)).toMatchObject([
        {
          id: 'mar-agent-tool:outer',
          kind: 'command_execution',
          status: type === 'tool.completed' ? 'COMPLETED' : 'FAILED'
        }
      ]);
      expect(
        history([...events, ...updates, terminal])
          .filter((item) => item.kind === 'todo_list')
          .map((item) => item.id)
      ).toEqual(['mar-agent-todo-list:native-todo-1', 'mar-agent-todo-list:native-todo-2']);
    }
  );

  it.each(['tool.completed', 'tool.failed'] as const)(
    'preserves ordinary MAR tool input on %s without inferring nested calls by timing',
    (type) => {
      const normalizer = new MarAgentConversationNormalizer();
      const base = {
        eventId: 'event',
        sequence: 1,
        timestamp: '2026-10-01T00:00:00.000Z',
        sessionId: 'session',
        executionId: 'execution',
        turnId: 'turn'
      };
      const input = 'out.text(await tools.exec({command:"pwd"}));';
      normalizer.normalize({
        ...base,
        type: 'tool.started',
        toolName: 'custom_tool',
        callId: 'cell',
        input
      });
      expect(
        normalizer.normalize({
          ...base,
          type: 'tool.started',
          toolName: 'exec',
          callId: 'nested',
          parentCallId: 'cell',
          input: { command: 'pwd' }
        })
      ).toEqual([]);
      expect(
        normalizer.normalize({
          ...base,
          type: 'tool.started',
          toolName: 'exec',
          callId: 'direct',
          input: { command: 'pwd' }
        })
      ).toEqual([expect.objectContaining({ kind: 'command_execution' })]);
      const terminal =
        type === 'tool.completed'
          ? { type, summary: 'output' }
          : { type, code: 'MAR_AGENT_TOOL_INPUT_INVALID', message: 'Invalid input.' };
      expect(
        normalizer.normalize({
          ...base,
          ...terminal,
          toolName: 'exec',
          callId: 'nested',
          parentCallId: 'cell'
        })
      ).toEqual([]);
      expect(
        normalizer.normalize({ ...base, ...terminal, toolName: 'custom_tool', callId: 'cell' })
      ).toEqual([
        expect.objectContaining({
          itemId: 'mar-agent-tool:cell',
          kind: 'tool_call',
          status: type === 'tool.completed' ? 'COMPLETED' : 'FAILED',
          payload: expect.objectContaining({
            toolName: 'custom_tool',
            inputSummary: input,
            outputSummary: type === 'tool.completed' ? 'output' : 'Invalid input.'
          })
        })
      ]);
    }
  );

  it('projects a direct permission stop on the visible tool card and replays it from history', () => {
    const permissionStop = {
      action: 'ask' as const,
      reason: 'Confirm before changing files.',
      source: {
        sessionId: 'session',
        executionId: 'execution',
        callId: 'direct-call',
        toolName: 'write_file'
      }
    };
    const base = {
      sessionId: 'session',
      executionId: 'execution',
      turnId: 'turn',
      timestamp: '2026-10-01T00:00:00.000Z'
    };
    const events: MarAgentEvent[] = [
      {
        ...base,
        eventId: 'started',
        sequence: 1,
        type: 'tool.started',
        toolName: 'write_file',
        callId: 'direct-call',
        input: { path: 'file.txt', content: 'data' }
      },
      {
        ...base,
        eventId: 'failed',
        sequence: 2,
        type: 'tool.failed',
        toolName: 'write_file',
        callId: 'direct-call',
        code: 'MAR_AGENT_PERMISSION_ASK',
        message: permissionStop.reason,
        permissionStop
      },
      {
        ...base,
        eventId: 'completed',
        sequence: 3,
        type: 'execution.completed',
        permissionStop
      }
    ];
    const normalizer = new MarAgentConversationNormalizer();
    const live = events.flatMap((event) => normalizer.normalize(event));
    expect(live.at(-1)).toMatchObject({
      kind: 'tool_call',
      status: 'FAILED',
      permissionStop
    });
    const [turn] = projectMarAgentHistory(
      { id: 'node-session', runner: 'mar-agent' } as NodeAgentSession,
      events.map((event): MarAgentHistoryEntry => ({
        kind: 'event',
        sequence: event.sequence,
        event
      }))
    );
    expect(turn?.status).toBe('INTERRUPTED');
    expect(turn?.items.at(-1)).toMatchObject({ permissionStop });
  });

  it.each(['code_exec', 'code_exec_wait'] as const)(
    'maps an internal Code Mode stop to the visible %s card in live and historical projection',
    (toolName) => {
      const permissionStop = {
        action: 'ask' as const,
        reason: 'Confirm before changing files.',
        source: {
          sessionId: 'session',
          executionId: 'execution',
          callId: 'nested-call',
          toolName: 'write_file',
          parentCallId: 'outer-call'
        }
      };
      const base = {
        sessionId: 'session',
        executionId: 'execution',
        turnId: 'turn',
        timestamp: '2026-10-01T00:00:00.000Z'
      };
      const events: MarAgentEvent[] = [
        {
          ...base,
          eventId: 'outer-started',
          sequence: 1,
          type: 'tool.started',
          toolName,
          callId: 'outer-call',
          input: { code: 'await tools.write_file({path:"file.txt", content:"data"});' }
        },
        {
          ...base,
          eventId: 'nested-failed',
          sequence: 2,
          type: 'tool.failed',
          toolName: 'write_file',
          callId: 'nested-call',
          parentCallId: 'outer-call',
          code: 'MAR_AGENT_PERMISSION_ASK',
          message: permissionStop.reason,
          permissionStop
        },
        {
          ...base,
          eventId: 'outer-failed',
          sequence: 3,
          type: 'tool.failed',
          toolName,
          callId: 'outer-call',
          code: 'MAR_AGENT_PERMISSION_ASK',
          message: permissionStop.reason,
          data: { cellId: 'cell', status: 'completed', permissionStop }
        },
        {
          ...base,
          eventId: 'completed',
          sequence: 4,
          type: 'execution.completed',
          permissionStop
        }
      ];
      const normalizer = new MarAgentConversationNormalizer();
      expect(normalizer.normalize(events[1]!)).toEqual([]);
      const live = [normalizer.normalize(events[0]!), normalizer.normalize(events[2]!)].flat();
      expect(live).toMatchObject([
        { itemId: 'mar-agent-tool:outer-call', status: 'IN_PROGRESS' },
        {
          itemId: 'mar-agent-tool:outer-call',
          kind: 'command_execution',
          status: 'FAILED',
          permissionStop
        }
      ]);
      const [turn] = projectMarAgentHistory(
        { id: 'node-session', runner: 'mar-agent' } as NodeAgentSession,
        events.map((event): MarAgentHistoryEntry => ({
          kind: 'event',
          sequence: event.sequence,
          event
        }))
      );
      expect(turn?.status).toBe('INTERRUPTED');
      expect(turn?.items).toHaveLength(1);
      expect(turn?.items[0]).toMatchObject({ permissionStop });
    }
  );

  it.each([['code_exec_wait', { cellId: 'cell-1', yieldMs: 1_500 }]])(
    'projects %s as command details with its complete input and result',
    (toolName, input) => {
      const normalizer = new MarAgentConversationNormalizer();
      const callId = `call-${toolName}`;
      const inputSummary = typeof input === 'string' ? input : JSON.stringify(input);
      const base = {
        eventId: 'event',
        sequence: 1,
        timestamp: '2026-10-01T00:00:00.000Z',
        sessionId: 'session',
        executionId: 'execution',
        turnId: 'turn'
      };

      expect(
        normalizer.normalize({ ...base, type: 'tool.started', toolName, callId, input })
      ).toEqual([
        expect.objectContaining({
          itemId: `mar-agent-tool:${callId}`,
          kind: 'command_execution',
          status: 'IN_PROGRESS',
          payload: expect.objectContaining({
            command: toolName,
            outputPreview: expect.stringContaining(inputSummary)
          })
        })
      ]);
      const completed = normalizer.normalize({
        ...base,
        type: 'tool.completed',
        toolName,
        callId,
        summary: 'done'
      });
      expect(completed).toEqual([
        expect.objectContaining({
          itemId: `mar-agent-tool:${callId}`,
          kind: 'command_execution',
          status: 'COMPLETED',
          payload: expect.objectContaining({
            command: toolName,
            outputPreview: expect.stringContaining(inputSummary)
          })
        })
      ]);
      expect(completed[0]?.payload.outputPreview).toContain('Result: done');
    }
  );

  it.each(['freeform', 'json'])(
    'preserves whole Code Exec %s input on failure and yield return',
    (mode) => {
      const normalizer = new MarAgentConversationNormalizer();
      const code = 'await cell.yield_control();\nawait tools.exec({command:"pwd"});';
      const base = {
        eventId: 'event',
        sequence: 1,
        timestamp: '2026-10-01T00:00:00.000Z',
        sessionId: 's',
        executionId: 'e',
        turnId: 't'
      };
      const started = normalizer.normalize({
        ...base,
        type: 'tool.started',
        toolName: 'code_exec',
        callId: 'cell',
        input: mode === 'freeform' ? code : { code }
      });
      expect(started).toMatchObject([
        {
          itemId: 'mar-agent-tool:cell',
          kind: 'command_execution',
          status: 'IN_PROGRESS',
          payload: { command: code, cwd: null, exitCode: null }
        }
      ]);
      expect(
        normalizer.normalize({
          ...base,
          type: 'tool.failed',
          toolName: 'code_exec',
          callId: 'cell',
          code: 'MAR_AGENT_CODE_EXECUTION_FAILED',
          message: 'Guest failed.'
        })
      ).toMatchObject([
        {
          itemId: 'mar-agent-tool:cell',
          kind: 'command_execution',
          status: 'FAILED',
          payload: {
            command: code,
            outputPreview: 'MAR_AGENT_CODE_EXECUTION_FAILED: Guest failed.',
            exitCode: null
          }
        }
      ]);
      const summary = '{"cellId":"retained","status":"running"}';
      expect(
        normalizer.normalize({
          ...base,
          type: 'tool.completed',
          toolName: 'code_exec',
          callId: 'cell',
          summary,
          data: { cellId: 'retained', status: 'running' }
        })
      ).toMatchObject([
        {
          itemId: 'mar-agent-tool:cell',
          kind: 'command_execution',
          status: 'COMPLETED',
          payload: { command: code, outputPreview: summary, exitCode: null }
        }
      ]);
    }
  );

  it('bounds Code Exec command input and failure output without inferring nested commands', () => {
    const normalizer = new MarAgentConversationNormalizer();
    const base = {
      eventId: 'event',
      sequence: 1,
      timestamp: '2026-10-01T00:00:00.000Z',
      sessionId: 's',
      executionId: 'e'
    };
    const started = normalizer.normalize({
      ...base,
      type: 'tool.started',
      toolName: 'code_exec',
      callId: 'cell',
      input: 'x'.repeat(20000)
    });
    expect(started[0]?.payload.truncated).toBe(true);
    expect((started[0]?.payload.command as string).length).toBeLessThanOrEqual(10000);
    const failed = normalizer.normalize({
      ...base,
      type: 'tool.failed',
      toolName: 'code_exec',
      callId: 'cell',
      code: 'MAR_AGENT_CODE_EXECUTION_FAILED',
      message: 'x'.repeat(20000)
    });
    expect(failed[0]?.payload.truncated).toBe(true);
    expect((failed[0]?.payload.outputPreview as string).length).toBeLessThanOrEqual(10000);
  });

  it('keeps ordinary tool cards visible in archived history', () => {
    const base = {
      eventId: 'event',
      sequence: 1,
      timestamp: '2026-10-01T00:00:00.000Z',
      sessionId: 'session',
      executionId: 'execution',
      turnId: 'turn'
    };
    const entries: MarAgentHistoryEntry[] = [
      {
        kind: 'event',
        sequence: 1,
        event: {
          ...base,
          type: 'tool.started',
          toolName: 'custom_tool',
          callId: 'legacy-cell',
          input: 'out.text("archived");'
        }
      },
      {
        kind: 'event',
        sequence: 2,
        event: {
          ...base,
          type: 'tool.completed',
          toolName: 'custom_tool',
          callId: 'legacy-cell',
          summary: 'archived output'
        }
      }
    ];

    const turns = projectMarAgentHistory(
      { id: 'node-session', runner: 'mar-agent' } as NodeAgentSession,
      entries
    );
    expect(turns.flatMap((turn) => turn.items)).toEqual([
      expect.objectContaining({
        id: 'mar-agent-tool:legacy-cell',
        kind: 'tool_call',
        status: 'COMPLETED',
        payload: expect.objectContaining({
          toolName: 'custom_tool',
          inputSummary: 'out.text("archived");',
          outputSummary: 'archived output'
        })
      })
    ]);
  });

  it.each(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'] as const)(
    'projects real SDK code_exec file changes and web tools in live and Catalog history for %s',
    async (protocol) => {
      const root = await mkdtemp(join(tmpdir(), 'mar-code-mode-projection-'));
      const workspace = join(root, 'workspace');
      const home = join(root, 'home');
      await mkdir(workspace);
      const command = `${JSON.stringify(process.execPath)} -e "process.stdout.write('nested')"`;
      const code = [
        `const command = await tools.exec({command: ${JSON.stringify(command)}, yieldMs: 5000});`,
        'await tools.apply_patch("*** Begin Patch\\n*** Add File: created.txt\\n+created\\n*** End Patch");',
        'try { await tools.apply_patch("invalid patch"); } catch (error) {}',
        'await tools.web_fetch({ url: "https://example.test/page", mode: "http" });',
        'await tools.web_search({ query: "Original query" });',
        'observe.text(command.data.stdout);'
      ].join('\n');
      const input = protocol === 'OPENAI_RESPONSES' ? code : { code };
      const model: MarAgentModelConfiguration = {
        id: 'projection',
        name: 'Projection',
        protocol,
        baseUrl: 'https://example.test',
        apiKey: new SecretValue('test'),
        modelId: 'projection',
        contextWindowTokens: 100_000,
        maxOutputTokens: 1_000,
        inputCapabilities: ['TEXT'],
        outputCapabilities: ['TEXT'],
        reasoningEfforts: [],
        hostedWebSearch: false,
        titleGeneration: false,
        codeMode: true,
        enabled: true
      };
      let round = 0;
      const adapter: ModelAdapter = {
        configuration: model,
        async *start(): AsyncIterable<ModelEvent> {
          if (round++ === 0) {
            yield { type: 'client_tool.call', callId: 'cell', name: 'code_exec', arguments: input };
            yield {
              type: 'client_tool.call',
              callId: 'direct-command',
              name: 'exec',
              arguments: { command, yieldMs: 5_000 }
            };
            yield { type: 'completed', reason: 'tool_use' };
          } else {
            yield { type: 'text.completed', itemId: 'answer', text: 'done' };
            yield { type: 'completed', reason: 'completed' };
          }
        }
      };
      const host = new LocalAgentHost({ homeDirectory: home, workspace });
      host.bindExecutionExtensions(
        createWebToolsExtensions({
          enabled: true,
          webFetch: async () => ({
            content: 'Original page',
            data: { url: 'https://example.test/page', mode: 'http', status: 200 }
          }),
          webSearch: async () => ({
            content: 'No sources',
            data: { query: 'Original query', results: [] }
          })
        })
      );
      const agent = await createMarAgent({
        mode: 'normal',
        host,
        models: [model],
        adapterFactory: () => adapter
      });
      try {
        const session = await agent.createSession({ workspace, title: 'code_exec projection' });
        const execution = session.run({ prompt: 'Compose tools, then run a direct command.' });
        const events: MarAgentEvent[] = [];
        for await (const event of execution) events.push(event);
        await expect(execution.result()).resolves.toMatchObject({ status: 'completed' });
        const toolEvents = events.filter(
          (event) =>
            event.type === 'tool.started' ||
            event.type === 'tool.completed' ||
            event.type === 'tool.failed'
        );
        const nested = toolEvents.filter(
          (event) => event.callId !== 'cell' && event.callId !== 'direct-command'
        );
        expect(nested).toHaveLength(10);
        expect(nested).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: 'tool.failed', toolName: 'apply_patch' })
          ])
        );
        for (const event of nested) expect(event).toHaveProperty('parentCallId', 'cell');
        for (const event of toolEvents.filter(
          (event) => event.callId === 'cell' || event.callId === 'direct-command'
        ))
          expect(event).not.toHaveProperty('parentCallId');
        const normalizer = new MarAgentConversationNormalizer();
        const live = new Map(
          events.flatMap((event) => normalizer.normalize(event)).map((item) => [item.itemId, item])
        );
        expect([...live.values()].filter((item) => item.kind === 'file_change')).toEqual([
          expect.objectContaining({
            status: 'COMPLETED',
            payload: {
              changes: [
                expect.objectContaining({
                  path: 'created.txt',
                  change: 'ADDED',
                  diffAvailable: true,
                  diff: expect.objectContaining({
                    status: 'available',
                    source: 'TOOL_CHANGE',
                    format: 'unified-diff'
                  })
                })
              ]
            }
          })
        ]);
        const expectedWebTools = [
          expect.objectContaining({
            status: 'COMPLETED',
            payload: expect.objectContaining({
              toolName: 'web_fetch',
              outputSummary: 'Original page',
              toolPresentation: expect.objectContaining({
                kind: 'WEB_FETCH',
                url: 'https://example.test/page',
                mode: 'http'
              })
            })
          }),
          expect.objectContaining({
            status: 'COMPLETED',
            payload: expect.objectContaining({
              toolName: 'web_search',
              toolPresentation: {
                kind: 'WEB_SEARCH',
                query: 'Original query',
                sources: [],
                sourceCount: 0
              }
            })
          })
        ];
        expect([...live.values()].filter((item) => item.kind === 'tool_call')).toEqual(
          expectedWebTools
        );
        const expectedPayload = {
          command: code,
          cwd: null,
          exitCode: null,
          outputPreview: expect.stringContaining('nested')
        };
        expect([...live.values()].filter((item) => item.kind === 'command_execution')).toEqual([
          expect.objectContaining({
            itemId: 'mar-agent-tool:cell',
            status: 'COMPLETED',
            payload: expect.objectContaining(expectedPayload)
          }),
          expect.objectContaining({ itemId: 'mar-agent-tool:direct-command' })
        ]);
        const catalog = await openMarAgentSessionCatalog({ homeDirectory: home });
        try {
          const history = await catalog.history(session.id, { limit: 200 });
          const turns = projectMarAgentHistory(
            { id: 'node-session', runner: 'mar-agent' } as NodeAgentSession,
            history.entries
          );
          const items = turns.flatMap((turn) => turn.items);
          expect(items.filter((item) => item.kind === 'file_change')).toEqual([
            expect.objectContaining({
              status: 'COMPLETED',
              payload: {
                changes: [
                  expect.objectContaining({
                    path: 'created.txt',
                    change: 'ADDED',
                    diffAvailable: true,
                    diff: expect.objectContaining({
                      status: 'available',
                      source: 'TOOL_CHANGE',
                      format: 'unified-diff'
                    })
                  })
                ]
              }
            })
          ]);
          expect(items.filter((item) => item.kind === 'tool_call')).toEqual(expectedWebTools);
          expect(items.filter((item) => item.kind === 'command_execution')).toEqual([
            expect.objectContaining({
              id: 'mar-agent-tool:cell',
              status: 'COMPLETED',
              payload: expect.objectContaining(expectedPayload)
            }),
            expect.objectContaining({ id: 'mar-agent-tool:direct-command' })
          ]);
        } finally {
          await catalog.close();
        }
      } finally {
        await agent.dispose();
        await host.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    20_000
  );
});
