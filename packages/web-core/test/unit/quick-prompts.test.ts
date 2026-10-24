import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { createQuickPromptService } from '../../src/service/quick-prompt-service.js';
import type { QuickPrompt } from '../../src/model/workbench.js';

describe('Public Account Quick Tip Read', () => {
  it('Coalesce concurrent refreshes, keep the old list after failure, and allow a later retry', async () => {
    let reject!: (error: Error) => void;
    const request = vi.fn().mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        })
    );
    const prompts = ref<readonly QuickPrompt[]>([]);
    const loading = ref(false);
    const failed = ref(false);
    const service = createQuickPromptService({ prompts, loading, failed, request });
    const first = service.refresh();
    const second = service.refresh();
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith('/api/quick-prompts');
    expect(loading.value).toBe(true);
    reject(new Error('offline'));
    await Promise.all([first, second]);
    expect(failed.value).toBe(true);
    expect(loading.value).toBe(false);
    request.mockResolvedValue({ prompts: [] });
    await service.refresh();
    expect(failed.value).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('Do not replace the current list with a non-array response', async () => {
    const prompts = ref<readonly QuickPrompt[]>([]);
    const service = createQuickPromptService({
      prompts,
      loading: ref(false),
      failed: ref(false),
      request: vi.fn().mockResolvedValue({ prompts: null })
    });
    await service.refresh();
    expect(prompts.value).toEqual([]);
  });
});
