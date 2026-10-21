import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlSessionStore } from '../../src/agent-core/session/store/index.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, readFile: vi.fn(actual.readFile), open: vi.fn(actual.open) };
});

const actualFs = await vi.importActual<typeof fs>('node:fs/promises');
const homes: string[] = [];
const stores: JsonlSessionStore[] = [];
const releases: Array<() => Promise<void>> = [];

async function openStore(home: string) {
  const store = await JsonlSessionStore.open(home);
  stores.push(store);
  return store;
}

async function fixture() {
  const home = await fs.mkdtemp(join(tmpdir(), 'mar-session-state-cache-'));
  homes.push(home);
  const store = await openStore(home);
  const session = await store.createSession({ workspace: home });
  const owner = {};
  const release = await store.acquireSessionLease(session.id, owner);
  releases.push(release);
  return { home, store, id: session.id, owner, release };
}

function historyReads() {
  return vi.mocked(fs.readFile).mock.calls.filter(([path]) => String(path).endsWith('.jsonl'))
    .length;
}

function resetReads() {
  vi.mocked(fs.readFile).mockClear();
}

const execution = { executionId: 'execution', turnId: 'turn' };
const set = (value: unknown) => [{ operation: 'set', key: 'value', value }];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.open).mockImplementation(actualFs.open);
  for (const release of releases.splice(0).reverse()) await release();
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    homes.splice(0).map((home) => actualFs.rm(home, { recursive: true, force: true }))
  );
  vi.clearAllMocks();
});

