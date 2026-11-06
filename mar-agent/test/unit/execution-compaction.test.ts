import { describe, expect, it, vi } from 'vitest';
import { createExecutionCompaction } from '../../src/sdk/execution-compaction.js';
import { CompactCoordinator } from '../../src/runtime/compaction/coordinator.js';
import { SessionExecution } from '../../src/sdk/session-execution.js';
import type { SessionModelMessage } from '../../src/session/model-request.js';

const unused = (): never => {
  throw new Error('not used');
};
const worldState = (generation: string) => ({
  generation,
  initialized: true,
  instructionSnapshot: undefined,
  resourceSnapshot: undefined,
  entries: []
});
const environment = () => ({ platform: 'linux', workspace: '/tmp' });

describe('execution compaction', () => {
  it('does not commit a generated candidate when the source generation changes', async () => {
    const messages: SessionModelMessage[] = [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'answer' }
    ];
    const world = worldState('before');
    const contextual: SessionModelMessage = {
      role: 'user',
      contextKind: 'contextual',
      content: 'CAPTURED_CONTEXT'
    };
    const compact = vi.fn();
    const leaf = createExecutionCompaction({
      mode: 'compact',
      sessionId: 'session',
      executionId: 'execution',
      turnId: 'turn',
      model: { id: 'model', protocol: 'OPENAI_RESPONSES', contextWindowTokens: 1000 },
      messages,
      pendingInputs: new Map(),
      messageSources: new WeakMap(),
      modelContext: {
        worldState: world,
        compactInputs: () => [],
        replaceCompactMessages: unused,
        adoptCompactCheckpoint: unused
      },
      resourceInput: { checkpoint: unused },
      store: { compact },
      coordinator: new CompactCoordinator(),
      userTokenLimit: 100,
      boundary: () => messages.length,
      updateBoundary: () => {},
      snapshotTools: () => [],
      projectRequest: (history, tools) => ({ messages: [contextual, ...history], tools }),
      usage: () => undefined,
      effort: () => 'low',
      environment,
      compose: async () => {
        contextual.content = 'LATER_CONTEXT';
        return { text: 'system' };
      },
      generate: async (snapshot) => {
        expect(snapshot.requestMessages[0]!.content).toBe('CAPTURED_CONTEXT');
        expect(snapshot.history).toEqual(messages);
        world.generation = 'after';
        return { summary: 'summary' };
      },
      retainedResources: async () => undefined,
      withProjection: (action) => action(),
      recordCommit: () => {},
      invalidateContext: () => {},
      invalidateUsage: () => {},
      emit: async () => {}
    });
    await expect(
      leaf({}, new AbortController().signal, async () => {}, 'compact')
    ).rejects.toMatchObject({
      code: 'MAR_AGENT_COMPACT_STALE'
    });
    expect(compact).not.toHaveBeenCalled();
  });

  it('preserves the committed receipt and poisons the execution if live projection fails', async () => {
    const messages: SessionModelMessage[] = [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'answer' }
    ];
    const owner = new SessionExecution(
      's',
      'e',
      't',
      'run',
      'user',
      {
        modelId: 'model',
        mode: 'run',
        models: new Map(),
        generation: 0,
        instruction: undefined
      },
      new Set()
    );
    const failure = new Error('reset continuation');
    const committed: string[] = [];
    const coordinator = new CompactCoordinator();
    const leaf = createExecutionCompaction({
      mode: 'compact',
      sessionId: 's',
      executionId: 'e',
      turnId: 't',
      model: { id: 'model', protocol: 'OPENAI_RESPONSES', contextWindowTokens: 1000 },
      messages,
      pendingInputs: new Map(),
      messageSources: new WeakMap(),
      modelContext: {
        worldState: worldState('g'),
        compactInputs: () => [],
        replaceCompactMessages: () => {
          throw failure;
        },
        adoptCompactCheckpoint: unused
      },
      resourceInput: { checkpoint: () => ({ version: 1 }) },
      store: {
        compact: async () => ({
          recordId: 'checkpoint',
          sessionId: 's',
          sequence: 1,
          timestamp: 'now',
          type: 'compact.completed',
          payload: {}
        })
      },
      coordinator,
      userTokenLimit: 100,
      boundary: () => messages.length,
      updateBoundary: () => {},
      snapshotTools: () => [],
      projectRequest: (history, tools) => ({ messages: history, tools }),
      usage: () => undefined,
      effort: () => 'low',
      environment,
      compose: async () => ({ text: 'system' }),
      generate: async () => ({ summary: 'summary' }),
      retainedResources: async () => undefined,
      withProjection: (action) => action(),
      recordCommit: (id) => committed.push(id),
      invalidateContext: (error) => owner.invalidateContext(error),
      invalidateUsage: () => {},
      emit: async () => {}
    });
    coordinator.start('compact', undefined, (prepare, signal) =>
      leaf({}, signal, prepare, 'compact')
    );
    await expect(coordinator.checkpoint(true).catch(() => owner.assertContextValid())).rejects.toBe(
      failure
    );
    expect(committed).toEqual(['checkpoint']);
    expect(() => owner.assertContextValid()).toThrow(failure);
  });
});
