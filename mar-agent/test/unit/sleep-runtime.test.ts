import { afterEach, describe, expect, it } from 'vitest';
import type { Agent, AgentEvent } from '../../src/index.js';
import { createSubagentExtension } from '../../extensions/subagent/src/index.js';
import type { ModelRequest } from '../../src/model/contracts.js';
import { fixture, answer, call, cleanupCoreFixtures } from './support/core-extension-fixture.js';

afterEach(cleanupCoreFixtures);

function sleepResult(request: ModelRequest) {
  const message = request.messages.findLast(
    (item) => item.role === 'tool' && item.name === 'sleep'
  );
  return JSON.parse(message!.content) as { wakeReason: string; elapsedMs: number };
}

describe.each(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'] as const)('SDK sleep %s', (protocol) => {
  it.each([false, true])(
    'wakes on steer and remains directly callable (Code Mode: %s)',
    async (codeMode) => {
      const sleeping = Promise.withResolvers<void>();
      const requests: ModelRequest[] = [];
      const f = await fixture(
        [],
        (request) => {
          requests.push(request);
          expect(request.tools.some((tool) => tool.name === 'sleep')).toBe(true);
          if (requests.length === 1) return call('sleep', { durationMs: 300000 });
          if (requests.length === 2) {
            expect(sleepResult(request).wakeReason).toBe('steer');
            expect(
              request.messages.filter(
                (item) => item.role === 'user' && item.content === 'change course'
              )
            ).toHaveLength(1);
            return call('sleep', { durationMs: 5 });
          }
          expect(sleepResult(request).wakeReason).toBe('elapsed');
          return answer();
        },
        codeMode,
        false,
        {},
        protocol
      );
      const execution = f.session.run({ prompt: 'wait briefly', permissionMode: 'full-access' });
      const events: AgentEvent[] = [];
      const collecting = (async () => {
        for await (const event of execution) {
          events.push(event);
          if (event.type === 'tool.started' && event.toolName === 'sleep') sleeping.resolve();
        }
      })();
      await sleeping.promise;
      expect(
        (
          await f.session.steer({
            expectedExecutionId: execution.executionId,
            prompt: 'change course',
            clientMessageId: 'sleep-steer'
          })
        ).status
      ).toBe('accepted');
      const result = await execution.result();
      expect(result.status, JSON.stringify(result)).toBe('completed');
      await collecting;
      expect(requests).toHaveLength(3);
      expect(
        events.filter((event) => event.type === 'tool.completed' && event.toolName === 'sleep')
      ).toMatchObject([{ data: { wakeReason: 'steer' } }, { data: { wakeReason: 'elapsed' } }]);
      expect(events.some((event) => event.type === 'tool.failed')).toBe(false);
    }
  );

  it('wakes for a running child message, injects and marks it read, then sleeps normally', async () => {
    const releaseMessage = Promise.withResolvers<void>();
    const holdChild = Promise.withResolvers<void>();
    let childReads = 0;
    let childRounds = 0;
    let agent!: Agent;
    const parents: ModelRequest[] = [];
    const f = await fixture(
      [createSubagentExtension({ agent: () => agent })],
      (request) => {
        const child = request.messages.some(
          (message) => message.role === 'user' && message.content.includes('sleep child worker')
        );
        if (child) {
          childRounds++;
          if (childRounds === 1) return call('read', { reads: [{ path: 'input.txt' }] });
          if (childRounds === 2)
            return [
              {
                type: 'text.completed',
                itemId: 'progress',
                phase: 'commentary',
                text: 'public progress while still running'
              },
              ...call('read', { reads: [{ path: 'input.txt' }] })
            ];
          return answer();
        }
        parents.push(request);
        if (parents.length === 1)
          return call('agent_start', {
            title: 'Child progress',
            description: 'Child progress',
            prompt: 'sleep child worker',
            role: 'explore'
          });
        if (parents.length === 2) return call('sleep', { durationMs: 300000 });
        const updates = request.messages.filter(
          (message) =>
            message.contextKind === 'contextual' &&
            message.content.startsWith('<mar_subagent_update>')
        );
        expect(updates).toHaveLength(1);
        expect(updates[0]!.content).toContain('public progress while still running');
        if (parents.length === 3) {
          expect(sleepResult(request).wakeReason).toBe('subagent_message');
          expect(updates[0]!.content).toContain('"kind":"message"');
          return call('sleep', { durationMs: 10 });
        }
        expect(sleepResult(request).wakeReason).toBe('elapsed');
        return answer();
      },
      false,
      false,
      {
        beforeToolExecute: async (tool) => {
          if (tool.name !== 'read') return;
          childReads++;
          await (childReads === 1 ? releaseMessage.promise : holdChild.promise);
        }
      },
      protocol
    );
    try {
      agent = f.agent;
      await agent.reconfigureModels({
        models: [{ ...f.adapter.configuration, subagentModel: true }]
      });
      const execution = f.session.run({
        prompt: 'receive child progress',
        permissionMode: 'full-access'
      });
      const collecting = (async () => {
        for await (const event of execution)
          if (event.type === 'tool.started' && event.toolName === 'sleep') releaseMessage.resolve();
      })();
      const result = await execution.result();
      expect(result.status, JSON.stringify(result)).toBe('completed');
      await collecting;
      expect(parents).toHaveLength(4);
      expect(childReads).toBe(2);
    } finally {
      releaseMessage.resolve();
      holdChild.resolve();
    }
  });

  it('cancels an active sleep without leaving a wait in the next Execution', async () => {
    const sleeping = Promise.withResolvers<void>();
    let rounds = 0;
    const f = await fixture(
      [],
      () =>
        ++rounds === 1
          ? call('sleep', { durationMs: 300000 })
          : rounds === 2
            ? call('sleep', { durationMs: 1 })
            : answer(),
      false,
      false,
      {},
      protocol
    );
    const execution = f.session.run({ prompt: 'cancel this wait', permissionMode: 'full-access' });
    const collecting = (async () => {
      for await (const event of execution)
        if (event.type === 'tool.started' && event.toolName === 'sleep') sleeping.resolve();
    })();
    await sleeping.promise;
    execution.cancel();
    expect(await execution.result()).toMatchObject({ status: 'cancelled' });
    await collecting;
    expect(
      await f.session.run({ prompt: 'new wait', permissionMode: 'full-access' }).result()
    ).toMatchObject({ status: 'completed' });
  });
});
