import { randomUUID } from 'node:crypto';
import { readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import type { SessionRecordInput } from '../../src/session/store/types.js';
import { segmentedSession } from '../support/segmented-session.js';
import { stageRollbackSegments } from '../../src/session/store/jsonl/history.js';
import { beginSessionStorageTransaction } from '../../src/session/store/jsonl/transaction-recovery.js';

const io = vi.hoisted(() => ({
  stages: [] as string[],
  writeFailure: false,
  syncFailure: false,
  closeFailure: undefined as Error | undefined,
  fail: undefined as ((from: string, to: string) => boolean) | undefined,
  failure: Object.assign(new Error('Rollback transaction failure'), { code: 'EIO' })
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).endsWith('.rollback-tmp')) io.stages.push(String(args[0]));
      const handle = await fs.open(...args);
      if (
        !String(args[0]).endsWith('.rollback-tmp') ||
        (!io.writeFailure && !io.syncFailure && !io.closeFailure)
      )
        return handle;
      const { writeFailure, syncFailure, closeFailure } = io;
      io.writeFailure = false;
      io.syncFailure = false;
      io.closeFailure = undefined;
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'writeFile' && writeFailure)
            return async () => {
              await target.writeFile('partial');
              throw io.failure;
            };
          if (property === 'sync' && syncFailure)
            return async () => {
              throw io.failure;
            };
          if (property === 'close' && closeFailure)
            return async () => {
              await target.close();
              throw closeFailure;
            };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      if (io.fail?.(String(args[0]), String(args[1]))) {
        io.fail = undefined;
        throw io.failure;
      }
      return fs.rename(...args);
    }
  };
});

const fixtures: Awaited<ReturnType<typeof segmentedSession>>[] = [];
afterEach(async () => {
  io.stages = [];
  io.writeFailure = false;
  io.syncFailure = false;
  io.closeFailure = undefined;
  io.fail = undefined;
  for (const { home, store } of fixtures.splice(0)) {
    await store.close();
    await rm(home, { recursive: true, force: true });
  }
});
const user = (turnId: string): SessionRecordInput => ({
  type: 'turn.user',
  turnId,
  payload: { prompt: turnId }
});
const event = (turnId: string): SessionRecordInput => ({
  type: 'test.record',
  turnId,
  payload: { text: turnId }
});
const continuation = (): SessionRecordInput => ({
  type: 'responses.continuation',
  turnId: 'first',
  payload: { responseId: 'stale' }
});
const path = (directory: string, number: number) =>
  join(directory, `events-${String(number).padStart(6, '0')}.jsonl`);
async function fixture(groups: SessionRecordInput[][]) {
  const value = await segmentedSession(groups);
  fixtures.push(value);
  return value;
}

it('reuses an unchanged prefix and rewrites only the partial boundary segment', async () => {
  const { home, store, session, directory, records } = await fixture([
    [user('first'), event('first')],
    [event('first'), user('second'), event('second')],
    [event('second')]
  ]);
  const before = await stat(path(directory, 1));
  await store.rollbackSession(session.id, { boundaryTurnId: 'first' });
  expect(io.stages).toHaveLength(1);
  expect(basename(io.stages[0]!)).toMatch(/^events-000002\.jsonl\./u);
  expect(await stat(path(directory, 1))).toMatchObject({
    ino: before.ino,
    mtimeMs: before.mtimeMs
  });
  expect(await store.read(session.id)).toEqual(records.slice(0, 4));
  await expect(stat(path(directory, 3))).rejects.toMatchObject({ code: 'ENOENT' });
  await store.close();
  const reopened = await JsonlSessionStore.open(home);
  try {
    const next = await reopened.append(session.id, user('new'));
    expect(next.sequence).toBe(5);
    expect((await reopened.read(session.id)).at(-1)).toEqual(next);
  } finally {
    await reopened.close();
  }
});

it('does not stage any history bytes when rollback ends at an unchanged segment boundary', async () => {
  const { store, session, directory, records } = await fixture([
    [user('first'), event('first')],
    [event('first')],
    [user('second')]
  ]);
  const before = await Promise.all([stat(path(directory, 1)), stat(path(directory, 2))]);
  await store.rollbackSession(session.id, { boundaryTurnId: 'first' });
  expect(io.stages).toEqual([]);
  for (const [index, value] of before.entries())
    expect(await stat(path(directory, index + 1))).toMatchObject({
      ino: value.ino,
      mtimeMs: value.mtimeMs
    });
  expect(await store.read(session.id)).toEqual(records.slice(0, 4));
});

