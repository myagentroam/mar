import { activeSessionDirectory } from '../support/jsonl-session-path.js';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlSessionStore } from '../../src/session/store/index.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open), readFile: vi.fn(actual.readFile) };
});

const actualFs = await vi.importActual<typeof fs>('node:fs/promises');
const homes: string[] = [];
const stores: JsonlSessionStore[] = [];

async function openStore(home: string) {
  const store = await JsonlSessionStore.open(home);
  stores.push(store);
  return store;
}

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function legacySessions(count: number, largeHistory = false) {
  const home = await fs.mkdtemp(join(tmpdir(), 'mar-agent-model-index-'));
  homes.push(home);
  const store = await openStore(home);
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const session = await store.createSession({ workspace: home, title: `Session ${index}` });
    ids.push(session.id);
    if (largeHistory)
      await store.append(session.id, {
        type: 'tool.completed',
        payload: { text: 'old-history'.repeat(600_000) }
      });
    await store.append(session.id, {
      type: 'execution.header',
      payload: { modelId: `model-${index}`, modelName: `Model ${index}`, reasoningEffort: 'high' }
    });
    await store.append(session.id, { type: 'message.completed', payload: { text: 'done' } });
  }
  await store.close();
  const indexPath = join(home, '.mar', 'agent', 'sessions', 'index.json');
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  for (const session of index.sessions) {
    delete session.resume.executionModelIndexed;
    delete session.resume.modelId;
    delete session.resume.modelName;
    delete session.resume.reasoningEffort;
  }
  await fs.writeFile(indexPath, JSON.stringify(index));
  return { home, ids, indexPath };
}

afterEach(async () => {
  try {
    await Promise.all(stores.splice(0).map((store) => store.close()));
  } finally {
    vi.restoreAllMocks();
    vi.mocked(fs.open).mockImplementation(actualFs.open);
    vi.clearAllMocks();
    await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
  }
});

