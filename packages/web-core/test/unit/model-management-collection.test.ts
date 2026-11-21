import { describe, expect, it, vi } from 'vitest';
import {
  createModelManagementCollectionService,
  type ManagedModelSummary
} from '../../src/service/model-management-collection-service.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('model management collection', () => {
  it('reads proxy details without caching or retaining a late response after disposal', async () => {
    const pending = deferred<unknown>();
    const request = vi.fn().mockReturnValue(pending.promise);
    const collection = createModelManagementCollectionService(
      request,
      '/api/admin/mar-agent/models',
      () => true
    );
    const reading = collection.connectionDetails('model/one');
    expect(request).toHaveBeenCalledExactlyOnceWith(
      '/api/admin/mar-agent/models/model%2Fone/connection',
      { cache: 'no-store' }
    );
    collection.dispose();
    pending.resolve({ details: { socks5Url: 'socks5://private:password@proxy.invalid:1080' } });
    await expect(reading).resolves.toBeUndefined();
    expect(collection.models.value).toEqual([]);
  });
  it('commits a model before refreshing and respects a revoked management scope', async () => {
    const commit = deferred<unknown>();
    let authorized = true;
    const request = vi.fn().mockReturnValueOnce(commit.promise).mockResolvedValue({ models: [] });
    const collection = createModelManagementCollectionService(
      request,
      '/api/mar-agent/models',
      () => authorized
    );
    const saving = collection.saveModel({ editingId: 'model-1', body: { name: 'Updated' } });
    expect(request).toHaveBeenCalledExactlyOnceWith('/api/mar-agent/models/model-1', {
      method: 'PUT',
      body: JSON.stringify({ name: 'Updated' })
    });
    authorized = false;
    commit.resolve({});
    const result = await saving;
    expect(result?.refresh).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('suppresses a late mutation and its refresh after disposal', async () => {
    const commit = deferred<unknown>();
    const request = vi.fn().mockReturnValueOnce(commit.promise);
    const collection = createModelManagementCollectionService(
      request,
      '/api/mar-agent/models',
      () => true
    );
    const deleting = collection.removeModel('model-1');
    collection.dispose();
    commit.resolve({});
    await expect(deleting).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledExactlyOnceWith('/api/mar-agent/models/model-1', {
      method: 'DELETE'
    });
  });

  it('suppresses a late failed mutation after disposal', async () => {
    const commit = deferred<unknown>();
    const request = vi.fn().mockReturnValueOnce(commit.promise);
    const collection = createModelManagementCollectionService(
      request,
      '/api/mar-agent/models',
      () => true
    );
    const deleting = collection.removeModel('model-1');
    collection.dispose();
    commit.reject(new Error('request failed'));
    await expect(deleting).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('ignores an older load and any response after disposal', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const third = deferred<unknown>();
    const request = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const collection = createModelManagementCollectionService(
      request,
      '/api/mar-agent/models',
      () => true
    );
    const old = collection.load();
    const latest = collection.load();
    second.resolve({ models: [] });
    await latest;
    expect(collection.ready.value).toBe(true);
    first.resolve({ models: [{ id: 'stale' }] });
    await old;
    expect(collection.models.value).toEqual([]);
    const pending = collection.load();
    collection.dispose();
    third.resolve({ models: [{ id: 'after-dispose' }] });
    await pending;
    expect(collection.models.value).toEqual([]);
    expect(collection.loading.value).toBe(false);
  });

  it('serializes order writes and leaves the editable order intact on failure', async () => {
    const gate = deferred<void>();
    const request = vi.fn(async () => {
      await gate.promise;
      throw new Error('order failed');
    });
    const collection = createModelManagementCollectionService(
      request,
      '/api/mar-agent/models',
      () => true
    );
    collection.models.value = [{ id: 'model-2' }, { id: 'model-1' }] as ManagedModelSummary[];
    const first = collection.saveOrder();
    await expect(collection.saveOrder()).resolves.toBeUndefined();
    gate.resolve();
    await expect(first).rejects.toThrow('order failed');
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith('/api/mar-agent/models/order', {
      method: 'PUT',
      body: JSON.stringify({ modelIds: ['model-2', 'model-1'] })
    });
    expect(collection.models.value.map((model) => model.id)).toEqual(['model-2', 'model-1']);
    expect(collection.savingOrder.value).toBe(false);
  });

  it('keeps the last list on a failed background read but clears it on a failed visible refresh', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        models: [{ id: 'model-1', reasoningEfforts: ['low'], defaultReasoningEffort: 'low' }]
      })
      .mockRejectedValue(new Error('request failed'));
    const collection = createModelManagementCollectionService(
      request,
      '/api/mar-agent/models',
      () => true
    );
    await collection.load();
    await expect(collection.load(false)).rejects.toThrow('request failed');
    expect(collection.models.value.map((model) => model.id)).toEqual(['model-1']);
    await expect(collection.load()).rejects.toThrow('request failed');
    expect(collection.models.value).toEqual([]);
    expect(collection.loading.value).toBe(false);
  });

  it('keeps the last list when a background read supersedes a visible refresh and fails', async () => {
    const visible = deferred<unknown>();
    const background = deferred<unknown>();
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        models: [{ id: 'model-1', reasoningEfforts: ['low'], defaultReasoningEffort: 'low' }]
      })
      .mockReturnValueOnce(visible.promise)
      .mockReturnValueOnce(background.promise);
    const collection = createModelManagementCollectionService(
      request,
      '/api/admin/mar-agent/models',
      () => true
    );
    await collection.load();

    const refresh = collection.load();
    const reread = collection.load(false);
    background.reject(new Error('post-write read failed'));
    await expect(reread).rejects.toThrow('post-write read failed');
    visible.resolve({ models: [] });
    await refresh;

    expect(collection.models.value.map((model) => model.id)).toEqual(['model-1']);
    expect(collection.ready.value).toBe(true);
    expect(collection.loading.value).toBe(false);
  });

  it('keeps the order submission busy until refresh completes and reports refresh failure separately', async () => {
    const refresh = deferred<unknown>();
    const request = vi.fn().mockResolvedValueOnce({}).mockReturnValueOnce(refresh.promise);
    const collection = createModelManagementCollectionService(
      request,
      '/api/mar-agent/models',
      () => true
    );
    const save = collection.saveOrder();
    await Promise.resolve();
    expect(collection.savingOrder.value).toBe(true);
    await expect(collection.saveOrder()).resolves.toBeUndefined();
    refresh.resolve({ models: [] });
    await expect(save).resolves.toEqual({});
    expect(collection.savingOrder.value).toBe(false);

    const failure = new Error('refresh failed');
    request.mockResolvedValueOnce({}).mockRejectedValueOnce(failure);
    await expect(collection.saveOrder()).resolves.toEqual({ refreshError: failure });
  });
});