it('removes stale continuations without rewriting unaffected segments and resumes across segment gaps', async () => {
  const { home, store, session, directory, records, indexPath } = await fixture([
    [user('first'), event('first')],
    [event('first'), continuation(), event('first')],
    [event('first')],
    [continuation()],
    [event('first'), user('second')],
    [event('second')]
  ]);
  const before = await Promise.all([stat(path(directory, 1)), stat(path(directory, 3))]);
  await store.rollbackSession(session.id, { boundaryTurnId: 'first' });
  expect(io.stages).toHaveLength(2);
  for (const [index, number] of [1, 3].entries())
    expect(await stat(path(directory, number))).toMatchObject({
      ino: before[index]!.ino,
      mtimeMs: before[index]!.mtimeMs
    });
  const retained = records.filter(
    (record) => record.turnId !== 'second' && record.type !== 'responses.continuation'
  );
  expect(await store.read(session.id)).toEqual(retained);
  expect(
    JSON.parse(await readFile(indexPath, 'utf8')).sessions[0].segments.map(
      (segment: { number: number }) => segment.number
    )
  ).toEqual([1, 2, 3, 5]);
  const immediate = await store.append(session.id, user('immediate'));
  expect(immediate.sequence).toBe(retained.at(-1)!.sequence + 1);
  expect((await store.readPage(session.id, { limit: 2 })).records).toEqual([
    retained.at(-1)!,
    immediate
  ]);
  await store.close();
  const reopened = await JsonlSessionStore.open(home);
  try {
    const next = await reopened.append(session.id, user('new'));
    expect(next.sequence).toBe(immediate.sequence + 1);
    expect(await reopened.read(session.id)).toEqual([...retained, immediate, next]);
  } finally {
    await reopened.close();
  }
});

it.each(['write', 'promotion', 'index'] as const)(
  'restores only changed segments after %s failure',
  async (phase) => {
    const { home, store, session, directory, records, indexPath } = await fixture([
      [user('first'), event('first')],
      [event('first'), user('second')],
      [event('second')]
    ]);
    const before = await stat(path(directory, 1));
    io.writeFailure = phase === 'write';
    io.fail = (from, to) =>
      phase === 'promotion'
        ? from.endsWith('.rollback-tmp')
        : phase === 'index' && to === indexPath;
    await expect(store.rollbackSession(session.id, { boundaryTurnId: 'first' })).rejects.toBe(
      io.failure
    );
    expect(await store.read(session.id)).toEqual(records);
    expect(await stat(path(directory, 1))).toMatchObject({
      ino: before.ino,
      mtimeMs: before.mtimeMs
    });
    expect(
      (await readdir(directory)).filter(
        (name) =>
          name.includes('backup') || name.endsWith('-tmp') || name === 'storage-transaction.json'
      )
    ).toEqual([]);
    await store.close();
    const reopened = await JsonlSessionStore.open(home);
    try {
      expect(await reopened.read(session.id)).toEqual(records);
    } finally {
      await reopened.close();
    }
  }
);

