import { describe, expect, it, vi } from 'vitest';
import { createModelTransportTestService } from '../../src/service/model-transport-test-service.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('model transport test lifecycle', () => {
  it('keeps the model busy through acceptance and rejects a duplicate', async () => {
    const result = deferred<never>();
    const refresh = deferred<void>();
    const run = vi.fn(() => result.promise);
    const accept = vi.fn(() => refresh.promise);
    const service = createModelTransportTestService(run, accept);
    const pending = service.test('model-1', 'node-1');
    expect(service.testingIds.value.has('model-1')).toBe(true);
    await service.test('model-1', 'node-1');
    expect(run).toHaveBeenCalledOnce();
    result.resolve({ ok: true } as never);
    await Promise.resolve();
    expect(accept).toHaveBeenCalledOnce();
    expect(service.testingIds.value.has('model-1')).toBe(true);
    refresh.resolve();
    await pending;
    expect(service.testingIds.value.has('model-1')).toBe(false);
  });

  it.each(['invalidate', 'dispose'] as const)(
    'suppresses late failures after %s',
    async (action) => {
      const result = deferred<never>();
      const accept = vi.fn(async () => undefined);
      const service = createModelTransportTestService(() => result.promise, accept);
      const pending = service.test('model-1', 'node-1');
      service[action]();
      result.reject(new Error('failed'));
      await expect(pending).resolves.toBeUndefined();
      expect(accept).not.toHaveBeenCalled();
      expect(service.testingIds.value.size).toBe(0);
    }
  );
});
