import { expect, it } from 'vitest';
import { countModelTokens } from '@myagentroam/agent';
import { modelWaitAgent } from '../src/wait-output.js';

it('keeps every group member in bounded valid JSON without changing native snapshots', () => {
  const agents = Array.from({ length: 8 }, (_, index) => ({
    agentId: `child-${index}`,
    executionId: `execution-${index}`,
    status: 'completed',
    waitOutcome: 'completion',
    summary: '😀'.repeat(4096),
    changedFiles: Array.from({ length: 200 }, (_, file) => `src/${file}-${'x'.repeat(80)}.ts`)
  }));
  const projected = agents.map((agent) => modelWaitAgent(agent, Math.floor(34000 / agents.length)));
  const content = JSON.stringify({
    mode: 'all',
    waitFor: 'completion',
    waitOutcome: 'completion',
    agents: projected,
    pendingAgentIds: []
  });
  expect(countModelTokens(content)).toBeLessThan(10000);
  const parsed = JSON.parse(content);
  expect(parsed.agents.map((agent: { agentId: string }) => agent.agentId)).toEqual(
    agents.map((a) => a.agentId)
  );
  expect(
    parsed.agents.every((agent: { summaryTruncated?: boolean }) => agent.summaryTruncated)
  ).toBe(true);
  expect(
    agents.every((agent) => agent.summary.length === 8192 && agent.changedFiles.length === 200)
  ).toBe(true);
});

it('retains complete summaries when the group fits and marks truncated file lists', () => {
  const agent = {
    agentId: 'child',
    status: 'completed',
    waitOutcome: 'completion',
    summary: 'a'.repeat(16000),
    changedFiles: Array.from({ length: 200 }, (_, i) => `${i}-${'x'.repeat(100)}`)
  };
  const model = modelWaitAgent(agent, 17000);
  expect(model.summary).toBe(agent.summary);
  expect(model.changedFilesTruncated).toBe(true);
  expect(model.changedFiles!.length).toBeLessThan(200);
  expect(agent.changedFiles).toHaveLength(200);
});

it('preserves actionable failure, permission and receipt states in the compact fallback', () => {
  const agent = {
    agentId: 'child',
    status: 'FAILED',
    waitOutcome: 'completion',
    errorCode: 'TEST_FAILURE',
    errorMessage: 'error'.repeat(4000),
    receipt: { status: 'applied' },
    permissionStop: { action: 'ask', reason: 'permission'.repeat(4000) }
  };
  const result = modelWaitAgent(agent, 4250);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4250);
  expect(result).toMatchObject({
    detailsTruncated: true,
    agentId: 'child',
    status: 'FAILED',
    errorCode: 'TEST_FAILURE',
    receipt: { status: 'applied' },
    permissionStop: { action: 'ask' }
  });
  expect(result.errorMessage!.length).toBeLessThan(agent.errorMessage.length);
  expect(result.permissionStop!.reason.length).toBeLessThan(agent.permissionStop.reason.length);
  expect(agent.permissionStop.reason).toHaveLength(40000);
});
