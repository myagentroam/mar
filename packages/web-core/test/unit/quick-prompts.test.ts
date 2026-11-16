import { describe, expect, it, vi } from 'vitest';
import { createQuickPromptService } from '../../src/service/quick-prompt-service.js';

describe('Public Account Quick Tip Read', () => {
  it.each(['success', 'failure'] as const)(
    'discards old-account %s without settling a new-account refresh',
    async (outcome) => {
      let resolveOld!: (value: unknown) => void;
      let rejectOld!: (error: Error) => void;
      let resolveCurrent!: (value: unknown) => void;
      const request = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve, reject) => {
              resolveOld = resolve;
              rejectOld = reject;
            })
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveCurrent = resolve;
            })
        );
      const service = createQuickPromptService({ request });
      const old = service.refresh();
      service.clear();
      const current = service.refresh();
      if (outcome === 'success') resolveOld({ prompts: [{ id: 'private-old-prompt' }] });
      else rejectOld(new Error('old request failed'));
      await old;
      expect(service.prompts.value).toEqual([]);
      expect(service.loading.value).toBe(true);
      expect(service.failed.value).toBe(false);
      resolveCurrent({ prompts: [] });
      await current;
      expect(service.loading.value).toBe(false);
    }
  );

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
