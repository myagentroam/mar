import { randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import { activeSessionDirectory } from '../support/jsonl-session-path.js';

const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

it('forks thousands of records with segment-bounded synchronization', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mar-agent-bulk-fork-'));
  homes.push(home);
  let store = await JsonlSessionStore.open(home);
  const source = await store.createSession({ title: 'Source', workspace: home });
  await store.close();
  const directory = await activeSessionDirectory(home, source.id);
  const original = JSON.parse(await readFile(join(directory, 'events-000001.jsonl'), 'utf8'));
  const records = Array.from({ length: 2651 }, (_, index) => ({
    ...original,
    recordId: randomUUID(),
    sequence: index + 2,
    type: index === 0 ? 'turn.user' : 'model.context',
    turnId: 'boundary',
    executionId: 'execution',
    payload: { prompt: 'Synthetic history', text: 'x'.repeat(2048) }
  }));
  await appendFile(
    join(directory, 'events-000001.jsonl'),
    records.map((record) => `${JSON.stringify(record)}\n`).join('')
  );
  store = await JsonlSessionStore.open(home);
  const probe = await open(join(home, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const sync = vi.spyOn(prototype, 'sync');
  const append = vi.spyOn(store, 'append');
  try {
    const forked = await store.forkSession(source.id, {
      boundaryTurnId: 'boundary',
      title: 'Branch'
    });
    expect(sync.mock.calls.length).toBeLessThan(10);
    expect(append).not.toHaveBeenCalled();
    const copied = await store.read(forked.id);
    expect(copied).toHaveLength(2652);
    expect(copied.map((record) => record.sequence)).toEqual(
      Array.from({ length: 2652 }, (_, index) => index + 1)
    );
    expect(copied.slice(1).map((record) => record.payload)).toEqual(
      records.map((record) => record.payload)
    );
    expect(copied.every((record) => record.sessionId === forked.id)).toBe(true);
    await store.close();
    store = await JsonlSessionStore.open(home);
    const index = JSON.parse(
      await readFile(join(home, '.mar', 'agent', 'sessions', 'index.json'), 'utf8')
    );
    const meta = index.sessions.find((session: { id: string }) => session.id === forked.id);
    expect(meta.nextSequence).toBe(2653);
    expect(meta.segments).toEqual([
      { number: 1, firstSequence: 1, lastSequence: 2652, bytes: expect.any(Number) }
    ]);
    expect(await store.read(forked.id)).toEqual(copied);
  } finally {
    await store.close();
  }
});

it('does not publish a fork when segment synchronization fails', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mar-agent-fork-sync-failure-'));
  homes.push(home);
  const store = await JsonlSessionStore.open(home);
  const source = await store.createSession({ title: 'Source', workspace: home });
  await store.append(source.id, {
    type: 'turn.user',
    payload: { prompt: 'Retained' },
    turnId: 'boundary'
  });
  await store.close();
  const reopened = await JsonlSessionStore.open(home);
  const probe = await open(join(home, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const writeFile = prototype.writeFile;
  const sync = prototype.sync;
  const segmentHandles = new WeakSet<object>();
  vi.spyOn(prototype, 'writeFile').mockImplementation(async function (
    this: object,
    ...args: unknown[]
  ) {
    if (typeof args[0] === 'string' && args[0].includes('"turn.user"')) segmentHandles.add(this);
    return writeFile.apply(this, args);
  });
  vi.spyOn(prototype, 'sync').mockImplementation(async function (this: object) {
    if (segmentHandles.has(this)) throw new Error('Synthetic segment sync failure');
    return sync.call(this);
  });
  try {
    await expect(
      reopened.forkSession(source.id, { boundaryTurnId: 'boundary', title: 'Branch' })
    ).rejects.toThrow('Synthetic segment sync failure');
    expect((await reopened.list()).sessions.map((session) => session.id)).toEqual([source.id]);
    expect(await readdir(join(home, '.mar', 'agent', 'sessions'))).toEqual(
      expect.arrayContaining([source.id, 'index.json'])
    );
    expect(
      (await readdir(join(home, '.mar', 'agent', 'sessions'))).filter((name) =>
        /^[0-9a-f-]{36}$/u.test(name)
      )
    ).toEqual([source.id]);
  } finally {
    vi.restoreAllMocks();
    await reopened.close();
  }
});

it('forks bounded segments and restores resume indexes before continuing the branch', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mar-agent-segmented-fork-'));
  homes.push(home);
  let store = await JsonlSessionStore.open(home);
  const source = await store.createSession({ title: 'Source', workspace: home });
  try {
    for (let index = 0; index < 2; index++)
      await store.append(source.id, {
        type: 'large.record',
        payload: { index, text: 'x'.repeat(9 * 1024 * 1024) },
        turnId: 'boundary'
      });
    await store.append(source.id, {
      type: 'todo.updated',
      payload: { revision: 1, items: [{ id: 'task', step: 'Continue', status: 'pending' }] },
      turnId: 'boundary'
    });
    await store.compact(source.id, {
      summary: 'Retained context',
      executionId: 'execution',
      turnId: 'boundary'
    });
    const retained = await store.read(source.id);
    await store.append(source.id, {
      type: 'turn.user',
      payload: { prompt: 'Excluded later turn' },
      turnId: 'later'
    });
    const forked = await store.forkSession(source.id, {
      boundaryTurnId: 'boundary',
      title: 'Branch'
    });
    const directory = await activeSessionDirectory(home, forked.id);
    const files = (await readdir(directory)).filter((name) => name.endsWith('.jsonl')).sort();
    expect(files).toEqual(['events-000001.jsonl', 'events-000002.jsonl']);
    for (const file of files)
      expect((await readFile(join(directory, file))).byteLength).toBeLessThanOrEqual(
        16 * 1024 * 1024
      );
    const copied = await store.read(forked.id);
    expect(copied.map((record) => record.type)).toEqual(retained.map((record) => record.type));
    expect(copied.slice(1).map((record) => record.payload)).toEqual(
      retained.slice(1).map((record) => record.payload)
    );
    await store.close();
    store = await JsonlSessionStore.open(home);
    await expect(store.readExecutionState(forked.id)).resolves.toMatchObject({
      todo: {
        revision: 1,
        items: [{ id: 'task', step: 'Continue', status: 'pending' }]
      },
      contextRecords: [
        expect.objectContaining({
          type: 'compact.completed',
          payload: expect.objectContaining({ summary: 'Retained context' })
        })
      ]
    });
    const release = await store.acquireSessionLease(forked.id);
    try {
      const appended = await store.append(forked.id, {
        type: 'turn.user',
        payload: { prompt: 'Continue branch' },
        turnId: 'next'
      });
      expect(appended.sequence).toBe(copied.length + 1);
    } finally {
      await release();
    }
    expect((await store.read(forked.id)).at(-1)?.turnId).toBe('next');
    expect((await store.read(source.id)).at(-1)?.turnId).toBe('later');
    expect((await readdir(directory)).filter((name) => name.endsWith('.jsonl')).sort()).toEqual(
      files
    );
  } finally {
    await store.close();
  }
});

it('writes completed fork segments before serializing the remaining history', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mar-agent-streamed-fork-'));
  homes.push(home);
  const store = await JsonlSessionStore.open(home);
  try {
    const source = await store.createSession({ title: 'Source', workspace: home });
    for (let index = 0; index < 3; index++)
      await store.append(source.id, {
        type: 'large.record',
        payload: { index, text: 'x'.repeat(9 * 1024 * 1024) },
        turnId: 'boundary'
      });
    const probe = await open(join(home, 'probe'), 'w');
    const prototype = Object.getPrototypeOf(probe);
    await probe.close();
    const events: string[] = [];
    const stringify = JSON.stringify;
    const writeFile = prototype.writeFile;
    vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
      if (value?.type === 'large.record' && value.sessionId !== source.id)
        events.push(`serialize-${value.payload.index}`);
      return stringify(value, replacer as never, space);
    });
    vi.spyOn(prototype, 'writeFile').mockImplementation(async function (
      this: object,
      ...args: unknown[]
    ) {
      if (typeof args[0] === 'string' && args[0].includes('"large.record"')) events.push('write');
      return writeFile.apply(this, args);
    });
    const forked = await store.forkSession(source.id, {
      boundaryTurnId: 'boundary',
      title: 'Branch'
    });
    expect(events.indexOf('write')).toBeLessThan(events.indexOf('serialize-2'));
    expect(events.filter((event) => event === 'write')).toHaveLength(3);
    expect(await store.read(forked.id)).toHaveLength(4);
  } finally {
    vi.restoreAllMocks();
    await store.close();
  }
});
