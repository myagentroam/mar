import { describe, expect, it, vi } from 'vitest';
import type { ModelAdapter } from '../../src/model/contracts.js';
import type { ResolvedModelConfiguration } from '../../src/sdk/model-runtime.js';
import { closeModelAdapters } from '../../src/sdk/model-runtime.js';
import { SessionModelAdapters } from '../../src/sdk/session-model-adapters.js';

const configuration = (id: string): ResolvedModelConfiguration =>
  ({ id, modelId: id }) as ResolvedModelConfiguration;
const models = new Map([
  ['a', configuration('a')],
  ['b', configuration('b')]
]);
function adapter(extra: Partial<ModelAdapter> = {}): ModelAdapter {
  return {
    configuration: configuration('a'),
    async *start() {},
    ...extra
  };
}

describe('SessionModelAdapters', () => {
  it('owns a coordinated transition while deduplicating shared adapters and protecting active ones', async () => {
    const commit = vi.fn();
    const shared = adapter({ prepareReconfigure: () => commit, close: vi.fn(async () => {}) });
    const retired = adapter({ close: vi.fn(async () => {}) });
    const active = adapter({ close: vi.fn(async () => {}) });
    const first = new SessionModelAdapters(0, (id) => (id === 'a' ? shared : retired), false);
    const second = new SessionModelAdapters(0, (id) => (id === 'a' ? shared : active), false);
    first.getOrCreate('a', models);
    first.getOrCreate('b', models);
    second.getOrCreate('a', models);
    second.getOrCreate('b', models);
    const install = await SessionModelAdapters.stageReconfiguration(
      [first, second],
      models,
      new Set([active]),
      () => {}
    );
    expect(commit).not.toHaveBeenCalled();
    expect(retired.close).toHaveBeenCalledOnce();
    expect(active.close).not.toHaveBeenCalled();
    expect(shared.close).not.toHaveBeenCalled();
    install(1);
    expect(commit).toHaveBeenCalledOnce();
    await first.refresh(1, new Set());
    await second.refresh(1, new Set());
    expect(first.snapshot()).toEqual([shared]);
    expect(second.snapshot()).toEqual([shared]);
  });

  it('does not commit or advance a staged transition when admission closes during cleanup', async () => {
    const error = new Error('disposed');
    const commit = vi.fn();
    const shared = adapter({ prepareReconfigure: () => commit });
    const cache = new SessionModelAdapters(0, () => shared, false);
    cache.getOrCreate('a', models);
    const install = await SessionModelAdapters.stageReconfiguration(
      [cache],
      models,
      new Set(),
      () => {
        throw error;
      }
    );
    expect(() => install(1)).toThrow(error);
    expect(commit).not.toHaveBeenCalled();
    expect(cache.snapshot()).toEqual([shared]);
  });
  it('caches by model identity without exposing the mutable collection', () => {
    const create = vi.fn((id: string) => adapter({ configuration: configuration(id) }));
    const cache = new SessionModelAdapters(1, create, false);
    const a = cache.getOrCreate('a', models);
    const b = cache.getOrCreate('b', models);
    expect(cache.getOrCreate('a', models)).toBe(a);
    expect(create).toHaveBeenCalledTimes(2);
    const snapshot = cache.snapshot() as ModelAdapter[];
    snapshot.pop();
    expect(cache.snapshot()).toEqual([a, b]);
  });

  it('does not cache a stateless custom adapter, but retains a turn-capable one', () => {
    const stateless = adapter();
    const withTurn = adapter({ createTurnSession: vi.fn() });
    const create = vi.fn().mockReturnValueOnce(stateless).mockReturnValueOnce(withTurn);
    const cache = new SessionModelAdapters(0, create, true);
    expect(cache.getOrCreate('a', models)).toBe(stateless);
    expect(cache.snapshot()).toEqual([]);
    expect(cache.getOrCreate('a', models)).toBe(withTurn);
    expect(cache.getOrCreate('a', models)).toBe(withTurn);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('refreshes only on generation change and leaves shared active adapters to their owners', async () => {
    const shared = adapter({ close: vi.fn(async () => {}) });
    const owned = adapter({ close: vi.fn(async () => {}) });
    const cache = new SessionModelAdapters(1, (id) => (id === 'a' ? shared : owned), false);
    cache.getOrCreate('a', models);
    cache.getOrCreate('b', models);
    await cache.refresh(1, new Set());
    expect(cache.snapshot()).toEqual([shared, owned]);
    await cache.refresh(2, new Set([shared]));
    expect(shared.close).not.toHaveBeenCalled();
    expect(owned.close).toHaveBeenCalledOnce();
    expect(cache.snapshot()).toEqual([]);
    await cache.refresh(2, new Set());
    expect(owned.close).toHaveBeenCalledOnce();
  });

  it('attempts every independent close, exposes the first error, and keeps state on refresh failure', async () => {
    const first = new Error('first close');
    const a = adapter({
      close: vi.fn(async () => {
        throw first;
      })
    });
    const b = adapter({
      close: vi.fn(async () => {
        throw new Error('second close');
      })
    });
    const cache = new SessionModelAdapters(1, (id) => (id === 'a' ? a : b), false);
    cache.getOrCreate('a', models);
    cache.getOrCreate('b', models);
    await expect(cache.refresh(2, new Set())).rejects.toBe(first);
    expect(a.close).toHaveBeenCalledOnce();
    expect(b.close).toHaveBeenCalledOnce();
    expect(cache.snapshot()).toEqual([a, b]);
    await cache.refresh(1, new Set());
    expect(a.close).toHaveBeenCalledOnce();
  });

  it('prepares without mutation, retires only unretained entries, and advances generation separately', async () => {
    const commit = vi.fn();
    const a = adapter({ prepareReconfigure: vi.fn(() => commit), close: vi.fn(async () => {}) });
    const b = adapter({ prepareReconfigure: vi.fn(), close: vi.fn(async () => {}) });
    const cache = new SessionModelAdapters(1, (id) => (id === 'a' ? a : b), false);
    cache.getOrCreate('a', models);
    cache.getOrCreate('b', models);
    expect(cache.prepareReconfigure(models, new Set([b]))).toEqual([{ adapter: a, commit }]);
    expect(commit).not.toHaveBeenCalled();
    expect(b.prepareReconfigure).not.toHaveBeenCalled();
    expect(cache.snapshot()).toEqual([a, b]);
    expect(cache.retire(new Set([a]))).toEqual([b]);
    commit();
    cache.setGeneration(2);
    await cache.refresh(2, new Set());
    expect(cache.snapshot()).toEqual([a]);
    expect(a.close).not.toHaveBeenCalled();
    expect(b.close).not.toHaveBeenCalled();
  });

  it('transfers shared references for one deduplicated close and drains idempotently', async () => {
    const shared = adapter({ close: vi.fn(async () => {}) });
    const first = new SessionModelAdapters(0, () => shared, false);
    const second = new SessionModelAdapters(0, () => shared, false);
    first.getOrCreate('a', models);
    second.getOrCreate('a', models);
    await closeModelAdapters([...first.drain(), ...second.drain()]);
    expect(shared.close).toHaveBeenCalledOnce();
    expect(first.drain()).toEqual([]);
    expect(second.drain()).toEqual([]);
  });
});
