import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { preflightV1Session } from '../../src/session/store/jsonl/jsonl-admission.js';
import { repairSegmentTail } from '../../src/session/store/jsonl/records.js';

const directories: string[] = [];
async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mar-jsonl-admission-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

const record = {
  schemaVersion: 1,
  recordId: 'record-1',
  sequence: 1,
  timestamp: '2026-10-27T00:00:00.000Z',
  sessionId: 'session-1',
  type: 'turn.user',
  payload: { prompt: 'hello' }
};

describe('v1 migration version admission', () => {
  it('rejects a complete future-version tail without touching it', async () => {
    const directory = await fixture();
    const path = join(directory, 'events-000001.jsonl');
    const raw = `${JSON.stringify(record)}\n${JSON.stringify({ ...record, schemaVersion: 2 })}`;
    await writeFile(path, raw);
    await expect(preflightV1Session(directory)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_VERSION_UNSUPPORTED'
    });
    expect(await readFile(path, 'utf8')).toBe(raw);
    await expect(repairSegmentTail(path)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_VERSION_UNSUPPORTED'
    });
    expect(await readFile(path, 'utf8')).toBe(raw);
  });

  it('allows a syntactically incomplete tail for the existing recovery protocol', async () => {
    const directory = await fixture();
    const raw = `${JSON.stringify(record)}\n{"schemaVersion":`;
    const path = join(directory, 'events-000001.jsonl');
    await writeFile(path, raw);
    await expect(preflightV1Session(directory)).resolves.toBeUndefined();
    expect(await readFile(path, 'utf8')).toBe(raw);
  });

  it('rejects an unsupported version in a recovery staging segment', async () => {
    const directory = await fixture();
    const name = 'events-000001.jsonl.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.rollback-tmp';
    await writeFile(join(directory, name), JSON.stringify({ ...record, schemaVersion: 3 }));
    await expect(preflightV1Session(directory)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_VERSION_UNSUPPORTED'
    });
  });

  it.each(['rollback', 'clear'])(
    'rejects a future-version %s backup before recovery can restore it',
    async (kind) => {
      const directory = await fixture();
      const canonical = join(directory, 'events-000001.jsonl');
      const backup = `${canonical}.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.${kind}-backup`;
      const original = JSON.stringify(record);
      const future = JSON.stringify({ ...record, schemaVersion: 3 });
      await writeFile(canonical, original);
      await writeFile(backup, future);
      await expect(preflightV1Session(directory)).rejects.toMatchObject({
        code: 'MAR_AGENT_SESSION_VERSION_UNSUPPORTED'
      });
      expect(await readFile(canonical, 'utf8')).toBe(original);
      expect(await readFile(backup, 'utf8')).toBe(future);
    }
  );

  it('rejects future resource metadata in transaction trash before recovery', async () => {
    const directory = await fixture();
    const resources = join(directory, 'resources');
    await mkdir(resources);
    const path = join(
      resources,
      `.${'a'.repeat(64)}.json.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.rollback-trash`
    );
    const future = JSON.stringify({ resourceInputVersion: 2 });
    await writeFile(path, future);
    await expect(preflightV1Session(directory)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_VERSION_UNSUPPORTED'
    });
    expect(await readFile(path, 'utf8')).toBe(future);
  });

  it('rejects future journal and GC checkpoint versions before recovery', async () => {
    const directory = await fixture();
    const journal = join(directory, 'storage-transaction.json');
    await writeFile(journal, JSON.stringify({ version: 2 }));
    await expect(preflightV1Session(directory)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_VERSION_UNSUPPORTED'
    });
    await rm(journal);
    await writeFile(
      join(directory, 'events-000001.jsonl'),
      JSON.stringify({ ...record, type: 'context.gc.completed', payload: { version: 2 } })
    );
    await expect(preflightV1Session(directory)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_VERSION_UNSUPPORTED'
    });
  });

  it('rejects future inline-media and image resource versions before recovery', async () => {
    const directory = await fixture();
    const path = join(directory, 'events-000001.jsonl');
    await writeFile(
      path,
      JSON.stringify({
        ...record,
        type: 'compact.completed',
        payload: { inlineMediaState: { version: 2 } }
      })
    );
    await expect(preflightV1Session(directory)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_VERSION_UNSUPPORTED'
    });
    await rm(path);
    await mkdir(join(directory, 'resources'));
    await writeFile(
      join(directory, 'resources', `${'a'.repeat(64)}.json`),
      JSON.stringify({ resourceInputVersion: 2 })
    );
    await expect(preflightV1Session(directory)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_VERSION_UNSUPPORTED'
    });
  });

  it('checks both world-state envelope and nested state versions', async () => {
    const directory = await fixture();
    const path = join(directory, 'context-world-state.json');
    await writeFile(path, JSON.stringify({ version: 2, state: { version: 2 } }));
    await expect(preflightV1Session(directory)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_VERSION_UNSUPPORTED'
    });
    await writeFile(path, JSON.stringify({ version: 1, state: { version: 3 } }));
    await expect(preflightV1Session(directory)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_VERSION_UNSUPPORTED'
    });
    await writeFile(path, JSON.stringify({ version: 1, state: { version: 2 } }));
    await expect(preflightV1Session(directory)).resolves.toBeUndefined();
  });
});
