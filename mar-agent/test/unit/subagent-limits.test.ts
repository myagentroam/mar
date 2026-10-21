import { describe, expect, it, vi } from 'vitest';
import { SubagentScheduler } from '../../src/agent-core/subagent/scheduler.js';
import { SubagentSessionController } from '../../src/agent-core/subagent/session-controller.js';

describe('Default subagent limits', () => {
  it.each(['scheduler', 'session controller'] as const)(
    '%s allows sixteen creations and concurrent Turns, then queues across Executions',
    async (kind) => {
      const started: string[] = [];
      const finishers: Array<() => void> = [];
      const start = (prompt: string) => {
        started.push(prompt);
        let finish!: () => void;
        const completion = new Promise<void>((resolve) => (finish = resolve));
        finishers.push(finish);
        return { completion, finish };
      };
      const runner = async (task: { prompt: string }, signal: AbortSignal) => {
        const work = start(task.prompt);
        signal.addEventListener('abort', work.finish, { once: true });
        try {
          await work.completion;
          return { summary: 'done', changedFiles: [], verification: [], evidence: [] };
        } finally {
          signal.removeEventListener('abort', work.finish);
        }
      };
      let childId = 0;
      const controller =
        kind === 'scheduler'
          ? new SubagentScheduler(runner)
          : await SubagentSessionController.open({
              parentSessionId: 'parent',
              rootSessionId: 'parent',
              backend: {
                createSession: async () => ({ id: `child-${++childId}` }),
                deleteSession: async () => {},
                listChildren: async () => [],
                loadChild: async () => undefined
              }
            });
      let execution = 0;
      const begin = async () => {
        if (controller instanceof SubagentScheduler) controller.beginExecution(runner);
        else
          await controller.beginParentExecution({
            executionId: `parent-${++execution}`,
            modelId: 'test',
            reasoningEffort: 'low',
            models: new Map([
              [
                'test',
                {
                  id: 'test',
                  name: 'Test',
                  reasoningEfforts: ['low'],
                  defaultReasoningEffort: 'low'
                }
              ]
            ]),
            emitTerminal: async () => {},
            startTurn: async (input) => {
              const work = start(input.prompt);
              return {
                executionId: input.turnId,
                turnId: input.turnId,
                async *[Symbol.asyncIterator]() {},
                result: async () => {
                  await work.completion;
                  return { executionId: input.turnId, status: 'completed', finalAnswer: 'done' };
                },
                cancel: work.finish,
                enqueueMessage: () => false
              };
            }
          });
      };
      const task = {
        description: 'Work',
        prompt: 'Work',
        role: 'explore' as const,
        background: true
      };
      try {
        await begin();
        for (let i = 0; i < 16; i++) await controller.run(task);
        await vi.waitFor(() => expect(started).toHaveLength(16));
        await expect(controller.run(task)).rejects.toMatchObject({
          code: 'MAR_AGENT_SUBAGENT_LIMIT'
        });

        await begin();
        const queued = await controller.run(task);
        expect(queued.status).toBe('queued');
        expect(started).toHaveLength(16);
        finishers[0]!();
        await vi.waitFor(() => expect(started).toHaveLength(17));
        expect((await controller.output(queued.agentId, { waitMs: 0 })).status).toBe('running');
      } finally {
        await controller.dispose();
      }
    }
  );
});
