import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareJsonlV2Generation } from '../../src/session/store/jsonl/jsonl-migration.js';
import { JsonlSessionStore } from '../../src/session/store/jsonl/jsonl-store.js';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('JSONL v2 generation preparation', () => {
  it('forks a v1 source without migrating it and creates a v2 target', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-v1-fork-'));
    temporary.push(home);
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const turnId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const base = join(home, '.mar/agent/sessions');
    const root = join(base, id);
    await mkdir(root, { recursive: true });
    const common = { schemaVersion: 1, timestamp: '2026-10-27T00:00:00.000Z', sessionId: id };
    const records = [
      {
        ...common,
        recordId: '11111111-1111-4111-8111-111111111111',
        sequence: 1,
        type: 'session.created',
        payload: {}
      },
      {
        ...common,
        recordId: '22222222-2222-4222-8222-222222222222',
        sequence: 2,
        turnId,
        type: 'turn.user',
        payload: { prompt: 'hello' }
      }
    ];
    const original = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
    await writeFile(join(root, 'events-000001.jsonl'), original);
    await writeFile(
      join(base, 'index.json'),
      JSON.stringify({
        version: 1,
        revision: 1,
        sessions: [
          {
            id,
            title: 'old',
            workspace: '/workspace',
            createdAt: common.timestamp,
            lastActivityAt: common.timestamp,
            nextSequence: 3
          }
        ]
      })
    );
    const store = await JsonlSessionStore.open(home);
    const child = await store.forkSession(id, { boundaryTurnId: turnId, title: 'fork' });
    const index = JSON.parse(await readFile(join(base, 'index.json'), 'utf8'));
    expect(
      index.sessions.find((session: { id: string }) => session.id === id).storage.encoding
    ).toBe(1);
    expect(
      index.sessions.find((session: { id: string }) => session.id === child.id).storage.encoding
    ).toBe(2);
    expect(await readFile(join(root, 'events-000001.jsonl'), 'utf8')).toBe(original);
    expect((await store.read(child.id)).map((record) => record.type)).toEqual([
      'session.created',
      'turn.user'
    ]);
    await store.close();
  });
  it('deletes a v1 session without migrating its discarded history', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-v1-delete-'));
    temporary.push(home);
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const base = join(home, '.mar/agent/sessions');
    const root = join(base, id);
    await mkdir(root, { recursive: true });
    const metadata = {
      id,
      title: 'old',
      workspace: '/workspace',
      createdAt: '2026-10-27T00:00:00.000Z',
      lastActivityAt: '2026-10-27T00:00:00.000Z',
      nextSequence: 2
    };
    await writeFile(
      join(base, 'index.json'),
      JSON.stringify({ version: 1, revision: 1, sessions: [metadata] })
    );
    // Deliberately corrupt history: delete must not depend on the migration decoder.
    await writeFile(join(root, 'events-000001.jsonl'), 'not-a-json-record\n');
    const store = await JsonlSessionStore.open(home);
    await store.delete(id);
    await expect(readFile(join(root, 'events-000001.jsonl'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    expect(JSON.parse(await readFile(join(base, 'index.json'), 'utf8')).sessions).toEqual([]);
    await store.close();
  });
  it('clears a v1 session directly to v2 and removes the original history and fixed images', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-v1-clear-'));
    temporary.push(home);
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const base = join(home, '.mar/agent/sessions');
    const sessionRoot = join(base, id);
    await mkdir(join(sessionRoot, 'generated_images'), { recursive: true });
    await mkdir(join(sessionRoot, 'resources'));
    const created = {
      schemaVersion: 1,
      recordId: '11111111-1111-4111-8111-111111111111',
      sequence: 1,
      timestamp: '2026-10-27T00:00:00.000Z',
      sessionId: id,
      type: 'session.created',
      payload: {}
    };
    await writeFile(join(sessionRoot, 'events-000001.jsonl'), JSON.stringify(created) + '\n');
    await writeFile(join(sessionRoot, 'generated_images', 'old.png'), 'private-image');
    await writeFile(join(sessionRoot, 'resources', `${'a'.repeat(64)}.bin`), 'private-input');
    await writeFile(
      join(base, 'index.json'),
      JSON.stringify({
        version: 1,
        revision: 1,
        sessions: [
          {
            id,
            title: 'old',
            workspace: '/workspace',
            source: { type: 'user' },
            createdAt: created.timestamp,
            lastActivityAt: created.timestamp,
            nextSequence: 2
          }
        ]
      })
    );
    const store = await JsonlSessionStore.open(home);
    await store.clearSession(id);
    const index = JSON.parse(await readFile(join(base, 'index.json'), 'utf8'));
    expect(index.sessions[0].storage.encoding).toBe(2);
    expect((await store.read(id)).map((record) => record.type)).toEqual(['session.created']);
    await expect(readFile(join(sessionRoot, 'events-000001.jsonl'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    await expect(readFile(join(sessionRoot, 'generated_images', 'old.png'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    await expect(
      readFile(join(sessionRoot, 'resources', `${'a'.repeat(64)}.bin`))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await store.close();
  });
  it('fences the root and lazily switches only the written v1 Session', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-v1-store-'));
    temporary.push(home);
    const sessions = join(home, '.mar/agent/sessions');
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const root = join(sessions, id);
    await mkdir(root, { recursive: true });
    const fixture = fileURLToPath(new URL('../fixtures/jsonl-v1/records.jsonl', import.meta.url));
    const original = await readFile(fixture, 'utf8');
    await writeFile(join(root, 'events-000001.jsonl'), original);
    const metadata = {
      id,
      title: 'Example',
      workspace: '/workspace',
      createdAt: '2026-10-27T00:00:00.000Z',
      lastActivityAt: '2026-10-27T00:00:00.000Z',
      nextSequence: 4
    };
    const rawIndex = JSON.stringify({ version: 1, revision: 7, sessions: [metadata] });
    await writeFile(join(sessions, 'index.json'), rawIndex);
    let store = await JsonlSessionStore.open(home);
    expect(await readFile(join(sessions, 'index.json'), 'utf8')).toBe(rawIndex);
    expect((await store.read(id)).map((record) => record.sequence)).toEqual([1, 2, 3]);
    await store.getSession(id);
    await store.userTurnCount(id);
    await store.firstUserMessagePreview(id);
    await store.close();
    expect(await readFile(join(sessions, 'index.json'), 'utf8')).toBe(rawIndex);
    store = await JsonlSessionStore.open(home);
    await store.append(id, { type: 'turn.user', payload: { prompt: 'after migration' } });
    const index = JSON.parse(await readFile(join(sessions, 'index.json'), 'utf8'));
    expect(index.version).toBe(2);
    expect(index.sessions[0].storage.encoding).toBe(2);
    expect(await readFile(join(root, 'events-000001.jsonl'), 'utf8')).toBe(original);
    expect((await store.read(id)).map((record) => record.sequence)).toEqual([1, 2, 3, 4]);
    await store.close();
  });
  it('preserves repeated legacy sequences within and across segments when migrating and resuming', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-v1-repeated-sequences-'));
    temporary.push(home);
    const sessions = join(home, '.mar/agent/sessions');
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const root = join(sessions, id);
    await mkdir(root, { recursive: true });
    const timestamp = '2026-10-27T00:00:00.000Z';
    const records = [1, 2, 2, 2, 3].map((sequence, index) => ({
      recordId: `legacy-record-${index}`,
      sequence,
      timestamp,
      sessionId: id,
      type: index === 0 ? 'session.created' : 'turn.user',
      payload:
        index === 0
          ? { title: 'Legacy', workspace: '/workspace' }
          : { prompt: `legacy input ${index}` }
    }));
    const originals = [records.slice(0, 3), records.slice(3)].map(
      (segment) =>
        segment.map((record) => JSON.stringify({ schemaVersion: 1, ...record })).join('\n') + '\n'
    );
    for (const [index, original] of originals.entries())
      await writeFile(join(root, `events-${String(index + 1).padStart(6, '0')}.jsonl`), original);
    await writeFile(
      join(sessions, 'index.json'),
      JSON.stringify({
        version: 1,
        revision: 1,
        sessions: [
          {
            id,
            title: 'Legacy',
            workspace: '/workspace',
            createdAt: timestamp,
            lastActivityAt: timestamp,
            nextSequence: 4
          }
        ]
      })
    );
    let store = await JsonlSessionStore.open(home);
    try {
      expect(await store.read(id)).toEqual(records);
      await store.append(id, { type: 'turn.user', payload: { prompt: 'after migration' } });
      const index = JSON.parse(await readFile(join(sessions, 'index.json'), 'utf8'));
      expect(index.sessions[0].storage.encoding).toBe(2);
      const migrated = await store.read(id);
      expect(migrated.slice(0, records.length)).toEqual(records);
      expect(migrated.map((record) => record.sequence)).toEqual([1, 2, 2, 2, 3, 4]);
      for (const [index, original] of originals.entries())
        expect(
          await readFile(join(root, `events-${String(index + 1).padStart(6, '0')}.jsonl`), 'utf8')
        ).toBe(original);
      await store.close();
      store = await JsonlSessionStore.open(home);
      expect(await store.read(id)).toEqual(migrated);
      await store.append(id, { type: 'turn.user', payload: { prompt: 'after reopening' } });
      expect((await store.read(id)).map((record) => record.sequence)).toEqual([
        1, 2, 2, 2, 3, 4, 5
      ]);
    } finally {
      await store.close();
    }
  });
  it('creates and appends logical records directly to a selected v2 generation', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-v2-store-'));
    temporary.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace: '/workspace' });
    await store.append(session.id, { type: 'turn.user', payload: { prompt: 'hello' } });
    const index = JSON.parse(await readFile(join(home, '.mar/agent/sessions/index.json'), 'utf8'));
    expect(index.version).toBe(2);
    expect(index.sessions[0].storage.encoding).toBe(2);
    const path = join(
      home,
      '.mar/agent/sessions',
      session.id,
      'v2',
      index.sessions[0].storage.generation,
      'events-000001.jsonl'
    );
    const lines = (await readFile(path, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => !('schemaVersion' in line))).toBe(true);
    expect((await store.read(session.id)).map((record) => record.sequence)).toEqual([1, 2]);
    await store.close();
  });
  it('preserves logical identities, segments and private resource bytes without modifying the v1 source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-jsonl-migration-'));
    temporary.push(root);
    const source = join(root, 'source');
    const destination = join(root, 'generation');
    await mkdir(source);
    const fixture = fileURLToPath(new URL('../fixtures/jsonl-v1/records.jsonl', import.meta.url));
    const original = await readFile(fixture, 'utf8');
    await writeFile(join(source, 'events-000001.jsonl'), original);
    await mkdir(join(source, 'resources'));
    await writeFile(join(source, 'resources', `${'a'.repeat(64)}.bin`), 'image');
    await writeFile(join(source, 'context-world-state.json'), '{"version":1}');

    const result = await prepareJsonlV2Generation({
      source,
      destination,
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      nextSequence: 4
    });
    const encoded = await readFile(join(destination, 'events-000001.jsonl'), 'utf8');
    const records = encoded
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records.map((record) => record.sequence)).toEqual([1, 2, 3]);
    expect(records.every((record) => !('schemaVersion' in record))).toBe(true);
    expect(records[0].payload.images[0]).not.toHaveProperty('fileName');
    expect(result.segments).toEqual([
      { number: 1, firstSequence: 1, lastSequence: 3, bytes: Buffer.byteLength(encoded) }
    ]);
    expect(await readFile(join(source, 'events-000001.jsonl'), 'utf8')).toBe(original);
    expect(await readFile(join(destination, 'resources', `${'a'.repeat(64)}.bin`), 'utf8')).toBe(
      'image'
    );
    expect(await readFile(join(destination, 'context-world-state.json'), 'utf8')).toBe(
      '{"version":1}'
    );
  });

  it('rejects a history identity mismatch without changing the v1 source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-jsonl-migration-'));
    temporary.push(root);
    const source = join(root, 'source');
    await mkdir(source);
    const fixture = fileURLToPath(new URL('../fixtures/jsonl-v1/records.jsonl', import.meta.url));
    const original = await readFile(fixture, 'utf8');
    await writeFile(join(source, 'events-000001.jsonl'), original);
    await expect(
      prepareJsonlV2Generation({
        source,
        destination: join(root, 'generation'),
        sessionId: 'wrong',
        nextSequence: 4
      })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_CORRUPT' });
    expect(await readFile(join(source, 'events-000001.jsonl'), 'utf8')).toBe(original);
  });
});
