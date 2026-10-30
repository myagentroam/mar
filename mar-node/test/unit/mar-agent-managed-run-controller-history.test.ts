import { executionActivity } from './support/execution-activity.js';
import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgent, SecretValue } from '@myagentroam/agent';
import { LocalAgentHost } from '@myagentroam/agent/host';
import {
  MarAgentManagedRunController,
  resolveRunModels
} from '../../src/runner/mar-agent/managed-run-controller.js';
import {
  MarAgentConversationNormalizer,
  normalizeMarAgentUsage
} from '../../src/runner/mar-agent/conversation-normalizer.js';
import { projectMarAgentHistory } from '../../src/runner/mar-agent/history-projection.js';
import { conversationSegments } from '../../src/service/conversation-segment-service.js';
import type { NodeAgentSession } from '../../src/database.js';
import { MarAgentRunner } from '../../src/runner/mar-agent-runner.js';
import {
  conversationItemSchema,
  serializeComposerTag,
  type MarAgentRuntimeModelConfiguration
} from '../../../packages/protocol/src/index.js';
import type { AgentEvent } from '../../../mar-agent/src/index.js';

const base = {
  eventId: 'event',
  sequence: 1,
  timestamp: '2026-01-01T00:00:00.000Z',
  sessionId: 'session',
  executionId: 'execution',
  turnId: 'turn'
};

