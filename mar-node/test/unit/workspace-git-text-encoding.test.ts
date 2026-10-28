import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readCurrentChangeDiff,
  readGitHistoryFileDiff,
  readRestrictedDiff
} from '../../src/workspace/git.js';

const directories: string[] = [];
const execFile = promisify(execFileCallback);

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('workspace Git diff text encoding', () => {
  it('keeps a tracked legacy-encoded current patch and omits lossy after text', async () => {
    const repository = await createRepository();
    const path = 'legacy.txt';
    await writeFile(join(repository, path), Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]));
    await commitAll(repository, 'add legacy file');
    await writeFile(join(repository, path), Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a]));

    const expectedPatch = await git(repository, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      'HEAD',
      '--',
      `:(literal)${path}`
    ]);
    const diff = await readCurrentChangeDiff(repository, path);

    expect(expectedPatch).toContain('diff --git');
    expect(diff).toMatchObject({ binary: false, text: expectedPatch, truncated: false });
    expect(diff).not.toHaveProperty('afterText');
    expect(diff).not.toHaveProperty('afterTruncated');
  });

  it('keeps an untracked legacy-encoded current patch and omits lossy after text', async () => {
    const repository = await createRepository();
    const path = 'untracked-legacy.txt';
    await writeFile(join(repository, path), Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]));

    const expectedPatch = await git(
      repository,
      ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', '/dev/null', path],
      true
    );
    const diff = await readCurrentChangeDiff(repository, path);

    expect(expectedPatch).toContain('diff --git');
    expect(diff).toMatchObject({ binary: false, text: expectedPatch, truncated: false });
    expect(diff).not.toHaveProperty('afterText');
    expect(diff).not.toHaveProperty('afterTruncated');
  });

  it('returns Git’s native history patch for a legacy-encoded file', async () => {
    const repository = await createRepository();
    const path = 'history-legacy.txt';
    await writeFile(join(repository, path), Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]));
    const commit = await commitAll(repository, 'add legacy history file');

    const expectedPatch = await git(repository, [
      'show',
      '--format=',
      '--first-parent',
      '--no-ext-diff',
      '--no-textconv',
      commit,
      '--',
      `:(literal)${path}`
    ]);
    const diff = await readGitHistoryFileDiff(repository, commit, path);

    expect(expectedPatch).toContain('diff --git');
    expect(diff).toEqual({ binary: false, text: expectedPatch, truncated: false });
  });

  it('classifies a NUL-containing current patch as binary', async () => {
    const repository = await createRepository();
    const path = 'nul.bin';
    await writeFile(join(repository, path), Buffer.from([0x62, 0x65, 0x66, 0x00, 0x0a]));
    await commitAll(repository, 'add NUL-containing file');
    await writeFile(join(repository, path), Buffer.from([0x61, 0x66, 0x74, 0x00, 0x0a]));

    const expectedPatch = await git(repository, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      'HEAD',
      '--',
      `:(literal)${path}`
    ]);
    const diff = await readCurrentChangeDiff(repository, path);

    expect(expectedPatch).toContain('Binary files ');
    expect(diff).toMatchObject({ binary: true, truncated: false });
    expect(diff).toHaveProperty('summary');
    expect(diff).not.toHaveProperty('text');
    expect(diff).not.toHaveProperty('afterText');
  });

  it('keeps Git’s binary marker for a text file configured with -diff', async () => {
    const repository = await createRepository();
    const path = 'forced-binary.txt';
    await writeFile(join(repository, '.gitattributes'), `${path} -diff\n`);
    await writeFile(join(repository, path), 'before\n');
    await commitAll(repository, 'add file with diff disabled');
    await writeFile(join(repository, path), 'after\n');

    const expectedPatch = await git(repository, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      'HEAD',
      '--',
      `:(literal)${path}`
    ]);
    const diff = await readCurrentChangeDiff(repository, path);

    expect(expectedPatch).toContain('Binary files ');
    expect(diff).toMatchObject({ binary: true, truncated: false });
    expect(diff).toHaveProperty('summary');
    expect(diff).not.toHaveProperty('text');
  });

  it('does not interpret binary-marker words inside patch content as a binary result', async () => {
    const repository = await createRepository();
    const path = 'source.c';
    await writeFile(join(repository, path), '// before\n');
    const baseline = await commitAll(repository, 'add source');
    await writeFile(join(repository, path), '// Binary files a and b differ\n');
    const commit = await commitAll(repository, 'add diagnostic comment');
    const history = await readGitHistoryFileDiff(repository, commit, path);
    expect(history.binary).toBe(false);
    expect(history.text).toContain('+// Binary files a and b differ');
    expect(await readRestrictedDiff(repository, baseline, commit)).toMatchObject({
      binary: false,
      text: history.text
    });
    await writeFile(join(repository, path), '// Binary files c and d differ\n');
    const current = await readCurrentChangeDiff(repository, path);
    expect(current.binary).toBe(false);
    expect(current.text).toContain('+// Binary files c and d differ');
  });

  it('honors a Git text diff attribute even when the patch contains NUL bytes', async () => {
    const repository = await createRepository();
    const path = 'forced-text.data';
    await writeFile(join(repository, '.gitattributes'), `${path} diff\n`);
    await writeFile(join(repository, path), Buffer.from('before\0\n'));
    const baseline = await commitAll(repository, 'add forced text file');
    await writeFile(join(repository, path), Buffer.from('after\0\n'));
    const current = await readCurrentChangeDiff(repository, path);
    expect(current).toMatchObject({
      binary: false,
      text: await git(repository, [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        'HEAD',
        '--',
        `:(literal)${path}`
      ])
    });
    expect(current).not.toHaveProperty('afterText');
    const commit = await commitAll(repository, 'update forced text file');
    const history = await readGitHistoryFileDiff(repository, commit, path);
    expect(history.binary).toBe(false);
    expect(history.text).toContain('+after\0');
    expect(await readRestrictedDiff(repository, baseline, commit)).toMatchObject({
      binary: false,
      text: history.text
    });
  });

  it('uses Git newline boundaries rather than Unicode text separators for binary markers', async () => {
    const repository = await createRepository();
    const path = 'source.c';
    const content = '// comment\u2028Binary files a and b differ\u2029end\n';
    await writeFile(join(repository, path), content);
    const current = await readCurrentChangeDiff(repository, path);
    expect(current.binary).toBe(false);
    expect(current.text).toContain(`+${content}`);
  });
});

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), 'mar-workspace-git-encoding-'));
  directories.push(repository);
  await git(repository, ['init', '--quiet']);
  await git(repository, ['config', 'user.name', 'MAR Test']);
  await git(repository, ['config', 'user.email', 'mar-test@example.invalid']);
  await git(repository, ['commit', '--quiet', '--allow-empty', '-m', 'baseline']);
  return repository;
}

async function commitAll(repository: string, message: string): Promise<string> {
  await git(repository, ['add', '--all']);
  await git(repository, ['commit', '--quiet', '-m', message]);
  return (await git(repository, ['rev-parse', 'HEAD'])).trim();
}

async function git(repository: string, args: string[], allowExitCodeOne = false): Promise<string> {
  try {
    const result = await execFile('git', args, { cwd: repository, encoding: 'utf8' });
    return result.stdout;
  } catch (error) {
    const failure = error as { readonly code?: number; readonly stdout?: string };
    if (allowExitCodeOne && failure.code === 1) return failure.stdout ?? '';
    throw error;
  }
}
