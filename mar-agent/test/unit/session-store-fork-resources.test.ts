import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import { createSessionCatalog } from '../../src/session/catalog.js';
import { restoreMessages } from '../../src/runtime/context/restore.js';
import { activeSessionDirectory } from '../support/jsonl-session-path.js';
import { prepareToolResultResources } from '../../src/session/tool-result-resources.js';

const io = vi.hoisted(() => ({
  read: undefined as ((path: string) => Promise<void>) | undefined,
  write: undefined as ((path: string, options: unknown) => Promise<void>) | undefined
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      await io.read?.(String(args[0]));
      return fs.readFile(...args);
    },
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      await io.write?.(String(args[0]), args[2]);
      return fs.writeFile(...args);
    }
  };
});

const fixtures: Array<{ home: string; store: JsonlSessionStore }> = [];
afterEach(async () => {
  io.read = undefined;
  io.write = undefined;
  for (const { home, store } of fixtures.splice(0)) {
    await store.close();
    await rm(home, { recursive: true, force: true });
  }
});

async function fixture(count: number, text = '+change\n') {
  const home = await mkdtemp(join(tmpdir(), 'mar-fork-tool-resources-'));
  const store = await JsonlSessionStore.open(home);
  fixtures.push({ home, store });
  const source = await store.createSession({ workspace: home });
  const resources = [];
  for (let index = 0; index < count; index++) {
    const turnId = 'turn-' + index;
    const executionId = 'execution-' + index;
    await store.append(source.id, {
      type: 'turn.user',
      executionId,
      turnId,
      payload: { prompt: 'Change ' + index }
    });
    const diff = await store.writeToolResultResource(source.id, text);
    const payload = {
      resultExtensions: [
        {
          type: 'file_changes',
          version: 1,
          entries: [
            {
              changeId: randomUUID(),
              path: 'file',
              change: 'modified',
              additions: 1,
              deletions: 0,
              diff
            }
          ]
        }
      ]
    };
    await store.append(source.id, { type: 'tool.completed', executionId, turnId, payload });
    await store.append(source.id, {
      type: 'tool.completed',
      executionId,
      turnId,
      payload: { data: { calls: [payload] } }
    });
    resources.push({ diff, payload, turnId });
  }
  await store.close();
  const reopened = await JsonlSessionStore.open(home);
  fixtures.at(-1)!.store = reopened;
  return { home, store: reopened, source, resources };
}

it('batches independent fork resources into durable segments without links or per-resource writes', async () => {
  const { home, store, source, resources } = await fixture(12);
  const gate = Promise.withResolvers<void>();
  const writes: string[] = [];
  let waiting = 0;
  io.read = async (path) => {
    if (!path.endsWith('.diff')) return;
    waiting++;
    await gate.promise;
  };
  io.write = async (path, options) => {
    if (!path.includes('/tool_results/')) return;
    expect(path.endsWith('/index.json')).toBe(true);
    expect(options).toMatchObject({ flush: true, flag: 'wx', mode: 0o600 });
    writes.push(path);
  };
  const copying = store.forkSession(source.id, { boundaryTurnId: 'turn-11', title: 'Branch' });
  try {
    await vi.waitFor(() => expect(waiting).toBeGreaterThan(1));
    expect(waiting).toBeLessThanOrEqual(8);
  } finally {
    gate.resolve();
  }
  const fork = await copying;
  io.read = undefined;
  io.write = undefined;
  expect(writes).toHaveLength(1);
  const directory = await activeSessionDirectory(home, fork.id);
  expect(await readdir(join(directory, 'tool_results'))).toEqual(['index.json']);
  const records = await store.read(fork.id);
  expect(records.filter((record) => record.type === 'tool.resource')).toHaveLength(12);
  const messages = await restoreMessages(store, fork.id, records, { includeImages: false });
  expect(JSON.stringify(messages)).not.toContain('dataBase64');
  const history = await createSessionCatalog(store, false).history(fork.id, { limit: 100 });
  expect(JSON.stringify(history)).not.toContain('dataBase64');
  expect(history.entries).toHaveLength(12);
  expect(JSON.stringify(messages)).toContain('Change 0');
  expect(JSON.stringify({ messages, history })).not.toContain(
    Buffer.from('+change\n').toString('base64')
  );
  const sourceDirectory = await activeSessionDirectory(home, source.id);
  await writeFile(
    join(sourceDirectory, 'tool_results', resources[0]!.diff.resourceRef + '.diff'),
    'source changed'
  );
  await store.delete(source.id);
  for (const { diff } of resources)
    expect(
      (await store.readToolResultResource(fork.id, { resourceRef: diff.resourceRef })).content
    ).toBe('+change\n');
  // A later wrapper reuses the first committed owner rather than rebinding its resource.
  await store.append(fork.id, {
    type: 'tool.completed',
    turnId: 'later',
    payload: { data: { calls: [resources[0]!.payload] } }
  });
  expect(
    (await store.readToolResultResource(fork.id, { resourceRef: resources[0]!.diff.resourceRef }))
      .content
  ).toBe('+change\n');
});

