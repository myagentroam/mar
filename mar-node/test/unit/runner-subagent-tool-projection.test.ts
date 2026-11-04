import { describe, expect, it } from 'vitest';
import {
  normalizeClaudeTool,
  extractClaudeToolResults
} from '../../src/runner/claude/tool-normalizer.js';
import { normalizeCodexTool } from '../../src/runner/codex/tool-normalizer.js';
import { MarAgentConversationNormalizer } from '../../src/runner/mar-agent/conversation-normalizer.js';
import { normalizeOpenCodeTool } from '../../src/runner/opencode/tool-normalizer.js';

const base = {
  eventId: 'event',
  sequence: 1,
  timestamp: '2026-08-30T00:00:00.000Z',
  sessionId: 'session',
  executionId: 'execution',
  turnId: 'turn'
};

describe('Runner subagent lifecycle tool projection', () => {
  it('projects confirmed structured native start and message bodies without reading JSON history', () => {
    const codex = normalizeCodexTool({
      name: 'spawn_agent',
      namespace: 'collaboration',
      rawInput: { task_name: 'review', message: 'Inspect\nthis' }
    });
    expect(codex.payload).toMatchObject({
      subagentOperation: 'START',
      subagentCallDetail: { message: 'Inspect\nthis' }
    });
    const claude = normalizeClaudeTool(
      'Agent',
      { description: 'review', prompt: 'Inspect\nthis' },
      null,
      false,
      false
    );
    expect(claude.payload).toMatchObject({
      subagentOperation: 'START',
      subagentCallDetail: { message: 'Inspect\nthis' }
    });
    const openCode = normalizeOpenCodeTool('task', {
      input: { description: 'review', prompt: 'Inspect\nthis' }
    });
    expect(openCode.payload).toMatchObject({
      subagentOperation: 'START',
      subagentCallDetail: { message: 'Inspect\nthis' }
    });
    const sent = normalizeCodexTool({
      name: 'send_input',
      rawInput: { id: 'peer', message: 'Continue' }
    });
    expect(sent.payload).toMatchObject({
      subagentOperation: 'MESSAGE',
      subagentCallDetail: { message: 'Continue' }
    });
    const claudeSent = normalizeClaudeTool(
      'SendMessage',
      { to: 'peer', message: 'Continue' },
      null,
      false,
      false
    );
    expect(claudeSent.payload).toMatchObject({
      subagentOperation: 'MESSAGE',
      subagentId: 'peer',
      subagentCallDetail: { message: 'Continue' }
    });
    for (const [withBody, withoutBody] of [
      [
        normalizeCodexTool({
          name: 'spawn_agent',
          rawInput: { task_name: 'review', message: 'body' }
        }),
        normalizeCodexTool({ name: 'spawn_agent', rawInput: { task_name: 'review' } })
      ],
      [
        normalizeClaudeTool('Agent', { description: 'review', prompt: 'body' }, null, false, false),
        normalizeClaudeTool('Agent', { description: 'review' }, null, false, false)
      ],
      [
        normalizeOpenCodeTool('task', { input: { description: 'review', prompt: 'body' } }),
        normalizeOpenCodeTool('task', { input: { description: 'review' } })
      ]
    ] as const) {
      for (const field of ['subagentOperation', 'subagentId', 'title', 'toolName', 'namespace'])
        expect(withBody.payload[field]).toEqual(withoutBody.payload[field]);
    }
    expect(
      normalizeCodexTool({ name: 'spawn_agent', rawInput: '{"message":"legacy"}' }).payload
    ).not.toHaveProperty('subagentCallDetail');
    const bounded = normalizeOpenCodeTool('task', { input: { prompt: '😀'.repeat(1100) } });
    expect(bounded.payload.subagentCallDetail).toMatchObject({
      message: '😀'.repeat(1000),
      messageTruncated: true
    });
  });
  it('keeps resolved wait targets from a running update through partial completion', () => {
    const normalizer = new MarAgentConversationNormalizer();
    const targets = [
      { agentId: 'a', sessionId: 'a', title: 'First task' },
      { agentId: 'b', sessionId: 'b', title: 'Second task' }
    ];
    normalizer.normalize({
      ...base,
      type: 'tool.started',
      toolName: 'agent_wait',
      callId: 'wait',
      input: { agentIds: ['a', 'b'] }
    });
    const [running] = normalizer.normalize({
      ...base,
      type: 'tool.updated',
      toolName: 'agent_wait',
      callId: 'wait',
      data: { agentOperation: { action: 'WAIT', targets } }
    });
    expect(running).toMatchObject({
      status: 'IN_PROGRESS',
      payload: { agentOperation: { targets } }
    });
    const [done] = normalizer.normalize({
      ...base,
      type: 'tool.completed',
      toolName: 'agent_wait',
      callId: 'wait',
      summary: '{}',
      data: {
        agentOperation: {
          action: 'WAIT',
          targets: [{ agentId: 'a', sessionId: 'a' }, { agentId: 'b' }]
        }
      }
    });
    expect(done).toMatchObject({ status: 'COMPLETED', payload: { agentOperation: { targets } } });
  });
  it('projects only an explicit, identity-matched product Session mapping', () => {
    for (const [data, expected] of [
      [{ agentId: 'child', sessionId: 'child' }, undefined],
      [{ agentId: 'child', productSessionId: 'another' }, undefined],
      [{ agentId: 'child', productSessionId: 'child' }, 'child']
    ] as const) {
      const normalizer = new MarAgentConversationNormalizer();
      normalizer.normalize({
        ...base,
        type: 'tool.started',
        toolName: 'agent_start',
        callId: 'call',
        input: { content: 'task' }
      });
      const [item] = normalizer.normalize({
        ...base,
        type: 'tool.completed',
        toolName: 'agent_start',
        callId: 'call',
        summary: 'done',
        data
      });
      expect(item?.payload.subagentSessionId).toBe(expected);
    }
  });
  it('associates Claude structured results only with an unambiguous root tool result', () => {
    const first = {
      type: 'tool_result',
      tool_use_id: 'first',
      content: 'First output',
      is_error: true
    };
    const second = { type: 'tool_result', tool_use_id: 'second', content: 'Second output' };
    const metadata = {
      agentId: 'child',
      task_type: 'local_agent',
      content: 'Not a public tool result'
    };
    const single = extractClaudeToolResults({
      parent_tool_use_id: null,
      tool_use_result: metadata,
      message: { content: [first] }
    });
    expect(single).toEqual([
      {
        toolUseId: 'first',
        output: 'First output',
        failed: true,
        truncated: false,
        claudeResult: { agentId: 'child', task_type: 'local_agent' }
      }
    ]);
    expect(
      extractClaudeToolResults({
        parent_tool_use_id: 'parent',
        tool_use_result: metadata,
        message: { content: [first] }
      })
    ).toEqual([]);
    const multiple = extractClaudeToolResults({
      tool_use_result: metadata,
      message: { content: [first, second] }
    });
    expect(multiple).toHaveLength(2);
    for (const result of multiple) expect(result).not.toHaveProperty('claudeResult');
    expect(
      extractClaudeToolResults({
        parent_tool_use_id: 'parent',
        tool_use_result: metadata,
        message: { content: [] }
      })
    ).toEqual([]);
  });

  it('keeps unknown and shell Claude tasks ordinary while linking confirmed agent controls', () => {
    const known = new Map<string, string>();
    expect(
      normalizeClaudeTool(
        'TaskOutput',
        { task_id: 'unknown', block: true },
        null,
        false,
        false,
        known
      ).payload
    ).not.toHaveProperty('subagentOperation');
    expect(
      normalizeClaudeTool(
        'TaskStop',
        { task_id: 'shell' },
        JSON.stringify({ task_type: 'local_bash' }),
        false,
        false,
        known
      ).payload
    ).not.toHaveProperty('subagentOperation');
    normalizeClaudeTool(
      'Agent',
      { description: 'Review' },
      JSON.stringify({ agentId: 'child' }),
      false,
      false,
      known
    );
    expect(
      normalizeClaudeTool(
        'TaskOutput',
        { task_id: 'child', block: true },
        null,
        false,
        false,
        known
      ).payload
    ).toMatchObject({
      subagentId: 'child',
      title: 'Review',
      subagentOperation: 'STATUS',
      subagentWait: true
    });
    expect(
      normalizeClaudeTool(
        'TaskOutput',
        { task_id: 'child', block: false },
        null,
        false,
        false,
        known
      ).payload
    ).toMatchObject({ subagentWait: false });
  });

  it('does not select a single target from a multi-target Codex wait', () => {
    expect(
      normalizeCodexTool({
        name: 'wait_agent',
        rawInput: { targets: ['a', 'b'] },
        outputSummary: JSON.stringify({ agent_id: 'a' })
      }).payload
    ).toMatchObject({ subagentId: null, subagentWait: true });
  });

  it('does not copy an observed message into a later MAR snapshot or failure', () => {
    const normalizer = new MarAgentConversationNormalizer();
    const message = {
      itemId: 'm',
      turnId: 'child-turn',
      phase: 'commentary' as const,
      text: 'Old progress',
      timestamp: base.timestamp,
      truncated: false
    };
    normalizer.normalize({
      ...base,
      type: 'tool.completed',
      toolName: 'agent_wait',
      callId: 'first',
      summary: 'message',
      data: { agentId: 'child', description: 'Review', status: 'running', latestMessage: message }
    });
    const [started] = normalizer.normalize({
      ...base,
      type: 'tool.started',
      toolName: 'agent_wait',
      callId: 'snapshot',
      input: { agentId: 'child', waitMs: 0 }
    });
    const [snapshot] = normalizer.normalize({
      ...base,
      type: 'tool.completed',
      toolName: 'agent_wait',
      callId: 'snapshot',
      summary: 'snapshot',
      data: { agentId: 'child', description: 'Review', status: 'running', waitOutcome: 'snapshot' }
    });
    expect(started?.payload).toMatchObject({ subagentWait: false });
    expect(snapshot).toMatchObject({ status: 'COMPLETED', payload: { outputSummary: 'snapshot' } });
    for (const value of [started, snapshot])
      expect(value?.payload).not.toHaveProperty('subagentLatestMessage');
  });

  it.each(['completed', 'failed', 'cancelled', 'interrupted'] as const)(
    'does not rewrite a completed start when its child becomes %s',
    (status) => {
      const normalizer = new MarAgentConversationNormalizer();
      normalizer.normalize({
        ...base,
        type: 'tool.started',
        toolName: 'agent_start',
        callId: 'start',
        input: { description: 'Review', prompt: 'Review', role: 'explore' }
      });
      const [receipt] = normalizer.normalize({
        ...base,
        type: 'tool.completed',
        toolName: 'agent_start',
        callId: 'start',
        summary: 'started',
        data: { agentId: 'child', description: 'Review', status: 'running' }
      });
      expect(receipt).toMatchObject({ status: 'COMPLETED', payload: { outputSummary: 'started' } });
      expect(
        normalizer.normalize({ ...base, type: 'subagent.completed', agentId: 'child', status })
      ).toEqual([]);
    }
  );
  it.each([
    ['spawn_agent', { task_name: 'review', message: 'Inspect the implementation' }, 'START', null],
    ['wait_agent', { targets: ['worker-1'] }, 'STATUS', 'worker-1'],
    ['list_agents', {}, 'STATUS', null],
    ['close_agent', { target: 'worker-1' }, 'CANCEL', 'worker-1'],
    ['interrupt_agent', { target: 'worker-1' }, 'CANCEL', 'worker-1'],
    ['send_input', { id: 'worker-1', message: 'Add more inspection' }, 'MESSAGE', 'worker-1'],
    ['send_message', { target: 'worker-1', message: 'Add more inspection' }, 'MESSAGE', 'worker-1'],
    [
      'followup_task',
      { agent_id: 'worker-1', message: 'Continue the inspection' },
      'MESSAGE',
      'worker-1'
    ],
    ['resume_agent', { id: 'worker-1' }, 'RESUME', 'worker-1']
  ])('Codex %s uses unified subagent semantics', (toolName, input, operation, subagentId) => {
    expect(
      normalizeCodexTool({
        name: toolName,
        namespace: 'collaboration',
        rawInput: input,
        inputSummary: JSON.stringify(input)
      }).payload
    ).toMatchObject({ subagentOperation: operation, subagentId });
  });

  it('extracts a post-start subagent ID only from known structured output', () => {
    expect(
      normalizeCodexTool({
        name: 'spawn_agent',
        namespace: 'multi_agent_v2',
        rawInput: { task_name: 'review' },
        outputSummary: JSON.stringify({ agent_id: 'worker-output' })
      }).payload
    ).toMatchObject({ subagentOperation: 'START', subagentId: 'worker-output' });
    expect(
      normalizeClaudeTool(
        'Agent',
        { description: 'Inspect the implementation', prompt: 'Inspect the parsing path' },
        JSON.stringify({ agentId: 'agent-output' }),
        false,
        false
      ).payload
    ).toMatchObject({ subagentOperation: 'START', subagentId: 'agent-output' });
    expect(
      normalizeOpenCodeTool('task', {
        status: 'completed',
        input: {
          description: 'Inspect the implementation',
          prompt: 'Inspect the parsing path'
        },
        output:
          '<task id="ses-output" state="completed"><task_result>Completed</task_result></task>'
      }).payload
    ).toMatchObject({ subagentOperation: 'START', subagentId: 'ses-output' });
    expect(
      normalizeCodexTool({
        name: 'spawn_agent',
        rawInput: { task_name: 'review' },
        outputSummary: 'worker-output started'
      }).payload
    ).toMatchObject({ subagentOperation: 'START', subagentId: null });
  });

  it.each([
    [
      'Agent',
      { description: 'Inspect the implementation', prompt: 'Inspect the parsing path' },
      'START',
      null
    ],
    ['TaskOutput', { task_id: 'agent-1', block: true, timeout: 30_000 }, 'STATUS', 'agent-1'],
    ['TaskStop', { task_id: 'agent-1' }, 'CANCEL', 'agent-1'],
    ['SendMessage', { to: 'agent-1', message: 'Add more inspection' }, 'MESSAGE', 'agent-1']
  ])('Claude Code %s uses unified subagent semantics', (toolName, input, operation, subagentId) => {
    expect(
      normalizeClaudeTool(toolName, input, null, false, false, new Map([['agent-1', 'Inspect']]))
        .payload
    ).toMatchObject({
      subagentOperation: operation,
      subagentId
    });
  });

  it('distinguishes OpenCode task start from resume using task_id', () => {
    expect(
      normalizeOpenCodeTool('task', {
        status: 'running',
        input: {
          id: 'ordinary invocation field',
          description: 'Inspect the implementation',
          prompt: 'Inspect the parsing path',
          subagent_type: 'explore'
        }
      }).payload
    ).toMatchObject({ subagentOperation: 'START', subagentId: null });
    expect(
      normalizeOpenCodeTool('task', {
        status: 'completed',
        input: {
          description: 'Continue the inspection',
          prompt: 'Add more inspection',
          subagent_type: 'explore',
          task_id: 'ses-child'
        },
        output: '<task id="ses-child" state="completed"><task_result>Completed</task_result></task>'
      }).payload
    ).toMatchObject({ subagentOperation: 'RESUME', subagentId: 'ses-child' });
  });

  it('normalizes task titles and safe result summaries independently for each Runner', () => {
    expect(
      normalizeCodexTool({
        name: 'spawn_agent',
        namespace: 'collaboration',
        rawInput: { task_name: 'review_oauth', message: 'Inspect OAuth' }
      }).payload
    ).toMatchObject({ title: 'review_oauth' });
    expect(
      normalizeClaudeTool(
        'Agent',
        { description: 'Investigate authorization logic', prompt: 'Inspect the implementation' },
        null,
        false,
        false
      ).payload
    ).toMatchObject({ title: 'Investigate authorization logic' });
    expect(
      normalizeOpenCodeTool('task', {
        status: 'completed',
        input: {
          description: 'Inspect the parsing path',
          prompt: 'Inspect the implementation'
        },
        output:
          '<task id="ses-child" state="completed"><task_result>Inspection completed</task_result></task>'
      }).payload
    ).toMatchObject({
      title: 'Inspect the parsing path',
      output: { blocks: [{ channel: 'TEXT', text: 'Inspection completed' }] }
    });
    const [marAgent] = new MarAgentConversationNormalizer().normalize({
      ...base,
      type: 'tool.started',
      toolName: 'agent_start',
      callId: 'task-title',
      input: {
        description: 'Inspect MAR implementation',
        prompt: 'Inspect the implementation',
        role: 'explore'
      }
    });
    expect(marAgent?.payload).toMatchObject({ title: 'Inspect MAR implementation' });
  });

  it.each([
    [
      'agent_start',
      {
        description: 'Inspect the implementation',
        prompt: 'Inspect the parsing path',
        role: 'explore'
      },
      'START',
      null
    ],
    ['agent_wait', { agentId: 'task-1', waitMs: 1_000 }, 'STATUS', 'task-1'],
    ['agent_wait', { agentId: 'task-1', agentIds: null }, 'STATUS', 'task-1'],
    ['agent_message', { agentId: 'task-1', message: 'Continue' }, 'MESSAGE', 'task-1'],
    ['agent_cancel', { agentId: 'task-1' }, 'CANCEL', 'task-1']
  ])('MAR Agent %s uses unified semantics', (toolName, input, operation, subagentId) => {
    const [item] = new MarAgentConversationNormalizer().normalize({
      ...base,
      type: 'tool.started',
      toolName,
      callId: `${toolName}-call`,
      input
    });
    expect(item?.payload).toMatchObject({ subagentOperation: operation, subagentId });
  });

  it.each(['any', 'all'] as const)(
    'projects singleton MAR Agent %s waits with the known identity and observed result',
    (mode) => {
      const normalizer = new MarAgentConversationNormalizer();
      normalizer.normalize({
        ...base,
        type: 'subagent.started',
        agentId: 'task-1',
        description: 'Inspect the implementation'
      });
      const input = { agentId: null, agentIds: ['task-1'], mode, waitMs: 300_000 };
      const [started] = normalizer.normalize({
        ...base,
        type: 'tool.started',
        toolName: 'agent_wait',
        callId: 'group-wait',
        input
      });
      const latestMessage = {
        itemId: 'message-1',
        turnId: 'child-turn',
        phase: 'final_answer' as const,
        text: 'Inspection completed.',
        timestamp: base.timestamp,
        truncated: false
      };
      const [completed] = normalizer.normalize({
        ...base,
        type: 'tool.completed',
        toolName: 'agent_wait',
        callId: 'group-wait',
        summary: 'Group completed',
        data: {
          mode,
          waitFor: 'completion',
          waitOutcome: 'completion',
          pendingAgentIds: [],
          agents: [
            {
              agentId: 'task-1',
              description: 'Inspect the implementation',
              status: 'completed',
              modelId: 'review',
              latestMessage
            }
          ]
        }
      });
      for (const item of [started, completed]) {
        expect(item?.payload).toMatchObject({
          title: 'Inspect the implementation',
          subagentOperation: 'STATUS',
          subagentId: 'task-1',
          subagentWait: true,
          inputSummary: JSON.stringify(input)
        });
      }
      expect(completed).toMatchObject({ status: 'COMPLETED' });
      expect(completed?.payload).toMatchObject({
        subagentModelId: 'review',
        subagentLatestMessage: latestMessage,
        outputSummary: null
      });
      normalizer.normalize({
        ...base,
        type: 'tool.started',
        toolName: 'agent_wait',
        callId: 'group-snapshot',
        input: { ...input, waitMs: 0 }
      });
      const [snapshot] = normalizer.normalize({
        ...base,
        type: 'tool.completed',
        toolName: 'agent_wait',
        callId: 'group-snapshot',
        summary: 'Snapshot',
        data: {
          mode,
          waitFor: 'completion',
          waitOutcome: 'snapshot',
          pendingAgentIds: [],
          agents: [
            { agentId: 'task-1', description: 'Inspect the implementation', status: 'completed' }
          ]
        }
      });
      expect(snapshot?.payload).toMatchObject({
        subagentId: 'task-1',
        subagentWait: false,
        subagentModelId: 'review',
        outputSummary: 'Snapshot'
      });
      expect(snapshot?.payload).not.toHaveProperty('subagentLatestMessage');
    }
  );

  it.each([
    ['any', 1],
    ['any', 2],
    ['all', 1],
    ['all', 2]
  ] as const)(
    'keeps multi-target MAR Agent %s waits independent with %i returned members',
    (mode, memberCount) => {
      const normalizer = new MarAgentConversationNormalizer();
      const [started] = normalizer.normalize({
        ...base,
        type: 'tool.started',
        toolName: 'agent_wait',
        callId: 'many-wait',
        input: { agentIds: ['task-1', 'task-2'], mode, waitMs: 300_000 }
      });
      const [completed] = normalizer.normalize({
        ...base,
        type: 'tool.completed',
        toolName: 'agent_wait',
        callId: 'many-wait',
        summary: 'Partial group result',
        data: {
          mode,
          waitFor: 'completion',
          waitOutcome: 'timeout',
          pendingAgentIds: ['task-2'],
          agents: [
            { agentId: 'task-1', description: 'First task', status: 'completed' as const },
            { agentId: 'task-2', description: 'Second task', status: 'running' as const }
          ].slice(0, memberCount)
        }
      });
      for (const item of [started, completed]) {
        expect(item?.payload).toMatchObject({
          title: 'agent_wait',
          subagentOperation: 'STATUS',
          subagentId: null
        });
      }
    }
  );

  it('groups a null-target MAR Agent wait only after its result confirms the agent', () => {
    const normalizer = new MarAgentConversationNormalizer();
    normalizer.normalize({
      ...base,
      type: 'subagent.started',
      agentId: 'task-1',
      description: 'Inspect the implementation',
      modelId: 'review'
    });
    const [started] = normalizer.normalize({
      ...base,
      type: 'tool.started',
      toolName: 'agent_wait',
      callId: 'untargeted-wait',
      input: { agentId: null, agentIds: null, waitMs: 300_000 }
    });
    expect(started?.payload).toMatchObject({
      title: 'agent_wait',
      subagentOperation: 'STATUS',
      subagentId: null
    });
    const [completed] = normalizer.normalize({
      ...base,
      type: 'tool.completed',
      toolName: 'agent_wait',
      callId: 'untargeted-wait',
      summary: 'Wait completed',
      data: { agentId: 'task-1', description: 'Inspect the implementation', status: 'completed' }
    });
    expect(completed?.payload).toMatchObject({
      title: 'Inspect the implementation',
      subagentOperation: 'STATUS',
      subagentId: 'task-1',
      subagentModelId: 'review',
      subagentWait: true
    });
  });

  it('keeps MAR Agent start receipts independent of child lifecycle events', () => {
    const normalizer = new MarAgentConversationNormalizer();
    const [startStarted] = normalizer.normalize({
      ...base,
      type: 'tool.started',
      toolName: 'agent_start',
      callId: 'start-call',
      input: {
        description: 'Inspect the implementation',
        prompt: 'Inspect the implementation',
        role: 'explore',
        background: true
      }
    });
    const lifecycleStarted = normalizer.normalize({
      ...base,
      type: 'subagent.started',
      agentId: 'task-1',
      description: 'Inspect the implementation',
      modelId: 'review',
      modelName: 'Review Agent',
      reasoningEffort: 'high'
    });
    const [startCompleted] = normalizer.normalize({
      ...base,
      eventId: 'start-completed',
      type: 'tool.completed',
      toolName: 'agent_start',
      callId: 'start-call',
      summary: 'started',
      data: {
        agentId: 'task-1',
        description: 'Inspect the implementation',
        status: 'running'
      }
    });
    const [waitStarted] = normalizer.normalize({
      ...base,
      eventId: 'wait-started',
      type: 'tool.started',
      toolName: 'agent_wait',
      callId: 'wait-call',
      input: { agentId: 'task-1', waitFor: 'completion', waitMs: 300_000 }
    });
    const [lifecycleCompleted] = normalizer.normalize({
      ...base,
      type: 'subagent.completed',
      agentId: 'task-1',
      status: 'completed',
      modelId: 'review',
      modelName: 'Review Agent',
      reasoningEffort: 'high',
      latestMessage: {
        itemId: 'message-1',
        turnId: 'turn-child-1',
        phase: 'final_answer',
        text: 'Inspection completed.',
        timestamp: '2026-09-12T00:00:00.000Z',
        truncated: false
      }
    });

    expect(startStarted).toMatchObject({
      itemId: 'mar-agent-tool:start-call',
      status: 'IN_PROGRESS',
      payload: { subagentOperation: 'START', subagentId: null }
    });
    expect(lifecycleStarted).toEqual([]);
    expect(startCompleted).toMatchObject({
      itemId: 'mar-agent-tool:start-call',
      status: 'COMPLETED',
      payload: {
        title: 'Inspect the implementation',
        subagentOperation: 'START',
        subagentId: 'task-1',
        subagentModelId: 'review',
        subagentModelName: 'Review Agent',
        subagentReasoningEffort: 'high'
      }
    });
    expect(waitStarted).toMatchObject({
      itemId: 'mar-agent-tool:wait-call',
      status: 'IN_PROGRESS',
      payload: {
        title: 'Inspect the implementation',
        subagentOperation: 'STATUS',
        subagentId: 'task-1'
      }
    });
    expect(lifecycleCompleted).toBeUndefined();
    expect(startCompleted?.payload.outputSummary).toBe('started');
    expect(startCompleted?.payload).not.toHaveProperty('subagentLatestMessage');
  });

  it('does not create an unassociated lifecycle card', () => {
    const [item] = new MarAgentConversationNormalizer().normalize({
      ...base,
      type: 'subagent.completed',
      agentId: 'task-interrupted',
      description: 'Resume interrupted work',
      status: 'interrupted'
    });

    expect(item).toBeUndefined();
  });

  it('retains lifecycle metadata for later explicit controls', () => {
    const normalizer = new MarAgentConversationNormalizer();
    normalizer.normalize({
      ...base,
      type: 'subagent.completed',
      agentId: 'task-1',
      description: 'Inspect the implementation',
      status: 'completed',
      modelId: 'review',
      modelName: 'Review Agent',
      reasoningEffort: 'high',
      latestMessage: {
        itemId: 'message-1',
        turnId: 'turn-child-1',
        phase: 'final_answer',
        text: 'Inspection completed.',
        timestamp: '2026-09-12T00:00:00.000Z',
        truncated: false
      }
    });
    const [status] = normalizer.normalize({
      ...base,
      type: 'tool.started',
      toolName: 'agent_wait',
      callId: 'status-call',
      input: { agentId: 'task-1' }
    });

    expect(status?.payload).toMatchObject({
      title: 'Inspect the implementation',
      subagentOperation: 'STATUS',
      subagentId: 'task-1',
      subagentModelId: 'review',
      subagentModelName: 'Review Agent',
      subagentReasoningEffort: 'high'
    });
  });

  it('MAR Agent structured control results project only explicit model and latest-message fields', () => {
    const normalizer = new MarAgentConversationNormalizer();
    normalizer.normalize({
      ...base,
      type: 'tool.started',
      toolName: 'agent_message',
      callId: 'message-call',
      input: { agentId: 'task-1', message: 'Continue' }
    });
    const [completed] = normalizer.normalize({
      ...base,
      eventId: 'message-completed',
      type: 'tool.completed',
      toolName: 'agent_message',
      callId: 'message-call',
      summary: 'structured result',
      data: {
        agentId: 'task-1',
        description: 'Inspect the implementation',
        status: 'completed',
        modelId: 'review',
        modelName: 'Review Agent',
        reasoningEffort: 'high',
        latestMessage: {
          itemId: 'message-1',
          turnId: 'turn-child-1',
          phase: 'commentary',
          text: 'Still checking.',
          timestamp: '2026-09-12T00:00:00.000Z',
          truncated: true
        }
      }
    });

    expect(completed?.payload).toMatchObject({
      title: 'Inspect the implementation',
      subagentOperation: 'MESSAGE',
      subagentId: 'task-1',
      subagentModelId: 'review',
      subagentModelName: 'Review Agent',
      subagentReasoningEffort: 'high',
      subagentLatestMessage: {
        text: 'Still checking.',
        phase: 'commentary',
        truncated: true
      },
      outputSummary: null
    });
  });

  it('does not repeat a preceding child final on a MAR Agent message receipt', () => {
    const normalizer = new MarAgentConversationNormalizer();
    normalizer.normalize({
      ...base,
      type: 'subagent.completed',
      agentId: 'task-1',
      description: 'Inspect the implementation',
      status: 'completed',
      modelId: 'review',
      modelName: 'Review Agent',
      reasoningEffort: 'high',
      latestMessage: {
        itemId: 'previous-final',
        turnId: 'previous-turn',
        phase: 'final_answer',
        text: 'Previous result.',
        timestamp: '2026-09-12T00:00:00.000Z',
        truncated: false
      }
    });
    normalizer.normalize({
      ...base,
      eventId: 'message-receipt-started',
      type: 'tool.started',
      toolName: 'agent_message',
      callId: 'message-receipt-call',
      input: { agentId: 'task-1', delivery: 'append', message: 'Review the latest fix.' }
    });
    const [completed] = normalizer.normalize({
      ...base,
      eventId: 'message-receipt-completed',
      type: 'tool.completed',
      toolName: 'agent_message',
      callId: 'message-receipt-call',
      summary:
        '{"agentId":"task-1","status":"running","deliveryStatus":"accepted","messageId":"message-1"}',
      data: {
        agentId: 'task-1',
        description: 'Inspect the implementation',
        status: 'running',
        deliveryStatus: 'accepted',
        messageId: 'message-1',
        modelId: 'review',
        modelName: 'Review Agent',
        reasoningEffort: 'high'
      }
    });

    expect(completed?.payload).toMatchObject({
      title: 'Inspect the implementation',
      subagentOperation: 'MESSAGE',
      subagentId: 'task-1',
      subagentModelId: 'review',
      subagentModelName: 'Review Agent',
      subagentReasoningEffort: 'high',
      inputSummary: expect.stringContaining('Review the latest fix.'),
      outputSummary:
        '{"agentId":"task-1","status":"running","deliveryStatus":"accepted","messageId":"message-1"}'
    });
    expect(completed?.payload).not.toHaveProperty('subagentLatestMessage');
  });

  it('rejects Subagent metadata when a control result targets a different agent ID', () => {
    const normalizer = new MarAgentConversationNormalizer();
    normalizer.normalize({
      ...base,
      type: 'tool.started',
      toolName: 'agent_wait',
      callId: 'mismatched-call',
      input: { agentId: 'task-a' }
    });
    const [completed] = normalizer.normalize({
      ...base,
      eventId: 'mismatched-completed',
      type: 'tool.completed',
      toolName: 'agent_wait',
      callId: 'mismatched-call',
      summary: 'mismatched result',
      data: {
        agentId: 'task-b',
        description: 'Different task',
        status: 'completed',
        modelId: 'other-model',
        modelName: 'Other Model',
        reasoningEffort: 'ultra',
        latestMessage: {
          itemId: 'other-message',
          turnId: 'other-turn',
          phase: 'final_answer',
          text: 'Other result.',
          timestamp: '2026-09-12T00:00:00.000Z',
          truncated: false
        }
      }
    });
    const [otherStatus] = normalizer.normalize({
      ...base,
      eventId: 'other-status',
      type: 'tool.started',
      toolName: 'agent_wait',
      callId: 'other-status-call',
      input: { agentId: 'task-b' }
    });

    expect(completed?.payload).toMatchObject({
      subagentOperation: 'STATUS',
      subagentId: 'task-a'
    });
    for (const item of [completed, otherStatus]) {
      expect(item?.payload).not.toHaveProperty('subagentModelId');
      expect(item?.payload).not.toHaveProperty('subagentModelName');
      expect(item?.payload).not.toHaveProperty('subagentReasoningEffort');
      expect(item?.payload).not.toHaveProperty('subagentLatestMessage');
    }
  });

  it.each([
    ['agent_wait', { agentId: 'task-1' }, 'STATUS'],
    ['agent_wait', { agentIds: ['task-1'], mode: 'any' }, 'STATUS'],
    ['agent_wait', { agentIds: ['task-1'], mode: 'all' }, 'STATUS'],
    ['agent_message', { agentId: 'task-1', message: 'Continue' }, 'MESSAGE'],
    ['agent_cancel', { agentId: 'task-1' }, 'CANCEL']
  ])('keeps known Subagent details when MAR Agent %s fails', (toolName, input, operation) => {
    const normalizer = new MarAgentConversationNormalizer();
    normalizer.normalize({
      ...base,
      type: 'subagent.completed',
      agentId: 'task-1',
      description: 'Inspect the implementation',
      status: 'completed',
      modelId: 'review',
      modelName: 'Review Agent',
      reasoningEffort: 'high',
      latestMessage: {
        itemId: 'message-1',
        turnId: 'turn-child-1',
        phase: 'commentary',
        text: 'Still checking.',
        timestamp: '2026-09-12T00:00:00.000Z',
        truncated: false
      }
    });
    normalizer.normalize({
      ...base,
      eventId: `${toolName}-started`,
      type: 'tool.started',
      toolName,
      callId: `${toolName}-failed-call`,
      input
    });
    const [failed] = normalizer.normalize({
      ...base,
      eventId: `${toolName}-failed`,
      type: 'tool.failed',
      toolName,
      callId: `${toolName}-failed-call`,
      code: 'MAR_AGENT_SUBAGENT_FAILED',
      message: 'Control request failed.'
    });

    expect(failed).toMatchObject({
      status: 'FAILED',
      payload: {
        title: 'Inspect the implementation',
        subagentOperation: operation,
        subagentId: 'task-1',
        subagentModelId: 'review',
        subagentModelName: 'Review Agent',
        subagentReasoningEffort: 'high'
      }
    });
  });

  it('keeps a code-point-bounded latest message without duplicating its text', () => {
    const text = '\u{1F680}'.repeat(10_000);
    const normalizer = new MarAgentConversationNormalizer();
    normalizer.normalize({
      ...base,
      type: 'tool.started',
      toolName: 'agent_start',
      callId: 'emoji-start',
      input: { description: 'Inspect Unicode output', prompt: 'Inspect', role: 'explore' }
    });
    normalizer.normalize({
      ...base,
      eventId: 'emoji-start-completed',
      type: 'tool.completed',
      toolName: 'agent_start',
      callId: 'emoji-start',
      summary: 'started',
      data: { agentId: 'task-emoji', description: 'Inspect Unicode output', status: 'running' }
    });
    const [completed] = normalizer.normalize({
      ...base,
      type: 'tool.completed',
      toolName: 'agent_wait',
      callId: 'emoji-wait',
      summary: 'completed',
      data: {
        agentId: 'task-emoji',
        description: 'Inspect emoji output',
        status: 'completed',
        latestMessage: {
          itemId: 'message-emoji',
          turnId: 'turn-emoji',
          phase: 'final_answer',
          text,
          timestamp: '2026-09-12T00:00:00.000Z',
          truncated: false
        }
      }
    });

    expect(completed?.payload.subagentLatestMessage).toMatchObject({ text, truncated: false });
    expect(completed?.payload.outputSummary).toBeNull();
    expect(completed?.payload.output).toBeUndefined();
  });

  it('projects the effective model name on completed MAR Agent messages', () => {
    const [message] = new MarAgentConversationNormalizer().normalize({
      ...base,
      type: 'message.completed',
      itemId: 'message-1',
      phase: 'final_answer',
      text: 'Done.',
      modelId: 'review',
      modelName: 'Review Agent'
    });

    expect(message?.payload).toMatchObject({ model: 'Review Agent' });
  });

  it('keeps legacy MAR Agent messages readable when model metadata is absent', () => {
    const [message] = new MarAgentConversationNormalizer().normalize({
      ...base,
      type: 'message.completed',
      itemId: 'legacy-message',
      phase: 'final_answer',
      text: 'Done.'
    } as never);

    expect(message?.payload).toMatchObject({ model: null });
  });

  it('does not seed subagent metadata from an unrelated structured tool result', () => {
    const normalizer = new MarAgentConversationNormalizer();
    normalizer.normalize({
      ...base,
      type: 'tool.started',
      toolName: 'read',
      callId: 'ordinary-call',
      input: { path: 'src/index.ts' }
    });
    normalizer.normalize({
      ...base,
      eventId: 'ordinary-completed',
      type: 'tool.completed',
      toolName: 'read',
      callId: 'ordinary-call',
      summary: 'completed',
      data: {
        agentId: 'task-1',
        description: 'Spoofed task',
        modelId: 'spoofed-model',
        modelName: 'Spoofed Model',
        reasoningEffort: 'ultra'
      } as never
    });
    const [status] = normalizer.normalize({
      ...base,
      eventId: 'status-started',
      type: 'tool.started',
      toolName: 'agent_wait',
      callId: 'status-call',
      input: { agentId: 'task-1' }
    });

    expect(status?.payload).toMatchObject({
      title: 'agent_wait',
      subagentOperation: 'STATUS',
      subagentId: 'task-1'
    });
    expect(status?.payload).not.toHaveProperty('subagentModelId');
    expect(status?.payload).not.toHaveProperty('subagentModelName');
    expect(status?.payload).not.toHaveProperty('subagentReasoningEffort');
  });

  it.each([
    ['agent_wait', 'STATUS'],
    ['agent_cancel', 'CANCEL']
  ])('MAR Agent %s uses the known task title instead of the task ID', (toolName, operation) => {
    const normalizer = new MarAgentConversationNormalizer();
    normalizer.normalize({
      ...base,
      type: 'subagent.started',
      agentId: 'task-1',
      description: 'Inspect the implementation'
    });
    const [started] = normalizer.normalize({
      ...base,
      eventId: `${toolName}-started`,
      type: 'tool.started',
      toolName,
      callId: `${toolName}-call`,
      input: { agentId: 'task-1' }
    });
    normalizer.normalize({
      ...base,
      eventId: `${toolName}-lifecycle-completed`,
      type: 'subagent.completed',
      agentId: 'task-1',
      status: 'completed'
    });
    const [completed] = normalizer.normalize({
      ...base,
      eventId: `${toolName}-completed`,
      type: 'tool.completed',
      toolName,
      callId: `${toolName}-call`,
      summary: JSON.stringify({ agentId: 'task-1', status: 'completed' }),
      data: { agentId: 'task-1', description: 'Inspect the implementation', status: 'completed' }
    });

    expect(started?.payload).toMatchObject({
      title: 'Inspect the implementation',
      subagentOperation: operation,
      subagentId: 'task-1'
    });
    expect(completed?.payload).toMatchObject({
      title: 'Inspect the implementation',
      subagentOperation: operation,
      subagentId: 'task-1'
    });
  });
});
