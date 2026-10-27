import { SubagentSessionController } from '../../../src/subagent/session-controller.js';
import type { SubagentTaskInput } from '../../../src/subagent/contracts.js';
import type { AgentEvent } from '../../../src/runtime/events.js';

interface TestTurnResult {
  summary: string;
  changedFiles: string[];
  verification: string[];
  evidence: Array<{ path: string; startLine?: number; endLine?: number }>;
}

/** Drive the production controller with a controlled child-turn boundary. */
export async function createTestSubagents(
  runner: (task: SubagentTaskInput, signal: AbortSignal) => Promise<TestTurnResult>,
  limits?: { maxTasks: number; maxConcurrent: number }
) {
  let sequence = 0;
  const descriptions = new Map<string, string>();
  const controller = await SubagentSessionController.open({
    parentSessionId: 'parent',
    rootSessionId: 'parent',
    ...(limits ? { limits } : {}),
    backend: {
      createSession: async ({ title }) => {
        const id = `child-${++sequence}`;
        descriptions.set(id, title);
        return { id };
      },
      deleteSession: async (id) => {
        descriptions.delete(id);
      },
      listChildren: async () => [],
      loadChild: async () => undefined
    }
  });
  const models = new Map(
    ['test', 'review'].map((id) => [
      id,
      {
        id,
        name: id,
        reasoningEfforts: ['low', 'medium', 'high'] as const,
        defaultReasoningEffort: 'low' as const
      }
    ])
  );
  await controller.beginParentExecution({
    executionId: 'parent-execution',
    modelId: 'test',
    reasoningEffort: 'low',
    models,
    emitTerminal: async () => {},
    startTurn: async (input) => {
      const abort = new AbortController();
      const work = runner(
        {
          description: descriptions.get(input.sessionId)!,
          prompt: input.prompt,
          role: input.role,
          modelId: input.modelId,
          reasoningEffort: input.reasoningEffort
        },
        abort.signal
      );
      const result = work.then(
        (value) => ({
          executionId: input.turnId,
          status: 'completed' as const,
          finalAnswer: value.summary
        }),
        () => ({
          executionId: input.turnId,
          status: abort.signal.aborted ? ('cancelled' as const) : ('failed' as const),
          finalAnswer: ''
        })
      );
      return {
        turnId: input.turnId,
        executionId: input.turnId,
        async *[Symbol.asyncIterator]() {
          try {
            const value = await work;
            let eventSequence = 0;
            const event = (payload: Record<string, unknown>) =>
              ({
                ...payload,
                eventId: String(++eventSequence),
                sequence: eventSequence,
                timestamp: new Date().toISOString(),
                sessionId: input.sessionId,
                executionId: input.turnId,
                turnId: input.turnId
              }) as AgentEvent;
            if (value.changedFiles.length) {
              yield event({
                type: 'tool.completed',
                toolName: 'apply_patch',
                callId: 'patch',
                summary: 'Files updated',
                data: { files: value.changedFiles.map((path) => ({ path })) }
              });
            }
            for (const summary of value.verification) {
              yield event({
                type: 'tool.completed',
                toolName: 'exec',
                callId: 'exec',
                summary
              });
            }
            if (value.evidence.length) {
              yield event({
                type: 'tool.completed',
                toolName: 'read',
                callId: 'read',
                summary: 'Files read',
                data: { results: value.evidence }
              });
            }
            yield event({
              type: 'message.completed',
              itemId: 'answer',
              phase: 'final_answer',
              text: value.summary
            });
          } catch {
            /* The result reports the child failure. */
          }
        },
        result: () => result,
        cancel: () => abort.abort(),
        enqueueMessage: () => false
      };
    }
  });
  return controller;
}
