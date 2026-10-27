import { appendFile, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import { activeSessionDirectory } from '../support/jsonl-session-path.js';

const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'mar-history-pagination-'));
  homes.push(home);
  const store = await JsonlSessionStore.open(home);
  const session = await store.createSession({ workspace: home });
  const path = join(await activeSessionDirectory(home, session.id), 'events-000001.jsonl');
  return { store, session, path };
}

describe('Session history pagination', () => {
  it('seeks sequential pages without repeatedly decoding records newer than the cursor', async () => {
    const { store, session, path } = await fixture();
    try {
      const base = (await store.read(session.id))[0]!;
      await appendFile(
        path,
        Array.from({ length: 5000 }, (_, index) =>
          JSON.stringify({ ...base, sequence: index + 2, payload: { text: '界'.repeat(100) } })
        ).join('\n') + '\n'
      );
      const parse = vi.spyOn(JSON, 'parse');
      const sequences: number[] = [];
      let beforeSequence: number | undefined;
      do {
        const page = await store.readPage(session.id, { limit: 250, beforeSequence });
        sequences.unshift(...page.records.map((record) => record.sequence));
        beforeSequence = page.previousBeforeSequence;
      } while (beforeSequence !== undefined);
      const decoded = parse.mock.results.filter(
        (result) => result.type === 'return' && result.value?.sessionId === session.id
      ).length;
      expect(sequences).toEqual(Array.from({ length: 5001 }, (_, index) => index + 1));
      expect(decoded).toBeLessThan(5100);
    } finally {
      await store.close();
    }
  });

  it('uses an arbitrary cursor between cached page boundaries without gaps', async () => {
    const { store, session } = await fixture();
    try {
      for (let index = 0; index < 30; index++)
        await store.append(session.id, { type: 'test', payload: { index } });
      await store.readPage(session.id, { limit: 5 });
      await store.readPage(session.id, { limit: 5, beforeSequence: 27 });
      const page = await store.readPage(session.id, { limit: 5, beforeSequence: 24 });
      expect(page.records.map((record) => record.sequence)).toEqual([19, 20, 21, 22, 23]);
      expect(page.previousBeforeSequence).toBe(19);
    } finally {
      await store.close();
    }
  });

  it('invalidates byte positions after an append and a same-size file replacement', async () => {
    const { store, session, path } = await fixture();
    try {
      for (let index = 0; index < 20; index++)
        await store.append(session.id, { type: 'test', payload: { text: `record-${index}` } });
      const first = await store.readPage(session.id, { limit: 5 });
      await store.append(session.id, { type: 'test', payload: { text: 'appended' } });
      expect((await store.readPage(session.id, { limit: 1 })).records[0]?.sequence).toBe(22);
      await store.readPage(session.id, { limit: 5 });
      const content = await readFile(path, 'utf8');
      const records = content
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line));
      for (const record of records)
        if (record.payload?.text?.startsWith('record-'))
          record.payload.text = record.payload.text.replace('record-', 'change-');
      records[11].payload.text += 'x'.repeat(9);
      records[19].payload.text = '';
      const replacement = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
      expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(content));
      await writeFile(`${path}.replacement`, replacement);
      await rename(`${path}.replacement`, path);
      const older = await store.readPage(session.id, {
        limit: 5,
        beforeSequence: first.previousBeforeSequence
      });
      expect(older.records.map((record) => record.sequence)).toEqual([12, 13, 14, 15, 16]);
      expect(older.records.map((record) => record.payload)).toEqual(
        Array.from({ length: 5 }, (_, index) => ({
          text: `change-${index + 10}${index === 0 ? 'x'.repeat(9) : ''}`
        }))
      );
    } finally {
      await store.close();
    }
  });

  it('keeps paging correct after offset eviction and history truncation', async () => {
    const { store, session, path } = await fixture();
    try {
      const base = (await store.read(session.id))[0]!;
      await appendFile(
        path,
        Array.from({ length: 300 }, (_, index) =>
          JSON.stringify({ ...base, sequence: index + 2, payload: { index } })
        ).join('\n') + '\n'
      );
      let beforeSequence: number | undefined;
      const sequences: number[] = [];
      do {
        const page = await store.readPage(session.id, { limit: 1, beforeSequence });
        sequences.unshift(...page.records.map((record) => record.sequence));
        beforeSequence = page.previousBeforeSequence;
      } while (beforeSequence !== undefined);
      expect(sequences).toEqual(Array.from({ length: 301 }, (_, index) => index + 1));
      expect(
        (await store.readPage(session.id, { beforeSequence: 300, limit: 2 })).records.map(
          (record) => record.sequence
        )
      ).toEqual([298, 299]);
      const lines = (await readFile(path, 'utf8')).trimEnd().split('\n');
      await writeFile(path, lines.slice(0, 100).join('\n') + '\n');
      expect(
        (await store.readPage(session.id, { beforeSequence: 90, limit: 2 })).records.map(
          (record) => record.sequence
        )
      ).toEqual([88, 89]);
    } finally {
      await store.close();
    }
  });
});