describe('Session execution model index', () => {
  it('persists every parallel legacy backfill and avoids rereading on reopen', async () => {
    const { home, ids } = await legacySessions(8);
    const store = await openStore(home);
    const configuration = await Promise.all(ids.map((id) => store.executionConfiguration(id)));
    expect(configuration.map((model) => model?.modelId)).toEqual(
      ids.map((_, index) => `model-${index}`)
    );
    expect((await store.list()).sessions.filter((session) => session.modelId)).toHaveLength(8);
    await store.close();

    const reopened = await openStore(home);
    const fullRead = vi.spyOn(reopened, 'read');
    const segmentOpen = vi.mocked(fs.open).mockClear();
    await Promise.all(ids.map((id) => reopened.executionConfiguration(id)));
    expect(fullRead).not.toHaveBeenCalled();
    expect(segmentOpen.mock.calls.filter(([path]) => String(path).endsWith('.jsonl'))).toEqual([]);
    expect((await reopened.list()).sessions.filter((session) => session.modelId)).toHaveLength(8);
  });

  it('shares one tail scan for concurrent readers of the same legacy session', async () => {
    const { home, ids } = await legacySessions(1);
    const first = await openStore(home);
    const second = await openStore(home);
    const segmentOpen = vi.mocked(fs.open).mockClear();
    const configurations = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        (index % 2 === 0 ? first : second).executionConfiguration(ids[0]!)
      )
    );
    expect(configurations.every((model) => model?.modelId === 'model-0')).toBe(true);
    expect(segmentOpen.mock.calls.filter(([path]) => String(path).endsWith('.jsonl'))).toHaveLength(
      1
    );
  });

  it('reads only the tail needed for a model and leaves unrelated resume state unchanged', async () => {
    const { home, ids, indexPath } = await legacySessions(1, true);
    const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    index.sessions[0].resume.todoRevision = 7;
    await fs.writeFile(indexPath, JSON.stringify(index));
    const store = await openStore(home);
    const fullRead = vi.spyOn(store, 'read');
    const readFile = vi.mocked(fs.readFile).mockClear();
    const originalOpen = actualFs.open;
    const reads: Array<ReturnType<typeof vi.spyOn>> = [];
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith('.jsonl')) reads.push(vi.spyOn(handle, 'read'));
      return handle;
    });

    await expect(store.executionConfiguration(ids[0]!)).resolves.toMatchObject({
      modelId: 'model-0'
    });
    expect(fullRead).not.toHaveBeenCalled();
    expect(readFile.mock.calls.filter(([path]) => String(path).endsWith('.jsonl'))).toEqual([]);
    expect(reads).toHaveLength(1);
    expect(reads[0]!.mock.calls).toHaveLength(1);
    await store.close();
    const persisted = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    expect(persisted.sessions[0].resume.todoRevision).toBe(7);
  });

  it('finds the latest valid header across segments and ignores an interrupted final line', async () => {
    const { home, ids, indexPath } = await legacySessions(1);
    const directory = await activeSessionDirectory(home, ids[0]!);
    const record = JSON.parse(
      (await fs.readFile(join(directory, 'events-000001.jsonl'), 'utf8')).split('\n')[0]!
    );
    await fs.writeFile(
      join(directory, 'events-000002.jsonl'),
      `${JSON.stringify({
        ...record,
        sequence: 5,
        type: 'execution.header',
        payload: { modelId: '' }
      })}\n${JSON.stringify({
        ...record,
        sequence: 6,
        type: 'message.completed',
        payload: { text: '你好'.repeat(30_000) }
      })}\n{"incomplete":`
    );
    const store = await openStore(home);
    await expect(store.executionConfiguration(ids[0]!)).resolves.toMatchObject({
      modelId: 'model-0'
    });
    await store.close();
    const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    expect(index.sessions[0].resume.modelId).toBe('model-0');
  });

  it('indexes the absence of a model without fabricating complete resume state', async () => {
    const home = await fs.mkdtemp(join(tmpdir(), 'mar-agent-model-index-empty-'));
    homes.push(home);
    const writer = await openStore(home);
    const session = await writer.createSession({ workspace: home });
    await writer.close();
    const indexPath = join(home, '.mar', 'agent', 'sessions', 'index.json');
    const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    delete index.sessions[0].resume;
    await fs.writeFile(indexPath, JSON.stringify(index));
    const store = await openStore(home);
    await expect(store.executionConfiguration(session.id)).resolves.toBeUndefined();
    await store.close();
    const reopened = await openStore(home);
    const segmentOpen = vi.mocked(fs.open).mockClear();
    await expect(reopened.executionConfiguration(session.id)).resolves.toBeUndefined();
    expect(segmentOpen.mock.calls.filter(([path]) => String(path).endsWith('.jsonl'))).toEqual([]);
    await expect(reopened.readExecutionState(session.id)).resolves.toMatchObject({
      automaticTitlePending: true,
      todo: { revision: 0, items: [] }
    });
  });

  it('propagates tail corruption, releases failed reads, and retries after repair', async () => {
    const { home, ids } = await legacySessions(1);
    const path = join(await activeSessionDirectory(home, ids[0]!), 'events-000001.jsonl');
    const original = await fs.readFile(path, 'utf8');
    await fs.appendFile(path, 'invalid record\n');
    const store = await openStore(home);
    await expect(
      Promise.all([store.executionConfiguration(ids[0]!), store.executionConfiguration(ids[0]!)])
    ).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_CORRUPT' });
    await fs.writeFile(path, original);
    await expect(store.executionConfiguration(ids[0]!)).resolves.toMatchObject({
      modelId: 'model-0'
    });
  });

  it.each(['append', 'clear', 'delete'] as const)(
    'does not publish a stale backfill when history changes through %s',
    async (operation) => {
      const { home, ids } = await legacySessions(1);
      const store = await openStore(home);
      // An already-admitted writer can append while the model-index reader is pinned.
      const releaseWriter =
        operation === 'append' ? await store.acquireSessionLease(ids[0]!) : undefined;
      const started = signal();
      const release = signal();
      let paused = false;
      vi.mocked(fs.open).mockImplementation(async (...args) => {
        const handle = await actualFs.open(...args);
        if (!paused && String(args[0]).endsWith('.jsonl') && args[1] === 'r') {
          paused = true;
          started.resolve();
          await release.promise;
        }
        return handle;
      });
      const pending = store.executionConfiguration(ids[0]!);
      void pending.catch(() => undefined);
      let maintenance: Promise<unknown> | undefined;
      try {
        await Promise.race([
          started.promise,
          pending.then(() => {
            throw new Error('Model index read completed before the test gate was reached.');
          })
        ]);
        if (operation === 'append')
          await store.append(ids[0]!, {
            type: 'execution.header',
            payload: { modelId: 'new-model', reasoningEffort: 'low' }
          });
        else {
          let settled = false;
          maintenance = (
            operation === 'clear' ? store.clearSession(ids[0]!) : store.delete(ids[0]!)
          ).finally(() => {
            settled = true;
          });
          void maintenance.catch(() => undefined);
          const gate = join(home, '.mar', 'agent', 'sessions', '.read-pins', `${ids[0]}.lock`);
          await vi.waitFor(async () => expect((await fs.stat(gate)).isFile()).toBe(true));
          expect(settled).toBe(false);
        }
        release.resolve();
        if (operation === 'append') {
          await expect(pending).resolves.toMatchObject({
            modelId: 'new-model',
            reasoningEffort: 'low'
          });
        } else {
          await expect(pending).resolves.toMatchObject({ modelId: 'model-0' });
          await maintenance;
          if (operation === 'delete') expect((await store.list()).sessions).toEqual([]);
          else expect((await store.list()).sessions[0]).not.toHaveProperty('modelId');
        }
      } finally {
        release.resolve();
        await pending.catch(() => undefined);
        await maintenance?.catch(() => undefined);
        await releaseWriter?.();
      }
    }
  );
});
