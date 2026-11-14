import { expect, it } from 'vitest';
import { agentNetworkModelOutput } from '../../src/runner/mar-agent/agent-network-model-output.js';

it('bounds the model projection fairly while preserving the Node result', () => {
  const summary = '😀'.repeat(4096);
  const input = {
    waitFor: 'completion',
    waitOutcome: 'completion',
    agents: Array.from({ length: 8 }, (_, n) => ({
      agentId: `agent-${n}`,
      runId: `run-${n}`,
      executionId: `execution-${n}`,
      status: 'SUCCEEDED',
      waitOutcome: 'completion',
      summary,
      changedFiles: Array.from({ length: 200 }, (_, i) => `src/${n}/${i}-${'x'.repeat(100)}.ts`)
    }))
  };
  const output = agentNetworkModelOutput('wait', input) as typeof input;
  expect(Buffer.byteLength(JSON.stringify(output), 'utf8')).toBeLessThan(40_000);
  expect(output.agents).toHaveLength(8);
  expect(output.agents.map((item) => item.agentId)).toEqual(
    input.agents.map((item) => item.agentId)
  );
  expect(output.agents.every((item) => 'summaryTruncated' in item)).toBe(true);
  expect(output.agents.every((item) => !('runId' in item) && !('executionId' in item))).toBe(true);
  expect(
    input.agents.every((item) => item.summary === summary && item.changedFiles.length === 200)
  ).toBe(true);
});

it('preserves partial and unknown operation outcomes without nested audit receipts', () => {
  const input = {
    agentId: 'child',
    approval: {
      status: 'partial',
      code: 'APPROVAL_DECISION_FAILED',
      result: { approvalId: 'approval', decision: 'approve', auditReceipt: { runId: 'internal' } }
    },
    goal: {
      status: 'failed',
      code: 'AGENT_GOAL_FAILED',
      current: { id: 'internal-goal', objective: 'Remaining task', status: 'active', revision: 4 }
    },
    message: { status: 'unknown', code: 'AGENT_SEND_FAILED' }
  };
  const before = structuredClone(input);
  expect(agentNetworkModelOutput('send', input)).toEqual({
    agentId: 'child',
    approval: {
      status: 'partial',
      code: 'APPROVAL_DECISION_FAILED',
      approvalId: 'approval',
      decision: 'approve'
    },
    goal: {
      status: 'failed',
      code: 'AGENT_GOAL_FAILED',
      current: { objective: 'Remaining task', status: 'active' }
    },
    message: { status: 'unknown', code: 'AGENT_SEND_FAILED' }
  });
  expect(input).toEqual(before);
  expect(
    agentNetworkModelOutput('send', {
      agentId: 'child',
      approval: input.approval,
      goal: { status: 'not_attempted' },
      message: { status: 'not_attempted' }
    })
  ).toMatchObject({ goal: { status: 'not_attempted' }, message: { status: 'not_attempted' } });
  expect(
    agentNetworkModelOutput('stop', {
      agentId: 'child',
      cancel: { status: 'unknown', code: 'AGENT_STOP_FAILED' },
      goal: { status: 'unchanged' }
    })
  ).toEqual({
    agentId: 'child',
    cancel: { status: 'unknown', code: 'AGENT_STOP_FAILED' },
    goal: { status: 'unchanged' }
  });
});

it('preserves Goal-only outcomes without fabricating a delivered message', () => {
  expect(
    agentNetworkModelOutput('send', {
      agentId: 'child',
      message: null,
      goal: {
        status: 'applied',
        result: {
          goal: { id: 'internal-goal', objective: 'Existing task', status: 'active', revision: 3 },
          goalAccessChanged: false
        }
      }
    })
  ).toEqual({
    agentId: 'child',
    message: null,
    goal: { status: 'applied', goal: { status: 'active' }, goalAccessChanged: false }
  });
  expect(
    agentNetworkModelOutput('send', {
      agentId: 'child',
      message: null,
      goal: {
        status: 'applied',
        result: { cleared: true, goalExit: { status: 'removed', elapsedWallMs: 5000, turns: 2 } }
      }
    })
  ).toEqual({
    agentId: 'child',
    message: null,
    goal: { status: 'applied', cleared: true, goalExit: { status: 'removed' } }
  });
});

it('wraps implicit child selection in agents and preserves messages, files and interruption', () => {
  const input = {
    agentId: 'child',
    runId: 'run',
    executionId: 'execution',
    turnId: 'turn',
    waitFor: 'message',
    waitOutcome: 'interrupted',
    reason: 'steer',
    status: 'RUNNING',
    changedFiles: ['src/task.ts'],
    changedFilesTruncated: true,
    updates: [{ kind: 'message', value: 'A decision is needed', truncated: false }]
  };
  expect(agentNetworkModelOutput('wait', input)).toEqual({
    waitFor: 'message',
    waitOutcome: 'interrupted',
    reason: 'steer',
    agents: [
      {
        agentId: 'child',
        status: 'RUNNING',
        waitOutcome: 'interrupted',
        changedFiles: ['src/task.ts'],
        changedFilesTruncated: true,
        updates: input.updates
      }
    ]
  });
  expect(input.runId).toBe('run');
});

it('bounds unread message text without losing terminal state or invalidating Unicode', () => {
  const input = {
    agents: [
      {
        agentId: 'child',
        status: 'FAILED',
        waitOutcome: 'completion',
        updates: [{ kind: 'terminal', value: 'Failed: ' + '😀'.repeat(10000), truncated: false }]
      }
    ],
    waitOutcome: 'completion'
  };
  const output = agentNetworkModelOutput('wait', input) as typeof input;
  expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(35000);
  expect(output.agents[0]).toMatchObject({
    agentId: 'child',
    status: 'FAILED',
    waitOutcome: 'completion',
    updates: [{ kind: 'terminal', truncated: true }]
  });
  expect(JSON.stringify(output)).not.toContain('�');
  expect(input.agents[0]!.updates[0]!.truncated).toBe(false);
});
