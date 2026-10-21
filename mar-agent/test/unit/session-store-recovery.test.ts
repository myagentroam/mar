import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlSessionStore } from '../../src/agent-core/session/store/index.js';
import {
  beginSessionStorageTransaction,
  type SessionStorageTransaction
} from '../../src/agent-core/session/transaction-recovery.js';

const indexLockFailure = vi.hoisted(() => ({ path: '', indexPath: '', injected: false }));
const indexInstallFailure = vi.hoisted(() => ({ path: '', injected: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      if (args[1] === indexInstallFailure.path && !indexInstallFailure.injected) {
        indexInstallFailure.injected = true;
        throw new Error('simulated index installation error');
      }
      return fs.rename(...args);
    },
    rm: async (...args: Parameters<typeof fs.rm>) => {
      if (args[0] === indexLockFailure.path && !indexLockFailure.injected) {
        const disk = JSON.parse(await fs.readFile(indexLockFailure.indexPath, 'utf8')) as {
          sessions: unknown[];
        };
        if (disk.sessions.length > 0) {
          indexLockFailure.injected = true;
          await fs.rm(...args);
          throw new Error('simulated post-commit index lock release error');
        }
      }
      return fs.rm(...args);
    }
  };
});

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'mar-agent-recovery-'));
  homes.push(home);
  const store = await JsonlSessionStore.open(home);
  const session = await store.createSession({ workspace: home });
  const directory = join(home, '.mar', 'agent', 'sessions');
  return {
    home,
    store,
    session,
    indexPath: join(directory, 'index.json'),
    eventsPath: join(directory, session.id, 'events-000001.jsonl')
  };
}

