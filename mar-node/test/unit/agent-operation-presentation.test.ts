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
      { agentId: 'peer', sessionId: 'peer' }
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
      { agentId: 'b', sessionId: 'b' }
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
          apiKey: 'SECRET',
          configuration: { password: 'SECRET' },
          latestMessage: { text: 'Public view message', truncated: true, secret: 'SECRET' }
        },
        history: [{ content: 'PRIVATE_HISTORY' }],
        apiKey: 'SECRET'
      }
    );
    expect(JSON.stringify(result)).not.toMatch(/SECRET|PRIVATE_HISTORY/);
    expect(JSON.parse(result.eventSummary).latestMessage).toEqual({
      text: 'Public view message',
      truncated: true
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
