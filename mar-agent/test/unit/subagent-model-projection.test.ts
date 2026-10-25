import { afterEach, describe, expect, it, vi } from 'vitest';
import { residencyFixture } from '../support/subagent-residency.js';
import { executeAgentWait } from '../../src/agent-core/tools/agent/agent-wait.js';
import { executeAgentCancel } from '../../src/agent-core/tools/agent/agent-cancel.js';
import { boundedModelToolOutput } from '../../src/agent-core/tools/output-projection.js';
import { renderSubagentUpdate } from '../../src/agent-core/subagent/model-update.js';
import { SubagentScheduler } from '../../src/agent-core/subagent/scheduler.js';
import type { SubagentTaskSnapshot } from '../../src/agent-core/subagent/contracts.js';
import type { ToolRuntimeContext } from '../../src/agent-core/tools/runtime-context.js';
import type { MarAgentEvent } from '../../src/agent-core/runtime/events.js';
import { TOOL_EXECUTION_LIMITS } from '../../src/agent-core/tools/execution-limits.js';

const fixtures: Awaited<ReturnType<typeof residencyFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

const task = { description: 'Inspect', prompt: 'Inspect independently.', role: 'explore' as const };

async function fixture(noisy = false, answer?: { text?: string; summary: string }) {
  const f = await residencyFixture(128, false);
  fixtures.push(f);
  const parent = f.context();
  const terminals: SubagentTaskSnapshot[] = [];
  await f.controller.beginParentExecution({
    ...parent,
    emitTerminal: async (snapshot) => {
      terminals.push(snapshot);
    },
    startTurn: async (input) => {
      const handle = await parent.startTurn(input);
      return {
        ...handle,
        result: async () => {
          const result = await handle.result();
          return answer ? { ...result, finalAnswer: answer.summary } : result;
        },
        async *[Symbol.asyncIterator]() {
          if (noisy)
            for (let i = 0; i < 16; i++)
              yield {
                type: 'tool.completed',
                toolName: 'exec',
                callId: `verbose-command-${i}`,
                summary: 'command-output '.repeat(140),
                timestamp: new Date().toISOString()
              } as MarAgentEvent;
          for await (const event of handle)
            if (answer && event.type === 'message.completed' && event.phase === 'final_answer') {
              if (answer.text !== undefined) yield { ...event, text: answer.text };
            } else yield event;
        }
      };
    }
  });
  const spawn = async () => {
    const receipt = await f.controller.run({ ...task, background: true });
    await vi.waitFor(async () => {
      expect(await f.controller.inspect(receipt.agentId)).toHaveProperty('status', 'completed');
    });
    return receipt.agentId;
  };
  const context = {
    subagents: f.controller,
    signal: new AbortController().signal
  } as ToolRuntimeContext;
  return { ...f, parent, terminals, spawn, context };
}

function expectModelResult(snapshot: SubagentTaskSnapshot) {
  expect(snapshot.status).toBe('completed');
  expect(snapshot.summary).toBeTruthy();
  expect(snapshot).not.toHaveProperty('verification');
  expect(snapshot).not.toHaveProperty('evidence');
}