describe('session storage recovery', () => {
  it('does not treat a broken index as an empty catalog or overwrite existing history', async () => {
    const { home, store, indexPath, eventsPath } = await fixture();
    const original = await readFile(eventsPath, 'utf8');
    await writeFile(indexPath, '{broken');
    await expect(store.list()).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_CORRUPT' });
    await expect(store.createSession({ workspace: home })).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_CORRUPT'
    });
    expect(await readFile(indexPath, 'utf8')).toBe('{broken');
    expect(await readFile(eventsPath, 'utf8')).toBe(original);
    await store.close();
    await expect(JsonlSessionStore.open(home)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_CORRUPT'
    });
  });

  it('refuses a missing index when there is already a session directory', async () => {
    const { home, store, indexPath } = await fixture();
    await store.close();
    await rm(indexPath);
    await expect(JsonlSessionStore.open(home)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_CORRUPT'
    });
  });

  it('reclaims an unpublished session killed after its first durable record', async () => {
    const { home, store, session } = await fixture();
    await store.close();
    const marker = join(home, 'unpublished-id');
    const moduleUrl = new URL('../../src/agent-core/session/store/index.ts', import.meta.url).href;
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `import { writeFile } from 'node:fs/promises';
         import { JsonlSessionStore } from ${JSON.stringify(moduleUrl)};
         const store = await JsonlSessionStore.open(process.argv[1]);
         const append = store.append.bind(store);
         store.append = async (id, input) => {
           const record = await append(id, input);
           await writeFile(process.argv[2], id);
           process.kill(process.pid, 'SIGKILL');
           return record;
         };
         await store.createSession({ workspace: process.argv[1] });`,
        home,
        marker
      ],
      { encoding: 'utf8', timeout: 10_000 }
    );
    expect(child.error).toBeUndefined();
    const abandonedId = await readFile(marker, 'utf8');
    expect(child.signal !== null || child.status !== 0).toBe(true);
    const abandonedDir = join(home, '.mar', 'agent', 'sessions', abandonedId);
    expect(await readdir(abandonedDir)).toContain('events-000001.jsonl');

    const reopened = await JsonlSessionStore.open(home);
    expect((await reopened.list()).sessions.map((entry) => entry.id)).toEqual([session.id]);
    await expect(readdir(abandonedDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await reopened.close();
  });

  it('reclaims an unfinished fork without touching its published source', async () => {
    const { home, store, session } = await fixture();
    await store.close();
    const marker = join(home, 'unpublished-fork-id');
    const moduleUrl = new URL('../../src/agent-core/session/store/index.ts', import.meta.url).href;
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `import { open, writeFile } from 'node:fs/promises';
         import { JsonlSessionStore } from ${JSON.stringify(moduleUrl)};
         const store = await JsonlSessionStore.open(process.argv[1]);
         const probe = await open(process.argv[3] + '.probe', 'w');
         const prototype = Object.getPrototypeOf(probe);
         await probe.close();
         const original = prototype.writeFile;
         prototype.writeFile = async function(data, ...args) {
           await original.call(this, data, ...args);
           if (typeof data === 'string' && data.startsWith('{"schemaVersion":')) {
             const record = JSON.parse(data.split('\\n')[0]);
             await writeFile(process.argv[3], record.sessionId);
             process.kill(process.pid, 'SIGKILL');
           }
         };
         await store.forkSession(process.argv[2], { boundaryTurnId: null, title: 'Unfinished' });`,
        home,
        session.id,
        marker
      ],
      { encoding: 'utf8', timeout: 10_000 }
    );
    expect(child.error).toBeUndefined();
    const abandonedId = await readFile(marker, 'utf8');
    expect(child.signal !== null || child.status !== 0).toBe(true);
    const reopened = await JsonlSessionStore.open(home);
    expect((await reopened.list()).sessions.map((entry) => entry.id)).toEqual([session.id]);
    expect((await reopened.read(session.id)).map((entry) => entry.type)).toEqual([
      'session.created'
    ]);
    await expect(
      readdir(join(home, '.mar', 'agent', 'sessions', abandonedId))
    ).rejects.toMatchObject({
      code: 'ENOENT'
    });
    await reopened.close();
  });

  it('keeps an indexed session if its publication marker survives a crash', async () => {
    const { home, store, session } = await fixture();
    const directory = join(home, '.mar', 'agent', 'sessions', session.id);
    await writeFile(join(directory, 'publication-pending'), '1');
    await store.close();
    const reopened = await JsonlSessionStore.open(home);
    expect((await reopened.read(session.id)).map((entry) => entry.type)).toEqual([
      'session.created'
    ]);
    expect(await readdir(directory)).not.toContain('publication-pending');
    await reopened.close();
  });

  it('does not remove an unpublished directory while its writer is still alive', async () => {
    const { home, store, session } = await fixture();
    await store.close();
    const directory = join(home, '.mar', 'agent', 'sessions', randomUUID());
    await mkdir(directory);
    await writeFile(join(directory, 'publication-pending'), '1');
    const lock = join(directory, 'lock');
    await writeFile(lock, JSON.stringify({ pid: process.pid }));
    const observer = await JsonlSessionStore.open(home);
    expect(await readdir(directory)).toContain('publication-pending');
    expect((await observer.list()).sessions.map((entry) => entry.id)).toEqual([session.id]);
    await observer.close();
    await rm(lock);
    const recovered = await JsonlSessionStore.open(home);
    await expect(readdir(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await recovered.close();
  });

  it('discards an interrupted final line before another append', async () => {
    const { store, session, eventsPath } = await fixture();
    await store.close();
    await appendFile(eventsPath, '{"interrupted":');
    const reopened = await JsonlSessionStore.open(homes.at(-1)!);
    const release = await reopened.acquireSessionLease(session.id);
    const appended = await reopened.append(session.id, {
      type: 'after.recovery',
      payload: {}
    });
    expect(appended.sequence).toBe(2);
    await release();
    expect((await reopened.read(session.id)).map((record) => record.type)).toEqual([
      'session.created',
      'after.recovery'
    ]);
    await reopened.close();
  });

  it('terminates a complete final JSON record missing its newline', async () => {
    const { store, session, eventsPath } = await fixture();
    await store.close();
    const first = await readFile(eventsPath, 'utf8');
    await writeFile(eventsPath, first.slice(0, -1));
    const reopened = await JsonlSessionStore.open(homes.at(-1)!);
    const release = await reopened.acquireSessionLease(session.id);
    await reopened.append(session.id, { type: 'after.recovery', payload: {} });
    await release();
    expect((await reopened.read(session.id)).map((record) => record.sequence)).toEqual([1, 2]);
    await reopened.close();
  });

  it('completes a short write before persisting the next JSONL sequence', async () => {
    const { home, store, session, eventsPath } = await fixture();
    const probe = await open(join(home, 'write-probe'), 'w');
    const prototype = Object.getPrototypeOf(probe) as { write: typeof probe.write };
    const original = prototype.write;
    let shortened = false;
    const spy = vi.spyOn(prototype, 'write').mockImplementation(function (
      this: typeof probe,
      buffer,
      offset,
      length,
      position
    ) {
      if (!shortened && Buffer.isBuffer(buffer) && typeof length === 'number') {
        shortened = true;
        return original.call(this, buffer, offset, Math.max(1, Math.floor(length / 2)), position);
      }
      return original.call(this, buffer, offset, length, position);
    });
    try {
      await store.append(session.id, { type: 'after.short-write', payload: { confirmed: true } });
    } finally {
      spy.mockRestore();
      await probe.close();
    }
    expect(shortened).toBe(true);
    await store.close();
    const lines = (await readFile(eventsPath, 'utf8')).trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!) as object).toMatchObject({
      sequence: 2,
      type: 'after.short-write',
      payload: { confirmed: true }
    });
  });

  it('removes interrupted staging files that have no committed transaction journal', async () => {
    const { home, store, session, eventsPath } = await fixture();
    await store.close();
    const directory = join(home, '.mar', 'agent', 'sessions', session.id);
    const staged = `events-000001.jsonl.${randomUUID()}.rollback-tmp`;
    const journalTemp = `storage-transaction.json.${randomUUID()}.tmp`;
    const original = await readFile(eventsPath, 'utf8');
    await writeFile(join(directory, staged), original);
    await writeFile(join(directory, journalTemp), '{partial');
    const reopened = await JsonlSessionStore.open(home);
    const release = await reopened.acquireSessionLease(session.id);
    await release();
    expect(await readdir(directory)).not.toContain(staged);
    expect(await readdir(directory)).not.toContain(journalTemp);
    expect(await readFile(eventsPath, 'utf8')).toBe(original);
    await reopened.close();
  });

  it('does not restore deleted index entries from stale in-memory sessions', async () => {
    const { home, store, session, indexPath } = await fixture();
    const index = JSON.parse(await readFile(indexPath, 'utf8')) as {
      revision: number;
      sessions: Array<{ id: string }>;
    };
    index.revision++;
    index.sessions = index.sessions.filter((entry) => entry.id !== session.id);
    await writeFile(indexPath, JSON.stringify(index));
    const replacement = await store.createSession({ workspace: home });
    expect((await store.list()).sessions.map((entry) => entry.id)).toEqual([replacement.id]);
    await store.close();
    expect(
      (JSON.parse(await readFile(indexPath, 'utf8')) as typeof index).sessions.map(
        (entry) => entry.id
      )
    ).toEqual([replacement.id]);
  });

  it('persists independent session updates when both leases flush the shared index concurrently', async () => {
    const { home, store, session } = await fixture();
    const other = await store.createSession({ workspace: home });
    const releaseFirst = await store.acquireSessionLease(session.id);
    const releaseSecond = await store.acquireSessionLease(other.id);
    for (const [id, label] of [
      [session.id, 'first'],
      [other.id, 'second']
    ] as const)
      await store.append(id, { type: `${label}.updated`, payload: {} });
    await Promise.all([releaseFirst(), releaseSecond()]);
    await store.close();

    const reopened = await JsonlSessionStore.open(home);
    expect((await reopened.read(session.id)).map((record) => record.type)).toEqual([
      'session.created',
      'first.updated'
    ]);
    expect((await reopened.read(other.id)).map((record) => record.type)).toEqual([
      'session.created',
      'second.updated'
    ]);
    const index = JSON.parse(
      await readFile(join(home, '.mar', 'agent', 'sessions', 'index.json'), 'utf8')
    ) as {
      sessions: Array<{ id: string; nextSequence: number }>;
    };
    expect(index.sessions.find((entry) => entry.id === session.id)?.nextSequence).toBe(3);
    expect(index.sessions.find((entry) => entry.id === other.id)?.nextSequence).toBe(3);
    await reopened.close();
  });

  it('publishes both sessions created while the index lock is held', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-concurrent-create-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const directory = join(home, '.mar', 'agent', 'sessions');
    const lockPath = join(directory, 'index.lock');
    const lock = await open(lockPath, 'wx', 0o600);
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    const creations = [
      store.createSession({ workspace: home }),
      store.createSession({ workspace: home })
    ];
    let durable = 0;
    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        durable = 0;
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          try {
            if ((await readFile(join(directory, entry.name, 'events-000001.jsonl'))).length > 0)
              durable++;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
        if (durable === 2) break;
        await delay(10);
      }
    } finally {
      await lock.close();
      await rm(lockPath, { force: true });
    }
    try {
      expect(durable).toBe(2);
      const [first, second] = await Promise.all(creations);
      const index = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8')) as {
        sessions: Array<{ id: string }>;
      };
      expect(index.sessions).toHaveLength(2);
      expect(index.sessions.map((entry) => entry.id)).toEqual(
        expect.arrayContaining([first.id, second.id])
      );
      expect((await store.list()).sessions.map((entry) => entry.id)).toEqual(
        expect.arrayContaining([first.id, second.id])
      );
    } finally {
      await Promise.allSettled(creations);
      await store.close();
    }
  });

  it('keeps a committed creation when releasing the index lock reports an error', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-post-commit-create-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const directory = join(home, '.mar', 'agent', 'sessions');
    const indexPath = join(directory, 'index.json');
    indexLockFailure.path = join(directory, 'index.lock');
    indexLockFailure.indexPath = indexPath;
    indexLockFailure.injected = false;
    let created: { id: string };
    try {
      created = await store.createSession({ workspace: home });
    } finally {
      indexLockFailure.path = '';
      await store.close();
    }
    expect(indexLockFailure.injected).toBe(true);
    const reopened = await JsonlSessionStore.open(home);
    try {
      expect((await reopened.list()).sessions.map((entry) => entry.id)).toContain(created.id);
      expect((await reopened.read(created.id))[0]?.type).toBe('session.created');
    } finally {
      await reopened.close();
    }
  });

  it.each(['rollback', 'clear'] as const)(
    'restores installed %s history, metadata and resources before index commit',
    async (operation) => {
      const { home, store, session, indexPath } = await fixture();
      const [image] = await store.persistInputImages(session.id, [
        { name: 'retained.png', mimeType: 'image/png', dataBase64: 'AAAB' }
      ]);
      await store.append(session.id, {
        type: 'turn.user',
        payload: { prompt: 'retained', images: [image] },
        turnId: 'retained-turn'
      });
      await store.updateTitle(session.id, 'Retained title');
      const sidecar = { snapshot: 'retained' };
      await store.writeContextualWorldState(session.id, sidecar);
      const records = await store.read(session.id);
      const metadata = await store.getSession(session.id);
      await store.close();
      const writer = await JsonlSessionStore.open(home);
      indexInstallFailure.path = indexPath;
      indexInstallFailure.injected = false;
      try {
        await expect(
          operation === 'rollback'
            ? writer.rollbackSession(session.id, { boundaryTurnId: null })
            : writer.clearSession(session.id)
        ).rejects.toThrow('simulated index installation error');
        expect(indexInstallFailure.injected).toBe(true);
        expect(await writer.read(session.id)).toEqual(records);
        expect(await writer.getSession(session.id)).toEqual(metadata);
      } finally {
        indexInstallFailure.path = '';
        await writer.close();
      }
      const reopened = await JsonlSessionStore.open(home);
      try {
        expect(await reopened.read(session.id)).toEqual(records);
        expect(await reopened.getSession(session.id)).toEqual(metadata);
        expect(await reopened.readContextualWorldState(session.id)).toEqual(sidecar);
        await expect(
          reopened.readInputImage(session.id, { sequence: 2, imageIndex: 0 })
        ).resolves.toMatchObject({ dataBase64: 'AAAB' });
        const directory = join(home, '.mar', 'agent', 'sessions', session.id);
        expect(await readdir(join(directory, 'input_images'))).toEqual([image!.fileName]);
        expect(await readdir(directory)).not.toContain('storage-transaction.json');
        expect(
          (await reopened.append(session.id, { type: 'model.context', payload: { text: 'next' } }))
            .sequence
        ).toBe(records.at(-1)!.sequence + 1);
      } finally {
        await reopened.close();
      }
    }
  );

  it.each(['rollback', 'clear'] as const)(
    'keeps committed %s history and resources when index lock release reports an error',
    async (operation) => {
      const { home, store, session, indexPath } = await fixture();
      const [image] = await store.persistInputImages(session.id, [
        { name: 'removed.png', mimeType: 'image/png', dataBase64: 'AAAB' }
      ]);
      await store.append(session.id, {
        type: 'turn.user',
        payload: { prompt: 'removed', images: [image] },
        turnId: 'removed-turn'
      });
      await store.writeContextualWorldState(session.id, { snapshot: 'removed' });
      await store.close();
      const writer = await JsonlSessionStore.open(home);
      indexLockFailure.path = join(home, '.mar', 'agent', 'sessions', 'index.lock');
      indexLockFailure.indexPath = indexPath;
      indexLockFailure.injected = false;
      try {
        await expect(
          operation === 'rollback'
            ? writer.rollbackSession(session.id, { boundaryTurnId: null })
            : writer.clearSession(session.id)
        ).rejects.toThrow('simulated post-commit index lock release error');
        expect(indexLockFailure.injected).toBe(true);
      } finally {
        indexLockFailure.path = '';
        await writer.close();
      }
      const reopened = await JsonlSessionStore.open(home);
      try {
        expect((await reopened.read(session.id)).map((record) => record.type)).toEqual([
          'session.created'
        ]);
        await expect(reopened.readContextualWorldState(session.id)).resolves.toBeUndefined();
        const directory = join(home, '.mar', 'agent', 'sessions', session.id);
        expect(await readdir(join(directory, 'input_images'))).toEqual([]);
        expect(await readdir(directory)).not.toContain('storage-transaction.json');
        expect(
          (await reopened.append(session.id, { type: 'model.context', payload: { text: 'next' } }))
            .sequence
        ).toBe(2);
      } finally {
        await reopened.close();
      }
    }
  );

  it('honors disk membership even when local unflushed updates have a higher revision', async () => {
    const { home, store, session, indexPath } = await fixture();
    const removed = await store.createSession({ workspace: home });
    for (let index = 0; index < 3; index++)
      await store.append(session.id, { type: 'locally.updated', payload: { index } });
    const disk = JSON.parse(await readFile(indexPath, 'utf8')) as {
      revision: number;
      sessions: Array<{ id: string }>;
    };
    disk.revision++;
    disk.sessions = disk.sessions.filter((entry) => entry.id !== removed.id);
    await writeFile(indexPath, JSON.stringify(disk));

    expect((await store.list()).sessions.map((entry) => entry.id)).toEqual([session.id]);
    await store.close();
    const reopened = await JsonlSessionStore.open(home);
    expect((await reopened.list()).sessions.map((entry) => entry.id)).toEqual([session.id]);
    await reopened.close();
  });

  it('serializes dead-lock reclamation between competing processes', async () => {
    const { home, store, session } = await fixture();
    await store.close();
    const directory = join(home, '.mar', 'agent', 'sessions', session.id);
    await writeFile(join(directory, 'lock'), JSON.stringify({ pid: 2147483647 }));
    const barrier = join(home, 'start-writers');
    const finish = join(home, 'release-writer');
    const moduleUrl = new URL('../../src/agent-core/session/store/index.ts', import.meta.url).href;
    const script = `import { readFile, writeFile } from 'node:fs/promises';
      import { setTimeout as delay } from 'node:timers/promises';
      import { JsonlSessionStore } from ${JSON.stringify(moduleUrl)};
      const [home, sessionId, ready, barrier, result, finish] = process.argv.slice(1);
      const store = await JsonlSessionStore.open(home);
      await writeFile(ready, 'ready');
      async function wait(path) {
        for (;;) {
          try { await readFile(path); return; }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          await delay(10);
        }
      }
      await wait(barrier);
      try {
        const release = await store.acquireSessionLease(sessionId);
        await writeFile(result, 'acquired');
        await wait(finish);
        await release();
      } catch (error) {
        if (error.code !== 'MAR_AGENT_SESSION_LOCKED') throw error;
        await writeFile(result, 'locked');
      } finally {
        await store.close();
      }`;
    const files = [0, 1].map((index) => ({
      ready: join(home, `ready-${index}`),
      result: join(home, `result-${index}`)
    }));
    const children = files.map(({ ready, result }) => {
      const child = spawn(process.execPath, [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        script,
        home,
        session.id,
        ready,
        barrier,
        result,
        finish
      ]);
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
      });
      const closed = new Promise<void>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) =>
          code === 0 ? resolve() : reject(new Error(`Writer exited ${code}: ${stderr}`))
        );
      });
      void closed.catch(() => undefined);
      return { child, closed };
    });
    const readWhenReady = async (path: string): Promise<string> => {
      const deadline = Date.now() + 8_000;
      for (;;) {
        try {
          return await readFile(path, 'utf8');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || Date.now() >= deadline)
            throw error;
        }
        await delay(10);
      }
    };
    try {
      await Promise.all(files.map(({ ready }) => readWhenReady(ready)));
      await writeFile(barrier, 'start');
      const outcomes = await Promise.all(files.map(({ result }) => readWhenReady(result)));
      expect(outcomes.sort()).toEqual(['acquired', 'locked']);
      await writeFile(finish, 'release');
      await Promise.all(children.map(({ closed }) => closed));
      expect(await readdir(directory)).not.toContain('lock.reclaim');
    } finally {
      for (const { child } of children)
        if (child.exitCode === null && child.signalCode === null) child.kill();
      await Promise.allSettled(children.map(({ closed }) => closed));
    }
  });

  it('refuses to reclaim an abandoned lock when its reclamation guard remains', async () => {
    const { home, store, session } = await fixture();
    await store.close();
    const lock = join(home, '.mar', 'agent', 'sessions', session.id, 'lock');
    await writeFile(lock, JSON.stringify({ pid: 2147483647 }));
    await writeFile(`${lock}.reclaim`, '');
    const reopened = await JsonlSessionStore.open(home);
    await expect(reopened.acquireSessionLease(session.id)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_LOCKED'
    });
    await reopened.close();
    expect(await readFile(lock, 'utf8')).toContain('2147483647');
  });

  it('reclaims input images left between file persistence and turn publication', async () => {
    const { home, store, session } = await fixture();
    const [image] = await store.persistInputImages(session.id, [
      { name: 'orphan.png', mimeType: 'image/png', dataBase64: 'AAAB' }
    ]);
    const directory = join(home, '.mar', 'agent', 'sessions', session.id, 'input_images');
    await writeFile(join(directory, `.${image!.fileName}.${randomUUID()}.tmp`), 'partial');
    await store.close();
    const reopened = await JsonlSessionStore.open(home);
    const release = await reopened.acquireSessionLease(session.id);
    await release();
    expect(await readdir(directory)).toEqual([]);
    await reopened.close();
  });

  it('preserves a committed image if its pending marker survives a crash', async () => {
    const { home, store, session } = await fixture();
    const [image] = await store.persistInputImages(session.id, [
      { name: 'retained.png', mimeType: 'image/png', dataBase64: 'AAAB' }
    ]);
    await store.append(session.id, {
      type: 'turn.user',
      payload: { prompt: 'inspect', images: [image] },
      executionId: 'execution',
      turnId: 'turn'
    });
    const directory = join(home, '.mar', 'agent', 'sessions', session.id, 'input_images');
    await writeFile(join(directory, `.${image!.fileName}.pending`), '');
    await store.close();
    const reopened = await JsonlSessionStore.open(home);
    const release = await reopened.acquireSessionLease(session.id);
    await release();
    expect(await readdir(directory)).toEqual([image!.fileName]);
    expect(await reopened.readInputImage(session.id, { sequence: 2, imageIndex: 0 })).toMatchObject(
      {
        dataBase64: 'AAAB'
      }
    );
    await reopened.close();
  });

  it('recovers a writer killed after persisting an input image but before publishing its turn', async () => {
    const { home, store, session } = await fixture();
    await store.close();
    const moduleUrl = new URL('../../src/agent-core/session/store/index.ts', import.meta.url).href;
    const marker = join(home, 'writer-ready');
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `import { writeFile } from 'node:fs/promises';
         import { JsonlSessionStore } from ${JSON.stringify(moduleUrl)};
         const store = await JsonlSessionStore.open(process.argv[1]);
         await store.acquireSessionLease(process.argv[2]);
         await store.persistInputImages(process.argv[2], [
           { name: 'unfinished.png', mimeType: 'image/png', dataBase64: 'AAAB' }
         ]);
         await writeFile(process.argv[3], 'ready');
         process.kill(process.pid, 'SIGKILL');`,
        home,
        session.id,
        marker
      ],
      { encoding: 'utf8', timeout: 10_000 }
    );
    expect(child.error).toBeUndefined();
    expect(await readFile(marker, 'utf8')).toBe('ready');
    expect(child.signal !== null || child.status !== 0).toBe(true);

    const reopened = await JsonlSessionStore.open(home);
    const release = await reopened.acquireSessionLease(session.id);
    await release();
    expect(
      await readdir(join(home, '.mar', 'agent', 'sessions', session.id, 'input_images'))
    ).toEqual([]);
    expect((await reopened.read(session.id)).map((entry) => entry.type)).toEqual([
      'session.created'
    ]);
    await reopened.close();
  });

  it('restores pre-clear history and image files after a writer is killed between journal and index commit', async () => {
    const { home, store, session, eventsPath } = await fixture();
    const [image] = await store.persistInputImages(session.id, [
      { name: 'retained.png', mimeType: 'image/png', dataBase64: 'AAAB' }
    ]);
    await store.append(session.id, {
      type: 'turn.user',
      payload: { prompt: 'retain', images: [image] },
      executionId: 'execution',
      turnId: 'turn'
    });
    await store.close();
    const moduleUrl = new URL('../../src/agent-core/session/store/index.ts', import.meta.url).href;
    const transactionUrl = new URL(
      '../../src/agent-core/session/transaction-recovery.ts',
      import.meta.url
    ).href;
    const marker = join(home, 'clear-ready');
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `import { randomUUID } from 'node:crypto';
         import { readFile, rename, writeFile } from 'node:fs/promises';
         import { join } from 'node:path';
         import { JsonlSessionStore } from ${JSON.stringify(moduleUrl)};
         import { beginSessionStorageTransaction } from ${JSON.stringify(transactionUrl)};
         const store = await JsonlSessionStore.open(process.argv[1]);
         const id = process.argv[2];
         await store.acquireSessionLease(id);
         const directory = join(process.argv[1], '.mar', 'agent', 'sessions', id);
         const original = join(directory, 'events-000001.jsonl');
         const transactionId = randomUUID();
         await beginSessionStorageTransaction(directory, {
           version: 1, id: transactionId, kind: 'clear',
           originalSegments: ['events-000001.jsonl'],
           stagedSegments: [],
           sidecarBackup: \`context-world-state.json.2.\${transactionId}.clear-backup\`
         });
         const imagePath = join(directory, 'input_images', process.argv[3]);
         await rename(imagePath, join(directory, 'input_images',
           \`.\${process.argv[3]}.\${transactionId}.rollback-trash\`));
         await rename(original, \`\${original}.\${transactionId}.clear-backup\`);
         const first = (await readFile(\`\${original}.\${transactionId}.clear-backup\`, 'utf8')).split('\\n')[0];
         await writeFile(original, first + '\\n');
         await writeFile(process.argv[4], 'ready');
         process.kill(process.pid, 'SIGKILL');`,
        home,
        session.id,
        image!.fileName,
        marker
      ],
      { encoding: 'utf8', timeout: 10_000 }
    );
    expect(child.error).toBeUndefined();
    expect(await readFile(marker, 'utf8')).toBe('ready');
    expect(child.signal !== null || child.status !== 0).toBe(true);

    const reopened = await JsonlSessionStore.open(home);
    expect((await reopened.read(session.id)).map((entry) => entry.type)).toEqual([
      'session.created',
      'turn.user'
    ]);
    expect(await reopened.readInputImage(session.id, { sequence: 2, imageIndex: 0 })).toMatchObject(
      {
        dataBase64: 'AAAB'
      }
    );
    expect(await readdir(join(home, '.mar', 'agent', 'sessions', session.id))).not.toContain(
      'storage-transaction.json'
    );
    expect(await readFile(eventsPath, 'utf8')).toContain('"turn.user"');
    await reopened.close();
  });

  it.each(['rollback', 'clear'] as const)(
    'restores old history and images after an interrupted %s',
    async (kind) => {
      const { home, store, session, indexPath, eventsPath } = await fixture();
      const [image] = await store.persistInputImages(session.id, [
        { name: 'diagram.png', mimeType: 'image/png', dataBase64: 'AAAB' }
      ]);
      await store.append(session.id, {
        type: 'turn.user',
        payload: { prompt: 'inspect', images: [image] },
        executionId: 'execution',
        turnId: 'turn'
      });
      await store.close();
      const original = await readFile(eventsPath, 'utf8');
      const directory = join(home, '.mar', 'agent', 'sessions', session.id);
      const imagePath = join(directory, 'input_images', image!.fileName);
      const transactionId = randomUUID();
      const stagedId = randomUUID();
      const temporary = `events-000001.jsonl.${stagedId}.rollback-tmp`;
      const transaction: SessionStorageTransaction = {
        version: 1,
        id: transactionId,
        kind,
        originalSegments: ['events-000001.jsonl'],
        stagedSegments: [{ path: 'events-000001.jsonl', temporary }],
        sidecarBackup: `context-world-state.json.2.${transactionId}.${kind}-backup`
      };
      await beginSessionStorageTransaction(directory, transaction);
      const trash = join(
        directory,
        'input_images',
        `.${image!.fileName}.${transactionId}.rollback-trash`
      );
      await rename(imagePath, trash);
      const backup = `${eventsPath}.${transactionId}.${kind}-backup`;
      await rename(eventsPath, backup);
      await writeFile(eventsPath, original.split('\n')[0] + '\n');
      await writeFile(join(directory, temporary), original);
      const reopened = await JsonlSessionStore.open(home);
      expect((await reopened.read(session.id)).map((entry) => entry.type)).toEqual([
        'session.created',
        'turn.user'
      ]);
      expect(
        await reopened.readInputImage(session.id, { sequence: 2, imageIndex: 0 })
      ).toMatchObject({
        dataBase64: 'AAAB'
      });
      expect(await readdir(directory)).not.toContain('storage-transaction.json');
      expect(await readdir(directory)).not.toContain(temporary);
      expect(await readdir(join(directory, 'input_images'))).toEqual([image!.fileName]);
      expect(await readFile(indexPath, 'utf8')).toContain(session.id);
      await reopened.close();
    }
  );

  it.each(['rollback', 'clear'] as const)(
    'finishes a committed %s and removes obsolete files after restart',
    async (kind) => {
      const { home, store, session, indexPath, eventsPath } = await fixture();
      await store.append(session.id, {
        type: 'turn.user',
        payload: { prompt: 'remove' },
        executionId: 'execution',
        turnId: 'turn'
      });
      await store.close();
      const directory = join(home, '.mar', 'agent', 'sessions', session.id);
      const transactionId = randomUUID();
      const temporary = `events-000001.jsonl.${randomUUID()}.rollback-tmp`;
      await beginSessionStorageTransaction(directory, {
        version: 1,
        id: transactionId,
        kind,
        originalSegments: ['events-000001.jsonl'],
        stagedSegments: [{ path: 'events-000001.jsonl', temporary }],
        sidecarBackup: `context-world-state.json.2.${transactionId}.${kind}-backup`
      });
      await rename(eventsPath, `${eventsPath}.${transactionId}.${kind}-backup`);
      const original = await readFile(`${eventsPath}.${transactionId}.${kind}-backup`, 'utf8');
      await writeFile(eventsPath, original.split('\n')[0] + '\n');
      await writeFile(join(directory, temporary), original);
      const index = JSON.parse(await readFile(indexPath, 'utf8')) as {
        revision: number;
        sessions: Array<{ id: string; storageTransactionId?: string }>;
      };
      index.revision++;
      index.sessions[0]!.storageTransactionId = transactionId;
      await writeFile(indexPath, JSON.stringify(index));
      const reopened = await JsonlSessionStore.open(home);
      expect((await reopened.read(session.id)).map((entry) => entry.type)).toEqual([
        'session.created'
      ]);
      expect((await readdir(directory)).filter((name) => name.includes(transactionId))).toEqual([]);
      expect(await readdir(directory)).not.toContain('storage-transaction.json');
      expect(await readdir(directory)).not.toContain(temporary);
      await reopened.close();
    }
  );
});
