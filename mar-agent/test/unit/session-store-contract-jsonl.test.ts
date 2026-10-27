import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import { JsonlStorePool } from '../../src/session/store/jsonl/store-pool.js';
import { sessionStoreContract } from '../support/session-store-contract-suite.js';

sessionStoreContract('JSONL', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mar-session-store-contract-'));
  return {
    workspace: home,
    open: () => JsonlSessionStore.open(home),
    dispose: () => rm(home, { recursive: true, force: true })
  };
});

it('does not close a handle acquired while the last close is flushing', async () => {
  const pool = new JsonlStorePool<{ root: string; references: number; closed: boolean }>();
  const open = async () => ({ root: 'domain', references: 1, closed: false });
  const original = await pool.acquire('domain', open);
  const flush = Promise.withResolvers<void>();
  const closing = pool.release(original, () => flush.promise);
  const reopening = pool.acquire('domain', open);
  flush.resolve();
  await closing;
  const next = await reopening;
  expect(next.closed).toBe(false);
  expect(next.references).toBe(1);
  await pool.release(next, () => undefined);
});

it('preserves a flush failure and permits a later handle to retry the same domain', async () => {
  const pool = new JsonlStorePool<{ root: string; references: number; closed: boolean }>();
  const open = async () => ({ root: 'domain', references: 1, closed: false });
  const original = await pool.acquire('domain', open);
  const flush = Promise.withResolvers<void>();
  const closing = pool.release(original, () => flush.promise);
  const reopening = pool.acquire('domain', open);
  const failure = new Error('index flush failed');
  flush.reject(failure);
  await expect(closing).rejects.toBe(failure);
  await expect(reopening).rejects.toBe(failure);
  const next = await pool.acquire('domain', open);
  expect(next).toBe(original);
  expect(next.closed).toBe(false);
  expect(next.references).toBe(1);
  await pool.release(next, () => undefined);
});
