import { expect, it } from 'vitest';
import { agentNetworkWaitModelOutput } from '../../src/runner/mar-agent/agent-network-wait-output.js';

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
  const output = agentNetworkWaitModelOutput(input) as typeof input;
  expect(Buffer.byteLength(JSON.stringify(output), 'utf8')).toBeLessThan(40_000);
  expect(output.agents).toHaveLength(8);
  expect(output.agents.map((item) => item.agentId)).toEqual(
    input.agents.map((item) => item.agentId)
  );
  expect(output.agents.every((item) => 'summaryTruncated' in item)).toBe(true);
  expect(
    input.agents.every((item) => item.summary === summary && item.changedFiles.length === 200)
  ).toBe(true);
});
