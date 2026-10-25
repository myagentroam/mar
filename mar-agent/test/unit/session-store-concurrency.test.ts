import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlSessionStore } from '../../src/agent-core/session/store/index.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open), rm: vi.fn(actual.rm) };
});

const actualFs = await vi.importActual<typeof fs>('node:fs/promises');
const homes: string[] = [];
const stores: JsonlSessionStore[] = [];

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function openStore(home: string) {
  const store = await JsonlSessionStore.open(home);
  stores.push(store);
  return store;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.open).mockImplementation(actualFs.open);
  vi.mocked(fs.rm).mockImplementation(actualFs.rm);
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    homes.splice(0).map((home) => actualFs.rm(home, { recursive: true, force: true }))
  );
});

describe('Session append and directory index concurrency', () => {
  it('does not combine an indexed count with a concurrently replaced history', async () => {
    const home = await fs.mkdtemp(join(tmpdir(), 'mar-agent-count-replacement-'));
    homes.push(home);
    const store = await openStore(home);
    const session = await store.createSession({ workspace: home });
    await store.append(session.id, { type: 'turn.user', payload: { prompt: 'first' } });
    await store.append(session.id, { type: 'turn.user', payload: { prompt: 'second' } });
    const records = await store.read(session.id);
    await store.close();
    const reopened = await openStore(home);
    const eventsPath = join(home, '.mar', 'agent', 'sessions', session.id, 'events-000001.jsonl');
    const indexPath = join(home, '.mar', 'agent', 'sessions', 'index.json');
    const started = signal();
    const resume = signal();
    let paused = false;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      if (!paused && args[0] === eventsPath && args[1] === 'r') {
        paused = true;
        started.resolve();
        await resume.promise;
      }
      return actualFs.open(...args);
    });
    const pending = reopened.userTurnCount(session.id);
    await started.promise;
    try {
      // Simulate a completed history transaction published by another process.
      const replacement = [
        records[0]!,
        { ...records[1]!, type: 'model.context' },
        records[2]!,
        { ...records[2]!, sequence: 4, type: 'model.context' }
      ];
      await actualFs.writeFile(
        eventsPath,
        replacement.map((record) => JSON.stringify(record)).join('\n') + '\n'
      );
      const index = JSON.parse(await actualFs.readFile(indexPath, 'utf8'));
      const meta = index.sessions.find((entry: { id: string }) => entry.id === session.id);
      meta.storageTransactionId = 'replacement';
      meta.nextSequence = 5;
      meta.resume.userTurns = 1;
      index.revision++;
      await actualFs.writeFile(indexPath, JSON.stringify(index));
    } finally {
      resume.resolve();
    }
    await expect(pending).resolves.toBe(1);
  });

  it.each(['rollback', 'clear'] as const)(
    'holds the maintenance lease until %s file replacement settles',
    async (operation) => {
      const home = await fs.mkdtemp(join(tmpdir(), 'mar-agent-replacement-lease-'));
      homes.push(home);
      const store = await openStore(home);
      const session = await store.createSession({ workspace: home });
      await store.append(session.id, {
        type: 'turn.user',
        payload: { prompt: 'retained' },
        turnId: 'turn'
      });
      const other = await openStore(home);
      const started = signal();
      const resume = signal();
      vi.mocked(fs.open).mockImplementation(async (...args) => {
        const handle = await actualFs.open(...args);
        if (String(args[0]).endsWith('.rollback-tmp')) {
          started.resolve();
          await resume.promise;
        }
        return handle;
      });
      const pending =
        operation === 'rollback'
          ? store.rollbackSession(session.id, { boundaryTurnId: 'turn' })
          : store.clearSession(session.id);
      let unexpectedLease: (() => Promise<void>) | undefined;
      try {
        await started.promise;
        await expect(
          other.acquireSessionLease(session.id).then((release) => {
            unexpectedLease = release;
          })
        ).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_LOCKED' });
      } finally {
        resume.resolve();
        try {
          await pending;
        } finally {
          await unexpectedLease?.();
        }
      }
      const release = await other.acquireSessionLease(session.id);
      await release();
      expect((await other.read(session.id)).map((record) => record.type)).toEqual(
        operation === 'rollback' ? ['session.created', 'turn.user'] : ['session.created']
      );
    }
  );

  it.each(['refresh', 'save'] as const)(
    'preserves repaired tail metadata across concurrent index %s',
    async (operation) => {
      const home = await fs.mkdtemp(join(tmpdir(), 'mar-agent-tail-index-'));
      homes.push(home);
      const original = await openStore(home);
      const session = await original.createSession({ workspace: home });
      const indexPath = join(home, '.mar', 'agent', 'sessions', 'index.json');
      const staleIndex = await fs.readFile(indexPath, 'utf8');
      const eventsPath = join(home, '.mar', 'agent', 'sessions', session.id, 'events-000001.jsonl');
      const timestamp = '2090-01-01T00:00:00.000Z';
      await original.append(session.id, {
        type: 'session.title.updated',
        timestamp,
        payload: { title: 'Recovered title' }
      });
      await original.close();
      await fs.writeFile(indexPath, staleIndex);
      await fs.writeFile(eventsPath, (await fs.readFile(eventsPath, 'utf8')).slice(0, -1));
      const store = await openStore(home);
      const reader = await openStore(home);
      const started = signal();
      const resume = signal();
      let paused = false;
      vi.mocked(fs.open).mockImplementation(async (...args) => {
        const handle = await actualFs.open(...args);
        if (!paused && args[0] === eventsPath && args[1] === 'r+') {
          paused = true;
          started.resolve();
          await resume.promise;
        }
        return handle;
      });
      const pending = store.acquireSessionLease(session.id);
      await started.promise;
      try {
        if (operation === 'refresh') await reader.list();
        else await reader.createSession({ workspace: home, title: 'Unrelated session' });
      } finally {
        resume.resolve();
      }
      const releaseLease = await pending;
      let record;
      try {
        record = await store.append(session.id, {
          type: 'model.context',
          timestamp,
          payload: { text: 'next' }
        });
      } finally {
        await releaseLease();
      }
      expect(record.sequence).toBe(3);
      expect((await store.read(session.id)).map((entry) => entry.sequence)).toEqual([1, 2, 3]);
      const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
      expect(index.sessions.find((entry: { id: string }) => entry.id === session.id)).toMatchObject(
        {
          title: 'Recovered title',
          nextSequence: 4,
          lastActivityAt: timestamp,
          segments: [{ firstSequence: 1, lastSequence: 3, bytes: (await fs.stat(eventsPath)).size }]
        }
      );
    }
  );

  for (const phase of ['before-write', 'after-sync'] as const) {
    for (const operation of ['refresh', 'save'] as const) {
      it.each([false, true])(
        `preserves sequence and resume metadata during ${operation} ${phase} (dirty=%s)`,
        async (dirty) => {
          const home = await fs.mkdtemp(join(tmpdir(), 'mar-agent-append-index-'));
          homes.push(home);
          const store = await openStore(home);
          const session = await store.createSession({ workspace: home });
          const reader = await openStore(home);
          const releaseLease = await store.acquireSessionLease(session.id);
          if (dirty)
            await store.append(session.id, { type: 'model.context', payload: { text: 'seed' } });
          const firstSequence = dirty ? 3 : 2;
          const started = signal();
          const resume = signal();
          const eventsPath = join(
            home,
            '.mar',
            'agent',
            'sessions',
            session.id,
            'events-000001.jsonl'
          );
          let paused = false;
          vi.mocked(fs.open).mockImplementation(async (...args) => {
            const handle = await actualFs.open(...args);
            if (!paused && args[0] === eventsPath && args[1] === 'a') {
              paused = true;
              if (phase === 'before-write') {
                started.resolve();
                await resume.promise;
              } else {
                const sync = handle.sync.bind(handle);
                vi.spyOn(handle, 'sync').mockImplementation(async () => {
                  await sync();
                  started.resolve();
                  await resume.promise;
                });
              }
            }
            return handle;
          });
          const timestamp = '2090-01-01T00:00:00.000Z';
          const pending = store.append(session.id, {
            type: 'execution.header',
            timestamp,
            payload: { modelId: 'new-model', modelName: 'New model', reasoningEffort: 'low' }
          });
          await started.promise;
          try {
            if (operation === 'refresh') await reader.list();
            else await reader.createSession({ workspace: home, title: 'Unrelated session' });
          } finally {
            resume.resolve();
          }
          const first = await pending;
          const second = await store.append(session.id, {
            type: 'usage.updated',
            timestamp,
            payload: { inputTokens: 12, outputTokens: 3 }
          });
          await releaseLease();
          expect([first.sequence, second.sequence]).toEqual([firstSequence, firstSequence + 1]);
          const records = await store.read(session.id);
          expect(records.map((record) => record.sequence)).toEqual(
            Array.from({ length: firstSequence + 1 }, (_, index) => index + 1)
          );
          await expect(reader.executionConfiguration(session.id)).resolves.toEqual({
            modelId: 'new-model',
            modelName: 'New model',
            reasoningEffort: 'low'
          });
          const index = JSON.parse(
            await fs.readFile(join(home, '.mar', 'agent', 'sessions', 'index.json'), 'utf8')
          );
          expect(
            index.sessions.find((entry: { id: string }) => entry.id === session.id)
          ).toMatchObject({
            nextSequence: firstSequence + 2,
            lastActivityAt: timestamp,
            segments: [
              {
                number: 1,
                firstSequence: 1,
                lastSequence: firstSequence + 1,
                bytes: (await fs.stat(eventsPath)).size
              }
            ]
          });
          await store.close();
          await reader.close();
          const reopened = await openStore(home);
          expect(
            (
              await reopened.append(session.id, {
                type: 'model.context',
                payload: { text: 'next' }
              })
            ).sequence
          ).toBe(firstSequence + 2);
        }
      );
    }
  }

  it('publishes the complete durable metadata before asynchronous image marker cleanup', async () => {
    const home = await fs.mkdtemp(join(tmpdir(), 'mar-agent-append-cleanup-'));
    homes.push(home);
    const store = await openStore(home);
    const session = await store.createSession({ workspace: home });
    const releaseLease = await store.acquireSessionLease(session.id);
    const images = await store.persistInputImages(session.id, [
      {
        name: 'image.png',
        mimeType: 'image/png',
        dataBase64: Buffer.from('image').toString('base64')
      }
    ]);
    const marker = join(
      home,
      '.mar',
      'agent',
      'sessions',
      session.id,
      'resources',
      `.${images[0]!.resourceId}.pending`
    );
    const started = signal();
    const resume = signal();
    vi.mocked(fs.rm).mockImplementation(async (...args) => {
      if (args[0] === marker) {
        started.resolve();
        await resume.promise;
      }
      return actualFs.rm(...args);
    });
    const timestamp = '2090-01-01T00:00:00.000Z';
    const pending = store.append(session.id, {
      type: 'turn.user',
      timestamp,
      payload: { prompt: 'Image request', images }
    });
    await started.promise;
    try {
      await store.createSession({ workspace: home, title: 'Concurrent publication' });
      const index = JSON.parse(
        await fs.readFile(join(home, '.mar', 'agent', 'sessions', 'index.json'), 'utf8')
      );
      const eventsPath = join(home, '.mar', 'agent', 'sessions', session.id, 'events-000001.jsonl');
      expect(index.sessions.find((entry: { id: string }) => entry.id === session.id)).toMatchObject(
        {
          nextSequence: 3,
          lastActivityAt: timestamp,
          automaticTitlePending: false,
          resume: { firstUserMessagePreview: 'Image request' },
          segments: [{ firstSequence: 1, lastSequence: 2, bytes: (await fs.stat(eventsPath)).size }]
        }
      );
    } finally {
      resume.resolve();
      await pending;
      await releaseLease();
    }
    expect(
      (await store.append(session.id, { type: 'model.context', payload: { text: 'next' } }))
        .sequence
    ).toBe(3);
    await expect(
      store.readInputImage(session.id, { sequence: 2, imageIndex: 0 })
    ).resolves.toMatchObject({
      mimeType: 'image/png',
      dataBase64: Buffer.from('image').toString('base64')
    });
  });
});
