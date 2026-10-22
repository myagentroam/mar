import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@myagentroam/protocol';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase } from '../../src/database.js';
import { NodeRequestService } from '../../src/service/node-request-service.js';
import { WorkspaceContentSearchService } from '../../src/service/workspace-content-search-service.js';
import type { WorkspaceFileService } from '../../src/service/workspace-file-service.js';
import { safePublicError } from '../../src/util/safe-error.js';
import { GitCommandError, readGitSummary } from '../../src/workspace.js';

const directories: string[] = [];
const execFile = promisify(execFileCallback);

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('Node Files and Changes fixed operations', () => {
  it('safely creates, moves, and recursively deletes files while rejecting overwrites and descendant moves', async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, 'source'));
    const database = new NodeDatabase(':memory:', 'node-file-mutations');
    const workspace = database.saveWorkspace({ path: root, kind: 'DIRECTORY', gitSummary: null });
    const connector = connectorFor(database);

    await operation(connector, 'workspace.files.mutate', {
      workspaceId: workspace.id,
      action: 'CREATE_DIRECTORY',
      path: 'source/nested'
    });
    await operation(connector, 'workspace.files.mutate', {
      workspaceId: workspace.id,
      action: 'CREATE_FILE',
      path: 'source/nested/a.txt'
    });
    await operation(connector, 'workspace.files.mutate', {
      workspaceId: workspace.id,
      action: 'MOVE',
      path: 'source/nested/a.txt',
      destination: 'source/renamed.txt'
    });
    await expect(readFile(join(root, 'source/renamed.txt'), 'utf8')).resolves.toBe('');
    await expect(
      operation(connector, 'workspace.files.mutate', {
        workspaceId: workspace.id,
        action: 'CREATE_FILE',
        path: 'source/renamed.txt'
      })
    ).rejects.toThrow('FILE_ALREADY_EXISTS');
    await expect(
      operation(connector, 'workspace.files.mutate', {
        workspaceId: workspace.id,
        action: 'MOVE',
        path: 'source',
        destination: 'source/nested/moved'
      })
    ).rejects.toThrow('FILE_MOVE_DESCENDANT_INVALID');
    await expect(
      operation(connector, 'workspace.files.mutate', {
        workspaceId: workspace.id,
        action: 'DELETE',
        path: '.'
      })
    ).rejects.toThrow('FILE_ROOT_MUTATION_INVALID');
    await expect(
      operation(connector, 'workspace.files.mutate', {
        workspaceId: workspace.id,
        action: 'CREATE_FILE',
        path: '../escaped.txt'
      })
    ).rejects.toThrow('FILE_PATH_ESCAPE');
    await writeFile(join(root, 'protected.txt'), 'keep');
    await symlink(join(root, 'protected.txt'), join(root, 'protected-link.txt'));
    await expect(
      operation(connector, 'workspace.files.mutate', {
        workspaceId: workspace.id,
        action: 'DELETE',
        path: 'protected-link.txt'
      })
    ).rejects.toThrow('FILE_PATH_ESCAPE');
    await expect(readFile(join(root, 'protected.txt'), 'utf8')).resolves.toBe('keep');
    await mkdir(join(root, 'actual-directory'));
    await symlink(join(root, 'actual-directory'), join(root, 'linked-directory'), 'dir');
    await expect(
      operation(connector, 'workspace.files.mutate', {
        workspaceId: workspace.id,
        action: 'CREATE_FILE',
        path: 'linked-directory/escaped-create.txt'
      })
    ).rejects.toThrow('FILE_PATH_ESCAPE');
    await writeFile(join(root, 'source', 'first.txt'), 'first');
    await writeFile(join(root, 'source', 'second.txt'), 'second');
    const competingMoves = await Promise.allSettled([
      operation(connector, 'workspace.files.mutate', {
        workspaceId: workspace.id,
        action: 'MOVE',
        path: 'source/first.txt',
        destination: 'source/shared.txt'
      }),
      operation(connector, 'workspace.files.mutate', {
        workspaceId: workspace.id,
        action: 'MOVE',
        path: 'source/second.txt',
        destination: 'source/shared.txt'
      })
    ]);
    expect(competingMoves.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(competingMoves.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await operation(connector, 'workspace.files.mutate', {
      workspaceId: workspace.id,
      action: 'DELETE',
      path: 'source'
    });
    await expect(readFile(join(root, 'source/renamed.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    });
    database.close();
  });

  it('returns the Git failure details for a staged diff without an initial commit', async () => {
    const repository = await temporaryDirectory();
    await git(repository, ['init', '-b', 'main']);
    await writeFile(join(repository, 'staged.txt'), 'pending\n');
    await git(repository, ['add', 'staged.txt']);
    const database = new NodeDatabase(':memory:', 'node-unborn-git-diff');
    const workspace = database.saveWorkspace({
      path: repository,
      kind: 'GIT_WORKSPACE',
      gitSummary: null
    });
    const connector = connectorFor(database);
    await expect(
      operation(connector, 'workspace.changes.current', { workspaceId: workspace.id })
    ).resolves.toMatchObject({
      changes: expect.arrayContaining([expect.objectContaining({ path: 'staged.txt' })])
    });
    const log = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      const failure = await operation(connector, 'workspace.change.diff', {
        workspaceId: workspace.id,
        path: 'staged.txt'
      }).catch((error: unknown) => safePublicError(error, 'INTERNAL_ERROR'));
      expect(failure).toMatchObject({
        code: 'GIT_COMMAND_FAILED',
        parameters: { gitExitCode: 128 },
        details: expect.stringMatching(/fatal: bad revision 'HEAD'/)
      });
      const logged = log.mock.calls.map(([line]) => String(line)).join('');
      expect(logged).toContain('node.command.failed');
      expect(logged).toContain('git diff');
      expect(logged).toContain("bad revision 'HEAD'");
    } finally {
      log.mockRestore();
    }
    database.close();
  });

  it.skipIf(process.platform === 'win32')(
    'does not treat a timed-out untracked Git diff as a successful empty diff',
    async () => {
      const repository = await temporaryDirectory();
      const tools = await temporaryDirectory();
      await git(repository, ['init', '-b', 'main']);
      await writeFile(join(repository, 'untracked.txt'), 'pending\n');
      const realGit = (await execFile('which', ['git'])).stdout.trim();
      const fakeGit = join(tools, 'git');
      await writeFile(
        fakeGit,
        `#!/bin/sh\nif [ "$1" = "diff" ]; then exec sleep 10; fi\nexec '${realGit}' "$@"\n`
      );
      await chmod(fakeGit, 0o755);
      const database = new NodeDatabase(':memory:', 'node-timed-out-git-diff');
      const workspace = database.saveWorkspace({
        path: repository,
        kind: 'GIT_WORKSPACE',
        gitSummary: null
      });
      const connector = connectorFor(database);
      const log = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      vi.stubEnv('PATH', `${tools}${delimiter}${process.env.PATH ?? ''}`);
      try {
        const failure = await operation(connector, 'workspace.change.diff', {
          workspaceId: workspace.id,
          path: 'untracked.txt'
        }).catch((error: unknown) => safePublicError(error, 'INTERNAL_ERROR'));
        expect(failure).toMatchObject({
          code: 'GIT_COMMAND_FAILED',
          details: expect.stringContaining('timed out')
        });
        const output = log.mock.calls.map(([line]) => String(line)).join('');
        expect(output).toContain('"reason":"TIMEOUT"');
      } finally {
        vi.unstubAllEnvs();
        log.mockRestore();
        database.close();
      }
    },
    12_000
  );

  it('bounds Git stderr and preserves the exit code in a public error', () => {
    const failure = safePublicError(
      new GitCommandError(128, `fatal: ${'x'.repeat(1_100)}`),
      'INTERNAL_ERROR'
    );
    expect(failure).toMatchObject({
      code: 'GIT_COMMAND_FAILED',
      details: expect.stringContaining('fatal:'),
      parameters: { gitExitCode: 128 }
    });
    expect(failure.details?.length).toBeLessThanOrEqual(1_000);
  });

  it('records Git diagnostics with the Node request ID', async () => {
    const stderr = "fatal: bad revision 'HEAD'";
    const authorizationIssuedAt = Date.now();
    const response = vi.fn();
    const request = createEnvelope(
      'node.request',
      {
        operation: 'workspace.change.diff',
        data: {},
        userAuthorization: {
          userId: 1,
          sessionHash: 'a'.repeat(43),
          nodeId: 'node-1',
          operation: 'workspace.change.diff',
          requestId: 'git-diff-test',
          issuedAt: authorizationIssuedAt,
          expiresAt: authorizationIssuedAt + 14_000
        }
      },
      { id: 'git-diff-test' }
    );
    const log = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await new NodeRequestService({
        nodeId: () => 'node-1',
        databaseAvailable: () => true,
        execute: async () => {
          throw new GitCommandError(128, stderr);
        },
        send: response
      }).handle(request);
      expect(response).toHaveBeenCalledWith(
        'node.response',
        expect.objectContaining({
          error: 'GIT_COMMAND_FAILED',
          details: stderr,
          parameters: { gitExitCode: 128 }
        }),
        request.id
      );
      const logged = log.mock.calls.map(([line]) => String(line)).join('');
      expect(logged).toContain(stderr);
      expect(logged).toContain(request.id);
    } finally {
      log.mockRestore();
    }
  });

  it('binds a requested direct Range to file size and revision without scanning the full file', async () => {
    const root = await temporaryDirectory();
    const content = Buffer.from('0123456789abcdef', 'utf8');
    await writeFile(join(root, 'payload.bin'), content);
    const database = new NodeDatabase(':memory:', 'node-file-direct-range');
    const workspace = database.saveWorkspace({ path: root, kind: 'DIRECTORY', gitSummary: null });
    const connector = connectorFor(database);

    const metadata = (await operation(connector, 'workspace.file.direct.metadata', {
      workspaceId: workspace.id,
      path: 'payload.bin'
    })) as {
      readonly file: { readonly size: number; readonly revision: string };
    };
    const range = (await operation(connector, 'workspace.file.direct.metadata', {
      workspaceId: workspace.id,
      path: 'payload.bin',
      offset: 4,
      length: 6,
      size: metadata.file.size,
      revision: metadata.file.revision
    })) as {
      readonly file: {
        readonly size: number;
        readonly revision: string;
        readonly range: {
          readonly offset: number;
          readonly length: number;
        };
      };
    };

    expect(metadata.file).toEqual({
      size: content.length,
      revision: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    expect(range.file).toEqual({
      ...metadata.file,
      range: {
        offset: 4,
        length: 6
      }
    });

    database.close();
  });

  it('rejects a direct Range when an equal-size Workspace file changed after metadata was read', async () => {
    const root = await temporaryDirectory();
    const target = join(root, 'payload.bin');
    await writeFile(target, 'first-value');
    const database = new NodeDatabase(':memory:', 'node-file-direct-stale-revision');
    const workspace = database.saveWorkspace({ path: root, kind: 'DIRECTORY', gitSummary: null });
    const connector = connectorFor(database);
    const metadata = (await operation(connector, 'workspace.file.direct.metadata', {
      workspaceId: workspace.id,
      path: 'payload.bin'
    })) as {
      readonly file: { readonly size: number; readonly revision: string };
    };

    await writeFile(target, 'other-value');
    const changedTime = new Date(Date.now() + 5_000);
    await utimes(target, changedTime, changedTime);

    await expect(
      operation(connector, 'workspace.file.direct.metadata', {
        workspaceId: workspace.id,
        path: 'payload.bin',
        offset: 0,
        length: metadata.file.size,
        size: metadata.file.size,
        revision: metadata.file.revision
      })
    ).rejects.toThrow('DIRECT_FILE_REVISION_CHANGED');

    database.close();
  });

  it('binds Git commit metadata and direct Range downloads to the immutable blob identity', async () => {
    const repository = await temporaryDirectory();
    const content = Buffer.from('git-blob-direct-range', 'utf8');
    await git(repository, ['init', '-b', 'main']);
    await git(repository, ['config', 'user.email', 'test@example.invalid']);
    await git(repository, ['config', 'user.name', 'Test']);
    await writeFile(join(repository, 'payload.bin'), content);
    await git(repository, ['add', 'payload.bin']);
    await git(repository, ['commit', '-m', 'base']);
    const commit = (await git(repository, ['rev-parse', 'HEAD'])).trim();
    const database = new NodeDatabase(':memory:', 'node-git-direct-range');
    const workspace = database.saveWorkspace({
      path: repository,
      kind: 'GIT_WORKSPACE',
      gitSummary: null
    });
    const connector = connectorFor(database);
    const resource = {
      kind: 'GIT_COMMIT_BLOB' as const,
      workspaceId: workspace.id,
      commit,
      path: 'payload.bin'
    };
    const metadata = (await operation(connector, 'workspace.git.commit.file.direct.metadata', {
      workspaceId: workspace.id,
      commit,
      path: 'payload.bin'
    })) as {
      readonly file: { readonly size: number; readonly revision: string };
    };
    const offset = 4;
    const length = 7;
    const rangeMetadata = (await operation(connector, 'workspace.git.commit.file.direct.metadata', {
      workspaceId: workspace.id,
      commit,
      path: 'payload.bin',
      offset,
      length,
      size: metadata.file.size,
      revision: metadata.file.revision
    })) as {
      readonly file: {
        readonly size: number;
        readonly revision: string;
        readonly range: {
          readonly offset: number;
          readonly length: number;
        };
      };
    };
    const workbench = (
      connector as unknown as {
        readonly workspaceWorkbenchService: {
          directDownload(descriptor: {
            readonly direction: 'DOWNLOAD';
            readonly resource: typeof resource;
            readonly fileName: string;
            readonly size: number;
            readonly revision: string;
            readonly range: {
              readonly offset: number;
              readonly length: number;
            };
          }): Promise<{ readonly chunks: AsyncIterable<Uint8Array> }>;
        };
      }
    ).workspaceWorkbenchService;
    const download = await workbench.directDownload({
      direction: 'DOWNLOAD',
      resource,
      fileName: 'payload.bin',
      size: metadata.file.size,
      revision: metadata.file.revision,
      range: rangeMetadata.file.range
    });

    expect(metadata.file).toEqual({
      size: content.length,
      revision: createHash('sha256').update(commit).update('\0').update('payload.bin').digest('hex')
    });
    expect(rangeMetadata.file).toEqual({
      ...metadata.file,
      range: {
        offset,
        length
      }
    });
    const chunks: Buffer[] = [];
    for await (const chunk of download.chunks) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(content.subarray(offset, offset + length));

    database.close();
  });

  it('allows ordinary file uploads while the Workspace has an active Run', async () => {
    const root = await temporaryDirectory();
    const database = new NodeDatabase(':memory:', 'node-file-upload-active-run');
    const workspace = database.saveWorkspace({ path: root, kind: 'DIRECTORY', gitSummary: null });
    const connector = connectorFor(database);
    const runtime = (
      connector as unknown as {
        readonly runtime: { hasActiveWorkspaceLease(workspaceId: string): boolean };
      }
    ).runtime;
    vi.spyOn(runtime, 'hasActiveWorkspaceLease').mockReturnValue(true);

    await expect(
      operation(connector, 'workspace.files.upload.create', {
        workspaceId: workspace.id,
        directory: '.',
        name: 'during-run.txt',
        size: 0,
        overwrite: false
      })
    ).resolves.toMatchObject({ upload: { receivedBytes: 0 } });

    database.close();
  });

  it('keeps Composer temporary files outside the Workspace without changing Git excludes', async () => {
    const root = await temporaryDirectory();
    const dataDirectory = await temporaryDirectory();
    await git(root, ['init', '-b', 'main']);
    await writeFile(join(root, '.git', 'info', 'exclude'), '# local\n');
    const database = new NodeDatabase(':memory:', 'node-composer-attachment-git-exclude');
    const localExclude = await readFile(join(root, '.git', 'info', 'exclude'), 'utf8');
    const workspace = database.saveWorkspace({
      path: root,
      kind: 'GIT_WORKSPACE',
      gitSummary: null
    });
    const connector = connectorFor(database, [root], dataDirectory);

    const created = (await operation(connector, 'workspace.files.upload.create', {
      workspaceId: workspace.id,
      name: 'notes.pdf',
      mime: 'application/pdf',
      size: 0,
      overwrite: false,
      composerAttachmentId: '0e6bb0ef-878a-4fc4-ab62-4aedbc5cf678'
    })) as { upload: { uploadId: string } };
    await operation(connector, 'workspace.files.upload.complete', {
      uploadId: created.upload.uploadId
    });
    await expect(
      readFile(
        join(dataDirectory, 'temp-files', '0e6bb0ef-878a-4fc4-ab62-4aedbc5cf678', 'notes.pdf')
      )
    ).resolves.toEqual(Buffer.alloc(0));
    await expect(access(join(root, '.mar'))).rejects.toThrow();
    await expect(readFile(join(root, '.git', 'info', 'exclude'), 'utf8')).resolves.toBe(
      localExclude
    );
    await expect(git(root, ['status', '--porcelain=v1', '--untracked-files=all'])).resolves.toBe(
      ''
    );
    database.close();
  });

  it('saves text using the read revision to prevent overwrites while preserving file permissions', async () => {
    const root = await temporaryDirectory();
    const target = join(root, 'editable.ts');
    await writeFile(target, 'const value = 1;\n', { mode: 0o640 });
    const database = new NodeDatabase(':memory:', 'node-file-write');
    const workspace = database.saveWorkspace({ path: root, kind: 'DIRECTORY', gitSummary: null });
    const connector = connectorFor(database);
    const read = (await operation(connector, 'workspace.file.read', {
      workspaceId: workspace.id,
      path: 'editable.ts'
    })) as { file: { revision: string } };

    const saved = await operation(connector, 'workspace.file.write', {
      workspaceId: workspace.id,
      path: 'editable.ts',
      content: 'const value = 2;\n',
      expectedRevision: read.file.revision
    });
    expect(saved).toMatchObject({ file: { path: 'editable.ts', revision: expect.any(String) } });
    await expect(readFile(target, 'utf8')).resolves.toBe('const value = 2;\n');
    await expect(
      (await import('node:fs/promises')).stat(target).then((value) => value.mode & 0o777)
    ).resolves.toBe(0o640);

    const savedRevision = (saved as { file: { revision: string } }).file.revision;
    const concurrent = await Promise.allSettled([
      operation(connector, 'workspace.file.write', {
        workspaceId: workspace.id,
        path: 'editable.ts',
        content: 'first concurrent value\n',
        expectedRevision: savedRevision
      }),
      operation(connector, 'workspace.file.write', {
        workspaceId: workspace.id,
        path: 'editable.ts',
        content: 'second concurrent value\n',
        expectedRevision: savedRevision
      })
    ]);
    expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === 'rejected')).toHaveLength(1);

    await writeFile(target, 'changed elsewhere\n');
    await expect(
      operation(connector, 'workspace.file.write', {
        workspaceId: workspace.id,
        path: 'editable.ts',
        content: 'stale editor\n',
        expectedRevision: savedRevision
      })
    ).rejects.toThrow('FILE_WRITE_CONFLICT');
    await expect(readFile(target, 'utf8')).resolves.toBe('changed elsewhere\n');
    const changedRevision = createHash('sha256').update('changed elsewhere\n').digest('hex');
    await expect(
      operation(connector, 'workspace.file.write', {
        workspaceId: workspace.id,
        path: 'editable.ts',
        content: 'text with a nul\0byte',
        expectedRevision: changedRevision
      })
    ).rejects.toThrow('FILE_NOT_TEXT');
    await expect(readFile(target, 'utf8')).resolves.toBe('changed elsewhere\n');
    await writeFile(join(root, 'binary.dat'), Buffer.from([0, 1, 2]));
    const binaryRead = (await operation(connector, 'workspace.file.read', {
      workspaceId: workspace.id,
      path: 'binary.dat'
    })) as { file: { revision: string } };
    await expect(
      operation(connector, 'workspace.file.write', {
        workspaceId: workspace.id,
        path: 'binary.dat',
        content: 'text',
        expectedRevision: binaryRead.file.revision
      })
    ).rejects.toThrow('FILE_NOT_TEXT');
    database.close();
  });

  it.each(['workspace.file.read', 'workspace.file.content.read', 'workspace.file.direct.metadata'])(
    'rejects sandbox absolute aliases for explicit repository targets in %s',
    async (name) => {
      const root = await temporaryDirectory();
      const repository = join(root, 'repo');
      await mkdir(repository);
      await git(repository, ['init', '-b', 'main']);
      const outside = join(root, 'outside file.txt');
      await writeFile(outside, 'outside repository');
      await writeFile(join(repository, 'inside.txt'), 'inside repository');
      const database = new NodeDatabase(':memory:', 'node-repository-preview-boundary');
      const workspace = database.saveWorkspace({
        path: repository,
        kind: 'GIT_WORKSPACE',
        gitSummary: null
      });
      const connector = connectorFor(database, [repository]);
      try {
        await expect(
          operation(connector, name, {
            workspaceId: workspace.id,
            repositoryPath: '',
            path: 'inside.txt'
          })
        ).resolves.toMatchObject({ file: { size: 17 } });
        await expect(
          operation(connector, name, {
            workspaceId: workspace.id,
            repositoryPath: '',
            path: `sandbox:${outside.replace(' ', '%20')}`
          })
        ).rejects.toThrow('FILE_PATH_ESCAPE');
      } finally {
        await connector.stop();
      }
    }
  );

  it('supports absolute and sandbox read-only previews outside Node roots without expanding mutations', async () => {
    const temporaryRoot = await temporaryDirectory();
    const workspaceRoot = join(temporaryRoot, 'workspace');
    await mkdir(workspaceRoot);
    const temporaryText = join(temporaryRoot, 'cache note.txt');
    const temporaryImage = join(temporaryRoot, 'cache.png');
    const allowedImage = join(workspaceRoot, 'allowed.png');
    const outsideFile = process.execPath;
    const escapedLink = join(temporaryRoot, 'escaped-link.ts');
    await writeFile(temporaryText, 'temporary preview');
    await writeFile(temporaryImage, Buffer.from([0, 1, 2, 3]));
    await writeFile(allowedImage, Buffer.from([4, 5]));
    await symlink(outsideFile, escapedLink);
    const database = new NodeDatabase(':memory:', 'node-sandbox-file-preview');
    const workspace = database.saveWorkspace({
      path: workspaceRoot,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = connectorFor(database, [workspaceRoot]);

    await expect(
      operation(connector, 'workspace.file.read', {
        workspaceId: workspace.id,
        path: `sandbox:${temporaryText.replace(' ', '%20')}`
      })
    ).resolves.toMatchObject({
      file: {
        path: temporaryText,
        encoding: 'utf-8',
        content: 'temporary preview'
      }
    });
    await expect(
      operation(connector, 'workspace.file.content.read', {
        workspaceId: workspace.id,
        path: `sandbox:${temporaryImage}`
      })
    ).resolves.toMatchObject({
      file: {
        path: temporaryImage,
        size: 4,
        offset: 0,
        contentBase64: Buffer.from([0, 1, 2, 3]).toString('base64'),
        nextOffset: null,
        sourceRevision: expect.stringMatching(/^[a-f0-9]{64}$/u)
      }
    });
    await expect(
      operation(connector, 'workspace.file.content.read', {
        workspaceId: workspace.id,
        path: allowedImage
      })
    ).resolves.toMatchObject({ file: { path: allowedImage, size: 2 } });
    await expect(
      operation(connector, 'workspace.file.content.read', {
        workspaceId: workspace.id,
        path: outsideFile,
        limit: 8
      })
    ).resolves.toMatchObject({ file: { path: outsideFile, offset: 0 } });
    await expect(
      operation(connector, 'workspace.file.content.read', {
        workspaceId: workspace.id,
        path: `sandbox:${escapedLink}`,
        limit: 8
      })
    ).resolves.toMatchObject({ file: { path: outsideFile, offset: 0 } });
    await expect(
      operation(connector, 'workspace.file.content.read', {
        workspaceId: workspace.id,
        path: temporaryRoot
      })
    ).rejects.toThrow('FILE_NOT_REGULAR');
    await expect(
      operation(connector, 'workspace.file.content.read', {
        workspaceId: workspace.id,
        path: join(temporaryRoot, 'missing.png')
      })
    ).rejects.toThrow('FILE_NOT_FOUND');
    await expect(
      operation(connector, 'workspace.files.mutate', {
        workspaceId: workspace.id,
        action: 'DELETE',
        path: temporaryText
      })
    ).rejects.toThrow('FILE_PATH_ESCAPE');
    await expect(readFile(temporaryText, 'utf8')).resolves.toBe('temporary preview');
    if (process.platform !== 'win32') {
      await mkdir(join(workspaceRoot, 'C:'));
      await writeFile(join(workspaceRoot, 'C:', 'foreign.png'), Buffer.from([9]));
      await expect(
        operation(connector, 'workspace.file.content.read', {
          workspaceId: workspace.id,
          path: 'sandbox:C:\\foreign.png'
        })
      ).rejects.toThrow('FILE_PATH_ESCAPE');
    }
    database.close();
  });

  it('writes Admin uploads in chunks, allows only explicit overwrites, and cleans up cancelled temporary files', async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'existing.txt'), 'old');
    const database = new NodeDatabase(':memory:', 'node-file-upload');
    const workspace = database.saveWorkspace({
      path: root,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = connectorFor(database);
    await expect(
      operation(connector, 'workspace.files.upload.preflight', {
        workspaceId: workspace.id,
        directory: '.',
        files: [{ name: 'upload.bin' }, { name: 'existing.txt' }, { name: '../escape' }]
      })
    ).resolves.toMatchObject({
      uploads: [
        { name: 'upload.bin', status: 'READY' },
        { name: 'existing.txt', status: 'EXISTS_FILE' },
        { name: '../escape', status: 'INVALID_NAME' }
      ]
    });
    await expect(
      operation(connector, 'workspace.files.upload.create', {
        workspaceId: workspace.id,
        directory: '.',
        name: 'existing.txt',
        size: 3,
        overwrite: false
      })
    ).rejects.toThrow('UPLOAD_TARGET_EXISTS');
    await expect(
      operation(connector, 'workspace.files.search', {
        workspaceId: workspace.id,
        query: 'upload.bin'
      })
    ).resolves.toMatchObject({ files: { entries: [] } });
    const payload = Buffer.alloc(512 * 1024 + 7, 7);
    const created = (await operation(connector, 'workspace.files.upload.create', {
      workspaceId: workspace.id,
      directory: 'nested',
      name: 'upload.bin',
      size: payload.length,
      overwrite: false
    })) as { readonly upload: { readonly uploadId: string } };
    await expect(
      operation(connector, 'workspace.files.upload.chunk', {
        uploadId: created.upload.uploadId,
        offset: 1,
        dataBase64: payload.subarray(0, 1).toString('base64')
      })
    ).rejects.toThrow('UPLOAD_OFFSET_INVALID');
    await operation(connector, 'workspace.files.upload.chunk', {
      uploadId: created.upload.uploadId,
      offset: 0,
      dataBase64: payload.subarray(0, 512 * 1024).toString('base64')
    });
    await operation(connector, 'workspace.files.upload.chunk', {
      uploadId: created.upload.uploadId,
      offset: 512 * 1024,
      dataBase64: payload.subarray(512 * 1024).toString('base64')
    });
    await operation(connector, 'workspace.files.upload.complete', {
      uploadId: created.upload.uploadId
    });
    await expect(readFile(join(root, 'nested', 'upload.bin'))).resolves.toEqual(payload);
    await expect(
      operation(connector, 'workspace.files.search', {
        workspaceId: workspace.id,
        query: 'upload.bin'
      })
    ).resolves.toMatchObject({
      files: { entries: [expect.objectContaining({ path: 'nested/upload.bin' })] }
    });
    const empty = (await operation(connector, 'workspace.files.upload.create', {
      workspaceId: workspace.id,
      name: 'empty.txt',
      size: 0,
      overwrite: false
    })) as { readonly upload: { readonly uploadId: string } };
    await operation(connector, 'workspace.files.upload.complete', {
      uploadId: empty.upload.uploadId
    });
    await expect(readFile(join(root, 'empty.txt'), 'utf8')).resolves.toBe('');
    const replacement = (await operation(connector, 'workspace.files.upload.create', {
      workspaceId: workspace.id,
      name: 'existing.txt',
      size: 3,
      overwrite: true
    })) as { readonly upload: { readonly uploadId: string } };
    await operation(connector, 'workspace.files.upload.chunk', {
      uploadId: replacement.upload.uploadId,
      offset: 0,
      dataBase64: Buffer.from('new').toString('base64')
    });
    await operation(connector, 'workspace.files.upload.complete', {
      uploadId: replacement.upload.uploadId
    });
    await expect(readFile(join(root, 'existing.txt'), 'utf8')).resolves.toBe('new');
    const cancelled = (await operation(connector, 'workspace.files.upload.create', {
      workspaceId: workspace.id,
      name: 'cancelled.txt',
      size: 1,
      overwrite: false
    })) as { readonly upload: { readonly uploadId: string } };
    await operation(connector, 'workspace.files.upload.cancel', {
      uploadId: cancelled.upload.uploadId
    });
    await expect(readFile(join(root, 'cancelled.txt'))).rejects.toThrow();
    database.close();
  });

  it('allows Admin file paging and search only inside registered Workspaces and does not call Git for ordinary directories', async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested', 'visible.txt'), 'hello');
    await writeFile(
      join(root, 'nested', 'many-matches.txt'),
      Array.from({ length: 25 }, (_, index) => `fallback match ${index}`).join('\n')
    );
    await writeFile(join(root, 'nested', 'invalid-utf8.txt'), Buffer.from([0xff, 0xfe]));
    const database = new NodeDatabase(':memory:', 'node-files');
    const workspace = database.saveWorkspace({
      path: root,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = connectorFor(database, [root]);

    await expect(
      operation(connector, 'workspace.files.list', { workspaceId: workspace.id, limit: 1 })
    ).resolves.toMatchObject({ files: { entries: [expect.any(Object)] } });
    await expect(
      operation(connector, 'workspace.file.read', {
        workspaceId: workspace.id,
        path: 'nested/visible.txt'
      })
    ).resolves.toMatchObject({ file: { content: 'hello', encoding: 'utf-8' } });
    await expect(
      operation(connector, 'workspace.files.search', {
        workspaceId: workspace.id,
        query: 'visible'
      })
    ).resolves.toMatchObject({
      files: { entries: [expect.objectContaining({ path: 'nested/visible.txt' })] }
    });
    await expect(
      operation(connector, 'workspace.files.search', {
        workspaceId: workspace.id,
        query: 'nested',
        includeDirectories: true
      })
    ).resolves.toMatchObject({
      files: {
        entries: expect.arrayContaining([
          expect.objectContaining({ path: 'nested', kind: 'DIRECTORY' })
        ])
      }
    });
    await expect(
      operation(connector, 'workspace.files.search', {
        workspaceId: workspace.id,
        query: 'no-such-file'
      })
    ).resolves.toEqual({ files: { entries: [], nextCursor: null, truncated: false } });
    await expect(
      operation(connector, 'workspace.content.search', {
        workspaceId: workspace.id,
        query: 'HELLO'
      })
    ).resolves.toMatchObject({
      search: {
        matches: [
          expect.objectContaining({
            path: 'nested/visible.txt',
            line: 1,
            column: 1,
            preview: 'hello'
          })
        ],
        engine: expect.stringMatching(/^(RIPGREP|GREP|NODE)$/u),
        truncated: false
      }
    });
    await expect(
      operation(connector, 'workspace.content.search', {
        workspaceId: workspace.id,
        query: 'fallback match'
      })
    ).resolves.toMatchObject({
      search: {
        matches: Array.from({ length: 20 }, (_, index) =>
          expect.objectContaining({
            path: 'nested/many-matches.txt',
            line: index + 1,
            preview: `fallback match ${index}`
          })
        ),
        engine: 'RIPGREP',
        truncated: false
      }
    });
    await expect(
      operation(connector, 'workspace.file.read', {
        workspaceId: workspace.id,
        path: '../outside.txt'
      })
    ).rejects.toThrow('FILE_PATH_ESCAPE');
    await expect(
      operation(connector, 'workspace.changes.current', { workspaceId: workspace.id })
    ).rejects.toThrow('WORKSPACE_NOT_GIT');
    database.close();
  });

  it('updates an initialized Git directory to a Git Workspace on root Files refresh', async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, 'README.md'), 'workspace');
    const database = new NodeDatabase(':memory:', 'node-files-workspace-kind');
    const workspace = database.saveWorkspace({
      path: root,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = connectorFor(database, [root]);
    await git(root, ['init', '-b', 'main']);
    const initialExclude = await readFile(join(root, '.git', 'info', 'exclude'), 'utf8');

    await expect(
      operation(connector, 'workspace.files.list', { workspaceId: workspace.id })
    ).resolves.toMatchObject({
      files: { entries: expect.any(Array) },
      workspace: {
        id: workspace.id,
        path: root,
        kind: 'GIT_WORKSPACE',
        gitSummary: { head: '', branch: 'main' }
      }
    });
    expect(database.getWorkspace(workspace.id)).toMatchObject({
      kind: 'GIT_WORKSPACE',
      gitSummary: { head: '', branch: 'main' }
    });
    await expect(readFile(join(root, '.git', 'info', 'exclude'), 'utf8')).resolves.toBe(
      initialExclude
    );

    await rm(join(root, '.git'), { recursive: true, force: true });
    await expect(
      operation(connector, 'workspace.files.list', { workspaceId: workspace.id })
    ).resolves.toMatchObject({
      workspace: {
        id: workspace.id,
        path: root,
        kind: 'DIRECTORY',
        gitSummary: null
      }
    });
    expect(database.getWorkspace(workspace.id)).toMatchObject({
      kind: 'DIRECTORY',
      gitSummary: null
    });
    database.close();
  });

  it('rejects a root Files refresh when a symlink redirects the registered path to another Workspace', async () => {
    const root = await temporaryDirectory();
    const firstPath = join(root, 'first');
    const secondPath = join(root, 'second');
    await mkdir(firstPath);
    await mkdir(secondPath);
    await writeFile(join(firstPath, 'a.txt'), 'first');
    await writeFile(join(secondPath, 'b.txt'), 'second');
    const database = new NodeDatabase(':memory:', 'node-files-workspace-path-identity');
    const first = database.saveWorkspace({
      path: firstPath,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const second = database.saveWorkspace({
      path: secondPath,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = connectorFor(database, [root]);
    await rm(firstPath, { recursive: true, force: true });
    await symlink(secondPath, firstPath, 'dir');

    await expect(
      operation(connector, 'workspace.files.list', { workspaceId: first.id })
    ).rejects.toThrow('WORKSPACE_NOT_ALLOWED');
    expect(database.getWorkspace(first.id)).toMatchObject({
      id: first.id,
      path: firstPath
    });
    expect(database.getWorkspace(second.id)).toMatchObject({
      id: second.id,
      path: secondPath
    });
    database.close();
  });

  it('invalidates stale Changes cache after root Files refresh changes the Git type', async () => {
    const repository = await temporaryDirectory();
    await git(repository, ['init', '-b', 'main']);
    await git(repository, ['config', 'user.email', 'test@example.invalid']);
    await git(repository, ['config', 'user.name', 'Test']);
    await writeFile(join(repository, 'old.txt'), 'base');
    await git(repository, ['add', 'old.txt']);
    await git(repository, ['commit', '-m', 'base']);
    await writeFile(join(repository, 'old.txt'), 'old change');
    const database = new NodeDatabase(':memory:', 'node-files-git-cache-invalidation');
    const workspace = database.saveWorkspace({
      path: repository,
      kind: 'GIT_WORKSPACE',
      gitSummary: null
    });
    const connector = connectorFor(database, [repository]);

    await expect(
      operation(connector, 'workspace.changes.current', { workspaceId: workspace.id })
    ).resolves.toMatchObject({
      changes: [expect.objectContaining({ path: 'old.txt' })]
    });

    await rm(join(repository, '.git'), { recursive: true, force: true });
    await rm(join(repository, 'old.txt'));
    await operation(connector, 'workspace.files.list', { workspaceId: workspace.id });
    await git(repository, ['init', '-b', 'main']);
    await writeFile(join(repository, 'new.txt'), 'new repository');
    await operation(connector, 'workspace.files.list', { workspaceId: workspace.id });

    const current = (await operation(connector, 'workspace.changes.current', {
      workspaceId: workspace.id
    })) as { readonly changes: readonly { readonly path: string }[] };
    expect(current.changes.map((change) => change.path)).toContain('new.txt');
    expect(current.changes.map((change) => change.path)).not.toContain('old.txt');
    database.close();
  });

  it('ends the native rg process as soon as streaming content search reaches its result limit', async () => {
    const root = await temporaryDirectory();
    const tools = await temporaryDirectory();
    const paths = Array.from({ length: 201 }, (_, index) => `match-${index}.txt`);
    await Promise.all(paths.map((path) => writeFile(join(root, path), 'bounded match')));
    const output = paths
      .map(
        (path) =>
          JSON.stringify({
            type: 'match',
            data: {
              path: { text: path },
              lines: { text: 'bounded match\n' },
              line_number: 1
            }
          }) + '\n'
      )
      .join('');
    const fakeRipgrep = join(tools, 'rg');
    await writeFile(fakeRipgrep, `#!/bin/sh\nprintf '%s' '${output}'\nexec /bin/sleep 30\n`);
    await chmod(fakeRipgrep, 0o755);
    const files = {
      index: () => ({
        contentCandidates: () =>
          Promise.resolve({ entries: paths.map((path) => ({ path })), truncated: false })
      })
    } as unknown as WorkspaceFileService;
    const service = new WorkspaceContentSearchService(files, 'linux', fakeRipgrep);
    const started = Date.now();
    await expect(
      service.search({ id: 'workspace-content-limit', path: root } as never, {
        query: 'bounded match'
      })
    ).resolves.toMatchObject({
      engine: 'RIPGREP',
      truncated: true,
      matches: expect.any(Array)
    });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('logs native search command failures before falling back to Node search', async () => {
    const root = await temporaryDirectory();
    const tools = await temporaryDirectory();
    await writeFile(join(root, 'example.txt'), 'search target');
    const fakeRipgrep = join(tools, 'rg');
    await writeFile(fakeRipgrep, "#!/bin/sh\nprintf 'rg failed' >&2\nexit 3\n");
    await chmod(fakeRipgrep, 0o755);
    const files = {
      index: () => ({
        contentCandidates: () =>
          Promise.resolve({ entries: [{ path: 'example.txt' }], truncated: false })
      })
    } as unknown as WorkspaceFileService;
    const service = new WorkspaceContentSearchService(files, 'linux', fakeRipgrep);
    const log = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await expect(
        service.search({ id: 'search-failure', path: root } as never, {
          query: 'search target'
        })
      ).resolves.toMatchObject({ engine: 'NODE' });
      expect(log.mock.calls.map(([line]) => String(line)).join('')).toContain('rg failed');
    } finally {
      log.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'does not treat a native search killed at its deadline as an empty success',
    async () => {
      const root = await temporaryDirectory();
      const tools = await temporaryDirectory();
      await writeFile(join(root, 'example.txt'), 'search target');
      const fakeRipgrep = join(tools, 'rg');
      await writeFile(
        fakeRipgrep,
        '#!/usr/bin/env node\nprocess.on("SIGTERM", () => process.exit(0)); setTimeout(() => {}, 30_000);\n'
      );
      await chmod(fakeRipgrep, 0o755);
      const files = {
        index: () => ({
          contentCandidates: () =>
            Promise.resolve({ entries: [{ path: 'example.txt' }], truncated: false })
        })
      } as unknown as WorkspaceFileService;
      const service = new WorkspaceContentSearchService(files, 'linux', fakeRipgrep);
      const log = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      try {
        await expect(
          service.search({ id: 'search-timed-out', path: root } as never, {
            query: 'search target'
          })
        ).resolves.toMatchObject({ engine: 'NODE' });
        expect(log.mock.calls.map(([line]) => String(line)).join('')).toContain(
          '"reason":"TIMEOUT"'
        );
      } finally {
        log.mockRestore();
      }
    },
    12_000
  );

  it('records invalid regex status without logging the user search expression', async () => {
    const root = await temporaryDirectory();
    const tools = await temporaryDirectory();
    const fakeRipgrep = join(tools, 'rg');
    await writeFile(fakeRipgrep, '#!/bin/sh\nprintf "private-regex" >&2\nexit 2\n');
    await chmod(fakeRipgrep, 0o755);
    const files = {
      index: () => ({
        contentCandidates: () => Promise.resolve({ entries: [], truncated: false })
      })
    } as unknown as WorkspaceFileService;
    const service = new WorkspaceContentSearchService(files, 'linux', fakeRipgrep);
    const log = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await expect(
        service.search({ id: 'workspace-regex-invalid', path: root } as never, {
          query: 'private-regex',
          regex: true
        })
      ).rejects.toThrow('FILE_CONTENT_SEARCH_INVALID');
      const output = log.mock.calls.map(([line]) => String(line)).join('');
      expect(output).toContain('"reason":"INVALID_QUERY"');
      expect(output).not.toContain('private-regex');
    } finally {
      log.mockRestore();
    }
  });

  it('caps one on-demand content search at 64 MiB before scanning candidate bodies', async () => {
    const root = await temporaryDirectory();
    const tools = await temporaryDirectory();
    const paths = Array.from({ length: 33 }, (_, index) => `large-${index}.txt`);
    await Promise.all(
      paths.map(async (path) => {
        await writeFile(join(root, path), '');
        await truncate(join(root, path), 2 * 1024 * 1024);
      })
    );
    const fakeRipgrep = join(tools, 'rg');
    await writeFile(fakeRipgrep, '#!/bin/sh\nexit 0\n');
    await chmod(fakeRipgrep, 0o755);
    const files = {
      index: () => ({
        contentCandidates: () =>
          Promise.resolve({ entries: paths.map((path) => ({ path })), truncated: false })
      })
    } as unknown as WorkspaceFileService;
    const service = new WorkspaceContentSearchService(files, 'linux', fakeRipgrep);

    await expect(
      service.search({ id: 'workspace-content-byte-limit', path: root } as never, {
        query: 'not-present'
      })
    ).resolves.toMatchObject({
      engine: 'RIPGREP',
      matches: [],
      truncated: true,
      skippedFiles: 0
    });
  });

  it('returns Git Workspace Current Changes with restricted per-file Diff and restore operations', async () => {
    const repository = await temporaryDirectory();
    await git(repository, ['init', '-b', 'main']);
    await git(repository, ['config', 'user.email', 'test@example.invalid']);
    await git(repository, ['config', 'user.name', 'Test']);
    await writeFile(join(repository, 'tracked.txt'), 'base');
    await writeFile(join(repository, 'image.png'), Buffer.from([0, 1, 2]));
    await git(repository, ['add', 'tracked.txt', 'image.png']);
    await git(repository, ['commit', '-m', 'base']);
    await writeFile(join(repository, 'tracked.txt'), 'changed');
    await writeFile(join(repository, 'image.png'), Buffer.from([0, 3, 4]));
    await writeFile(join(repository, 'staged.txt'), 'staged');
    await writeFile(join(repository, 'untracked.txt'), 'untracked');
    await git(repository, ['add', 'staged.txt']);

    const database = new NodeDatabase(':memory:', 'node-git-files');
    const workspace = database.saveWorkspace({
      path: repository,
      kind: 'GIT_WORKSPACE',
      gitSummary: null
    });
    const connector = connectorFor(database);

    await expect(
      operation(connector, 'workspace.changes.current', { workspaceId: workspace.id })
    ).resolves.toMatchObject({
      branch: 'main',
      changes: expect.arrayContaining([
        expect.objectContaining({ path: 'tracked.txt', state: 'UNSTAGED' }),
        expect.objectContaining({ path: 'staged.txt', state: 'STAGED' }),
        expect.objectContaining({
          path: 'untracked.txt',
          state: 'UNTRACKED',
          diffAvailable: true
        })
      ])
    });
    const trackedDiff = await operation(connector, 'workspace.change.diff', {
      workspaceId: workspace.id,
      path: 'tracked.txt'
    });
    expect(trackedDiff).toMatchObject({
      diff: {
        text: expect.stringContaining('-base'),
        afterText: 'changed'
      }
    });
    expect((trackedDiff as { readonly diff: object }).diff).not.toHaveProperty('beforeText');
    await expect(
      operation(connector, 'workspace.change.diff', {
        workspaceId: workspace.id,
        path: 'image.png'
      })
    ).resolves.toMatchObject({
      diff: {
        binary: true
      }
    });
    await expect(
      operation(connector, 'workspace.change.diff', {
        workspaceId: workspace.id,
        path: 'staged.txt'
      })
    ).resolves.toMatchObject({ diff: { binary: false, afterText: 'staged' } });
    await expect(
      operation(connector, 'workspace.change.diff', {
        workspaceId: workspace.id,
        path: 'untracked.txt'
      })
    ).resolves.toMatchObject({
      diff: { binary: false, text: expect.stringContaining('+untracked'), afterText: 'untracked' }
    });
    const runtime = (
      connector as unknown as {
        readonly runtime: { hasActiveWorkspaceLease(workspaceId: string): boolean };
      }
    ).runtime;
    vi.spyOn(runtime, 'hasActiveWorkspaceLease').mockReturnValue(true);
    await expect(
      operation(connector, 'workspace.change.restore', {
        workspaceId: workspace.id,
        path: 'tracked.txt',
        state: 'UNSTAGED'
      })
    ).resolves.toEqual({ restored: true });
    await expect(readFile(join(repository, 'tracked.txt'), 'utf8')).resolves.toBe('base');
    await expect(
      operation(connector, 'workspace.files.search', {
        workspaceId: workspace.id,
        query: 'untracked.txt'
      })
    ).resolves.toMatchObject({
      files: { entries: [expect.objectContaining({ path: 'untracked.txt' })] }
    });
    await expect(
      operation(connector, 'workspace.change.restore', {
        workspaceId: workspace.id,
        path: '../outside.txt',
        state: 'UNSTAGED'
      })
    ).rejects.toThrow('FILE_PATH_ESCAPE');
    await expect(
      operation(connector, 'workspace.change.restore', {
        workspaceId: workspace.id,
        path: 'untracked.txt',
        state: 'UNTRACKED'
      })
    ).resolves.toEqual({ restored: true });
    await expect(readFile(join(repository, 'untracked.txt'), 'utf8')).rejects.toThrow();
    await expect(
      operation(connector, 'workspace.files.search', {
        workspaceId: workspace.id,
        query: 'untracked.txt'
      })
    ).resolves.toMatchObject({ files: { entries: [] } });
    await writeFile(join(repository, '.gitignore'), 'ignored.txt\n');
    await writeFile(join(repository, 'ignored.txt'), 'keep');
    await expect(
      operation(connector, 'workspace.change.restore', {
        workspaceId: workspace.id,
        path: 'ignored.txt',
        state: 'UNTRACKED'
      })
    ).rejects.toThrow('GIT_CHANGE_RESTORE_UNAVAILABLE');
    await expect(readFile(join(repository, 'ignored.txt'), 'utf8')).resolves.toBe('keep');
    database.close();
  });

  it('flattens all worktree file changes and supports Diff, preview, and restore after revalidating the target', async () => {
    const repository = await temporaryDirectory();
    const worktreeParent = await temporaryDirectory();
    const cleanWorktree = join(worktreeParent, 'clean-agent');
    const dirtyWorktree = join(worktreeParent, 'dirty-agent');
    const detachedWorktree = join(worktreeParent, 'detached-agent');
    const prunableWorktree = join(worktreeParent, 'prunable-agent');
    await git(repository, ['init', '-b', 'main']);
    await git(repository, ['config', 'user.email', 'test@example.invalid']);
    await git(repository, ['config', 'user.name', 'Test']);
    await writeFile(join(repository, 'tracked.txt'), 'base\n');
    await git(repository, ['add', 'tracked.txt']);
    await git(repository, ['commit', '-m', 'base']);
    await git(repository, ['worktree', 'add', '-b', 'agent/clean', cleanWorktree]);
    await git(repository, ['worktree', 'add', '-b', 'agent/dirty', dirtyWorktree]);
    await git(repository, ['worktree', 'add', '--detach', detachedWorktree, 'HEAD']);
    await git(repository, ['worktree', 'add', '-b', 'agent/prunable', prunableWorktree]);
    await writeFile(join(dirtyWorktree, 'tracked.txt'), 'changed in linked worktree\n');
    await writeFile(join(dirtyWorktree, 'uncommitted.txt'), 'pending\n');
    await git(repository, ['worktree', 'lock', '--reason', 'active-agent', dirtyWorktree]);
    await rm(prunableWorktree, { recursive: true, force: true });

    const database = new NodeDatabase(':memory:', 'node-worktree-summary');
    const workspace = database.saveWorkspace({
      path: repository,
      kind: 'GIT_WORKSPACE',
      gitSummary: null
    });
    const connector = connectorFor(database);
    const recorder = await createGitCommandRecorder();
    try {
      const current = (await operation(connector, 'workspace.changes.current', {
        workspaceId: workspace.id
      })) as {
        readonly repositories: readonly {
          readonly repositoryPath: string;
          readonly repositoryName: string;
          readonly source?: 'ROOT' | 'SUBMODULE' | 'WORKTREE';
          readonly worktreePath?: string;
          readonly physicalPath?: string;
          readonly current?: boolean;
          readonly status?: 'CLEAN' | 'DIRTY' | 'UNAVAILABLE';
          readonly locked?: boolean;
          readonly prunable?: boolean;
          readonly changes: readonly { readonly path: string; readonly state: string }[];
        }[];
        readonly worktrees: readonly {
          readonly directoryName: string;
          readonly branch: string | null;
          readonly head: string;
          readonly current: boolean;
          readonly status: 'CLEAN' | 'DIRTY' | 'UNAVAILABLE';
          readonly locked: boolean;
          readonly prunable: boolean;
        }[];
        readonly worktreesTruncated: boolean;
      };

      expect(current.worktreesTruncated).toBe(false);
      expect(current.repositories).toHaveLength(5);
      expect(current.repositories).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            repositoryPath: '',
            repositoryName: repository.split(/[/\\]/).at(-1),
            source: 'ROOT',
            physicalPath: repository,
            current: true,
            status: 'CLEAN',
            changes: []
          }),
          expect.objectContaining({
            repositoryPath: '',
            repositoryName: 'clean-agent',
            source: 'WORKTREE',
            worktreePath: cleanWorktree,
            physicalPath: cleanWorktree,
            current: false,
            status: 'CLEAN',
            changes: []
          }),
          expect.objectContaining({
            repositoryPath: '',
            repositoryName: 'dirty-agent',
            source: 'WORKTREE',
            worktreePath: dirtyWorktree,
            physicalPath: dirtyWorktree,
            current: false,
            status: 'DIRTY',
            locked: true,
            changes: expect.arrayContaining([
              expect.objectContaining({ path: 'tracked.txt', state: 'UNSTAGED' }),
              expect.objectContaining({ path: 'uncommitted.txt', state: 'UNTRACKED' })
            ])
          }),
          expect.objectContaining({
            repositoryPath: '',
            repositoryName: 'detached-agent',
            source: 'WORKTREE',
            worktreePath: detachedWorktree,
            physicalPath: detachedWorktree,
            current: false,
            status: 'CLEAN'
          }),
          expect.objectContaining({
            repositoryPath: '',
            repositoryName: 'prunable-agent',
            source: 'WORKTREE',
            worktreePath: prunableWorktree,
            physicalPath: prunableWorktree,
            current: false,
            status: 'UNAVAILABLE',
            prunable: true,
            changes: []
          })
        ])
      );
      expect(current.worktrees).toHaveLength(5);
      expect(current.worktrees).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            directoryName: repository.split(/[/\\]/).at(-1),
            branch: 'main',
            current: true,
            status: 'CLEAN',
            locked: false,
            prunable: false
          }),
          expect.objectContaining({
            directoryName: 'clean-agent',
            branch: 'agent/clean',
            current: false,
            status: 'CLEAN'
          }),
          expect.objectContaining({
            directoryName: 'dirty-agent',
            branch: 'agent/dirty',
            current: false,
            status: 'DIRTY',
            locked: true
          }),
          expect.objectContaining({
            directoryName: 'detached-agent',
            branch: null,
            head: expect.stringMatching(/^[0-9a-f]{40,64}$/),
            current: false,
            status: 'CLEAN'
          }),
          expect.objectContaining({
            directoryName: 'prunable-agent',
            branch: 'agent/prunable',
            current: false,
            status: 'UNAVAILABLE',
            prunable: true
          })
        ])
      );
      expect(JSON.stringify(current)).toContain(cleanWorktree);
      expect(JSON.stringify(current)).toContain(dirtyWorktree);
      expect(JSON.stringify(current)).toContain(prunableWorktree);

      const commands = await recorder.read();
      expect(
        commands.filter((command) => command.arguments === 'worktree list --porcelain -z')
      ).toHaveLength(1);
      expect(
        commands.filter(
          (command) =>
            command.arguments ===
            'status --porcelain=v1 -z --branch --ahead-behind --untracked-files=all'
        )
      ).toHaveLength(4);
      expect(commands.every((command) => command.optionalLocks === '0')).toBe(true);

      await recorder.clear();
      await expect(
        operation(connector, 'workspace.change.diff', {
          workspaceId: workspace.id,
          worktreePath: dirtyWorktree,
          path: 'tracked.txt'
        })
      ).resolves.toMatchObject({
        diff: {
          afterText: 'changed in linked worktree\n',
          text: expect.stringContaining('+changed in linked worktree')
        }
      });
      await expect(
        operation(connector, 'workspace.file.read', {
          workspaceId: workspace.id,
          worktreePath: dirtyWorktree,
          path: 'uncommitted.txt',
          offset: 0,
          limit: 512
        })
      ).resolves.toMatchObject({
        file: { path: 'uncommitted.txt', encoding: 'utf-8', content: 'pending\n' }
      });
      await expect(
        operation(connector, 'workspace.file.content.read', {
          workspaceId: workspace.id,
          worktreePath: dirtyWorktree,
          path: 'uncommitted.txt',
          offset: 0,
          limit: 512
        })
      ).resolves.toMatchObject({
        file: {
          path: 'uncommitted.txt',
          contentBase64: Buffer.from('pending\n').toString('base64')
        }
      });
      await expect(
        operation(connector, 'workspace.file.read', {
          workspaceId: workspace.id,
          worktreePath: dirtyWorktree,
          path: join(dirtyWorktree, 'tracked.txt')
        })
      ).rejects.toThrow('FILE_PATH_ESCAPE');
      await expect(
        operation(connector, 'workspace.change.restore', {
          workspaceId: workspace.id,
          worktreePath: dirtyWorktree,
          path: 'tracked.txt',
          state: 'UNSTAGED'
        })
      ).resolves.toEqual({ restored: true });
      await expect(readFile(join(dirtyWorktree, 'tracked.txt'), 'utf8')).resolves.toBe('base\n');
      await expect(
        operation(connector, 'workspace.change.restore', {
          workspaceId: workspace.id,
          worktreePath: dirtyWorktree,
          path: 'uncommitted.txt',
          state: 'UNTRACKED'
        })
      ).resolves.toEqual({ restored: true });
      await expect(readFile(join(dirtyWorktree, 'uncommitted.txt'), 'utf8')).rejects.toThrow();

      const unregisteredWorktree = join(worktreeParent, 'not-registered');
      await expect(
        operation(connector, 'workspace.change.diff', {
          workspaceId: workspace.id,
          worktreePath: unregisteredWorktree,
          path: 'tracked.txt'
        })
      ).rejects.toThrow('GIT_REPOSITORY_INVALID');
      await expect(
        operation(connector, 'workspace.file.read', {
          workspaceId: workspace.id,
          worktreePath: unregisteredWorktree,
          path: 'tracked.txt'
        })
      ).rejects.toThrow('GIT_REPOSITORY_INVALID');
      const operationCommands = await recorder.read();
      // Absolute file paths fail before Git lookup; the seven relative targets still revalidate membership.
      expect(
        operationCommands.filter((command) => command.arguments === 'worktree list --porcelain -z')
          .length
      ).toBeGreaterThanOrEqual(7);
    } finally {
      recorder.restore();
      database.close();
    }
  });

  it('falls back to newline worktree porcelain when an old Git rejects -z with a language-independent usage error', async () => {
    const repository = await temporaryDirectory();
    const worktreeParent = await temporaryDirectory();
    const linkedWorktree = join(worktreeParent, 'linked-agent');
    await git(repository, ['init', '-b', 'main']);
    await git(repository, ['config', 'user.email', 'test@example.invalid']);
    await git(repository, ['config', 'user.name', 'Test']);
    await writeFile(join(repository, 'tracked.txt'), 'base\n');
    await git(repository, ['add', 'tracked.txt']);
    await git(repository, ['commit', '-m', 'base']);
    await git(repository, ['worktree', 'add', '-b', 'agent/linked', linkedWorktree]);
    await writeFile(join(linkedWorktree, 'tracked.txt'), 'changed in linked worktree\n');

    const database = new NodeDatabase(':memory:', 'node-worktree-legacy-porcelain');
    const workspace = database.saveWorkspace({
      path: repository,
      kind: 'GIT_WORKSPACE',
      gitSummary: null
    });
    const connector = connectorFor(database);
    const recorder = await createGitCommandRecorder({ rejectWorktreeListNull: true });
    try {
      await expect(
        operation(connector, 'workspace.changes.current', { workspaceId: workspace.id })
      ).resolves.toMatchObject({
        repositories: expect.arrayContaining([
          expect.objectContaining({ source: 'ROOT', physicalPath: repository }),
          expect.objectContaining({
            source: 'WORKTREE',
            physicalPath: linkedWorktree,
            status: 'DIRTY',
            changes: [expect.objectContaining({ path: 'tracked.txt', state: 'UNSTAGED' })]
          })
        ])
      });
      const commands = await recorder.read();
      expect(
        commands.filter((command) => command.arguments === 'worktree list --porcelain -z')
      ).toHaveLength(1);
      expect(
        commands.filter((command) => command.arguments === 'worktree list --porcelain')
      ).toHaveLength(1);
    } finally {
      recorder.restore();
      database.close();
    }
  });

  it('discovers recursive submodules once and does not repeat status for child-repository Changes and History', async () => {
    const commit = (cwd: string, ...args: string[]) =>
      git(cwd, [
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'user.name=Test',
        'commit',
        ...args
      ]);
    const repository = await temporaryDirectory();
    const submoduleSource = await temporaryDirectory();
    const nestedSubmoduleSource = await temporaryDirectory();
    await git(nestedSubmoduleSource, ['init', '-b', 'main']);
    await writeFile(join(nestedSubmoduleSource, 'nested.txt'), 'nested-base');
    await git(nestedSubmoduleSource, ['add', 'nested.txt']);
    await commit(nestedSubmoduleSource, '-m', 'nested base');

    await git(submoduleSource, ['init', '-b', 'main']);
    await writeFile(join(submoduleSource, 'child.txt'), 'child-base');
    await git(submoduleSource, ['add', 'child.txt']);
    await commit(submoduleSource, '-m', 'child base');
    await git(submoduleSource, [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      nestedSubmoduleSource,
      'deps/nested'
    ]);
    await commit(submoduleSource, '-am', 'add nested');

    await git(repository, ['init', '-b', 'main']);
    await writeFile(join(repository, 'root.txt'), 'root-base');
    await git(repository, ['add', 'root.txt']);
    await commit(repository, '-m', 'root base');
    await git(repository, [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      submoduleSource,
      'modules/child'
    ]);
    await commit(repository, '-am', 'add child');
    await git(repository, [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'update',
      '--init',
      '--recursive'
    ]);

    await writeFile(join(repository, 'root.txt'), 'root-changed');
    await writeFile(join(repository, 'modules', 'child', 'child.txt'), 'child-changed');
    await writeFile(join(repository, 'modules', 'child', 'untracked.txt'), 'untracked');
    await writeFile(
      join(repository, 'modules', 'child', 'deps', 'nested', 'nested.txt'),
      'nested-changed'
    );

    const database = new NodeDatabase(':memory:', 'node-multi-repo-changes');
    const workspace = database.saveWorkspace({
      path: repository,
      kind: 'GIT_WORKSPACE',
      gitSummary: null
    });
    const connector = connectorFor(database);
    const recorder = await createGitCommandRecorder();
    let current: {
      readonly repositories: readonly {
        readonly repositoryPath: string;
        readonly repositoryName: string;
        readonly changes: readonly { readonly path: string }[];
      }[];
    };
    try {
      current = (await operation(connector, 'workspace.changes.current', {
        workspaceId: workspace.id
      })) as typeof current;
      const changeCommands = await recorder.read();
      expect(
        changeCommands.filter((command) => command.arguments === 'ls-files --stage -z')
      ).toHaveLength(3);
      expect(
        changeCommands.filter(
          (command) =>
            command.arguments ===
            'status --porcelain=v1 -z --branch --ahead-behind --untracked-files=all'
        )
      ).toHaveLength(3);
      expect(changeCommands.every((command) => command.optionalLocks === '0')).toBe(true);
      expect(
        changeCommands.some((command) => command.arguments === 'rev-parse --git-common-dir')
      ).toBe(false);

      await recorder.clear();
      await expect(
        operation(connector, 'workspace.git.refs.list', {
          workspaceId: workspace.id,
          repositoryPath: 'modules/child/deps/nested'
        })
      ).resolves.toMatchObject({
        refs: expect.arrayContaining([expect.objectContaining({ name: 'refs/heads/main' })])
      });
      await expect(
        operation(connector, 'workspace.git.history.list', {
          workspaceId: workspace.id,
          repositoryPath: 'modules/child/deps/nested',
          limit: 1
        })
      ).resolves.toMatchObject({ commits: [expect.objectContaining({ subject: 'nested base' })] });
      const historyCommands = await recorder.read();
      expect(historyCommands.every((command) => command.optionalLocks === '0')).toBe(true);
      expect(historyCommands.some((command) => command.arguments.startsWith('status '))).toBe(
        false
      );
      expect(
        historyCommands.some((command) => command.arguments === 'submodule status --recursive')
      ).toBe(false);
      expect(
        historyCommands.filter(
          (command) =>
            command.arguments === 'rev-parse --show-toplevel --show-superproject-working-tree'
        )
      ).toHaveLength(4);
      expect(
        historyCommands.some(
          (command) =>
            command.arguments.includes('log --topo-order') &&
            command.arguments.includes(' --branches --remotes --')
        )
      ).toBe(true);

      await recorder.clear();
      await expect(readGitSummary(repository)).resolves.toMatchObject({ branch: 'main' });
      const summaryCommands = await recorder.read();
      expect(
        summaryCommands.filter((command) => command.arguments.startsWith('status '))
      ).toHaveLength(1);
      expect(summaryCommands.every((command) => command.optionalLocks === '0')).toBe(true);
    } finally {
      recorder.restore();
    }

    expect(current.repositories.map((item) => item.repositoryPath)).toEqual([
      '',
      'modules/child',
      'modules/child/deps/nested'
    ]);
    expect(current.repositories.map((item) => item.repositoryName)).toEqual([
      repository.split('/').at(-1),
      'child',
      'nested'
    ]);
    expect(current.repositories[0]?.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'root.txt' }),
        expect.objectContaining({ path: 'modules/child' })
      ])
    );
    expect(current.repositories[1]?.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'child.txt', state: 'UNSTAGED' }),
        expect.objectContaining({ path: 'untracked.txt', state: 'UNTRACKED' })
      ])
    );
    expect(current.repositories[2]?.changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'nested.txt', state: 'UNSTAGED' })])
    );

    await expect(
      operation(connector, 'workspace.change.diff', {
        workspaceId: workspace.id,
        repositoryPath: 'modules/child',
        path: 'child.txt'
      })
    ).resolves.toMatchObject({ diff: { afterText: 'child-changed' } });
    await expect(
      operation(connector, 'workspace.change.restore', {
        workspaceId: workspace.id,
        repositoryPath: 'modules/child',
        path: 'child.txt',
        state: 'UNSTAGED'
      })
    ).resolves.toEqual({ restored: true });
    await expect(readFile(join(repository, 'modules', 'child', 'child.txt'), 'utf8')).resolves.toBe(
      'child-base'
    );
    await expect(
      operation(connector, 'workspace.change.restore', {
        workspaceId: workspace.id,
        repositoryPath: 'modules/child',
        path: 'untracked.txt',
        state: 'UNTRACKED'
      })
    ).resolves.toEqual({ restored: true });
    await expect(
      operation(connector, 'workspace.change.diff', {
        workspaceId: workspace.id,
        repositoryPath: 'not-a-submodule',
        path: 'root.txt'
      })
    ).rejects.toThrow('GIT_REPOSITORY_INVALID');
    if (process.platform !== 'win32') {
      await symlink('modules/child', join(repository, 'child-alias'), 'dir');
      await expect(
        operation(connector, 'workspace.git.refs.list', {
          workspaceId: workspace.id,
          repositoryPath: 'child-alias'
        })
      ).rejects.toThrow('GIT_REPOSITORY_INVALID');
    }
    database.close();
  });
});

