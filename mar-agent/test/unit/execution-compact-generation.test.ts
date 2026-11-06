import { afterEach, expect, it, vi } from 'vitest';
import { CompactionOperation } from '../../src/runtime/compaction/operation.js';
import { generateExecutionCompaction } from '../../src/sdk/execution-compact-generation.js';

afterEach(() => vi.useRealTimers());

it('disposes its deadline and progress timer if the independent Turn cannot be created', async () => {
  vi.useFakeTimers();
  const failure = new Error('create Turn');
  const progress = vi.fn();
  const operation = new CompactionOperation(new AbortController().signal, progress);
  await expect(
    generateExecutionCompaction({
      snapshot: {
        history: [],
        requestMessages: [],
        system: '',
        tools: [],
        contextWindowTokens: 1000,
        latestUsage: undefined,
        reasoningEffort: 'low',
        reason: 'manual',
        promptCacheKey: 'test'
      },
      createOperation: () => operation,
      withTurn: () => {
        throw failure;
      },
      generateExtension: async () => undefined,
      transformRequest: async (request) => request,
      stream: (start, signal) => start(signal),
      observeUsage: async () => {},
      onAttemptDiagnostic: () => {}
    })
  ).rejects.toBe(failure);
  expect(progress).toHaveBeenCalledTimes(1);
  expect(progress).toHaveBeenCalledWith(expect.objectContaining({ state: 'FINISHED' }));
  await vi.advanceTimersByTimeAsync(610_000);
  expect(progress).toHaveBeenCalledTimes(1);
  expect(operation.signal.aborted).toBe(false);
});