describe('Session writer state cache', () => {
  it('serializes the first restore with append and writer release', async () => {
    const { store, id, release } = await fixture();
    const entered = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    vi.mocked(fs.readFile).mockImplementationOnce(async (...args) => {
      const result = await actualFs.readFile(...args);
      entered.resolve();
      await proceed.promise;
      return result;
    });
    const initial = store.readCodeModeState(id);
    await entered.promise;
    const appended = store.append(id, {
      type: 'code.state.updated',
      payload: { mutations: set(1) }
    });
    const latest = store.readCodeModeState(id);
    const released = release();
    proceed.resolve();
    expect(await initial).toEqual([]);
    await appended;
    expect(await latest).toEqual([{ key: 'value', value: 1 }]);
    await released;
    resetReads();
    expect(await store.readCodeModeState(id)).toEqual([{ key: 'value', value: 1 }]);
    expect(historyReads()).toBe(1);
  });

  it('checks concurrent checkpoint revisions against the same committed cache', async () => {
    const { store, id, owner } = await fixture();
    await store.readExtensionCheckpoint(id, 'extension', 'key');
    resetReads();
    const outcomes = await Promise.allSettled(
      [1, 2].map((value) =>
        store.writeExtensionCheckpoint(id, 'extension', 'key', value, 0, {
          owner,
          signal: new AbortController().signal
        })
      )
    );
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'MAR_AGENT_EXTENSION_DATA_CONFLICT' }
    });
    expect(await store.readExtensionCheckpoint(id, 'extension', 'key')).toEqual({
      revision: 1,
      value: 1
    });
    expect(historyReads()).toBe(0);
  });

  it.each([4, 1024])(
    'does not reread %i unrelated records after either state is restored',
    async (count) => {
      const { home, store, id, owner } = await fixture();
      const other = await openStore(home);
      for (let index = 0; index < count; index++)
        await store.append(id, {
          type: 'test.history',
          payload: { text: 'history'.repeat(64), index }
        });

      resetReads();
      expect(await store.readCodeModeState(id)).toEqual([]);
      expect(historyReads()).toBeGreaterThan(0);
      resetReads();
      expect(await store.readExtensionCheckpoint(id, 'extension', 'key')).toEqual({ revision: 0 });
      expect(historyReads()).toBeGreaterThan(0);
      resetReads();
      for (let value = 1; value <= 3; value++) {
        const baseline = await other.readCodeModeState(id);
        await store.commitCodeModeState(id, set({ count: value }), {
          ...execution,
          expectedState: baseline
        });
        const checkpoint = await other.readExtensionCheckpoint(id, 'extension', 'key');
        await other.writeExtensionCheckpoint(
          id,
          'extension',
          'key',
          { count: value },
          checkpoint.revision,
          { owner, signal: new AbortController().signal }
        );
        await store.append(id, { type: 'test.background', payload: { value } });
        expect(await other.readCodeModeState(id)).toEqual([
          { key: 'value', value: { count: value } }
        ]);
        expect(await store.readExtensionCheckpoint(id, 'extension', 'key')).toEqual({
          revision: value,
          value: { count: value }
        });
        expect(await store.readExtensionCheckpoint(id, 'extension', 'missing')).toEqual({
          revision: 0
        });
      }
      expect(historyReads()).toBe(0);
      await expect(
        store.writeExtensionCheckpoint(id, 'extension', 'key', 0, 0, {
          owner,
          signal: new AbortController().signal
        })
      ).rejects.toMatchObject({ code: 'MAR_AGENT_EXTENSION_DATA_CONFLICT' });
      const baseline = await store.readCodeModeState(id);
      const outcomes = await Promise.allSettled([
        store.commitCodeModeState(id, set(4), { ...execution, expectedState: baseline }),
        other.commitCodeModeState(id, set(5), { ...execution, expectedState: baseline })
      ]);
      expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.find((result) => result.status === 'rejected')).toMatchObject({
        reason: { code: 'MAR_AGENT_CODE_STATE_CONFLICT' }
      });
      expect(historyReads()).toBe(0);
    }
  );

  it('isolates cached values from append inputs, returned records and state snapshots', async () => {
    const { store, id } = await fixture();
    await store.readCodeModeState(id);
    await store.readExtensionCheckpoint(id, 'extension', 'key');
    const codePayload = { mutations: set({ count: 1 }) };
    const codeRecord = await store.append(id, { type: 'code.state.updated', payload: codePayload });
    const checkpointPayload = {
      extensionId: 'extension',
      key: 'key',
      revision: 1,
      value: { count: 1 }
    };
    const checkpointRecord = await store.append(id, {
      type: 'extension.checkpoint.updated',
      payload: checkpointPayload
    });
    (codePayload.mutations[0]!.value as { count: number }).count = 9;
    (codeRecord.payload as typeof codePayload).mutations[0]!.value = 10;
    checkpointPayload.value.count = 9;
    (checkpointRecord.payload as typeof checkpointPayload).value = { count: 10 };
    const state = await store.readCodeModeState(id);
    (state[0]!.value as { count: number }).count = 20;
    const checkpoint = await store.readExtensionCheckpoint(id, 'extension', 'key');
    (checkpoint.value as { count: number }).count = 20;
    expect(await store.readCodeModeState(id)).toEqual([{ key: 'value', value: { count: 1 } }]);
    expect(await store.readExtensionCheckpoint(id, 'extension', 'key')).toEqual({
      revision: 1,
      value: { count: 1 }
    });
  });

  it('retains caches for a background lease and rebuilds after a different writer takes over', async () => {
    const { store, id, owner, release } = await fixture();
    await store.commitCodeModeState(id, set(1), execution);
    await store.readExtensionCheckpoint(id, 'extension', 'key');
    const retained = await store.retainSessionLease(id, owner);
    releases.push(retained);
    await release();
    resetReads();
    expect(await store.readCodeModeState(id)).toEqual([{ key: 'value', value: 1 }]);
    const takeover = await store.acquireSessionLease(id, owner);
    releases.push(takeover);
    await retained();
    await store.commitCodeModeState(id, set(2), execution);
    expect(historyReads()).toBe(0);
    await takeover();
    const foreign = await store.acquireSessionLease(id, {});
    releases.push(foreign);
    await store.append(id, { type: 'code.state.updated', payload: { mutations: set(3) } });
    await store.append(id, {
      type: 'extension.checkpoint.updated',
      payload: { extensionId: 'extension', key: 'key', revision: 1, value: 3 }
    });
    await foreign();
    const next = await store.acquireSessionLease(id, owner);
    releases.push(next);
    resetReads();
    expect(await store.readCodeModeState(id)).toEqual([{ key: 'value', value: 3 }]);
    expect(await store.readExtensionCheckpoint(id, 'extension', 'key')).toEqual({
      revision: 1,
      value: 3
    });
    expect(historyReads()).toBeGreaterThan(0);
  });

  it('keeps validation lazy, namespace-specific, and identical before and after cache initialization', async () => {
    const { store, id } = await fixture();
    const bad = {
      type: 'extension.checkpoint.updated',
      payload: { extensionId: 'a', key: 'b:c', revision: -1 }
    };
    await store.append(id, bad);
    await store.append(id, {
      type: 'code.state.updated',
      payload: { mutations: [{ operation: 'unknown' }] }
    });
    expect(await store.readExtensionCheckpoint(id, 'a:b', 'c')).toEqual({ revision: 0 });
    await expect(store.readCodeModeState(id)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_CORRUPT'
    });
    await expect(store.readExtensionCheckpoint(id, 'a', 'b:c')).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_CORRUPT'
    });
    await store.append(id, {
      type: bad.type,
      payload: { extensionId: 'a', key: 'b:c', revision: 2, value: 'repaired' }
    });
    expect(await store.readExtensionCheckpoint(id, 'a', 'b:c')).toEqual({
      revision: 2,
      value: 'repaired'
    });
    await store.append(id, {
      type: bad.type,
      payload: { extensionId: 'a', key: 'b:c', revision: 3, deleted: true }
    });
    expect(await store.readExtensionCheckpoint(id, 'a', 'b:c')).toEqual({ revision: 3 });
    await store.append(id, bad);
    await expect(store.readExtensionCheckpoint(id, 'a', 'b:c')).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_CORRUPT'
    });
  });

  it.each(['write', 'sync', 'close'] as const)(
    'invalidates both caches after an uncertain %s failure',
    async (phase) => {
      const { store, id, owner, release } = await fixture();
      await store.readCodeModeState(id);
      await store.readExtensionCheckpoint(id, 'extension', 'key');
      const failure = new Error('Injected append failure');
      vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
        const handle = await actualFs.open(...args);
        if (phase === 'write') vi.spyOn(handle, 'write').mockRejectedValueOnce(failure);
        else if (phase === 'sync') {
          const sync = handle.sync.bind(handle);
          vi.spyOn(handle, 'sync').mockImplementationOnce(async () => {
            await sync();
            throw failure;
          });
        } else {
          const close = handle.close.bind(handle);
          vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
            await close();
            throw failure;
          });
        }
        return handle;
      });
      await expect(
        store.append(id, { type: 'code.state.updated', payload: { mutations: set(1) } })
      ).rejects.toBe(failure);
      resetReads();
      expect(await store.readCodeModeState(id)).toEqual(
        phase === 'write' ? [] : [{ key: 'value', value: 1 }]
      );
      expect(await store.readExtensionCheckpoint(id, 'extension', 'key')).toEqual({ revision: 0 });
      expect(historyReads()).toBeGreaterThanOrEqual(2);
      await release();
      const next = await store.acquireSessionLease(id, owner);
      releases.push(next);
      expect(await store.readCodeModeState(id)).toEqual(
        phase === 'write' ? [] : [{ key: 'value', value: 1 }]
      );
    }
  );

  it('does not fail a durable append when the cached Code Mode reducer rejects its payload', async () => {
    const { store, id } = await fixture();
    await store.readCodeModeState(id);
    await expect(
      store.append(id, {
        type: 'code.state.updated',
        payload: { mutations: [{ operation: 'unknown' }] }
      })
    ).resolves.toMatchObject({ type: 'code.state.updated' });
    await expect(store.readCodeModeState(id)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_CORRUPT'
    });
    expect(await store.readExtensionCheckpoint(id, 'extension', 'key')).toEqual({ revision: 0 });
  });

  it('restores the retained prefix after compact, fork, rollback, clear and reopen', async () => {
    const { home, store, id, owner, release } = await fixture();
    await store.append(id, { type: 'turn.user', payload: { prompt: 'first' }, ...execution });
    await store.commitCodeModeState(id, set(1), execution);
    await store.writeExtensionCheckpoint(id, 'extension', 'key', 1, 0, {
      owner,
      signal: new AbortController().signal,
      ...execution
    });
    await store.compact(id, { summary: 'Retain state independently of context', ...execution });
    resetReads();
    expect(await store.readCodeModeState(id)).toEqual([{ key: 'value', value: 1 }]);
    expect(await store.readExtensionCheckpoint(id, 'extension', 'key')).toEqual({
      revision: 1,
      value: 1
    });
    expect(historyReads()).toBe(0);
    await release();
    const fork = await store.forkSession(id, { boundaryTurnId: 'turn', title: 'State fork' });
    const forkLease = await store.acquireSessionLease(fork.id, {});
    releases.push(forkLease);
    expect(await store.readCodeModeState(fork.id)).toEqual([{ key: 'value', value: 1 }]);
    expect(await store.readExtensionCheckpoint(fork.id, 'extension', 'key')).toEqual({
      revision: 1,
      value: 1
    });
    await forkLease();
    const next = await store.acquireSessionLease(id, owner);
    releases.push(next);
    await store.append(id, { type: 'turn.user', payload: { prompt: 'second' }, turnId: 'second' });
    await store.commitCodeModeState(id, set(2), { ...execution, turnId: 'second' });
    await store.writeExtensionCheckpoint(id, 'extension', 'key', 2, 1, {
      owner,
      signal: new AbortController().signal,
      turnId: 'second'
    });
    await next();
    await store.rollbackSession(id, { boundaryTurnId: 'turn' });
    const rolledBack = await store.acquireSessionLease(id, owner);
    releases.push(rolledBack);
    expect(await store.readCodeModeState(id)).toEqual([{ key: 'value', value: 1 }]);
    expect(await store.readExtensionCheckpoint(id, 'extension', 'key')).toEqual({
      revision: 1,
      value: 1
    });
    await rolledBack();
    await store.clearSession(id);
    await store.close();
    const reopened = await openStore(home);
    const cleared = await reopened.acquireSessionLease(id, owner);
    releases.push(cleared);
    expect(await reopened.readCodeModeState(id)).toEqual([]);
    expect(await reopened.readExtensionCheckpoint(id, 'extension', 'key')).toEqual({ revision: 0 });
    await cleared();
    await reopened.delete(id);
    await expect(reopened.readCodeModeState(id)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_NOT_FOUND'
    });
  });

  it('does not reuse state without an owned writer lease', async () => {
    const { store, id, release } = await fixture();
    await store.readCodeModeState(id);
    await release();
    const maintenance = await store.acquireSessionLease(id);
    releases.push(maintenance);
    resetReads();
    for (let index = 0; index < 2; index++) {
      expect(await store.readCodeModeState(id)).toEqual([]);
      expect(await store.readExtensionCheckpoint(id, 'extension', 'key')).toEqual({ revision: 0 });
    }
    expect(historyReads()).toBe(4);
    await maintenance();
    resetReads();
    await store.readCodeModeState(id);
    await store.readExtensionCheckpoint(id, 'extension', 'key');
    expect(historyReads()).toBe(2);
  });
});