describe('MAR Agent managed run projection', () => {
  it('projects separate latency and generation TPS from the built SDK over fake HTTP', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-node-model-performance-'));
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (event: unknown) => response.write(`data: ${JSON.stringify(event)}\n\n`);
      void (async () => {
        now = 100;
        send({
          type: 'message_start',
          message: { id: 'model-response', usage: { input_tokens: 10 } }
        });
        send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        await delay(20);
        now = 200;
        send({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Done.' }
        });
        await delay(20);
        now = 1_100;
        send({ type: 'content_block_stop', index: 0 });
        send({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 90 }
        });
        await delay(20);
        now = 5_000;
        send({ type: 'message_stop' });
        response.end();
      })();
    });
    let agent: Awaited<ReturnType<typeof createAgent>> | undefined;
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('Missing fake HTTP port.');
      agent = await createAgent({
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [
          {
            id: 'performance',
            name: 'Performance',
            protocol: 'ANTHROPIC_MESSAGES',
            baseUrl: `http://127.0.0.1:${address.port}`,
            apiKey: new SecretValue('test-only'),
            modelId: 'performance',
            contextWindowTokens: 10_000,
            maxOutputTokens: 512,
            inputCapabilities: ['TEXT'],
            outputCapabilities: ['TEXT'],
            reasoningEfforts: [],
            hostedWebSearch: false,
            responsesPreviousResponseId: false,
            titleGeneration: false,
            codeMode: false,
            enabled: true
          }
        ]
      });
      const emit = vi.fn();
      const emitItem = vi.fn();
      const controller = new MarAgentManagedRunController(new MarAgentRunner(), {
        ...executionActivity(),
        adopt: vi.fn(),
        promote: vi.fn(),
        syncTitle: vi.fn(),
        emit,
        emitItem,
        run: vi.fn(),
        commandState: vi.fn(),
        setCommandState: vi.fn(),
        clearCommandState: vi.fn(),
        commandStates: vi.fn(() => []),
        webSearch: vi.fn()
      });
      const project = controller as unknown as {
        project(runId: string, event: AgentEvent): void;
      };
      const session = await agent.createSession({ workspace });
      const execution = session.run({ prompt: 'Measure output.' });
      for await (const event of execution) project.project('run', event);
      await execution.result();
      expect(
        emit.mock.calls
          .filter(([, type]) => type === 'run.performance')
          .map(([, , payload]) => payload)
      ).toEqual([{ latencyMs: 200 }, { latencyMs: 200, tokensPerSecond: 90 }]);
      expect(JSON.stringify(emitItem.mock.calls)).not.toContain('output.started');
      expect(JSON.stringify(emitItem.mock.calls)).not.toContain('model.performance');
    } finally {
      await agent?.dispose();
      clock.mockRestore();
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  });

  it('merges standard search inputs and results onto one ordinary tool card', () => {
    const normalizer = new MarAgentConversationNormalizer();
    const pending = normalizer.normalize({
      ...base,
      type: 'tool.started',
      callId: 'ws_1',
      toolName: 'web_search'
    })[0];
    const input = { type: 'search', queries: ['first query', 'second query'] };
    const running = normalizer.normalize({
      ...base,
      type: 'tool.started',
      callId: 'ws_1',
      toolName: 'web_search',
      input
    })[0];
    const output = {
      sources: [
        { url: 'https://example.test/one', title: 'First source' },
        { url: 'https://example.test/two' }
      ]
    };
    const completed = normalizer.normalize({
      ...base,
      type: 'tool.completed',
      callId: 'ws_1',
      toolName: 'web_search',
      summary: JSON.stringify(output),
      truncated: true
    })[0];
    expect(pending).toMatchObject({
      itemId: 'mar-agent-tool:ws_1',
      payload: { inputSummary: null }
    });
    expect(running).toMatchObject({
      itemId: pending?.itemId,
      status: 'IN_PROGRESS',
      payload: {
        namespace: 'mar-agent',
        toolName: 'web_search',
        title: 'web_search',
        progressLabel: 'Running'
      }
    });
    expect(completed).toMatchObject({
      itemId: pending?.itemId,
      status: 'COMPLETED',
      payload: { progressLabel: null },
      merge: true
    });
    expect(JSON.parse(running?.payload.inputSummary as string)).toEqual(input);
    expect(JSON.parse(completed?.payload.inputSummary as string)).toEqual(input);
    expect(JSON.parse(completed?.payload.outputSummary as string)).toEqual(output);
    expect(completed?.payload).not.toHaveProperty('output.truncation');
  });

  it.each([
    { type: 'search', query: 'single query' },
    { type: 'search', queries: ['first query', 'second query'] },
    { type: 'open_page', url: 'https://example.test/page' },
    { type: 'find_in_page', url: 'https://example.test/page', pattern: 'exact phrase' },
    { type: 'open_page' }
  ])('projects ordinary tool action parameters unchanged: %j', (input) => {
    const normalizer = new MarAgentConversationNormalizer();
    const started = normalizer.normalize({
      ...base,
      type: 'tool.started',
      callId: 'native-web',
      toolName: 'web_search',
      input
    })[0];
    const completed = normalizer.normalize({
      ...base,
      type: 'tool.completed',
      callId: 'native-web',
      toolName: 'web_search',
      summary: ''
    })[0];
    expect(completed).toMatchObject({
      itemId: started?.itemId,
      kind: 'tool_call',
      status: 'COMPLETED',
      payload: {
        namespace: 'mar-agent',
        toolName: 'web_search',
        title: 'web_search',
        outputSummary: ''
      }
    });
    expect(JSON.parse(completed?.payload.inputSummary as string)).toEqual(input);
  });

  it.each(['web_search', 'web_fetch', 'read', 'skill', 'todo_read', 'mcp__test__lookup'])(
    'keeps ordinary %s names and inputs unchanged',
    (toolName) => {
      const input =
        toolName === 'web_search'
          ? { query: 'single query', limit: 5 }
          : { url: 'https://example.test/page', mode: 'browser' };
      const normalizer = new MarAgentConversationNormalizer();
      const item = normalizer.normalize({
        ...base,
        type: 'tool.started',
        callId: 'ordinary-web',
        toolName,
        input
      })[0];
      expect(item).toMatchObject({ kind: 'tool_call', payload: { toolName, title: toolName } });
      expect(JSON.parse(item?.payload.inputSummary as string)).toEqual(input);
      const summary = '{"content":"Actual tool result"}';
      const completed = normalizer.normalize({
        ...base,
        type: 'tool.completed',
        callId: 'ordinary-web',
        toolName,
        summary
      })[0];
      expect(completed).toMatchObject({
        itemId: item?.itemId,
        status: 'COMPLETED',
        payload: { toolName, title: toolName, outputSummary: summary }
      });
    }
  );

  it('preserves standard tool failures and producer truncation without tool-specific interpretation', () => {
    const normalizer = new MarAgentConversationNormalizer();
    const input = { type: 'find_in_page', pattern: 'exact phrase' };
    const output = { sources: [{ url: 'https://example.test', title: 'Actual source' }] };
    const started = normalizer.normalize({
      ...base,
      type: 'tool.started',
      callId: 'native-web-result',
      toolName: 'web_search',
      input,
      truncated: true
    })[0];
    const failed = normalizer.normalize({
      ...base,
      type: 'tool.failed',
      callId: 'native-web-result',
      toolName: 'web_search',
      code: 'HOSTED_TOOL_FAILED',
      message: JSON.stringify(output),
      truncated: true
    })[0];
    expect(started?.payload).not.toHaveProperty('output.truncation');
    expect(failed).toMatchObject({
      itemId: started?.itemId,
      kind: 'tool_call',
      status: 'FAILED',
      payload: {
        toolName: 'web_search',
        errorCode: 'HOSTED_TOOL_FAILED',
        errorMessage: JSON.stringify(output)
      }
    });
    expect(JSON.parse(failed?.payload.inputSummary as string)).toEqual(input);
    expect(failed?.payload).not.toHaveProperty('output.truncation');
  });

  it('marks ordinary tool input truncation through the shared projection', () => {
    const item = new MarAgentConversationNormalizer().normalize({
      ...base,
      type: 'tool.started',
      callId: 'long-input',
      toolName: 'web_search',
      input: { query: 'x'.repeat(10_001) }
    })[0];
    expect(item?.payload.inputTruncated).toBe(true);
    expect((item?.payload.inputSummary as string).length).toBeLessThanOrEqual(10_000);
  });

  it('marks a Turn complete only after the persisted execution terminal event', () => {
    const session = {
      id: 'session',
      runner: 'mar-agent',
      model: null,
      effort: null,
      access: null
    } as NodeAgentSession;
    const user = {
      kind: 'user' as const,
      sequence: 1,
      timestamp: base.timestamp,
      sessionId: 'session',
      executionId: 'execution',
      turnId: 'turn',
      clientMessageId: 'submission',
      text: 'Request'
    };
    expect(projectMarAgentHistory(session, [user])[0]?.completedAt).toBeNull();
    const completed = projectMarAgentHistory(session, [
      user,
      {
        kind: 'event',
        sequence: 2,
        event: {
          ...base,
          sequence: 2,
          type: 'execution.completed',
          eventId: 'completed'
        }
      }
    ]);
    expect(completed[0]?.status).toBe('SUCCEEDED');
    expect(completed[0]?.completedAt).toBe(Date.parse(base.timestamp));
  });

  it('keeps an injected user message after the preceding Agent reply in the same SDK Turn', () => {
    const session = {
      id: 'session',
      runner: 'mar-agent',
      model: null,
      effort: null,
      access: null
    } as NodeAgentSession;
    const [turn] = projectMarAgentHistory(session, [
      {
        kind: 'user',
        sequence: 1,
        timestamp: base.timestamp,
        sessionId: 'session',
        executionId: 'execution',
        turnId: 'turn',
        clientMessageId: 'submission',
        text: 'Initial request'
      },
      {
        kind: 'event',
        sequence: 2,
        event: {
          ...base,
          sequence: 2,
          eventId: 'reply',
          type: 'message.completed',
          itemId: 'reply',
          phase: 'commentary',
          modelId: 'model',
          modelName: 'Model',
          text: 'Agent reply'
        }
      },
      {
        kind: 'user',
        sequence: 3,
        timestamp: base.timestamp,
        sessionId: 'session',
        executionId: 'execution',
        turnId: 'turn',
        inputSource: 'parent_agent',
        text: 'Additional instruction'
      },
      {
        kind: 'event',
        sequence: 4,
        event: {
          ...base,
          sequence: 4,
          eventId: 'command',
          type: 'tool.started',
          toolName: 'exec',
          callId: 'command',
          input: { command: 'pwd' }
        }
      }
    ]);
    expect(
      turn?.items.map((item) => [item.kind, (item.payload as { text?: string }).text])
    ).toEqual([
      ['user_message', 'Initial request'],
      ['assistant_message', 'Agent reply'],
      ['user_message', 'Additional instruction'],
      ['command_execution', undefined]
    ]);
    expect(turn?.userItemId).toBe(turn?.items[0]?.id);
    expect(new Set(turn?.items.map((item) => item.id)).size).toBe(4);
    expect(
      conversationSegments(turn!).map((segment) => segment.items.map((item) => item.kind))
    ).toEqual([
      ['user_message', 'assistant_message'],
      ['user_message', 'command_execution']
    ]);
  });

  it('ignores legacy persisted performance when reading assistant history', () => {
    const session = {
      id: 'session',
      runner: 'mar-agent',
      model: null,
      effort: null,
      access: null
    } as NodeAgentSession;
    const [turn] = projectMarAgentHistory(session, [
      {
        kind: 'event',
        sequence: 1,
        event: {
          ...base,
          sequence: 1,
          eventId: 'completed-message',
          type: 'message.completed',
          itemId: 'reply',
          phase: 'final_answer',
          modelId: 'model',
          modelName: 'Model',
          text: 'Done.'
        }
      },
      {
        kind: 'event',
        sequence: 2,
        event: {
          ...base,
          sequence: 2,
          eventId: 'performance',
          type: 'message.performance',
          itemId: 'reply',
          ttftMs: 420,
          outputTokens: 84,
          outputDurationMs: 2_000,
          tokensPerSecond: 42
        }
      }
    ]);

    expect(turn?.items).toEqual([
      expect.objectContaining({
        id: 'mar-agent-message:reply',
        kind: 'assistant_message',
        status: 'COMPLETED',
        payload: {
          text: 'Done.',
          format: 'markdown',
          model: 'Model',
          phase: 'final_answer'
        }
      })
    ]);
  });
  it.each([
    [
      'mar_goal_start',
      'A Goal has started or changed.',
      serializeComposerTag('mar_goal_start', {
        objective: 'private objective',
        instruction: [
          'A Goal has started or changed.',
          '',
          'Continue executing this Goal across turns:',
          '- Work on the objective now.'
        ].join(String.fromCharCode(10))
      }),
      serializeComposerTag('mar_goal_start', { objective: 'private objective' })
    ],
    [
      'mar_goal_continue',
      'Continue the active Goal.',
      serializeComposerTag('mar_goal_continue', {
        objective: 'private objective',
        instruction: [
          'Continue the active Goal.',
          '',
          'Continue executing this Goal across turns:',
          '- Work on the objective now.'
        ].join(String.fromCharCode(10))
      }),
      serializeComposerTag('mar_goal_continue', {})
    ],
    [
      'mar_goal_continue',
      'A Goal has started or changed.',
      serializeComposerTag('mar_goal_continue', {
        objective: 'private objective',
        instruction: [
          'A Goal has started or changed.',
          '',
          'Continue executing this Goal across turns:',
          '- Work on the objective now.'
        ].join(String.fromCharCode(10))
      }),
      serializeComposerTag('mar_goal_continue', {})
    ],
    [
      'mar_goal_start',
      'Continue the active Goal.',
      serializeComposerTag('mar_goal_start', {
        objective: 'private objective',
        instruction: [
          'Continue the active Goal.',
          '',
          'Continue executing this Goal across turns:',
          '- Work on the objective now.'
        ].join(String.fromCharCode(10))
      }),
      serializeComposerTag('mar_goal_start', { objective: 'private objective' })
    ]
  ])(
    'replaces the internal %s prompt with public history text',
    (tag, heading, input, expected) => {
      const [turn] = projectMarAgentHistory(
        {
          id: 'session',
          runner: 'mar-agent',
          model: null,
          effort: null,
          access: null
        } as NodeAgentSession,
        [
          {
            kind: 'user',
            sequence: 1,
            timestamp: base.timestamp,
            sessionId: 'session',
            executionId: 'execution',
            turnId: 'turn',
            clientMessageId: 'goal-message',
            text: input
          }
        ]
      );

      const user = turn?.items.find((item) => item.kind === 'user_message');
      expect(user?.payload).toMatchObject({ text: expected });
      expect(JSON.stringify(user?.payload)).not.toContain(heading);
      expect(JSON.stringify(user?.payload)).not.toContain('Continue executing this Goal');
      if (tag === 'mar_goal_start')
        expect(JSON.stringify(user?.payload)).toContain('private objective');
      else expect(JSON.stringify(user?.payload)).not.toContain('private objective');
    }
  );

  it.each(['task', 'task_output', 'task_cancel'])(
    'does not recognize the removed %s alias',
    (toolName) => {
      const [item] = new MarAgentConversationNormalizer().normalize({
        ...base,
        type: 'tool.started',
        toolName,
        callId: 'removed-alias',
        input: { taskId: 'old-task' }
      });
      expect(item?.payload).not.toHaveProperty('subagentOperation');
      expect(item?.payload).not.toHaveProperty('subagentId');
    }
  );

  it.each([
    ['agent_start', 'START'],
    ['agent_wait', 'STATUS'],
    ['agent_send', 'MESSAGE'],
    ['agent_stop', 'CANCEL'],
    ['agent_message', 'MESSAGE'],
    ['agent_cancel', 'CANCEL']
  ])('maps %s and agentId at the MAR Runner boundary', (toolName, operation) => {
    const normalizer = new MarAgentConversationNormalizer();
    const projected = normalizer.normalize({
      ...base,
      type: 'tool.started',
      toolName,
      callId: 'agent-call',
      input: { agentId: 'agent-1', description: 'Inspect' }
    });
    expect(projected[0]?.payload).toMatchObject({
      subagentOperation: operation,
      subagentId: 'agent-1'
    });
  });

  it.each([undefined, 'any', 'all'] as const)(
    'restores task metadata across historical Turns for wait mode %s',
    (mode) => {
      const events: AgentEvent[] = [
        {
          ...base,
          type: 'tool.started',
          toolName: 'agent_wait',
          callId: 'task-output-call',
          input:
            mode === undefined
              ? { agentId: 'task-1', waitMs: 1_000 }
              : { agentIds: ['task-1'], mode, waitMs: 1_000 }
        },
        {
          ...base,
          eventId: 'subagent-completed',
          sequence: 2,
          type: 'subagent.completed',
          agentId: 'task-1',
          description: 'Check the implementation',
          status: 'completed'
        },
        {
          ...base,
          eventId: 'tool-completed',
          sequence: 3,
          type: 'tool.completed',
          toolName: 'agent_wait',
          callId: 'task-output-call',
          summary: 'completed',
          data: {
            agentId: 'task-1',
            description: 'Check the implementation',
            status: 'completed',
            modelId: 'review',
            modelName: 'Review Agent',
            reasoningEffort: 'high',
            latestMessage: {
              itemId: 'message-child',
              turnId: 'turn-child',
              phase: 'final_answer',
              text: 'Inspection completed.',
              timestamp: '2026-09-12T00:00:00.000Z',
              truncated: false
            }
          }
        }
      ];
      const result = events[2];
      if (mode !== undefined && result?.type === 'tool.completed')
        result.data = {
          mode,
          waitFor: 'completion',
          waitOutcome: 'completion',
          pendingAgentIds: [],
          agents: [result.data]
        } as NonNullable<typeof result.data>;
      const turn = projectMarAgentHistory(
        {
          id: 'session',
          runner: 'mar-agent',
          model: null,
          effort: null,
          access: null
        } as NodeAgentSession,
        events.map((event) => ({ kind: 'event' as const, sequence: event.sequence, event }))
      )[0];
      const control = turn?.items.find((item) => item.id === 'mar-agent-tool:task-output-call');

      expect(control).toMatchObject({
        kind: 'tool_call',
        status: 'COMPLETED',
        payload: {
          title: 'Check the implementation',
          subagentOperation: 'STATUS',
          subagentId: 'task-1',
          subagentModelId: 'review',
          subagentModelName: 'Review Agent',
          subagentReasoningEffort: 'high'
        }
      });
    }
  );

  it('preserves the original start receipt when replaying child lifecycle events', () => {
    const events: AgentEvent[] = [
      {
        ...base,
        eventId: 'start-started',
        sequence: 1,
        type: 'tool.started',
        toolName: 'agent_start',
        callId: 'start-call',
        input: {
          description: 'Check the implementation',
          prompt: 'Check the implementation',
          role: 'explore'
        }
      },
      {
        ...base,
        eventId: 'child-started',
        sequence: 2,
        type: 'subagent.started',
        agentId: 'task-1',
        description: 'Check the implementation',
        modelId: 'review',
        modelName: 'Review Agent',
        reasoningEffort: 'high'
      },
      {
        ...base,
        eventId: 'start-completed',
        sequence: 3,
        type: 'tool.completed',
        toolName: 'agent_start',
        callId: 'start-call',
        summary: 'started',
        data: { agentId: 'task-1', description: 'Check the implementation', status: 'running' }
      },
      {
        ...base,
        eventId: 'child-completed',
        sequence: 4,
        type: 'subagent.completed',
        agentId: 'task-1',
        status: 'completed',
        latestMessage: {
          itemId: 'message-child',
          turnId: 'turn-child',
          phase: 'final_answer',
          text: 'Inspection completed.',
          timestamp: '2026-09-12T00:00:00.000Z',
          truncated: false
        }
      }
    ];
    const turn = projectMarAgentHistory(
      {
        id: 'session',
        runner: 'mar-agent',
        model: null,
        effort: null,
        access: null
      } as NodeAgentSession,
      events.map((event) => ({ kind: 'event' as const, sequence: event.sequence, event }))
    )[0];
    const controls = turn?.items.filter((item) => item.kind === 'tool_call') ?? [];

    expect(controls).toEqual([
      expect.objectContaining({
        id: 'mar-agent-tool:start-call',
        status: 'COMPLETED',
        payload: expect.objectContaining({
          toolName: 'agent_start',
          title: 'Check the implementation',
          subagentOperation: 'START',
          subagentId: 'task-1',
          subagentModelId: 'review',
          outputSummary: 'started'
        })
      })
    ]);
  });

  it('retains Subagent model metadata without copying old messages across historical Turns', () => {
    const firstTurn = 'turn-start';
    const secondTurn = 'turn-status';
    const events: AgentEvent[] = [
      {
        ...base,
        turnId: firstTurn,
        type: 'subagent.completed',
        agentId: 'task-1',
        description: 'Check the implementation',
        status: 'completed',
        modelId: 'review',
        modelName: 'Review Agent',
        reasoningEffort: 'high',
        latestMessage: {
          itemId: 'message-child',
          turnId: 'turn-child',
          phase: 'final_answer',
          text: 'Inspection completed.',
          timestamp: '2026-09-12T00:00:00.000Z',
          truncated: false
        }
      },
      {
        ...base,
        eventId: 'status-started',
        sequence: 2,
        executionId: 'execution-status',
        turnId: secondTurn,
        type: 'tool.started',
        toolName: 'agent_wait',
        callId: 'status-call',
        input: { agentId: 'task-1', waitMs: 1_000 }
      },
      {
        ...base,
        eventId: 'status-completed',
        sequence: 3,
        executionId: 'execution-status',
        turnId: secondTurn,
        type: 'tool.completed',
        toolName: 'agent_wait',
        callId: 'status-call',
        summary: 'completed',
        data: {
          agentId: 'task-1',
          description: 'Check the implementation',
          status: 'completed'
        }
      }
    ];
    const turns = projectMarAgentHistory(
      {
        id: 'session',
        runner: 'mar-agent',
        model: null,
        effort: null,
        access: null
      } as NodeAgentSession,
      events.map((event) => ({ kind: 'event' as const, sequence: event.sequence, event }))
    );
    const control = turns
      .find((turn) => turn.id === secondTurn)
      ?.items.find((item) => item.id === 'mar-agent-tool:status-call');

    expect(control).toMatchObject({
      kind: 'tool_call',
      payload: {
        title: 'Check the implementation',
        subagentOperation: 'STATUS',
        subagentId: 'task-1',
        subagentModelId: 'review',
        subagentModelName: 'Review Agent',
        subagentReasoningEffort: 'high'
      }
    });
  });

  it('preserves command semantics and truncation state when a structured exec summary is truncated by length without an explicit marker', () => {
    const truncatedSummary = JSON.stringify({
      status: 'completed',
      stdout: 'x'.repeat(3_000),
      stderr: '',
      exitCode: 0,
      truncated: false
    }).slice(0, 2_000);
    const events: AgentEvent[] = [
      {
        ...base,
        type: 'tool.started',
        toolName: 'exec',
        callId: 'truncated-command',
        input: { command: 'pnpm test' }
      },
      {
        ...base,
        eventId: 'completed',
        sequence: 2,
        type: 'tool.completed',
        toolName: 'exec',
        callId: 'truncated-command',
        summary: truncatedSummary,
        truncated: false,
        data: {
          status: 'completed',
          exitCode: 0,
          truncated: false,
          stdoutBytes: 3_000,
          stderrBytes: 0,
          stdoutDroppedBytes: 0,
          stderrDroppedBytes: 0
        }
      }
    ];
    const historyItem = projectMarAgentHistory(
      {
        id: 'session',
        runner: 'mar-agent',
        model: null,
        effort: null,
        access: null
      } as NodeAgentSession,
      events.map((event) => ({ kind: 'event' as const, sequence: event.sequence, event }))
    )[0]?.items[0];

    expect(historyItem).toMatchObject({
      kind: 'command_execution',
      status: 'COMPLETED',
      payload: {
        command: 'pnpm test',
        exitCode: 0
      }
    });
    expect(historyItem?.payload).not.toHaveProperty('output');
  });

  it('preserves the user attachment prompt and image placeholder from MAR Agent history after Node restart', () => {
    const runnerInput =
      'Read the attachment\n\nAttachments available in the Workspace:\n- .mar/temp-files/run/notes.pdf';
    const turn = projectMarAgentHistory(
      {
        id: 'session',
        runner: 'mar-agent',
        model: null,
        effort: null,
        access: null
      } as NodeAgentSession,
      [
        {
          kind: 'user',
          sequence: 1,
          timestamp: '2026-08-31T00:00:00.000Z',
          sessionId: 'session',
          executionId: 'execution',
          turnId: 'turn',
          text: runnerInput,
          clientMessageId: 'message-with-attachment',
          images: [{ name: 'diagram.png', mimeType: 'image/png', byteSize: 3 }]
        }
      ] as never
    )[0];

    expect(turn?.runId).toBeNull();
    expect(turn?.items[0]?.payload).toMatchObject({
      text: runnerInput,
      clientMessageId: 'message-with-attachment',
      attachments: [{ name: 'diagram.png', mime: 'image/png', byteSize: 3 }]
    });
  });

  it('projects a structured SDK execution failure as a user-visible error item', () => {
    const event: AgentEvent = {
      ...base,
      type: 'execution.failed',
      code: 'MAR_AGENT_MODEL_PROTOCOL_ERROR',
      message: 'Model endpoint returned HTTP 504.'
    };
    const [item] = new MarAgentConversationNormalizer().normalize(event);

    expect(item).toEqual({
      itemId: 'mar-agent-error:execution',
      kind: 'error',
      status: 'FAILED',
      payload: {
        code: 'MAR_AGENT_MODEL_PROTOCOL_ERROR',
        httpStatus: 504,
        message: 'Model endpoint returned HTTP 504.',
        recoverable: true,
        retryAfterMs: null
      },
      merge: true
    });
    expectNormalizedItemsValid(item === undefined ? [] : [item]);

    const historyTurn = projectMarAgentHistory(
      {
        id: 'session',
        runner: 'mar-agent',
        model: null,
        effort: null,
        access: null
      } as NodeAgentSession,
      [{ kind: 'event', sequence: event.sequence, event }]
    )[0];
    expect(historyTurn).toMatchObject({
      status: 'FAILED',
      items: [
        {
          id: item?.itemId,
          kind: 'error',
          status: 'FAILED',
          payload: item?.payload
        }
      ]
    });
  });

  it('projects streamed and completed assistant content onto one stable item', () => {
    const emit = vi.fn();
    const emitItem = vi.fn();
    const controller = new MarAgentManagedRunController(new MarAgentRunner(), {
      ...executionActivity(),
      adopt: vi.fn(),
      promote: vi.fn(),
      syncTitle: vi.fn(),
      emit,
      emitItem,
      run: vi.fn(),
      commandState: vi.fn(),
      setCommandState: vi.fn(),
      clearCommandState: vi.fn(),
      commandStates: vi.fn(() => []),
      webSearch: vi.fn()
    });
    const project = (event: AgentEvent) =>
      (
        controller as unknown as {
          project(runId: string, event: AgentEvent): void;
        }
      ).project('run', event);

    project({
      ...base,
      type: 'message.delta',
      itemId: 'model-message',
      phase: 'final_answer',
      delta: 'O'
    });
    project({
      ...base,
      eventId: 'completed',
      type: 'message.completed',
      itemId: 'model-message',
      phase: 'final_answer',
      text: 'OK',
      modelId: 'review',
      modelName: 'Review Agent'
    });
    project({
      ...base,
      eventId: 'performance',
      type: 'model.performance',
      latencyMs: 420,
      outputTokens: 84,
      outputDurationMs: 2_000,
      tokensPerSecond: 42
    });

    expect(emit).toHaveBeenCalledWith('run', 'text.delta', {
      text: 'O',
      phase: 'final_answer',
      itemId: 'mar-agent-message:model-message'
    });
    expect(emitItem).toHaveBeenCalledWith(
      'run',
      expect.objectContaining({
        itemId: 'mar-agent-message:model-message',
        kind: 'assistant_message',
        payload: expect.objectContaining({ model: 'Review Agent' })
      })
    );
    expect(emitItem).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('run', 'run.performance', {
      latencyMs: 420,
      tokensPerSecond: 42
    });
    project({
      ...base,
      eventId: 'performance-tps-only',
      type: 'model.performance',
      outputTokens: 100,
      outputDurationMs: 1_000,
      tokensPerSecond: 100
    });
    expect(emit).toHaveBeenLastCalledWith('run', 'run.performance', { tokensPerSecond: 100 });
  });

  it('normalizes SDK questions to the shared conversation contract', async () => {
    const emitItem = vi.fn();
    const controller = new MarAgentManagedRunController(new MarAgentRunner(), {
      ...executionActivity(),
      adopt: vi.fn(),
      promote: vi.fn(),
      syncTitle: vi.fn(),
      emit: vi.fn(),
      emitItem,
      run: vi.fn(),
      commandState: vi.fn(),
      setCommandState: vi.fn(),
      clearCommandState: vi.fn(),
      commandStates: vi.fn(() => []),
      webSearch: vi.fn()
    });
    const pending = (
      controller as unknown as {
        requestQuestion(
          runId: string,
          request: { requestId: string; questions: unknown[] }
        ): Promise<Record<string, unknown>>;
        respondUserInput(
          runId: string,
          requestId: string,
          answers: Record<string, unknown>
        ): boolean;
      }
    ).requestQuestion('run', {
      requestId: 'request',
      questions: [
        {
          id: 'choice',
          header: 'Mode',
          question: 'Choose a mode',
          options: [{ label: 'Safe', description: 'Ask before writes.' }]
        }
      ]
    });
    const emitted = emitItem.mock.calls[0]?.[1];
    expect(
      conversationItemSchema.safeParse({
        id: emitted.itemId,
        sessionId: 'session',
        turnId: 'turn',
        runId: 'run',
        parentItemId: null,
        sourceSequence: 1,
        revision: 0,
        status: emitted.status,
        startedAt: 1,
        completedAt: null,
        kind: emitted.kind,
        payload: emitted.payload
      }).success
    ).toBe(true);
    expect(emitted.payload.questions[0]).toEqual({
      id: 'choice',
      prompt: 'Choose a mode',
      input: 'SINGLE_SELECT',
      options: [{ value: 'Safe', label: 'Safe', description: 'Ask before writes.' }],
      allowOther: true
    });
    expect(controller.respondUserInput('run', 'request', { choice: ['Safe'] })).toBe(true);
    await expect(pending).resolves.toEqual({ choice: 'Safe' });
  });

  it('releases a pending question immediately when execution is aborted', async () => {
    const controller = new MarAgentManagedRunController(new MarAgentRunner(), {
      ...executionActivity(),
      adopt: vi.fn(),
      promote: vi.fn(),
      syncTitle: vi.fn(),
      emit: vi.fn(),
      emitItem: vi.fn(),
      run: vi.fn(),
      commandState: vi.fn(),
      setCommandState: vi.fn(),
      clearCommandState: vi.fn(),
      commandStates: vi.fn(() => []),
      webSearch: vi.fn()
    });
    const internals = controller as unknown as {
      requestQuestion(
        runId: string,
        request: { requestId: string; questions: unknown[] },
        signal: AbortSignal
      ): Promise<Record<string, unknown>>;
      respondUserInput(runId: string, requestId: string, answers: Record<string, unknown>): boolean;
    };
    const abort = new AbortController();
    const question = internals.requestQuestion(
      'run',
      {
        requestId: 'cancelled-question',
        questions: [
          {
            id: 'choice',
            question: 'Choose',
            options: [{ label: 'A', description: 'A' }]
          }
        ]
      },
      abort.signal
    );

    abort.abort();

    await expect(Promise.race([question, delayed('question did not cancel')])).resolves.toEqual({});
    expect(internals.respondUserInput('run', 'cancelled-question', { choice: 'A' })).toBe(false);
  });

  it('projects Todo updates as task lists and refreshes context when MAR Agent context usage changes', () => {
    const emitItem = vi.fn();
    const refreshContext = vi.fn();
    const controller = new MarAgentManagedRunController(new MarAgentRunner(), {
      ...executionActivity(),
      adopt: vi.fn(),
      promote: vi.fn(),
      syncTitle: vi.fn(),
      emit: vi.fn(),
      emitItem,
      refreshContext,
      run: vi.fn(),
      commandState: vi.fn(),
      setCommandState: vi.fn(),
      clearCommandState: vi.fn(),
      commandStates: vi.fn(() => []),
      webSearch: vi.fn()
    });
    const project = (event: AgentEvent) =>
      (
        controller as unknown as {
          project(runId: string, event: AgentEvent): void;
        }
      ).project('run', event);
    project({
      ...base,
      type: 'todo.updated',
      revision: 1,
      items: [
        { id: 'one', step: 'Inspect', status: 'completed' },
        { id: 'two', step: 'Implement', status: 'in_progress' },
        { id: 'three', step: 'Verify', status: 'pending' }
      ]
    });
    project({
      ...base,
      type: 'reasoning.completed',
      itemId: 'reasoning-one',
      representation: 'summary',
      text: 'Checked the change.'
    });
    project({
      ...base,
      eventId: 'output-usage-updated',
      type: 'usage.updated',
      outputTokens: 500
    });
    project({
      ...base,
      eventId: 'usage-updated',
      type: 'usage.updated',
      inputTokens: 12_000,
      contextInputTokens: 18_000
    });
    project({
      ...base,
      eventId: 'compact-usage-updated',
      type: 'usage.updated',
      purpose: 'compact',
      inputTokens: 24_000,
      contextInputTokens: 24_000
    });
    project({
      ...base,
      type: 'tool.completed',
      callId: 'web',
      toolName: 'web_search',
      summary: ''
    });
    project({ ...base, type: 'subagent.started', agentId: 'agent_start', description: 'Inspect' });
    project({ ...base, type: 'subagent.completed', agentId: 'agent_start', status: 'completed' });
    project({
      ...base,
      eventId: 'compact-started',
      type: 'context.compacting',
      compactionId: 'compaction-1',
      async: true,
      stage: 'GENERATING',
      anchor: { kind: 'message', id: 'prefix-message' }
    });
    project({
      ...base,
      eventId: 'compact-waiting',
      type: 'context.compacting',
      compactionId: 'compaction-1',
      async: true,
      stage: 'WAITING'
    });
    project({
      ...base,
      eventId: 'compact-completed',
      type: 'context.compacted',
      compactionId: 'compaction-1',
      async: true,
      retainedContext: true
    });
    expect(emitItem.mock.calls.map((call) => call[1].kind)).toEqual([
      'todo_list',
      'reasoning',
      'tool_call',
      'context_compaction',
      'context_compaction',
      'context_compaction'
    ]);
    expect(refreshContext).toHaveBeenCalledTimes(2);
    expect(refreshContext).toHaveBeenNthCalledWith(1, 'run');
    expect(refreshContext).toHaveBeenNthCalledWith(2, 'run');
    expect(emitItem.mock.calls[0]?.[1]).toMatchObject({
      kind: 'todo_list',
      payload: {
        items: [
          { id: 'one', text: 'Inspect', status: 'COMPLETED' },
          { id: 'two', text: 'Implement', status: 'IN_PROGRESS' },
          { id: 'three', text: 'Verify', status: 'PENDING' }
        ]
      }
    });
    expect(emitItem.mock.calls[2]?.[1]).toMatchObject({
      status: 'COMPLETED',
      payload: { namespace: 'mar-agent', toolName: 'web_search' }
    });
    const compactionItems = emitItem.mock.calls
      .map((call) => call[1])
      .filter((item) => item.kind === 'context_compaction');
    expect(compactionItems).toEqual([
      expect.objectContaining({
        itemId: 'mar-agent-compact:compaction-1',
        status: 'IN_PROGRESS',
        payload: {
          phase: 'STARTED',
          summary: null,
          mode: 'BACKGROUND',
          stage: 'GENERATING',
          anchorItemId: 'run:mar-agent-message:prefix-message'
        },
        merge: true
      }),
      expect.objectContaining({
        itemId: 'mar-agent-compact:compaction-1',
        status: 'IN_PROGRESS',
        payload: {
          phase: 'STARTED',
          summary: null,
          mode: 'BACKGROUND',
          stage: 'WAITING'
        },
        merge: true
      }),
      expect.objectContaining({
        itemId: 'mar-agent-compact:compaction-1',
        status: 'COMPLETED',
        payload: {
          phase: 'COMPLETED',
          summary: null,
          mode: 'BACKGROUND',
          retainedContext: true
        },
        merge: true
      })
    ]);
    expectNormalizedItemsValid(compactionItems);
    expect(
      normalizeMarAgentUsage({
        recordId: 'usage-record',
        requestId: 'usage-request',
        revision: 2,
        modelConfigurationId: 'coding',
        modelName: 'Coding',
        provider: 'OPENAI_RESPONSES',
        requestedModel: 'provider-coding',
        startedAt: 1,
        endedAt: 2,
        state: 'succeeded',
        sessionId: 'session',
        executionId: 'execution',
        purpose: 'compact',
        agentRole: 'root',
        inputTokens: '24000',
        outputTokens: '500'
      })
    ).toMatchObject({
      purpose: 'compact',
      inputTokens: '24000',
      outputTokens: '500',
      coverage: 'request'
    });

    const projectedHistory = projectMarAgentHistory(
      {
        id: 'session',
        runner: 'mar-agent',
        model: null,
        effort: null,
        access: null
      } as NodeAgentSession,
      [
        {
          kind: 'event',
          sequence: 2,
          event: {
            ...base,
            eventId: 'compact-history-start',
            sequence: 2,
            type: 'context.compacting',
            compactionId: 'compaction-1',
            async: true,
            stage: 'GENERATING',
            anchor: { kind: 'message', id: 'prefix-message' }
          }
        },
        {
          kind: 'event',
          sequence: 3,
          event: {
            ...base,
            eventId: 'compact-history-tail',
            sequence: 3,
            type: 'message.completed',
            itemId: 'tail-message',
            phase: 'final_answer',
            text: 'Continued work.',
            modelId: 'coding',
            modelName: 'Coding'
          }
        },
        {
          kind: 'event',
          sequence: 4,
          event: {
            ...base,
            eventId: 'compact-history-completed',
            sequence: 4,
            type: 'context.compacted',
            compactionId: 'compaction-1',
            retainedContext: true
          }
        }
      ]
    )[0]?.items;
    expect(projectedHistory?.map((item) => item.id)).toEqual([
      'mar-agent-compact:compaction-1',
      'mar-agent-message:tail-message'
    ]);
    expect(projectedHistory?.[0]).toMatchObject({
      status: 'COMPLETED',
      payload: {
        phase: 'COMPLETED',
        mode: 'BACKGROUND',
        retainedContext: true,
        anchorItemId: 'mar-agent-message:prefix-message'
      }
    });
  });

  it('projects compact failure and cancellation as terminal states on the same item identity', () => {
    const normalizer = new MarAgentConversationNormalizer();
    const failed = normalizer.normalize({
      ...base,
      type: 'context.compact_failed',
      compactionId: 'compact-failed',
      code: 'MAR_AGENT_COMPACT_FAILED',
      async: true,
      anchor: { kind: 'message', id: 'prefix-message' }
    });
    const cancelled = normalizer.normalize({
      ...base,
      type: 'context.compact_failed',
      compactionId: 'compact-cancelled',
      code: 'MAR_AGENT_COMPACT_CANCELLED',
      cancelled: true,
      async: true
    });

    expect(failed).toMatchObject([
      {
        itemId: 'mar-agent-compact:compact-failed',
        kind: 'context_compaction',
        status: 'FAILED',
        payload: {
          phase: 'STARTED',
          mode: 'BACKGROUND',
          code: 'MAR_AGENT_COMPACT_FAILED',
          anchorItemId: 'mar-agent-message:prefix-message'
        },
        merge: true
      }
    ]);
    expect(cancelled).toMatchObject([
      {
        itemId: 'mar-agent-compact:compact-cancelled',
        status: 'CANCELLED',
        payload: { phase: 'STARTED', mode: 'BACKGROUND', code: 'MAR_AGENT_COMPACT_CANCELLED' },
        merge: true
      }
    ]);
    expectNormalizedItemsValid([...failed, ...cancelled]);
  });

  it('retains a mapped Compact anchor when waiting and failure events omit it', () => {
    const [turn] = projectMarAgentHistory(
      {
        id: 'session',
        runner: 'mar-agent',
        model: null,
        effort: null,
        access: null
      } as NodeAgentSession,
      [
        {
          kind: 'event',
          sequence: 1,
          event: {
            ...base,
            eventId: 'compact-start',
            sequence: 1,
            type: 'context.compacting',
            compactionId: 'compact-retained-anchor',
            async: true,
            stage: 'GENERATING',
            anchor: { kind: 'message', id: 'prefix-message' }
          }
        },
        {
          kind: 'event',
          sequence: 2,
          event: {
            ...base,
            eventId: 'compact-waiting-no-anchor',
            sequence: 2,
            type: 'context.compacting',
            compactionId: 'compact-retained-anchor',
            async: true,
            stage: 'WAITING'
          }
        },
        {
          kind: 'event',
          sequence: 3,
          event: {
            ...base,
            eventId: 'compact-failed-no-anchor',
            sequence: 3,
            type: 'context.compact_failed',
            compactionId: 'compact-retained-anchor',
            async: true,
            code: 'MAR_AGENT_COMPACT_FAILED'
          }
        }
      ]
    );

    expect(turn?.items).toMatchObject([
      {
        id: 'mar-agent-compact:compact-retained-anchor',
        status: 'FAILED',
        payload: {
          phase: 'STARTED',
          mode: 'BACKGROUND',
          anchorItemId: 'mar-agent-message:prefix-message',
          code: 'MAR_AGENT_COMPACT_FAILED'
        }
      }
    ]);
  });

  it('maps message and tracked tool anchors to public item IDs and omits unknown tools', () => {
    const normalizer = new MarAgentConversationNormalizer();
    const [messageAnchor] = normalizer.normalize(
      {
        ...base,
        type: 'context.compacting',
        compactionId: 'message-anchor',
        async: true,
        anchor: { kind: 'message', id: 'message-1' }
      },
      { publicItemIdPrefix: 'run-1' }
    );
    expect(messageAnchor?.payload.anchorItemId).toBe('run-1:mar-agent-message:message-1');

    normalizer.normalize({
      ...base,
      type: 'tool.started',
      toolName: 'read',
      callId: 'tool-1',
      input: { path: 'src/index.ts' }
    });
    const [toolAnchor] = normalizer.normalize({
      ...base,
      type: 'context.compacting',
      compactionId: 'tool-anchor',
      async: true,
      anchor: { kind: 'tool', id: 'tool-1' }
    });
    expect(toolAnchor?.payload.anchorItemId).toBe('mar-agent-tool:tool-1');

    const [unknownTool] = normalizer.normalize({
      ...base,
      type: 'context.compacting',
      compactionId: 'unknown-tool-anchor',
      async: true,
      anchor: { kind: 'tool', id: 'missing-tool' }
    });
    expect(unknownTool?.payload).not.toHaveProperty('anchorItemId');
    expectNormalizedItemsValid([messageAnchor!, toolAnchor!, unknownTool!]);
  });

  it('resolves all enabled models with deduplication and falls back to a single model when none are available', () => {
    const current: MarAgentRuntimeModelConfiguration = {
      id: 'coding',
      name: 'Coding',
      protocol: 'ANTHROPIC_MESSAGES',
      baseUrl: 'https://example.test',
      credential: { type: 'INLINE_API_KEY', value: 'current-key' },
      modelId: 'coding',
      contextWindowTokens: 200_000,
      maxOutputTokens: 4096,
      inputCapabilities: ['TEXT'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: [],
      hostedWebSearch: false,
      responsesPreviousResponseId: false,
      enabled: true
    };
    const extra: MarAgentRuntimeModelConfiguration = {
      ...current,
      id: 'review',
      name: 'Review Mini',
      credential: { type: 'INLINE_API_KEY', value: 'review-key' },
      modelId: 'review'
    };

    expect(resolveRunModels(current, undefined)).toHaveLength(1);
    expect(resolveRunModels(current, 'invalid')).toHaveLength(1);

    const models = resolveRunModels(current, [extra, current, { id: 'broken' }, 'garbage']);
    expect(models.map((model) => model.id)).toEqual(['review', 'coding']);
    expect(models[0]?.credential).toEqual({ type: 'INLINE_API_KEY', value: 'review-key' });
    expect(models[1]?.credential).toEqual({ type: 'INLINE_API_KEY', value: 'current-key' });
    expect(resolveRunModels(current, [extra]).map((candidate) => candidate.id)).toEqual([
      'review',
      'coding'
    ]);
  });
});

function expectNormalizedItemsValid(
  items: readonly ReturnType<MarAgentConversationNormalizer['normalize']>[number][]
): void {
  for (const item of items)
    expect(
      conversationItemSchema.safeParse({
        id: item.itemId,
        sessionId: 'session',
        turnId: 'turn',
        runId: 'run',
        parentItemId: null,
        sourceSequence: 1,
        revision: 0,
        status: item.status,
        startedAt: 1,
        completedAt: item.status === 'IN_PROGRESS' ? null : 2,
        kind: item.kind,
        payload: item.payload
      }).success
    ).toBe(true);
}

function delayed(message: string): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), 100);
    timer.unref();
  });
}
