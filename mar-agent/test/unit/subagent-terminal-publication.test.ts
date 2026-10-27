import { describe, expect, it } from 'vitest';
import {
  SubagentSessionController,
  type SubagentParentExecution
} from '../../src/subagent/session-controller.js';
import type { SubagentTaskSnapshot } from '../../src/subagent/contracts.js';

describe('subagent terminal publication', () => {
  it('joins a failed opening before replacement and leaves the successor barrier independent', async () => {
    let rejectOpen!: (error: Error) => void;
    let markOpening!: () => void;
    const opening = new Promise<void>((resolve) => {
      markOpening = resolve;
    });
    let finishSuccessor!: () => void;
    const successor = new Promise<void>((resolve) => {
      finishSuccessor = resolve;
    });
    const controller = await SubagentSessionController.open({
      parentSessionId: 'parent',
      rootSessionId: 'parent',
      backend: {
        createSession: async () => ({ id: 'child' }),
        deleteSession: async () => {},
        listChildren: async () => [],
        loadChild: async () => undefined
      }
    });
    let starts = 0;
    const execution: SubagentParentExecution = {
      executionId: 'parent-execution',
      modelId: 'model',
      reasoningEffort: 'low',
      models: new Map([
        [
          'model',
          { id: 'model', name: 'Model', reasoningEfforts: ['low'], defaultReasoningEffort: 'low' }
        ]
      ]),
      emitTerminal: async () => {},
      startTurn: async (input) => {
        if (++starts === 1) {
          markOpening();
          return await new Promise<never>((_, reject) => {
            rejectOpen = reject;
          });
        }
        return {
          executionId: input.turnId,
          turnId: input.turnId,
          async *[Symbol.asyncIterator]() {},
          result: async () => {
            await successor;
            return { executionId: input.turnId, status: 'completed', finalAnswer: 'successor' };
          },
          cancel: () => finishSuccessor(),
          enqueueMessage: () => false
        };
      }
    };
    try {
      await controller.beginParentExecution(execution);
      const child = await controller.run({
        description: 'child',
        prompt: 'first',
        role: 'explore',
        background: true
      });
      await opening;
      let cancelled = false;
      const cancelling = controller.cancel(child.agentId).then(() => {
        cancelled = true;
      });
      const replacing = controller.message(child.agentId, 'next', { delivery: 'replace' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(cancelled).toBe(false);
      expect(starts).toBe(1);
      rejectOpen(new Error('opening failed'));
      await cancelling;
      const receipt = await replacing;
      expect(starts).toBe(2);
      let observed = false;
      const waiting = controller.output(child.agentId, { waitMs: 10_000 }).then((value) => {
        observed = true;
        return value;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(observed).toBe(false);
      finishSuccessor();
      await expect(waiting).resolves.toMatchObject({
        agentId: child.agentId,
        status: 'completed',
        summary: 'successor',
        turnId: receipt.turnId
      });
    } finally {
      rejectOpen?.(new Error('test cleanup'));
      finishSuccessor();
      await controller.dispose();
    }
  });

  it('does not let an older delayed publication acknowledge a newer failed publication', async () => {
    let releaseOld!: () => void;
    let enteredOld!: () => void;
    let enteredNew!: () => void;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const oldEntered = new Promise<void>((resolve) => {
      enteredOld = resolve;
    });
    const newEntered = new Promise<void>((resolve) => {
      enteredNew = resolve;
    });
    const controller = await SubagentSessionController.open({
      parentSessionId: 'parent',
      rootSessionId: 'parent',
      backend: {
        createSession: async () => ({ id: 'child' }),
        deleteSession: async () => {},
        listChildren: async () => [],
        loadChild: async () => undefined
      }
    });
    let starts = 0;
    const delivered: SubagentTaskSnapshot[] = [];
    const execution: SubagentParentExecution = {
      executionId: 'first-parent',
      modelId: 'model',
      reasoningEffort: 'low',
      models: new Map([
        [
          'model',
          { id: 'model', name: 'Model', reasoningEfforts: ['low'], defaultReasoningEffort: 'low' }
        ]
      ]),
      emitTerminal: async (snapshot) => {
        if (snapshot.status === 'failed') {
          enteredOld();
          await oldGate;
          return;
        }
        enteredNew();
        throw new Error('new terminal publication failed');
      },
      startTurn: async (input) => {
        if (++starts === 1) throw new Error('old turn failed to start');
        return {
          executionId: input.turnId,
          turnId: input.turnId,
          async *[Symbol.asyncIterator]() {},
          result: async () => ({
            executionId: input.turnId,
            status: 'completed',
            finalAnswer: 'new result'
          }),
          cancel: () => {},
          enqueueMessage: () => false
        };
      }
    };
    try {
      await controller.beginParentExecution(execution);
      const child = await controller.run({
        description: 'child',
        prompt: 'old',
        role: 'explore',
        background: true
      });
      await oldEntered;
      await controller.message(child.agentId, 'new');
      await newEntered;
      releaseOld();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await controller.beginParentExecution({
        ...execution,
        executionId: 'next-parent',
        emitTerminal: async (snapshot) => {
          delivered.push(snapshot);
        }
      });
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({
        agentId: child.agentId,
        status: 'completed',
        summary: 'new result'
      });
    } finally {
      releaseOld();
      await controller.dispose();
    }
  });
});
