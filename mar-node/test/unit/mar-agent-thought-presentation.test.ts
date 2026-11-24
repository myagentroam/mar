import { expect, it } from 'vitest';
import type { AgentEvent } from '@myagentroam/agent';
import { MarAgentConversationNormalizer } from '../../src/runner/mar-agent/conversation-normalizer.js';

it('marks Thought titles without exposing the body or changing ordinary reasoning', () => {
  const normalizer = new MarAgentConversationNormalizer();
  const base = {
    eventId: 'event',
    sequence: 1,
    timestamp: '2026-11-24T10:00:00Z',
    sessionId: 'session',
    executionId: 'execution',
    turnId: 'turn',
    callId: 'call'
  };
  const tool = { ...base, toolName: 'thought' };
  expect(normalizer.normalize({ ...tool, type: 'tool.started', input: {} })).toEqual([]);
  expect(
    normalizer.normalize({ ...tool, type: 'tool.failed', code: 'BAD_INPUT', message: 'invalid' })
  ).toEqual([]);
  expect(
    normalizer.normalize({ ...tool, type: 'tool.completed', summary: '{"status":"recorded"}' })
  ).toEqual([]);
  const content = 'TX: CAS✓; ¬dual-wr⇒split-brain; ?q7/lease@failover';
  const title = '确认单写入者约束';
  const recorded = { ...base, type: 'thought.recorded', title, content } as const;
  expect(normalizer.normalize(recorded)).toEqual([
    expect.objectContaining({
      kind: 'reasoning',
      status: 'COMPLETED',
      payload: { representation: 'summary', sections: [{ index: 0, text: `✦ ${title}` }] }
    })
  ]);
  expect(
    normalizer.normalize({
      ...base,
      type: 'reasoning.completed',
      itemId: 'provider-reasoning',
      representation: 'summary',
      text: title
    })
  ).toEqual([
    expect.objectContaining({
      kind: 'reasoning',
      status: 'COMPLETED',
      payload: { representation: 'summary', sections: [{ index: 0, text: title }] }
    })
  ]);
  const legacy = { ...base, type: 'thought.recorded', summary: content } as unknown as AgentEvent;
  expect(normalizer.normalize(legacy)).toEqual([]);
});
