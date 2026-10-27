import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import { activeSessionDirectory } from '../support/jsonl-session-path.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open), readFile: vi.fn(actual.readFile) };
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
  const home = await fs.mkdtemp(join(tmpdir(), 'mar-session-user-turn-count-'));
  homes.push(home);
  const store = await openStore(home);
  const session = await store.createSession({ workspace: home });
  return { home, store, sessionId: session.id };
}

async function reopenStore(home: string, store: JsonlSessionStore) {
  const index = stores.indexOf(store);
  if (index >= 0) stores.splice(index, 1);
  await store.close();
  return openStore(home);
}

async function acquireWriter(store: JsonlSessionStore, sessionId: string) {
  const release = await store.acquireSessionLease(sessionId);
  releases.push(release);
  return release;
}

async function appendUserTurn(
  store: JsonlSessionStore,
  sessionId: string,
  turnId: string,
  payload: Record<string, unknown> = { prompt: turnId }
) {
  return store.append(sessionId, { type: 'turn.user', payload, turnId });
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.open).mockImplementation(actualFs.open);
  vi.mocked(fs.readFile).mockImplementation(actualFs.readFile);
  for (const release of releases.splice(0).reverse()) await release();
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    homes.splice(0).map((home) => actualFs.rm(home, { recursive: true, force: true }))
  );
  vi.clearAllMocks();
});