it('reforks and truncates private resource bodies with the owning history', async () => {
  const { home, store, source, resources } = await fixture(2);
  const fork = await store.forkSession(source.id, { boundaryTurnId: 'turn-1', title: 'Branch' });
  const next = await store.forkSession(fork.id, { boundaryTurnId: 'turn-1', title: 'Next' });
  expect(
    (await store.read(next.id)).filter((record) => record.type === 'tool.resource')
  ).toHaveLength(2);
  await store.rollbackSession(fork.id, { boundaryTurnId: 'turn-0' });
  expect(
    (await store.read(fork.id)).filter((record) => record.type === 'tool.resource')
  ).toHaveLength(1);
  await expect(
    store.readToolResultResource(fork.id, { resourceRef: resources[1]!.diff.resourceRef })
  ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_RESOURCE_NOT_FOUND' });
  await store.clearSession(fork.id);
  expect((await store.read(fork.id)).some((record) => record.type === 'tool.resource')).toBe(false);
  expect(await readdir(join(await activeSessionDirectory(home, fork.id), 'tool_results'))).toEqual(
    []
  );
  expect(
    (await store.readToolResultResource(next.id, { resourceRef: resources[1]!.diff.resourceRef }))
      .content
  ).toBe('+change\n');
});

it('chunks large resource bodies and preserves UTF-8 paging after reopening', async () => {
  const text = '你好\n'.repeat(180000);
  const { home, store, source, resources } = await fixture(1, text);
  const fork = await store.forkSession(source.id, { boundaryTurnId: 'turn-0', title: 'Branch' });
  expect(
    (await store.read(fork.id)).filter((record) => record.type === 'tool.resource')
  ).toHaveLength(2);
  const reopened = await JsonlSessionStore.open(home);
  try {
    let content = '',
      cursor: string | undefined;
    do {
      const page = await reopened.readToolResultResource(fork.id, {
        resourceRef: resources[0]!.diff.resourceRef,
        maxBytes: 256 * 1024,
        ...(cursor ? { cursor } : {})
      });
      content += page.content;
      cursor = page.nextCursor;
    } while (cursor);
    expect(content).toBe(text);
  } finally {
    await reopened.close();
  }
});

it('keeps a missing source resource unavailable without failing the fork', async () => {
  const { home, store, source, resources } = await fixture(2);
  const directory = await activeSessionDirectory(home, source.id);
  await rm(join(directory, 'tool_results', resources[0]!.diff.resourceRef + '.diff'));
  const fork = await store.forkSession(source.id, { boundaryTurnId: 'turn-1', title: 'Branch' });
  await expect(
    store.readToolResultResource(fork.id, { resourceRef: resources[0]!.diff.resourceRef })
  ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_RESOURCE_NOT_FOUND' });
  expect(
    (await store.readToolResultResource(fork.id, { resourceRef: resources[1]!.diff.resourceRef }))
      .content
  ).toBe('+change\n');
});

it('rejects conflicting resource ownership before reading resource bytes', async () => {
  const { home, store, source, resources } = await fixture(1);
  const records = await store.read(source.id);
  const owner = records.find((record) => record.type === 'tool.completed')!;
  const conflict = {
    ...owner,
    recordId: randomUUID(),
    sequence: records.length + 1,
    payload: JSON.parse(
      JSON.stringify(owner.payload).replace(resources[0]!.diff.sha256, 'b'.repeat(64))
    )
  };
  let reads = 0;
  io.read = async (path) => {
    if (path.endsWith('.diff')) reads++;
  };
  await expect(
    prepareToolResultResources(await activeSessionDirectory(home, source.id), [
      ...records,
      conflict
    ])
  ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_RESOURCE_CORRUPT' });
  expect(reads).toBe(0);
});

it.each(['read', 'index'] as const)(
  'does not publish an incomplete fork when resource %s fails',
  async (phase) => {
    const { home, store, source } = await fixture(12);
    const fail = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const failure = new Error('Synthetic resource failure');
    let entered = 0,
      settled = false;
    if (phase === 'read')
      io.read = async (path) => {
        if (!path.endsWith('.diff')) return;
        if (++entered === 1) {
          await fail.promise;
          throw failure;
        }
        await release.promise;
      };
    else
      io.write = async (path) => {
        if (path.endsWith('/tool_results/index.json')) throw failure;
      };
    const copying = store.forkSession(source.id, { boundaryTurnId: 'turn-11', title: 'Branch' });
    const outcome = copying.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    try {
      if (phase === 'read') {
        await vi.waitFor(() => expect(entered).toBeGreaterThan(1));
        fail.resolve();
        await setImmediate();
        expect(settled).toBe(false);
        release.resolve();
      }
      if (phase === 'read')
        await expect(copying).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_RESOURCE_CORRUPT' });
      else await expect(copying).rejects.toBe(failure);
      expect(entered).toBeLessThanOrEqual(8);
      expect((await store.list()).sessions.map((item) => item.id)).toEqual([source.id]);
      const roots = await readdir(join(home, '.mar', 'agent', 'sessions'));
      expect(roots.filter((name) => /^[0-9a-f-]{36}$/u.test(name))).toEqual([source.id]);
    } finally {
      fail.resolve();
      release.resolve();
      await outcome;
    }
  }
);
