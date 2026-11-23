import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserProfiles } from '../../src/browser/browser-profiles.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const DAY = 24 * 60 * 60_000;
const scope = { workspaceId: 'workspace-one', userId: 1 };
let root: string;
let today: number;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mar-browser-retention-'));
  today = DAY;
});
afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

function profiles(isUnused = vi.fn(async () => false)) {
  return new BrowserProfiles({
    root: join(root, 'profiles'),
    isUnused,
    now: () => today,
    failed: (error) => {
      throw error;
    }
  });
}

describe('Browser persistent profiles', () => {
  it('can retry initial creation after failing to publish the retention marker', async () => {
    const store = profiles();
    const error = Object.assign(new Error('Disk full'), { code: 'ENOSPC' });
    vi.mocked(rename).mockRejectedValueOnce(error);

    await expect(store.acquire(scope)).rejects.toBe(error);
    expect(await readdir(join(root, 'profiles'))).toEqual([]);

    const profile = await store.acquire(scope);
    await profile.release();
    expect(await store.inspect(scope)).toEqual(expect.any(String));
  });

  it('does not remove an existing Profile when updating its retention marker fails', async () => {
    const store = profiles();
    const profile = await store.acquire(scope);
    await writeFile(join(profile.path, 'site-data'), 'retained data');
    await profile.release();
    const id = await store.inspect(scope);
    const error = Object.assign(new Error('Disk full'), { code: 'ENOSPC' });
    vi.mocked(rename).mockRejectedValueOnce(error);

    await expect(store.acquire(scope)).rejects.toBe(error);
    expect(await store.inspect(scope)).toBe(id);
    const retry = await store.acquire(scope);
    expect(await readFile(join(retry.path, 'site-data'), 'utf8')).toBe('retained data');
    await retry.release();
  });

  it('preserves active and unrelated profiles and expires each closed scope after 30 days', async () => {
    const store = profiles();
    const first = await store.acquire(scope);
    await writeFile(join(first.path, 'site-data'), 'test data');
    await first.release();
    const other = await store.acquire({ ...scope, workspaceId: 'workspace-two' });
    const anotherUser = await store.acquire({ ...scope, userId: 2 });
    expect(new Set([first.path, other.path, anotherUser.path]).size).toBe(3);
    await writeFile(join(other.path, 'site-data'), 'other data');
    today += 30 * DAY - 1;
    await store.sweep();
    expect(await readFile(join(first.path, 'site-data'), 'utf8')).toBe('test data');
    today++;
    await store.sweep();
    expect(await readFile(join(other.path, 'site-data'), 'utf8')).toBe('other data');
    await expect(readFile(join(first.path, 'site-data'))).rejects.toMatchObject({ code: 'ENOENT' });
    const replacement = await store.acquire(scope);
    expect(replacement.path).toBe(first.path);
    await expect(readFile(join(replacement.path, 'site-data'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('reconciles an orphan only after the deployment reports no owner, without deleting it at first sight', async () => {
    const abandoned = await profiles().acquire(scope);
    await writeFile(join(abandoned.path, 'site-data'), 'recoverable');
    const isUnused = vi.fn(async () => false);
    const restarted = profiles(isUnused);
    today += 40 * DAY;
    await restarted.sweep();
    await expect(restarted.acquire(scope)).rejects.toThrow('BROWSER_PROFILE_BUSY');
    isUnused.mockResolvedValue(true);
    await restarted.sweep();
    expect(await readFile(join(abandoned.path, 'site-data'), 'utf8')).toBe('recoverable');
    today += 30 * DAY;
    await restarted.sweep();
    await expect(readFile(join(abandoned.path, 'site-data'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('does not follow unknown profile entries or data directory links', async () => {
    const store = profiles();
    const retained = await store.acquire(scope);
    await retained.release();
    const outside = join(root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'site-data'), 'outside data');
    await rm(retained.path, { recursive: true });
    await symlink(outside, retained.path, 'junction');
    const unknown = join(dirname(dirname(retained.path)), 'a'.repeat(64));
    await mkdir(unknown);
    await writeFile(join(unknown, 'unknown-data'), 'unrecognized');
    today += 30 * DAY;
    await store.sweep();
    expect(await readFile(join(outside, 'site-data'), 'utf8')).toBe('outside data');
    expect(await readFile(join(unknown, 'unknown-data'), 'utf8')).toBe('unrecognized');
    await expect(store.acquire(scope)).rejects.toThrow('BROWSER_PROFILE_INVALID');
  });
});
