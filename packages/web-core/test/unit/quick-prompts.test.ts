import { describe, expect, it, vi } from 'vitest';
import { createQuickPromptService } from '../../src/service/quick-prompt-service.js';

describe('Public Account Quick Tip Read', () => {
  it('Coalesce concurrent refreshes, keep the old list after failure, and allow a later retry', async () => {
    let reject!: (error: Error) => void;
    const request = vi.fn().mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        })
    );
    const service = createQuickPromptService({ request });
    const { loading, failed } = service;
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
    const service = createQuickPromptService({
      request: vi.fn().mockResolvedValue({ prompts: null })
    });
    await service.refresh();
    expect(service.prompts.value).toEqual([]);
  });
});
