import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentError } from '../../src/error.js';
import type { ModelEvent, ModelRequest, ModelTurnSession } from '../../src/model/contracts.js';
import { generateCompactionCandidate } from '../../src/runtime/compaction/generate.js';
import { CompactionOperation } from '../../src/runtime/compaction/operation.js';
import { projectSessionRequestMessages } from '../../src/sdk/request-preparation.js';

const snapshot = () => {
  const history = [
    { role: 'user' as const, content: 'Keep the original objective.' },
    { role: 'assistant' as const, content: 'Verified the first step.' }
  ];
  return {
    history,
    requestMessages: projectSessionRequestMessages(
      history,
      [{ index: 0, kind: 'instructions', content: 'PRIVATE_RUNTIME_CONTEXT' }],
      false,
      false
    ),
    system: 'System.',
    tools: [],
    contextWindowTokens: 100_000,
    latestUsage: undefined,
    reasoningEffort: 'medium' as const,
    reason: 'manual' as const,
    promptCacheKey: 'candidate-only'
  };
};
const answer: ModelEvent[] = [
  { type: 'text.completed', itemId: 'summary', text: '  Complete handoff.  ' },
  { type: 'usage', usage: { inputTokens: 25, outputTokens: 5 } },
  { type: 'completed', reason: 'completed' }
];
const operations: CompactionOperation[] = [];
afterEach(async () => {
  await Promise.all(operations.splice(0).map((operation) => operation.dispose()));
  vi.useRealTimers();
});
function dependencies(
  script: (request: ModelRequest, signal: AbortSignal) => AsyncIterable<ModelEvent>
) {
  const operation = new CompactionOperation(new AbortController().signal, () => undefined);
  operations.push(operation);
  const turn: ModelTurnSession = { start: vi.fn(script), close: vi.fn(async () => undefined) };
  return {
    operation,
    turn,
    generateExtension: vi.fn(async (_history: ModelRequest['messages']) => undefined),
    transformRequest: vi.fn(async (request: ModelRequest) => request),
    stream: (start: (signal: AbortSignal) => AsyncIterable<ModelEvent>, signal: AbortSignal) =>
      start(signal),
    observeUsage: vi.fn(async () => undefined),
    onAttemptDiagnostic: vi.fn()
  };
}

describe('compaction candidate generation', () => {
  it('returns only a complete candidate without mutating the snapshot or closing borrowed resources', async () => {
    const input = snapshot();
    const before = structuredClone(input);
    const d = dependencies(async function* () {
      yield* answer;
    });
    await expect(generateCompactionCandidate(input, d)).resolves.toEqual({
      summary: 'Complete handoff.',
      usage: { inputTokens: 25, outputTokens: 5 }
    });
    expect(input).toEqual(before);
    expect(d.turn.close).not.toHaveBeenCalled();
    expect(d.transformRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining(input.history),
        toolChoice: 'none',
        promptCacheKey: 'candidate-only'
      })
    );
    expect(d.observeUsage).toHaveBeenCalledExactlyOnceWith({ inputTokens: 25, outputTokens: 5 });
    expect(d.transformRequest.mock.calls[0]![0].messages).toContainEqual(
      expect.objectContaining({ content: 'PRIVATE_RUNTIME_CONTEXT' })
    );
    expect(d.generateExtension.mock.calls[0]![0]).toEqual(input.history);
  });

  it('retries an overflowing native prefix as bounded text without re-entering the extension', async () => {
    let requests = 0;
    const d = dependencies(async function* () {
      if (++requests === 1) throw new AgentError('context_length_exceeded', 'Overflow.');
      yield* answer;
    });
    await expect(generateCompactionCandidate(snapshot(), d)).resolves.toHaveProperty(
      'summary',
      'Complete handoff.'
    );
    expect(d.generateExtension).toHaveBeenCalledTimes(1);
    expect(d.transformRequest).toHaveBeenCalledTimes(2);
    const first = d.transformRequest.mock.calls[0]![0];
    const fallback = d.transformRequest.mock.calls[1]![0];
    expect(first.messages).not.toEqual(fallback.messages);
    expect(fallback.messages.map((message) => message.content).join('\n')).toContain(
      'Keep the original objective.'
    );
    expect(fallback.retryState).toBe(first.retryState);
    expect(JSON.stringify(first.messages)).toContain('PRIVATE_RUNTIME_CONTEXT');
    expect(JSON.stringify(fallback.messages)).not.toContain('PRIVATE_RUNTIME_CONTEXT');
  });

  it('budgets the captured request projection before choosing bounded durable evidence', async () => {
    const input = snapshot();
    input.requestMessages = projectSessionRequestMessages(
      input.history,
      [{ index: 0, kind: 'instructions', content: 'PRIVATE_LARGE_CONTEXT'.repeat(20_000) }],
      false,
      false
    );
    const d = dependencies(async function* () {
      yield* answer;
    });
    await generateCompactionCandidate(input, d);
    expect(d.transformRequest).toHaveBeenCalledTimes(1);
    const request = d.transformRequest.mock.calls[0]![0];
    expect(request.messages).toHaveLength(2);
    expect(JSON.stringify(request.messages)).not.toContain('PRIVATE_LARGE_CONTEXT');
    expect(JSON.stringify(request.messages)).toContain('Keep the original objective.');
  });

  it.each(['max_output', 'cancelled'] as const)(
    'rejects a partial %s result rather than returning a candidate',
    async (reason) => {
      const d = dependencies(async function* () {
        yield answer[0]!;
        yield { type: 'completed', reason };
      });
      await expect(generateCompactionCandidate(snapshot(), d)).rejects.toMatchObject({
        code: 'MAR_AGENT_COMPACT_FAILED'
      });
      expect(d.turn.close).not.toHaveBeenCalled();
    }
  );
});
