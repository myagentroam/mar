import { expect, it, vi } from 'vitest';
import { createExecutionCompactExtension } from '../../src/sdk/execution-compact-extension.js';
import { CompactionOperation } from '../../src/runtime/compaction/operation.js';

it('drops late diagnostics and falls back after an Extension failure', async () => {
  const operation = new CompactionOperation(new AbortController().signal, () => {});
  let report!: (value: unknown) => void;
  const diagnostic = vi.spyOn(operation, 'observeExtension');
  const extension = createExecutionCompactExtension({
    contextWindowTokens: 1000,
    maxOutputTokens: 100,
    hasInterceptor: () => true,
    invoke: async (context) => {
      report = context.reportDiagnostic;
      throw new Error('extension failure');
    }
  });
  await expect(
    extension([{ role: 'user', content: 'history' }], 'manual', undefined, operation)
  ).resolves.toBeUndefined();
  report({ stage: 'late' });
  expect(diagnostic).not.toHaveBeenCalled();
  await operation.dispose();
});