describe('Session user turn count', () => {
  it('counts direct user turns but excludes extension and parent-agent inputs', async () => {
    const { store, sessionId } = await fixture();
    await appendUserTurn(store, sessionId, 'direct');
    await appendUserTurn(store, sessionId, 'extension', {
      prompt: 'extension input',
      inputSource: 'extension'
    });
    await appendUserTurn(store, sessionId, 'parent', {
      prompt: 'parent input',
      inputSource: 'parent_agent'
    });
    await store.append(sessionId, {
      type: 'extension.input',
      payload: { prompt: 'extension record' },
      turnId: 'extension-record'
    });

    await expect(store.userTurnCount(sessionId)).resolves.toBe(1);
  });

  it('counts a deferred turn once after its model-context application', async () => {
    const { store, sessionId } = await fixture();
    const deferred = await appendUserTurn(store, sessionId, 'deferred', {
      prompt: 'queued input',
      deferred: true
    });
    await store.append(sessionId, {
      type: 'model.context',
      payload: {
        role: 'user',
        content: 'queued input',
        inputRef: deferred.recordId,
        input: { prompt: 'queued input', deferred: true }
      },
      turnId: 'deferred'
    });

    await expect(store.userTurnCount(sessionId)).resolves.toBe(1);
  });

  it('serializes concurrent first queries after reopening the store', async () => {
    const { home, store, sessionId } = await fixture();
    await appendUserTurn(store, sessionId, 'first');
    await appendUserTurn(store, sessionId, 'second');
    const reopened = await reopenStore(home, store);

    await expect(
      Promise.all(Array.from({ length: 16 }, () => reopened.userTurnCount(sessionId)))
    ).resolves.toEqual(Array.from({ length: 16 }, () => 2));
  });

  it('does not reset a missing count when appending before concurrent cold queries', async () => {
    const { home, store, sessionId } = await fixture();
    await appendUserTurn(store, sessionId, 'first');
    await appendUserTurn(store, sessionId, 'second');
    await appendUserTurn(store, sessionId, 'third');
    const indexPath = join(home, '.mar', 'agent', 'sessions', 'index.json');
    await store.close();
    const storeIndex = stores.indexOf(store);
    if (storeIndex >= 0) stores.splice(storeIndex, 1);

    const index = JSON.parse(await actualFs.readFile(indexPath, 'utf8')) as {
      sessions: { id: string; resume?: { userTurns?: number; [key: string]: unknown } }[];
      [key: string]: unknown;
    };
    const entry = index.sessions.find((session) => session.id === sessionId);
    expect(entry?.resume?.userTurns).toBe(3);
    if (!entry?.resume) throw new Error('Expected a persisted resume index.');
    delete entry.resume.userTurns;
    await actualFs.writeFile(indexPath, `${JSON.stringify(index)}\n`);
    const reopened = await openStore(home);
    await appendUserTurn(reopened, sessionId, 'after-upgrade');

    await expect(
      Promise.all(Array.from({ length: 16 }, () => reopened.userTurnCount(sessionId)))
    ).resolves.toEqual(Array.from({ length: 16 }, () => 4));
  });

  it('keeps the lifetime count across Compact and cold reindexing', async () => {
    const { home, store, sessionId } = await fixture();
    await appendUserTurn(store, sessionId, 'first');
    await appendUserTurn(store, sessionId, 'second');
    await store.compact(sessionId, { summary: 'Retain the task facts.' });
    await appendUserTurn(store, sessionId, 'third');
    await expect(store.userTurnCount(sessionId)).resolves.toBe(3);
    await store.close();
    const indexPath = join(home, '.mar', 'agent', 'sessions', 'index.json');
    const index = JSON.parse(await actualFs.readFile(indexPath, 'utf8'));
    delete index.sessions[0].resume.userTurns;
    await actualFs.writeFile(indexPath, JSON.stringify(index));
    const reopened = await openStore(home);
    await expect(reopened.userTurnCount(sessionId)).resolves.toBe(3);
  });

  it.each(['rename', 'append', 'clear', 'delete'] as const)(
    'keeps external %s updates while saving a derived count',
    async (action) => {
      const { home, store, sessionId } = await fixture();
      await appendUserTurn(store, sessionId, 'original');
      await store.close();
      const indexPath = join(home, '.mar', 'agent', 'sessions', 'index.json');
      const index = JSON.parse(await actualFs.readFile(indexPath, 'utf8'));
      delete index.sessions[0].resume.userTurns;
      await actualFs.writeFile(indexPath, JSON.stringify(index));
      const reopened = await openStore(home);
      await expect(reopened.userTurnCount(sessionId)).resolves.toBe(1);
      const meta = index.sessions[0];
      if (action === 'delete') index.sessions = [];
      else {
        meta.title = 'Updated by another writer';
        if (action === 'append') {
          meta.nextSequence++;
          meta.resume.userTurns = 2;
        } else if (action === 'clear') {
          meta.storageTransactionId = 'replacement';
          meta.nextSequence = 2;
          meta.resume.userTurns = 0;
        }
      }
      index.revision++;
      await actualFs.writeFile(indexPath, JSON.stringify(index));
      await reopened.close();
      const saved = JSON.parse(await actualFs.readFile(indexPath, 'utf8'));
      expect(saved.revision).toBe(index.revision);
      if (action === 'delete') expect(saved.sessions).toEqual([]);
      else {
        expect(saved.sessions[0].title).toBe('Updated by another writer');
        expect(saved.sessions[0].resume.userTurns).toBe(
          action === 'append' ? 2 : action === 'clear' ? 0 : 1
        );
        expect(saved.sessions[0].nextSequence).toBe(meta.nextSequence);
        expect(saved.sessions[0].storageTransactionId).toBe(meta.storageTransactionId);
      }
    }
  );

  it('updates the count as the existing writer appends user turns', async () => {
    const { store, sessionId } = await fixture();
    await expect(store.userTurnCount(sessionId)).resolves.toBe(0);
    await appendUserTurn(store, sessionId, 'first');
    await expect(store.userTurnCount(sessionId)).resolves.toBe(1);
    await appendUserTurn(store, sessionId, 'second');
    await expect(store.userTurnCount(sessionId)).resolves.toBe(2);
  });

  it('preserves count semantics across fork, rollback, clear, and reopen', async () => {
    const { home, store, sessionId } = await fixture();
    await appendUserTurn(store, sessionId, 'first');
    await appendUserTurn(store, sessionId, 'second');
    const fork = await store.forkSession(sessionId, {
      boundaryTurnId: 'first',
      title: 'User turn count fork'
    });
    await expect(store.userTurnCount(fork.id)).resolves.toBe(1);

    await store.rollbackSession(sessionId, { boundaryTurnId: 'first' });
    await expect(store.userTurnCount(sessionId)).resolves.toBe(1);
    let reopened = await reopenStore(home, store);
    await expect(reopened.userTurnCount(sessionId)).resolves.toBe(1);
    await expect(reopened.userTurnCount(fork.id)).resolves.toBe(1);

    await reopened.clearSession(sessionId);
    await expect(reopened.userTurnCount(sessionId)).resolves.toBe(0);
    reopened = await reopenStore(home, reopened);
    await expect(reopened.userTurnCount(sessionId)).resolves.toBe(0);
  });

  it.each([false, true])(
    'includes an unindexed physical tail (new segment: %s)',
    async (newSegment) => {
      const { home, store, sessionId } = await fixture();
      const first = await appendUserTurn(store, sessionId, 'first');
      const directory = await activeSessionDirectory(home, sessionId);
      const segment = (await actualFs.readdir(directory))
        .filter((name) => name.endsWith('.jsonl'))
        .sort()
        .at(-1)!;
      const tail = {
        ...first,
        recordId: randomUUID(),
        sequence: first.sequence + 1,
        turnId: 'physical-tail',
        payload: { prompt: 'physical tail' }
      };
      await actualFs.appendFile(
        join(directory, newSegment ? 'events-000002.jsonl' : segment),
        `${JSON.stringify(tail)}\n`
      );
      const reopened = await reopenStore(home, store);

      await expect(reopened.userTurnCount(sessionId)).resolves.toBe(2);
      await reopened.close();
      const index = JSON.parse(
        await actualFs.readFile(join(home, '.mar', 'agent', 'sessions', 'index.json'), 'utf8')
      );
      expect(index.sessions[0].resume.userTurns).toBe(1);
      expect(index.sessions[0].nextSequence).toBe(first.sequence + 1);
    }
  );

  it('does not open or read session JSONL bodies for hot queries with an existing writer', async () => {
    const { store, sessionId } = await fixture();
    await acquireWriter(store, sessionId);
    await appendUserTurn(store, sessionId, 'first');
    await expect(store.userTurnCount(sessionId)).resolves.toBe(1);
    vi.mocked(fs.readFile).mockClear();
    let jsonlOpens = 0;
    let jsonlReads = 0;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actualFs.open(...args);
      if (!String(args[0]).endsWith('.jsonl')) return handle;
      jsonlOpens++;
      const read = handle.read.bind(handle);
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'read')
            return (...readArgs: Parameters<typeof handle.read>) => {
              jsonlReads++;
              return read(...readArgs);
            };
          return Reflect.get(target, property, target);
        }
      });
    });

    await expect(store.userTurnCount(sessionId)).resolves.toBe(1);
    await expect(store.userTurnCount(sessionId)).resolves.toBe(1);

    expect(jsonlOpens).toBe(0);
    expect(jsonlReads).toBe(0);
    expect(
      vi.mocked(fs.readFile).mock.calls.filter(([path]) => String(path).endsWith('.jsonl'))
    ).toHaveLength(0);
  });

  it.each(['sync', 'close'] as const)(
    'counts a complete uncertain append after its %s failure on the same writer',
    async (failurePoint) => {
      const { home, store: original, sessionId } = await fixture();
      let store = original;
      await appendUserTurn(store, sessionId, 'retained');
      store = await reopenStore(home, store);
      await acquireWriter(store, sessionId);
      await expect(store.userTurnCount(sessionId)).resolves.toBe(1);

      const directory = await activeSessionDirectory(home, sessionId);
      const segment = (await actualFs.readdir(directory))
        .filter((name) => name.endsWith('.jsonl'))
        .sort()
        .at(-1)!;
      const eventsPath = join(directory, segment);
      let injected = false;
      vi.mocked(fs.open).mockImplementation(async (...args) => {
        const handle = await actualFs.open(...args);
        if (!injected && String(args[0]) === eventsPath && args[1] === 'a') {
          injected = true;
          if (failurePoint === 'sync') {
            const sync = handle.sync.bind(handle);
            vi.spyOn(handle, 'sync').mockImplementation(async () => {
              await sync();
              throw new Error('injected sync failure');
            });
          } else {
            const close = handle.close.bind(handle);
            vi.spyOn(handle, 'close').mockImplementation(async () => {
              await close();
              throw new Error('injected close failure');
            });
          }
        }
        return handle;
      });

      await expect(appendUserTurn(store, sessionId, 'uncertain')).rejects.toThrow(
        `injected ${failurePoint} failure`
      );
      expect(injected).toBe(true);
      const contents = await actualFs.readFile(eventsPath, 'utf8');
      expect(contents.endsWith('\n')).toBe(true);
      expect(JSON.parse(contents.trimEnd().split('\n').at(-1)!)).toMatchObject({
        type: 'turn.user',
        turnId: 'uncertain'
      });
      await expect(store.userTurnCount(sessionId)).resolves.toBe(2);
    }
  );
});