function connectorFor(
  database: NodeDatabase,
  allowedRoots?: readonly string[],
  dataDirectory?: string
): NodeConnector {
  return new NodeConnector({
    reconnect: false,
    database,
    ...(allowedRoots === undefined && dataDirectory === undefined
      ? {}
      : {
          config: {
            serverUrl: 'http://server.test',
            allowedRoots: allowedRoots ?? [],
            ...(dataDirectory === undefined ? {} : { dataDirectory })
          }
        }),
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
  const path = await mkdtemp(join(tmpdir(), 'my-agent-roam-files-'));
  directories.push(path);
  return path;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFile('git', args, { cwd });
  return result.stdout;
}

async function createGitCommandRecorder(
  options: { readonly rejectWorktreeListNull?: boolean } = {}
): Promise<{
  read(): Promise<readonly { optionalLocks: string; arguments: string }[]>;
  clear(): Promise<void>;
  restore(): void;
}> {
  const directory = await temporaryDirectory();
  const logPath = join(directory, 'commands.log');
  const executablePath = join(directory, process.platform === 'win32' ? 'git.cmd' : 'git');
  const lookup = await execFile(process.platform === 'win32' ? 'where.exe' : 'which', ['git']);
  const realGit = lookup.stdout
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0)
    ?.trim();
  if (realGit === undefined) throw new Error('GIT_NOT_FOUND');
  await writeFile(logPath, '');
  await writeFile(
    executablePath,
    process.platform === 'win32'
      ? [
          '@echo off',
          'if not "%MAR_GIT_RECORDING%"=="1" (',
          '  >>"%MAR_GIT_RECORD_LOG%" echo %GIT_OPTIONAL_LOCKS%\t%*',
          '  set MAR_GIT_RECORDING=1',
          ')',
          'if "%MAR_GIT_REJECT_WORKTREE_LIST_NULL%"=="1" if "%~1"=="worktree" if "%~2"=="list" if "%~3"=="--porcelain" if "%~4"=="-z" (',
          '  >&2 echo error: unsupported flag z',
          '  exit /b 129',
          ')',
          '"%MAR_REAL_GIT%" %*'
        ].join('\r\n')
      : [
          '#!/bin/sh',
          'if [ "${MAR_GIT_RECORDING:-}" != "1" ]; then',
          '  printf "%s\\t%s\\n" "${GIT_OPTIONAL_LOCKS:-}" "$*" >> "$MAR_GIT_RECORD_LOG"',
          '  export MAR_GIT_RECORDING=1',
          'fi',
          'if [ "${MAR_GIT_REJECT_WORKTREE_LIST_NULL:-}" = "1" ] && [ "$1" = "worktree" ] && [ "$2" = "list" ] && [ "$3" = "--porcelain" ] && [ "$4" = "-z" ]; then',
          '  printf "%s\\n" "error: unsupported flag z" >&2',
          '  exit 129',
          'fi',
          'exec "$MAR_REAL_GIT" "$@"'
        ].join('\n')
  );
  if (process.platform !== 'win32') await chmod(executablePath, 0o755);
  const previous = {
    PATH: process.env['PATH'],
    MAR_REAL_GIT: process.env['MAR_REAL_GIT'],
    MAR_GIT_RECORD_LOG: process.env['MAR_GIT_RECORD_LOG'],
    MAR_GIT_REJECT_WORKTREE_LIST_NULL: process.env['MAR_GIT_REJECT_WORKTREE_LIST_NULL']
  };
  process.env['PATH'] = [directory, previous.PATH].filter(Boolean).join(delimiter);
  process.env['MAR_REAL_GIT'] = realGit;
  process.env['MAR_GIT_RECORD_LOG'] = logPath;
  if (options.rejectWorktreeListNull === true)
    process.env['MAR_GIT_REJECT_WORKTREE_LIST_NULL'] = '1';
  else delete process.env['MAR_GIT_REJECT_WORKTREE_LIST_NULL'];
  const restoreValue = (name: keyof typeof previous): void => {
    const value = previous[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  return {
    async read() {
      return (await readFile(logPath, 'utf8'))
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .map((line) => {
          const separator = line.indexOf('\t');
          return {
            optionalLocks: separator < 0 ? '' : line.slice(0, separator),
            arguments: separator < 0 ? line : line.slice(separator + 1)
          };
        });
    },
    async clear() {
      await writeFile(logPath, '');
    },
    restore() {
      restoreValue('PATH');
      restoreValue('MAR_REAL_GIT');
      restoreValue('MAR_GIT_RECORD_LOG');
    }
  };
}