it.each([false, true])(
  'recovers a partial transaction without touching reused files (committed=%s)',
  async (committed) => {
    const { home, store, session, directory, records, segments, indexPath } = await fixture([
      [user('first'), event('first')],
      [event('first'), user('second')],
      [event('second')]
    ]);
    await store.close();
    const before = await stat(path(directory, 1));
    const id = randomUUID();
    const retained = records.slice(0, 4);
    const staged = await stageRollbackSegments(directory, retained, segments);
    await beginSessionStorageTransaction(directory, {
      version: 1,
      id,
      kind: 'rollback',
      originalSegments: [basename(path(directory, 2)), basename(path(directory, 3))],
      stagedSegments: staged.files.map((file) => ({
        path: basename(file.path),
        temporary: basename(file.temporaryPath)
      })),
      sidecarBackup: `context-world-state.json.5.${id}.rollback-backup`
    });
    for (const number of [2, 3])
      await rename(path(directory, number), `${path(directory, number)}.${id}.rollback-backup`);
    for (const file of staged.files) await rename(file.temporaryPath, file.path);
    if (committed) {
      const index = JSON.parse(await readFile(indexPath, 'utf8'));
      Object.assign(index.sessions[0], {
        storageTransactionId: id,
        segments: staged.segments,
        nextSequence: 5
      });
      await writeFile(indexPath, JSON.stringify(index));
    }
    const reopened = await JsonlSessionStore.open(home);
    try {
      const release = await reopened.acquireSessionLease(session.id);
      await release();
      expect(await reopened.read(session.id)).toEqual(committed ? retained : records);
      expect(await stat(path(directory, 1))).toMatchObject({
        ino: before.ino,
        mtimeMs: before.mtimeMs
      });
      expect(await readdir(directory)).not.toContain('storage-transaction.json');
      if (committed)
        await expect(stat(path(directory, 3))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await reopened.close();
    }
  }
);

it.each([4, 2])(
  'preserves physical prefix boundaries for admitted legacy sequence order (tail sequence=%s)',
  async (sequence) => {
    const { home, store, session, directory, records, indexPath } = await fixture([
      [user('first'), event('first')],
      [event('first'), user('second'), event('second')],
      [event('second')]
    ]);
    await store.close();
    records[5] = { ...records[5]!, sequence };
    await writeFile(
      path(directory, 2),
      records
        .slice(3, 6)
        .map((record) => JSON.stringify(record) + '\n')
        .join('')
    );
    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    index.sessions[0].segments[1].lastSequence = sequence;
    await writeFile(indexPath, JSON.stringify(index));
    const reopened = await JsonlSessionStore.open(home);
    try {
      await reopened.rollbackSession(session.id, { boundaryTurnId: 'first' });
      expect(await reopened.read(session.id)).toEqual(records.slice(0, 4));
      expect(io.stages).toHaveLength(1);
    } finally {
      await reopened.close();
    }
  }
);

it.each(['missing', 'partial'] as const)(
  'preserves retained history when the optional segment cache is %s',
  async (cache) => {
    const { home, store, session, records, indexPath } = await fixture([
      [user('first'), event('first')],
      [event('first')],
      [event('first')],
      [user('second'), event('second')]
    ]);
    await store.close();
    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    if (cache === 'missing') delete index.sessions[0].segments;
    else index.sessions[0].segments.splice(1, 1);
    await writeFile(indexPath, JSON.stringify(index));
    const reopened = await JsonlSessionStore.open(home);
    try {
      await reopened.rollbackSession(session.id, {
        boundaryTurnId: cache === 'missing' ? 'second' : 'first'
      });
      expect(await reopened.read(session.id)).toEqual(
        cache === 'missing' ? records : records.slice(0, 5)
      );
      expect(io.stages).toHaveLength(1);
      expect(basename(io.stages[0]!)).toMatch(/^events-000001\.jsonl\./u);
    } finally {
      await reopened.close();
    }
  }
);

it('does not retain a removed tail when an older segment cache predates durable unindexed writes', async () => {
  const { home, store, session, records, indexPath } = await fixture([
    [user('first'), event('first'), user('second'), event('second')],
    [event('second')]
  ]);
  await store.close();
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  const retained = records.slice(0, 3);
  index.sessions[0].segments = [
    {
      ...index.sessions[0].segments[0],
      lastSequence: 3,
      bytes: Buffer.byteLength(retained.map((record) => JSON.stringify(record) + '\n').join(''))
    }
  ];
  index.sessions[0].nextSequence = 4;
  await writeFile(indexPath, JSON.stringify(index));
  const reopened = await JsonlSessionStore.open(home);
  try {
    await reopened.rollbackSession(session.id, { boundaryTurnId: 'first' });
    expect(await reopened.read(session.id)).toEqual(retained);
    const next = await reopened.append(session.id, user('new'));
    expect(next.sequence).toBe(4);
    expect(await reopened.read(session.id)).toEqual([...retained, next]);
  } finally {
    await reopened.close();
  }
});

it.each(['write', 'sync', 'close'] as const)(
  'preserves the first staging error when %s and close fail',
  async (phase) => {
    const { store, session, directory, records } = await fixture([
      [user('first')],
      [event('first'), user('second')]
    ]);
    const closeFailure = new Error('Secondary close failure');
    io.writeFailure = phase === 'write';
    io.syncFailure = phase === 'sync';
    io.closeFailure = closeFailure;
    await expect(store.rollbackSession(session.id, { boundaryTurnId: 'first' })).rejects.toBe(
      phase === 'close' ? closeFailure : io.failure
    );
    expect(await store.read(session.id)).toEqual(records);
    expect((await readdir(directory)).some((name) => name.endsWith('-tmp'))).toBe(false);
  }
);
