import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { JsonlSessionStore } from '../../src/agent-core/session/store/index.js';
import { createSubagentBackend } from '../../src/agent-core/sdk/subagent-backend.js';
import {
  SubagentSessionController,
  type SubagentParentExecution
} from '../../src/agent-core/subagent/session-controller.js';
import type { MarAgentEvent } from '../../src/agent-core/runtime/events.js';

/** Disk-backed history keeps benchmark fixtures from retaining the released result bodies. */
export async function residencyFixture(bytes = 128, durable = true) {
  const home = await mkdtemp(join(tmpdir(), 'mar-subagent-residency-'));
  const store = await JsonlSessionStore.open(home);
  const parent = await store.createSession({ workspace: home });
  const backend = createSubagentBackend(store, home);
  const loads = new Map<string, number>();
  let beforeLoad: ((id: string) => Promise<void>) | undefined;
  const controller = await SubagentSessionController.open({
    parentSessionId: parent.id,
    rootSessionId: parent.id,
    backend: {
      ...backend,
      loadChild: async (parentId, id) => {
        loads.set(id, (loads.get(id) ?? 0) + 1);
        await beforeLoad?.(id);
        return backend.loadChild(parentId, id);
      }
    }
  });
  let execution = 0;
  const context = (): SubagentParentExecution => ({
    executionId: `parent-${++execution}`,
    modelId: 'test',
    reasoningEffort: 'low',
    models: new Map([
      [
        'test',
        { id: 'test', name: 'Test', reasoningEfforts: ['low'], defaultReasoningEffort: 'low' }
      ]
    ]),
    emitTerminal: async () => {},
    startTurn: async (input) => {
      const executionId = input.turnId;
      let sequence = 0;
      let persisted = false;
      const text = randomBytes(bytes).toString('hex');
      return {
        executionId,
        turnId: input.turnId,
        get persistedEvents() {
          return persisted;
        },
        async *[Symbol.asyncIterator]() {
          const event = async (
            payload: Omit<
              MarAgentEvent,
              'eventId' | 'sequence' | 'timestamp' | 'sessionId' | 'executionId' | 'turnId'
            >
          ) => {
            const full = {
              ...payload,
              eventId: String(++sequence),
              sequence,
              timestamp: new Date().toISOString(),
              sessionId: input.sessionId,
              executionId,
              turnId: input.turnId
            } as MarAgentEvent;
            if (durable)
              await store.append(input.sessionId, {
                type: full.type,
                payload: full,
                executionId,
                turnId: input.turnId
              });
            return full;
          };
          if (durable) {
            await store.append(input.sessionId, {
              type: 'execution.header',
              executionId,
              turnId: input.turnId,
              payload: { modelId: 'test', modelName: 'Test', reasoningEffort: 'low' }
            });
            await store.append(input.sessionId, {
              type: 'turn.user',
              executionId,
              turnId: input.turnId,
              payload: {
                prompt: input.prompt,
                ...(input.delivery ? { messageId: input.delivery.messageId } : {})
              }
            });
          }
          input.delivery?.applied();
          yield await event({ type: 'execution.started', mode: 'run' } as MarAgentEvent);
          yield await event({
            type: 'tool.completed',
            toolName: 'read',
            callId: 'read',
            summary: 'read',
            data: { results: [{ path: 'source.ts', startLine: 2, endLine: 9 }] }
          } as MarAgentEvent);
          yield await event({
            type: 'tool.completed',
            toolName: 'exec',
            callId: 'exec',
            summary: 'tests passed'
          } as MarAgentEvent);
          yield await event({
            type: 'message.completed',
            itemId: 'answer',
            phase: 'final_answer',
            text
          } as MarAgentEvent);
          yield await event({ type: 'execution.completed' } as MarAgentEvent);
          persisted = durable;
        },
        result: async () => ({ executionId, status: 'completed' as const, finalAnswer: text }),
        cancel: () => {},
        enqueueMessage: () => false
      };
    }
  });
  return {
    home,
    store,
    controller,
    loads,
    context,
    setBeforeLoad: (hook?: (id: string) => Promise<void>) => {
      beforeLoad = hook;
    },
    begin: () => controller.beginParentExecution(context()),
    close: async () => {
      await controller.dispose();
      await rm(home, { recursive: true, force: true });
    }
  };
}