describe('subagent model result projection', () => {
  it.each(['single', 'untargeted', 'group', 'cancel'] as const)(
    'omits automatic command and read records from %s results without changing native results',
    async (entry) => {
      const f = await fixture();
      const id = await f.spawn();
      const native = await f.controller.inspect(id);
      expect(native.verification).toEqual(['tests passed']);
      expect(native.evidence).toEqual([{ path: 'source.ts', startLine: 2, endLine: 9 }]);
      const result =
        entry === 'cancel'
          ? await executeAgentCancel({ agentId: id }, f.context)
          : await executeAgentWait(
              {
                ...(entry === 'single' ? { agentId: id } : {}),
                ...(entry === 'group' ? { agentIds: [id], mode: 'all' } : {}),
                waitMs: 10_000
              },
              f.context
            );
      const parsed = JSON.parse(result.content);
      expectModelResult(entry === 'group' ? parsed.agents[0] : parsed);
      expect(await f.controller.inspect(id)).toEqual(native);
    }
  );

  it('keeps automatic updates compact without reporting intentionally omitted records as clipping', async () => {
    const f = await fixture();
    const id = await f.spawn();
    const [update] = f.controller.collectModelUpdates();
    expectModelResult(update!.snapshot);
    expect(update!.truncated).toBe(false);
    const xml = renderSubagentUpdate(update!.snapshot, update!.truncated);
    expect(xml).not.toContain('<verification');
    expect(xml).not.toContain('<evidence');
    expect(xml).toContain('truncated="false"');
    expectModelResult(f.terminals[0]!);
    expect(f.controller.listSessionResources()).toEqual([
      { agentId: id, status: 'completed', description: task.description }
    ]);
    const nativeWait = await f.controller.withOperation(
      {
        ...f.parent,
        operationId: 'inspect-result',
        ownerInstanceId: 'native-consumer',
        extensionId: 'native',
        signal: new AbortController().signal
      },
      () => f.controller.output(id, { waitMs: 10_000 })
    );
    expect(nativeWait.verification).toEqual(['tests passed']);
    expect(nativeWait.evidence).toEqual([{ path: 'source.ts', startLine: 2, endLine: 9 }]);
  });

  it('preserves every final answer in a group with verbose command records', async () => {
    const f = await fixture(true);
    const ids = [await f.spawn(), await f.spawn()];
    const native = await Promise.all(ids.map((id) => f.controller.inspect(id)));
    expect(Buffer.byteLength(JSON.stringify(native))).toBeGreaterThan(40_000);
    const raw = await executeAgentWait({ agentIds: ids, mode: 'all', waitMs: 10_000 }, f.context);
    const model = boundedModelToolOutput('agent_wait', raw.content, raw.data);
    expect(model.truncated).toBe(false);
    const parsed = JSON.parse(model.content);
    expect(parsed.agents).toHaveLength(2);
    for (const [index, agent] of parsed.agents.entries()) {
      expectModelResult(agent);
      expect(agent.agentId).toBe(ids[index]);
      expect(agent.summary).toBe(native[index]!.summary);
      expect(agent.turnId).toBe(native[index]!.latestMessage?.turnId);
      expect(agent).not.toHaveProperty('latestMessage');
    }
  });

  it.each([
    { name: 'identical text', text: 'Verified.', summary: 'Verified.', omit: true },
    { name: 'different text', text: 'Public result.', summary: 'Final result.', omit: false },
    { name: 'whitespace differences', text: ' Result ', summary: 'Result', omit: false },
    { name: 'missing public message', summary: 'Final result.', omit: false },
    {
      name: 'clipped public message',
      text: 'x'.repeat(12_000),
      summary: 'x'.repeat(12_000),
      omit: true
    },
    {
      name: 'complete Unicode message',
      text: '界'.repeat(6_000),
      summary: '界'.repeat(6_000),
      omit: false
    }
  ])(
    'keeps summary and omits only a fully covered final message: $name',
    async ({ text, summary, omit }) => {
      const f = await fixture(false, { text, summary });
      const id = await f.spawn();
      const [update] = f.controller.collectModelUpdates();
      const projected = update!.snapshot;
      const native = await f.controller.inspect(id);
      const summaryClipped =
        Buffer.byteLength(summary) > TOOL_EXECUTION_LIMITS.subagentSummaryMaxBytes;
      if (summaryClipped) {
        expect(summary.startsWith(projected.summary!)).toBe(true);
        expect(Buffer.byteLength(projected.summary!)).toBeLessThanOrEqual(
          TOOL_EXECUTION_LIMITS.subagentSummaryMaxBytes
        );
      } else expect(projected.summary).toBe(summary);
      if (omit) {
        expect(projected).not.toHaveProperty('latestMessage');
        expect(projected.turnId).toBe(native.latestMessage?.turnId);
        expect(renderSubagentUpdate(projected)).not.toContain('<message ');
        expect(f.terminals[0]).not.toHaveProperty('latestMessage');
      } else if (text === undefined) expect(projected).not.toHaveProperty('latestMessage');
      else expect(projected.latestMessage?.text).toBe(text);
      expect(update!.truncated).toBe(summaryClipped);
      expect(renderSubagentUpdate(projected)).toContain('<summary>');
      const output = await executeAgentWait({ agentId: id, waitMs: 10_000 }, f.context);
      expect(JSON.parse(output.content)).toEqual(expect.objectContaining(projected));
      expect(native).toHaveProperty('summary', summary);
      if (text !== undefined) expect(native.latestMessage?.text).toBe(text);
    }
  );

  it('does not expose automatic records through the standalone scheduler', async () => {
    const scheduler = new SubagentScheduler(async () => ({
      summary: 'Tests passed; see source.ts:2-9.',
      changedFiles: ['source.ts'],
      verification: ['verbose command output'],
      evidence: [{ path: 'source.ts', startLine: 2, endLine: 9 }]
    }));
    try {
      const receipt = await scheduler.run(task);
      const result = await executeAgentWait(
        { agentIds: [receipt.agentId], mode: 'all', waitMs: 10_000 },
        { subagents: scheduler, signal: new AbortController().signal } as ToolRuntimeContext
      );
      expectModelResult(JSON.parse(result.content).agents[0]);
    } finally {
      await scheduler.dispose();
    }
  });
});
