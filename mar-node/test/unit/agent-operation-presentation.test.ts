import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@myagentroam/agent';
import { agentOperationPresentationSchema, conversationItemSchema } from '@myagentroam/protocol';
import {
  agentOperationAction,
  agentOperationEvent
} from '../../src/runner/mar-agent/agent-operation-presentation.js';
import { MarAgentConversationNormalizer } from '../../src/runner/mar-agent/conversation-normalizer.js';
import { AgentNetworkObservations } from '../../src/service/agent-network-observations.js';
import { waitForAgentTargets } from '../../src/service/agent-network-wait.js';

function event(value: Record<string, unknown>): AgentEvent {
  return {
    eventId: 'event',
    sequence: 1,
    timestamp: '2026-10-30T00:00:00Z',
    sessionId: 'parent',
    executionId: 'execution',
    turnId: 'turn',
    ...value
  } as AgentEvent;
}

describe('public Agent operations', () => {
  it.each(['tree', 'active'])('projects the effective LIST scope %s from the result', (scope) => {
    const operation = agentOperationEvent('list', {}, { scope, sessions: [] });
    expect(operation.eventData.agentOperation).toMatchObject({
      action: 'LIST',
      scope,
      targets: []
    });
  });

  it.each([{ agentId: 'child' }, {}, { agentIds: ['child'] }, { agentIds: ['a', 'b'] }])(
    'only projects a wait mode for an explicit multi-target call: %j',
    (selection) => {
      const result = agentOperationEvent(
        'wait',
        { ...selection, waitFor: 'message', waitMs: 0, mode: 'all' },
        {}
      );
      expect(result.eventData.agentOperation.detail?.wait).toEqual({
        waitFor: 'message',
        waitMs: 0,
        ...('agentIds' in selection ? { mode: 'all' } : {})
      });
    }
  );
  it('projects only current public card facts without private goal or configuration', () => {
    const start = agentOperationEvent(
      'start',
      { title: 'Task', content: 'Initial\nmessage', goal: { objective: 'PRIVATE' } },
      { agentId: 'child' }
    );
    expect(start.eventData.agentOperation).toMatchObject({
      detail: { message: 'Initial\nmessage' }
    });
    const send = agentOperationEvent(
      'send',
      { agentId: 'child', content: 'Hello', deliveryIntent: 'REPLACE_CURRENT' },
      {
        agentId: 'child',
        message: { status: 'accepted', result: { auditReceipt: { inputMode: 'REPLACE_CURRENT' } } }
      }
    );
    expect(send.eventData.agentOperation).toMatchObject({
      detail: { message: 'Hello', delivery: 'STEER' }
    });
    const list = agentOperationEvent(
      'list',
      {},
      { sessions: [{ id: 'child', title: 'Task', status: 'RUNNING' }] }
    );
    expect(list.eventData.agentOperation).toMatchObject({
      detail: {},
      targets: [{ title: 'Task', status: 'RUNNING' }]
    });
    expect(
      agentOperationEvent('list', {}, { sessions: [{ id: 'child' }], truncated: true }).eventData
        .agentOperation.targetsTruncated
    ).toBe(true);
    expect(JSON.stringify(start.eventData)).not.toContain('PRIVATE');
    const normalizer = new MarAgentConversationNormalizer();
    const [legacy] = normalizer.normalize(
      event({
        type: 'tool.started',
        toolName: 'agent_start',
        callId: 'old',
        input: { title: 'Task', content: 'Old record' }
      })
    );
    expect((legacy?.payload.agentOperation as { detail?: unknown })?.detail).toBeUndefined();
  });
  it('retains existing target titles before clipping newly added multilingual messages', () => {
    const title = '标题'.repeat(250);
    const send = agentOperationEvent(
      'send',
      { agentId: 'peer', content: '文'.repeat(2000) },
      { agentId: 'peer', title }
    );
    expect(send.eventData.agentOperation.targets).toEqual([
      { agentId: 'peer', sessionId: 'peer', title }
    ]);
    expect(send.eventData.agentOperation.detail?.messageTruncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(send.eventData))).toBeLessThan(7001);
    const wait = agentOperationEvent(
      'wait',
      { agentIds: ['a', 'b', 'c'] },
      {
        agents: ['a', 'b', 'c'].map((agentId) => ({
          agentId,
          title,
          updates: [{ kind: 'message', value: '😀'.repeat(400) }]
        }))
      }
    );
    expect(wait.eventData.agentOperation.targets.map((target) => target.title)).toEqual([
      title,
      title,
      title
    ]);
    expect(wait.eventData.agentOperation.targets.some((target) => target.messageTruncated)).toBe(
      true
    );
    expect(Buffer.byteLength(JSON.stringify(wait.eventData))).toBeLessThan(7001);
  });
  it('uses delivery receipts, not message intent, and preserves partial failures', () => {
    const input = { agentId: 'peer', content: 'hello', deliveryIntent: 'REPLACE_CURRENT' };
    const intentOnly = agentOperationEvent('send', input, {
      agentId: 'peer',
      message: { status: 'accepted' }
    });
    expect(intentOnly.eventData.agentOperation.detail).not.toHaveProperty('delivery');
    const queued = agentOperationEvent('send', input, {
      agentId: 'peer',
      message: {
        status: 'accepted',
        result: { delivery: 'QUEUED', auditReceipt: { inputMode: 'REPLACE_CURRENT' } }
      }
    });
    expect(queued.eventData.agentOperation.detail?.delivery).toBe('QUEUE');
    const auditQueue = agentOperationEvent('send', input, {
      agentId: 'peer',
      message: {
        status: 'accepted',
        result: { delivery: 'STARTED', auditReceipt: { inputMode: 'QUEUE' } }
      }
    });
    expect(auditQueue.eventData.agentOperation.detail?.delivery).toBe('QUEUE');
    const partial = agentOperationEvent('send', input, {
      agentId: 'peer',
      goal: { status: 'partial', code: 'GOAL_ERROR' },
      message: { status: 'accepted', result: { auditReceipt: { inputMode: 'REPLACE_CURRENT' } } }
    });
    expect(partial.eventData.agentOperation.detail).toMatchObject({
      failed: true,
      error: 'GOAL_ERROR'
    });
    expect(partial.eventData.agentOperation.detail).not.toHaveProperty('delivery');
    const failed = agentOperationEvent('send', input, {
      agentId: 'peer',
      message: { status: 'unknown', code: 'AGENT_SEND_FAILED' }
    });
    expect(failed.eventData.agentOperation.detail?.failed).toBe(true);
    expect(failed.eventSummary).toContain('AGENT_SEND_FAILED');
    expect(
      agentOperationEvent(
        'send',
        { agentId: 'peer', goal: { clear: true } },
        { agentId: 'peer', message: null }
      ).eventData.agentOperation.detail
    ).toBeUndefined();
  });
  it('prefers the authoritative wait summary and uses only its own truncation fact', () => {
    const result = agentOperationEvent(
      'wait',
      { agentId: 'peer' },
      {
        agentId: 'peer',
        status: 'SUCCEEDED',
        summary: '最终结果',
        updates: [{ kind: 'message', value: '仍在检查', truncated: true }]
      }
    );
    expect(result.eventData.agentOperation.targets[0]).toMatchObject({ message: '最终结果' });
    expect(result.eventData.agentOperation.targets[0]).not.toHaveProperty('messageTruncated');
    const messageOnly = agentOperationEvent(
      'wait',
      { agentId: 'peer' },
      { agentId: 'peer', summaryTruncated: true, updates: [{ kind: 'message', value: '完整进度' }] }
    );
    expect(messageOnly.eventData.agentOperation.targets[0]).toMatchObject({ message: '完整进度' });
    expect(messageOnly.eventData.agentOperation.targets[0]).not.toHaveProperty('messageTruncated');
  });
  it('projects only the public latest message in an agent_view snapshot', () => {
    const result = agentOperationEvent(
      'view',
      { agentId: 'peer' },
      {
        session: {
          id: 'peer',
          title: 'Review',
          status: 'IDLE',
          latestMessage: { text: 'Public answer', truncated: true },
          modelId: 'private-model',
          goal: { objective: 'private-goal' }
        }
      }
    );
    expect(result.eventData.agentOperation.targets).toEqual([
      {
        agentId: 'peer',
        sessionId: 'peer',
        title: 'Review',
        status: 'IDLE',
        message: 'Public answer',
        messageTruncated: true
      }
    ]);
    expect(JSON.stringify(result.eventData)).not.toContain('private-');
  });
  it('keeps resolved titles while replacing wait outcome facts in terminal snapshot', () => {
    const normalizer = new MarAgentConversationNormalizer();
    const input = { agentIds: ['a', 'b'] };
    const resolved = agentOperationEvent('wait', input, {
      agents: [
        { agentId: 'a', title: 'A' },
        { agentId: 'b', title: 'B' }
      ]
    });
    const final = agentOperationEvent('wait', input, {
      agents: [{ agentId: 'b', status: 'SUCCEEDED', summary: 'Done' }]
    });
    normalizer.normalize(
      event({ type: 'tool.started', toolName: 'agent_wait', callId: 'wait', input })
    );
    const [progress] = normalizer.normalize(
      event({
        type: 'tool.updated',
        toolName: 'agent_wait',
        callId: 'wait',
        data: resolved.eventData
      })
    );
    expect(progress?.payload.agentOperation).toMatchObject({
      targets: [{ title: 'A' }, { title: 'B' }]
    });
    const [complete] = normalizer.normalize(
      event({
        type: 'tool.completed',
        toolName: 'agent_wait',
        callId: 'wait',
        data: final.eventData,
        summary: final.eventSummary
      })
    );
    expect(complete?.payload.agentOperation).toMatchObject({
      targets: [{ title: 'A' }, { title: 'B', status: 'SUCCEEDED', message: 'Done' }]
    });
    expect(
      conversationItemSchema.parse({
        ...complete,
        id: complete!.itemId,
        sessionId: 'parent',
        turnId: 'turn',
        runId: 'run',
        parentItemId: null,
        sourceSequence: 1,
        revision: 1,
        startedAt: null,
        completedAt: null
      }).payload
    ).toMatchObject({ agentOperation: { detail: {} } });
  });
  it('does not lose later WAIT targets when a bounded progress snapshot had fewer entries', () => {
    const normalizer = new MarAgentConversationNormalizer();
    const input = { agentIds: ['a', 'b'] };
    normalizer.normalize(
      event({ type: 'tool.started', toolName: 'agent_wait', callId: 'w', input })
    );
    normalizer.normalize(
      event({
        type: 'tool.updated',
        toolName: 'agent_wait',
        callId: 'w',
        data: {
          agentOperation: {
            action: 'WAIT',
            targets: [{ agentId: 'a', title: 'A' }],
            targetsTruncated: true,
            detail: {}
          }
        }
      })
    );
    const final = agentOperationEvent('wait', input, {
      agents: [
        { agentId: 'a', status: 'SUCCEEDED' },
        { agentId: 'b', status: 'RUNNING' }
      ]
    });
    const [completed] = normalizer.normalize(
      event({
        type: 'tool.completed',
        toolName: 'agent_wait',
        callId: 'w',
        data: final.eventData,
        summary: final.eventSummary
      })
    );
    expect(completed?.payload.agentOperation).toMatchObject({
      targets: [
        { agentId: 'a', title: 'A', status: 'SUCCEEDED' },
        { agentId: 'b', status: 'RUNNING' }
      ]
    });
    expect(completed?.payload.agentOperation).not.toHaveProperty('targetsTruncated');
  });
  it.each([true, false])('projects real wait messages and mappings (single=%s)', async (single) => {
    const network = new AgentNetworkObservations();
    const observations = network.attach('parent');
    network.publish({
      parentId: 'parent',
      childId: 'peer',
      runId: 'run-peer',
      executionId: 'execution-peer',
      kind: 'message',
      value: 'Public progress'
    });
    const result = await waitForAgentTargets({
      targets: [
        {
          agentId: 'peer',
          runId: 'run-peer',
          executionId: 'execution-peer',
          read: () => ({ status: 'RUNNING' })
        }
      ],
      observations,
      single,
      waitFor: 'message'
    });
    const projected = agentOperationEvent(
      'wait',
      single ? { agentId: 'peer' } : { agentIds: ['peer'] },
      result
    );
    expect(projected.eventData.agentOperation.targets).toEqual([
      { agentId: 'peer', sessionId: 'peer', status: 'RUNNING', message: 'Public progress' }
    ]);
    const receipt = JSON.parse(projected.eventSummary);
    expect(single ? receipt : receipt.agents[0]).toMatchObject({
      status: 'RUNNING',
      waitOutcome: 'message',
      latestMessage: { value: 'Public progress' }
    });
  });

  it('bounds the latest wait message and ignores non-public update fields', () => {
    const projected = agentOperationEvent(
      'wait',
      {},
      {
        agentId: 'peer',
        updates: [
          { kind: 'message', value: 'Older progress' },
          { kind: 'message', value: 'x'.repeat(900), truncated: true, secret: 'PRIVATE' },
          { kind: 'reasoning', value: 'PRIVATE' }
        ]
      }
    );
    expect(JSON.parse(projected.eventSummary).latestMessage).toEqual({
      value: 'x'.repeat(800),
      truncated: true
    });
    expect(projected.eventSummary).not.toContain('PRIVATE');
  });

  it('keeps an any-wait multi-target even when one target produces the result', () => {
    const wait = agentOperationEvent(
      'wait',
      { agentIds: ['a', 'b'], mode: 'any' },
      {
        agents: [{ agentId: 'b', status: 'SUCCEEDED' }]
      }
    );
    expect(wait.eventData.agentOperation.targets).toEqual([
      { agentId: 'a' },
      { agentId: 'b', sessionId: 'b', status: 'SUCCEEDED' }
    ]);
    const profile = agentOperationEvent(
      'list',
      { scope: 'profile' },
      { runner: 'mar-agent', models: [{ id: 'fixture' }] }
    );
    expect(profile.eventData.agentOperation).toEqual({
      action: 'LIST',
      scope: 'profile',
      targets: []
    });
    expect(JSON.parse(profile.eventSummary)).toEqual({ runner: 'mar-agent', modelCount: 1 });
  });

  it('does not split Unicode characters when clipping public titles and messages', () => {
    const started = agentOperationEvent(
      'start',
      { title: `${'x'.repeat(499)}😀` },
      { agentId: 'peer' }
    );
    expect(started.eventData.agentOperation.targets[0]?.title).toBe('x'.repeat(499));
    const waited = agentOperationEvent(
      'wait',
      {},
      {
        agentId: 'peer',
        updates: [{ kind: 'message', value: `${'x'.repeat(799)}😀` }]
      }
    );
    expect(JSON.parse(waited.eventSummary).latestMessage).toEqual({
      value: 'x'.repeat(799),
      truncated: true
    });
  });
  it.each(['start', 'send', 'wait', 'stop', 'list', 'view'])(
    'projects direct and nested %s with independent call identity and replay',
    (action) => {
      const input = action === 'start' ? { title: 'Inspect changes' } : { agentId: 'peer' };
      const result =
        action === 'list'
          ? { sessions: [{ id: 'peer', title: 'Peer' }] }
          : action === 'view'
            ? { session: { id: 'peer', title: 'Peer' } }
            : action === 'wait'
              ? { agents: [{ agentId: 'peer', status: 'RUNNING', waitOutcome: 'timeout' }] }
              : { agentId: 'peer' };
      const projected = agentOperationEvent(action, input, result);
      expect(
        agentOperationPresentationSchema.parse(projected.eventData.agentOperation).action
      ).toBe(action.toUpperCase());
      for (const parentCallId of [undefined, 'cell']) {
        const events = [
          event({
            type: 'tool.started',
            callId: 'agent-call',
            toolName: `agent_${action}`,
            input,
            parentCallId
          }),
          event({
            type: 'tool.completed',
            callId: 'agent-call',
            toolName: `agent_${action}`,
            summary: projected.eventSummary,
            data: projected.eventData,
            parentCallId
          })
        ];
        const replay = () => {
          const normalizer = new MarAgentConversationNormalizer();
          return events.flatMap((value) => normalizer.normalize(value));
        };
        const items = replay();
        expect(items).toHaveLength(2);
        expect(items[0]?.itemId).toBe(items[1]?.itemId);
        expect(items.map((item) => item.status)).toEqual(['IN_PROGRESS', 'COMPLETED']);
        expect(items[0]?.payload.agentOperation).not.toMatchObject({
          targets: [{ sessionId: 'peer' }]
        });
        expect(items[1]?.payload.agentOperation).toMatchObject({
          action: action.toUpperCase(),
          targets: [{ agentId: 'peer', sessionId: 'peer' }]
        });
        const published = conversationItemSchema.parse({
          ...items[1],
          id: items[1]!.itemId,
          sessionId: 'parent',
          turnId: 'turn',
          runId: 'run',
          parentItemId: parentCallId ?? null,
          sourceSequence: 2,
          revision: 0,
          startedAt: 0,
          completedAt: 1
        });
        expect(published.payload).toMatchObject({
          agentOperation: items[1]!.payload.agentOperation
        });
        expect(replay()).toEqual(items);
      }
    }
  );

  it('keeps failed nested calls visible without promoting input identities to navigation', () => {
    const normalizer = new MarAgentConversationNormalizer();
    normalizer.normalize(
      event({
        type: 'tool.started',
        callId: 'wait',
        toolName: 'agent_wait',
        input: { agentIds: ['peer', 'other'] },
        parentCallId: 'cell'
      })
    );
    const [item] = normalizer.normalize(
      event({
        type: 'tool.failed',
        callId: 'wait',
        toolName: 'agent_wait',
        code: 'AGENT_NOT_FOUND',
        message: 'Agent unavailable',
        parentCallId: 'cell'
      })
    );
    expect(item).toMatchObject({
      status: 'FAILED',
      payload: {
        errorCode: 'AGENT_NOT_FOUND',
        agentOperation: { action: 'WAIT', targets: [{ agentId: 'peer' }, { agentId: 'other' }] }
      }
    });
    expect(agentOperationAction('toString')).toBeUndefined();
  });

  it('publishes bounded receipts, never private configuration, full history or truncated IDs', () => {
    const result = agentOperationEvent(
      'view',
      {},
      {
        session: {
          id: 'peer',
          title: 'Peer',
          status: 'RUNNING',
          modelId: 'profile-model',
          model: 'LEGACY_MODEL',
          effort: 'high',
          apiKey: 'SECRET',
          configuration: { password: 'SECRET' },
          latestMessage: { text: 'Public view message', truncated: true, secret: 'SECRET' }
        },
        history: [{ content: 'PRIVATE_HISTORY' }],
        apiKey: 'SECRET'
      }
    );
    expect(JSON.stringify(result)).not.toMatch(/SECRET|PRIVATE_HISTORY/);
    expect(JSON.parse(result.eventSummary)).toEqual({
      status: 'RUNNING',
      modelId: 'profile-model',
      effort: 'high',
      latestMessage: { text: 'Public view message', truncated: true }
    });
    const listed = agentOperationEvent(
      'list',
      { scope: 'workspace' },
      {
        sessions: Array.from({ length: 100 }, (_, index) => ({
          id: `id-${index}`,
          title: '文'.repeat(500)
        }))
      }
    );
    expect(Buffer.byteLength(JSON.stringify(listed.eventData))).toBeLessThan(8192);
    expect(listed.eventData.agentOperation.targetsTruncated).toBe(true);
    expect(
      agentOperationEvent('view', {}, { session: { id: 'x'.repeat(129) } }).eventData.agentOperation
        .targets
    ).toEqual([]);
    const wait = agentOperationEvent(
      'wait',
      {},
      {
        agents: [
          { agentId: 'peer', status: 'FAILED', summary: 'Public result', hiddenReasoning: 'SECRET' }
        ]
      }
    );
    expect(JSON.parse(wait.eventSummary)).toMatchObject({
      agents: [{ status: 'FAILED', summary: 'Public result' }]
    });
    expect(wait.eventSummary).not.toContain('SECRET');
  });
});
