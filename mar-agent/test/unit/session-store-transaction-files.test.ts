import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import {
  stageRollbackSegments,
  stageUnreferencedImages
} from '../../src/session/store/jsonl/history.js';
import {
  beginSessionStorageTransaction,
  recoverSessionStorageTransaction
} from '../../src/session/store/jsonl/transaction-recovery.js';

const io = vi.hoisted(() => ({
  operation: undefined as
    ((kind: 'rename' | 'rm', from: string, to: string) => Promise<void>) | undefined
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      await io.operation?.('rename', String(args[0]), String(args[1]));
      return fs.rename(...args);
    },
    rm: async (...args: Parameters<typeof fs.rm>) => {
      await io.operation?.('rm', String(args[0]), '');
      return fs.rm(...args);
    }
  };
});

const homes: string[] = [];
afterEach(async () => {
  io.operation = undefined;
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mar-transaction-files-'));
  homes.push(directory);
  const folder = join(directory, 'tool_results');
  await mkdir(folder);
  const names = Array.from({ length: 16 }, (_, index) => `resource-${index}.diff`);
  for (const name of [...names, 'keep.diff']) await writeFile(join(folder, name), name);
  return { directory, folder, names, id: randomUUID() };
}

/** Hold the other workers after the first failure to catch early transaction recovery. */
async function expectDrainedFailure(
  start: () => Promise<unknown>,
  matches: (kind: 'rename' | 'rm', from: string, to: string) => boolean,
  expected?: Error
) {
  const first = Promise.withResolvers<void>();
  const others = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<void>();
  const failure = Object.assign(new Error('Transaction file failure'), { code: 'EIO' });
  let entered = 0;
  let settled = false;
  io.operation = async (kind, from, to) => {
    if (!matches(kind, from, to)) return;
    const index = entered++;
    await (index === 0 ? first.promise : others.promise);
    if (index === 0) {
      failed.resolve();
      throw failure;
    }
  };
  const outcome = start()
    .then(
      () => undefined,
      (error) => error
    )
    .finally(() => {
      settled = true;
    });
  try {
    await vi.waitFor(() => expect(entered).toBeGreaterThan(1));
    expect(entered).toBeLessThanOrEqual(8);
    first.resolve();
    await failed.promise;
    await nextTurn();
    expect(settled).toBe(false);
    expect(entered).toBeLessThanOrEqual(8);
  } finally {
    first.resolve();
    others.resolve();
    await outcome;
  }
  expect(await outcome).toBe(expected ?? failure);
  io.operation = undefined;
}

it('bounds resource staging and restores completed moves only after all workers stop', async () => {
  const { directory, folder, names, id } = await fixture();
  await expectDrainedFailure(
    () => stageUnreferencedImages(directory, 'tool_results', new Set(['keep.diff']), id),
    (kind, _from, to) => kind === 'rename' && to.endsWith('.rollback-trash')
  );
  expect((await readdir(folder)).sort()).toEqual([...names, 'keep.diff'].sort());
  for (const name of names) expect(await readFile(join(folder, name), 'utf8')).toBe(name);
});

it('drains failed staging cleanup before returning its original error', async () => {
  const { directory } = await fixture();
  const failure = new Error('Serialization failure after staging earlier segments');
  const prefix = Array.from({ length: 6 }, (_, index) => ({
    recordId: randomUUID(),
    sessionId: 'test',
    timestamp: '2026-11-01T00:00:00.000Z',
    sequence: index + 1,
    type: index % 2 === 0 ? 'test.record' : 'responses.continuation',
    payload:
      index === 4
        ? {
            toJSON() {
              throw failure;
            }
          }
        : {}
  }));
  const originals = [1, 2, 3].map((number) => ({
    number,
    firstSequence: number * 2 - 1,
    lastSequence: number * 2,
    bytes: 100
  }));
  await expectDrainedFailure(
    () => stageRollbackSegments(directory, prefix, originals),
    (kind, from) => kind === 'rm' && from.endsWith('.rollback-tmp'),
    failure
  );
  await recoverSessionStorageTransaction(directory);
  expect((await readdir(directory)).some((name) => name.endsWith('-tmp'))).toBe(false);
});

it.each([false, true])(
  'bounds resource recovery and leaves its journal retryable (committed=%s)',
  async (committed) => {
    const { directory, folder, names, id } = await fixture();
    await beginSessionStorageTransaction(directory, {
      version: 1,
      id,
      kind: 'rollback',
      originalSegments: [],
      stagedSegments: [],
      sidecarBackup: `context-world-state.json.2.${id}.rollback-backup`
    });
    await stageUnreferencedImages(directory, 'tool_results', new Set(['keep.diff']), id);
    await expectDrainedFailure(
      () => recoverSessionStorageTransaction(directory, committed ? id : undefined),
      (kind, from) => from.endsWith('.rollback-trash') && kind === (committed ? 'rm' : 'rename')
    );
    expect(JSON.parse(await readFile(join(directory, 'storage-transaction.json'), 'utf8')).id).toBe(
      id
    );
    await recoverSessionStorageTransaction(directory, committed ? id : undefined);
    expect((await readdir(folder)).sort()).toEqual(
      (committed ? ['keep.diff'] : [...names, 'keep.diff']).sort()
    );
    await expect(readFile(join(directory, 'storage-transaction.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  }
);
