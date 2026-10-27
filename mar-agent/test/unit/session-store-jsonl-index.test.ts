import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  prepareSessionIndexCommit,
  readSessionIndex,
  upgradeSessionIndex
} from '../../src/session/store/jsonl/directory-index.js';
import type { SessionIndex } from '../../src/session/store/types.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const meta = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  title: 'session',
  workspace: '/workspace',
  createdAt: '2026-01-01',
  lastActivityAt: '2026-01-01',
  nextSequence: 4
};

describe('JSONL index v2 admission', () => {
  it('marks legacy entries without changing revision, and prevents dirty metadata from reverting an active generation', () => {
    const old: SessionIndex = { version: 1, revision: 7, sessions: [meta] };
    const fenced = upgradeSessionIndex(old);
    expect(fenced).toMatchObject({
      version: 2,
      revision: 7,
      sessions: [{ ...meta, storage: { encoding: 1 } }]
    });
    expect(old).toEqual({ version: 1, revision: 7, sessions: [meta] });
    const disk: SessionIndex = {
      ...fenced,
      sessions: [
        {
          ...fenced.sessions[0]!,
          storage: { encoding: 2, generation: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }
        }
      ]
    };
    const merged = prepareSessionIndexCommit(
      disk,
      fenced,
      new Map([[meta.id, 1]]),
      new Set(),
      undefined,
      []
    );
    expect(merged.version).toBe(2);
    expect(merged.sessions[0]?.storage).toEqual({
      encoding: 2,
      generation: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    });
  });

  it('rejects future index versions without changing the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mar-index-version-'));
    directories.push(dir);
    const path = join(dir, 'index.json');
    const raw = JSON.stringify({ version: 3, revision: 1, sessions: [] });
    await writeFile(path, raw);
    await expect(readSessionIndex(path)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_VERSION_UNSUPPORTED'
    });
    expect(await readFile(path, 'utf8')).toBe(raw);
  });
});
