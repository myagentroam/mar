import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase } from '../../src/database.js';

const directories: string[] = [];
const execFile = promisify(execFileCallback);

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('Node Files and Changes fixed-operation handling', () => {
  it('Git Changes preserve deleted files while exposing read-only History, commit files, and Diff', async () => {
    const repository = await temporaryDirectory();
    await git(repository, ['init', '-b', 'main']);
    await git(repository, ['config', 'user.email', 'test@example.invalid']);
    await git(repository, ['config', 'user.name', 'Test']);
    await writeFile(join(repository, 'deleted.txt'), 'before\n');
    await writeFile(join(repository, 'history.png'), Buffer.from([0, 10]));
    await git(repository, ['add', 'deleted.txt', 'history.png']);
    await git(repository, ['commit', '-m', 'root commit']);
    const rootCommit = (await git(repository, ['rev-parse', 'HEAD'])).trim();
    await git(repository, ['branch', 'feature']);
    await writeFile(join(repository, 'second.txt'), 'second\n');
    await writeFile(join(repository, 'history.png'), Buffer.from([0, 11]));
    await git(repository, ['add', 'second.txt', 'history.png']);
    await git(repository, ['commit', '-m', 'second commit']);
    const secondCommit = (await git(repository, ['rev-parse', 'HEAD'])).trim();
    await git(repository, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    await rm(join(repository, 'deleted.txt'));

    const database = new NodeDatabase(':memory:', 'node-git-history');
    const workspace = database.saveWorkspace({
      path: repository,
      kind: 'GIT_WORKSPACE',
      gitSummary: null
    });
    const connector = connectorFor(database);

    await expect(
      operation(connector, 'workspace.git.fetch', {
        workspaceId: workspace.id,
        repositoryPath: ''
      })
    ).resolves.toEqual({ fetchFailed: false, updated: false });

    await expect(
      operation(connector, 'workspace.changes.current', { workspaceId: workspace.id })
    ).resolves.toMatchObject({
      changes: expect.arrayContaining([
        expect.objectContaining({ path: 'deleted.txt', state: 'UNSTAGED', change: 'DELETED' })
      ])
    });
    await expect(
      operation(connector, 'workspace.change.diff', {
        workspaceId: workspace.id,
        path: 'deleted.txt'
      })
    ).resolves.toMatchObject({ diff: { text: expect.stringContaining('-before'), afterText: '' } });

    const refs = (await operation(connector, 'workspace.git.refs.list', {
      workspaceId: workspace.id
    })) as { readonly refs: readonly { readonly name: string; readonly kind: string }[] };
    expect(refs.refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'refs/heads/main', kind: 'LOCAL' }),
        expect.objectContaining({ name: 'refs/heads/feature', kind: 'LOCAL' }),
        expect.objectContaining({ name: 'refs/remotes/origin/main', kind: 'REMOTE' })
      ])
    );
    const history = (await operation(connector, 'workspace.git.history.list', {
      workspaceId: workspace.id,
      refs: ['refs/heads/main'],
      limit: 1
    })) as { readonly commits: readonly { readonly hash: string }[]; readonly nextCursor: string };
    expect(history.commits).toEqual([expect.objectContaining({ hash: secondCommit })]);
    const older = (await operation(connector, 'workspace.git.history.list', {
      workspaceId: workspace.id,
      refs: ['refs/heads/main'],
      cursor: history.nextCursor,
      limit: 1
    })) as { readonly commits: readonly { readonly hash: string }[] };
    expect(older.commits).toEqual([expect.objectContaining({ hash: rootCommit })]);
    await writeFile(join(repository, 'third.txt'), 'third\n');
    await git(repository, ['add', 'third.txt']);
    await git(repository, ['commit', '-m', 'control \x1e marker']);
    await expect(
      operation(connector, 'workspace.git.history.list', {
        workspaceId: workspace.id,
        refs: ['refs/heads/main'],
        cursor: history.nextCursor,
        limit: 1
      })
    ).rejects.toThrow('GIT_HISTORY_CURSOR_INVALID');
    await expect(
      operation(connector, 'workspace.git.history.list', {
        workspaceId: workspace.id,
        refs: ['refs/heads/main'],
        limit: 1
      })
    ).resolves.toMatchObject({
      commits: [expect.objectContaining({ subject: 'control \x1e marker' })]
    });
    await expect(
      operation(connector, 'workspace.git.history.list', {
        workspaceId: workspace.id,
        cursor: 1
      })
    ).rejects.toThrow('GIT_HISTORY_CURSOR_INVALID');
    await expect(
      operation(connector, 'workspace.git.commit.files', {
        workspaceId: workspace.id,
        commit: rootCommit,
        refs: ['refs/heads/main']
      })
    ).resolves.toMatchObject({
      files: expect.arrayContaining([
        expect.objectContaining({ path: 'deleted.txt', change: 'ADDED' })
      ])
    });
    await expect(
      operation(connector, 'workspace.git.commit.file.diff', {
        workspaceId: workspace.id,
        commit: rootCommit,
        path: 'deleted.txt',
        refs: ['refs/heads/main']
      })
    ).resolves.toMatchObject({ diff: { text: expect.stringContaining('+before') } });
    await expect(
      operation(connector, 'workspace.git.commit.file.diff', {
        workspaceId: workspace.id,
        commit: secondCommit,
        path: 'history.png',
        refs: ['refs/heads/main']
      })
    ).resolves.toMatchObject({
      diff: {
        binary: true
      }
    });
    await expect(
      operation(connector, 'workspace.git.commit.file.content.read', {
        workspaceId: workspace.id,
        commit: secondCommit,
        path: 'history.png',
        refs: ['refs/heads/main'],
        offset: 1,
        limit: 1
      })
    ).resolves.toEqual({
      file: {
        path: 'history.png',
        size: 2,
        offset: 1,
        contentBase64: Buffer.from([11]).toString('base64'),
        nextOffset: null
      }
    });
    await expect(
      operation(connector, 'workspace.git.history.list', {
        workspaceId: workspace.id,
        refs: ['refs/heads/missing']
      })
    ).rejects.toThrow('GIT_HISTORY_REF_INVALID');
    database.close();
  });
});

function connectorFor(database: NodeDatabase, allowedRoots?: readonly string[]): NodeConnector {
  return new NodeConnector({
    reconnect: false,
    database,
    ...(allowedRoots === undefined
      ? {}
      : { config: { serverUrl: 'http://server.test', allowedRoots } }),
    capabilities: {
      platform: 'linux',
      architecture: 'x64',
      nodeVersion: process.version,
      codex: { available: false },
      claudeCode: { available: false }
    }
  });
}

function operation(connector: NodeConnector, name: string, data: unknown): Promise<unknown> {
  return (
    connector as unknown as {
      executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
    }
  ).executeNodeOperation(name, data);
}

async function temporaryDirectory(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'my-agent-roam-files-')));
  directories.push(path);
  return path;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFile('git', args, { cwd });
  return result.stdout;
}
