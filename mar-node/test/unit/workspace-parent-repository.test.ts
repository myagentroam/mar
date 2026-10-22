import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeConnector } from '../../src/connector.js';
import {
  migrate,
  NODE_SCHEMA_MIGRATIONS,
  NodeDatabase,
  type NodeWorkspace
} from '../../src/database.js';
import { NodeWorkspaceCoordinator } from '../../src/service/node-workspace-coordinator.js';
import { updateWorkspaceSkillGitExclude } from '../../src/service/workspace-git-exclude-service.js';
import * as gitExclude from '../../src/service/workspace-git-exclude-service.js';
import * as workspaceModule from '../../src/workspace.js';
import {
  inspectWorkspace,
  readCurrentChangeDiff,
  resolveGitRepository,
  resolveWorkspaceGitRoot
} from '../../src/workspace.js';

const directories: string[] = [];
const execFile = promisify(execFileCallback);

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('Workspace parent Git repository support', () => {
  it.skipIf(process.platform === 'win32')(
    'preserves trailing spaces in POSIX repository roots',
    async () => {
      const temporaryRoot = await temporaryDirectory();
      const repositoryRoot = join(temporaryRoot, 'repo ');
      const childWorkspace = join(repositoryRoot, 'frontend');
      await mkdir(childWorkspace, { recursive: true });
      await git(repositoryRoot, ['init', '-b', 'main']);

      await expect(resolveWorkspaceGitRoot(childWorkspace)).resolves.toBe(repositoryRoot);
      await expect(resolveWorkspaceGitRoot(repositoryRoot, false)).resolves.toBe(repositoryRoot);
      await expect(inspectWorkspace(childWorkspace, [childWorkspace])).resolves.toMatchObject({
        path: childWorkspace,
        kind: 'GIT_WORKSPACE',
        gitSummary: { repositoryRoot }
      });
      await expect(resolveWorkspaceGitRoot(childWorkspace, false)).rejects.toThrow(
        'WORKSPACE_NOT_GIT'
      );
    }
  );

  it('resolves a child Workspace to its repository while preserving root-relative change paths', async () => {
    const temporaryRoot = await temporaryDirectory();
    const repositoryRoot = join(temporaryRoot, 'repo');
    const childWorkspace = join(repositoryRoot, 'frontend');
    await mkdir(childWorkspace, { recursive: true });
    await git(repositoryRoot, ['init', '-b', 'main']);
    await git(repositoryRoot, ['config', 'user.email', 'test@example.invalid']);
    await git(repositoryRoot, ['config', 'user.name', 'Test']);
    await writeFile(join(repositoryRoot, 'shared.txt'), 'repository version\n');
    await writeFile(join(childWorkspace, 'shared.txt'), 'child version\n');
    await git(repositoryRoot, ['add', 'shared.txt', 'frontend/shared.txt']);
    await git(repositoryRoot, ['commit', '-m', 'initial files']);

    await writeFile(join(repositoryRoot, 'shared.txt'), 'repository changed\n');
    await writeFile(join(childWorkspace, 'shared.txt'), 'child changed\n');

    await expect(resolveWorkspaceGitRoot(repositoryRoot)).resolves.toBe(repositoryRoot);
    await expect(resolveWorkspaceGitRoot(repositoryRoot, false)).resolves.toBe(repositoryRoot);
    await expect(resolveWorkspaceGitRoot(childWorkspace)).resolves.toBe(repositoryRoot);
    await expect(resolveWorkspaceGitRoot(childWorkspace, false)).rejects.toThrow(
      'WORKSPACE_NOT_GIT'
    );
    await expect(resolveGitRepository(repositoryRoot, '')).resolves.toBe(repositoryRoot);

    await expect(inspectWorkspace(repositoryRoot, [temporaryRoot])).resolves.toMatchObject({
      kind: 'GIT_WORKSPACE',
      gitSummary: { repositoryRoot }
    });
    await expect(inspectWorkspace(repositoryRoot, [temporaryRoot], false)).resolves.toMatchObject({
      kind: 'GIT_WORKSPACE',
      gitSummary: { repositoryRoot }
    });
    const childInspection = await inspectWorkspace(childWorkspace, [temporaryRoot]);
    expect(childInspection).toMatchObject({
      path: childWorkspace,
      kind: 'GIT_WORKSPACE',
      gitSummary: { repositoryRoot }
    });
    const disabledChildInspection = await inspectWorkspace(childWorkspace, [temporaryRoot], false);
    expect(disabledChildInspection.kind).toBe('DIRECTORY');
    expect(disabledChildInspection.gitSummary).toBeUndefined();

    const childDiff = await readCurrentChangeDiff(repositoryRoot, 'frontend/shared.txt');
    expect(childDiff).toMatchObject({
      binary: false,
      afterText: 'child changed\n',
      truncated: false
    });
    expect(childDiff.text).toContain('-child version');
    expect(childDiff.text).toContain('+child changed');
    const rootDiff = await readCurrentChangeDiff(repositoryRoot, 'shared.txt');
    expect(rootDiff.afterText).toBe('repository changed\n');
    expect(rootDiff.text).toContain('-repository version');
    expect(rootDiff.text).toContain('+repository changed');

    const ordinaryDirectory = join(temporaryRoot, 'ordinary');
    await mkdir(ordinaryDirectory);
    await expect(resolveWorkspaceGitRoot(ordinaryDirectory)).rejects.toThrow('GIT_COMMAND_FAILED');
    await expect(inspectWorkspace(ordinaryDirectory, [temporaryRoot])).resolves.toMatchObject({
      kind: 'DIRECTORY'
    });
  });

  it('routes parent and Workspace files, Changes, Diff, and restore through Workbench operations', async () => {
    const temporaryRoot = await temporaryDirectory();
    const repositoryRoot = join(temporaryRoot, 'repo');
    const childWorkspace = join(repositoryRoot, 'frontend');
    await mkdir(childWorkspace, { recursive: true });
    await initializeRepository(repositoryRoot);
    await writeFile(join(repositoryRoot, 'shared.txt'), 'repository version\n');
    await writeFile(join(childWorkspace, 'shared.txt'), 'Workspace version\n');
    await git(repositoryRoot, ['add', 'shared.txt', 'frontend/shared.txt']);
    await git(repositoryRoot, ['commit', '-m', 'initial files']);

    const database = new NodeDatabase(':memory:', 'node-parent-workbench');
    const connector = connectorFor(database, [temporaryRoot]);
    try {
      const registration = (await operation(connector, 'workspace.register', {
        path: childWorkspace
      })) as { readonly workspace: NodeWorkspace };
      const workspace = registration.workspace;
      expect(workspace).toMatchObject({
        kind: 'GIT_WORKSPACE',
        includeParentRepository: true,
        gitSummary: { repositoryRoot }
      });
      const coordinator = (
        connector as unknown as {
          workspaceCoordinator: { gitPolicyChanged(workspaceId: string): void };
        }
      ).workspaceCoordinator;
      const policyRefresh = vi.spyOn(coordinator, 'gitPolicyChanged');
      await expect(
        operation(connector, 'workspace.git.settings.update', {
          workspaceId: workspace.id,
          preserveGitConfig: workspace.preserveGitConfig,
          includeParentRepository: true
        })
      ).resolves.toMatchObject({ includeParentRepository: true });
      expect(policyRefresh).not.toHaveBeenCalled();

      await expect(
        operation(connector, 'workspace.file.read', {
          workspaceId: workspace.id,
          path: 'shared.txt'
        })
      ).resolves.toMatchObject({ file: { content: 'Workspace version\n' } });
      await expect(
        operation(connector, 'workspace.file.read', {
          workspaceId: workspace.id,
          path: 'shared.txt',
          repositoryPath: ''
        })
      ).resolves.toMatchObject({ file: { content: 'repository version\n' } });
      await expect(
        operation(connector, 'workspace.file.write', {
          workspaceId: workspace.id,
          path: 'shared.txt',
          repositoryPath: '',
          content: 'unauthorized parent write\n',
          expectedRevision: 'unused'
        })
      ).rejects.toThrow('FILE_WRITE_INVALID');
      await expect(readFile(join(repositoryRoot, 'shared.txt'), 'utf8')).resolves.toBe(
        'repository version\n'
      );
      await expect(readFile(join(childWorkspace, 'shared.txt'), 'utf8')).resolves.toBe(
        'Workspace version\n'
      );

      await writeFile(join(repositoryRoot, 'shared.txt'), 'repository changed\n');
      await writeFile(join(childWorkspace, 'shared.txt'), 'Workspace changed\n');
      const current = (await operation(connector, 'workspace.changes.current', {
        workspaceId: workspace.id
      })) as {
        readonly repositoryRoot: string;
        readonly changes: readonly { readonly path: string }[];
      };
      expect(current.repositoryRoot).toBe(repositoryRoot);
      expect(current.changes.map(({ path }) => path)).toEqual(
        expect.arrayContaining(['shared.txt', 'frontend/shared.txt'])
      );
      await expect(
        operation(connector, 'workspace.change.diff', {
          workspaceId: workspace.id,
          path: 'shared.txt'
        })
      ).resolves.toMatchObject({
        diff: {
          text: expect.stringContaining('+repository changed'),
          afterText: 'repository changed\n'
        }
      });
      await expect(
        operation(connector, 'workspace.change.restore', {
          workspaceId: workspace.id,
          path: 'shared.txt',
          state: 'UNSTAGED'
        })
      ).resolves.toEqual({ restored: true });
      await expect(readFile(join(repositoryRoot, 'shared.txt'), 'utf8')).resolves.toBe(
        'repository version\n'
      );
      await expect(readFile(join(childWorkspace, 'shared.txt'), 'utf8')).resolves.toBe(
        'Workspace changed\n'
      );
    } finally {
      database.close();
    }
  });

  it('does not commit Files metadata captured before parent Git is disabled', async () => {
    const temporaryRoot = await temporaryDirectory();
    const repositoryRoot = join(temporaryRoot, 'repo');
    const childWorkspace = join(repositoryRoot, 'frontend');
    await mkdir(childWorkspace, { recursive: true });
    await initializeRepository(repositoryRoot);
    await writeFile(join(childWorkspace, 'inside.txt'), 'Workspace file\n');
    await git(repositoryRoot, ['add', 'frontend/inside.txt']);
    await git(repositoryRoot, ['commit', '-m', 'initial files']);

    const database = new NodeDatabase(':memory:', 'node-parent-workspace-metadata-race');
    const connector = connectorFor(database, [temporaryRoot]);
    const coordinator = (
      connector as unknown as {
        workspaceCoordinator: NodeWorkspaceCoordinator;
      }
    ).workspaceCoordinator;
    const inspected = deferred<void>();
    const releaseInspection = deferred<void>();
    const disabledMetadataCommitted = deferred<void>();
    const originalInspect = coordinator.inspectMetadata.bind(coordinator);
    const originalCommit = coordinator.commitMetadata.bind(coordinator);
    let gateFirstParentInspection = true;
    let pendingFiles: Promise<unknown> | undefined;

    vi.spyOn(coordinator, 'inspectMetadata').mockImplementation(async (workspace) => {
      const inspection = await originalInspect(workspace);
      if (workspace.includeParentRepository !== false && gateFirstParentInspection) {
        gateFirstParentInspection = false;
        inspected.resolve();
        await releaseInspection.promise;
      }
      return inspection;
    });
    vi.spyOn(coordinator, 'commitMetadata').mockImplementation(async (workspace, inspection) => {
      const saved = await originalCommit(workspace, inspection);
      if (workspace.includeParentRepository === false) disabledMetadataCommitted.resolve();
      return saved;
    });

    try {
      const registration = (await operation(connector, 'workspace.register', {
        path: childWorkspace
      })) as { readonly workspace: NodeWorkspace };
      pendingFiles = operation(connector, 'workspace.files.list', {
        workspaceId: registration.workspace.id,
        path: '.'
      });
      await inspected.promise;

      await operation(connector, 'workspace.git.settings.update', {
        workspaceId: registration.workspace.id,
        preserveGitConfig: registration.workspace.preserveGitConfig,
        includeParentRepository: false
      });
      await disabledMetadataCommitted.promise;
      expect(database.getWorkspace(registration.workspace.id)).toMatchObject({
        kind: 'DIRECTORY',
        includeParentRepository: false,
        gitSummary: null
      });

      releaseInspection.resolve();
      await expect(pendingFiles).resolves.toMatchObject({
        workspace: {
          id: registration.workspace.id,
          kind: 'DIRECTORY',
          includeParentRepository: false,
          gitSummary: null
        }
      });
      expect(database.getWorkspace(registration.workspace.id)).toMatchObject({
        kind: 'DIRECTORY',
        includeParentRepository: false,
        gitSummary: null
      });
    } finally {
      releaseInspection.resolve();
      await pendingFiles?.catch(() => undefined);
      connector.stop();
    }
  });

  it.each(['inspection', 'exclude'] as const)(
    'does not overwrite disabled metadata when re-registration finishes after %s',
    async (stage) => {
      const temporaryRoot = await temporaryDirectory();
      const repositoryRoot = join(temporaryRoot, 'repo');
      const childWorkspace = join(repositoryRoot, 'frontend');
      await mkdir(childWorkspace, { recursive: true });
      await initializeRepository(repositoryRoot);
      const database = new NodeDatabase(':memory:', 'node-parent-registration-race');
      const connector = connectorFor(database, [temporaryRoot]);
      const captured = deferred<void>();
      const release = deferred<void>();
      let pending: Promise<unknown> | undefined;
      const originalInspect = workspaceModule.inspectWorkspace;
      const originalExclude = gitExclude.ensureWorkspaceGitExclude;
      try {
        const { workspace } = (await operation(connector, 'workspace.register', {
          path: childWorkspace
        })) as { workspace: NodeWorkspace };
        const exclude = vi.spyOn(gitExclude, 'ensureWorkspaceGitExclude');
        if (stage === 'inspection')
          vi.spyOn(workspaceModule, 'inspectWorkspace').mockImplementation(async (...args) => {
            const result = await originalInspect(...args);
            if (args[2] !== false) {
              captured.resolve();
              await release.promise;
            }
            return result;
          });
        else
          exclude.mockImplementation(async (...args) => {
            await originalExclude(...args);
            captured.resolve();
            await release.promise;
          });
        pending = operation(connector, 'workspace.register', { path: childWorkspace });
        await captured.promise;
        await operation(connector, 'workspace.git.settings.update', {
          workspaceId: workspace.id,
          preserveGitConfig: false,
          includeParentRepository: false
        });
        const expected = {
          id: workspace.id,
          kind: 'DIRECTORY',
          includeParentRepository: false,
          gitSummary: null
        };
        await vi.waitFor(() => expect(database.getWorkspace(workspace.id)).toMatchObject(expected));
        release.resolve();
        await expect(pending).resolves.toMatchObject({ workspace: expected });
        expect(database.getWorkspace(workspace.id)).toMatchObject(expected);
        expect(exclude).toHaveBeenCalledTimes(stage === 'inspection' ? 0 : 1);
      } finally {
        release.resolve();
        await pending?.catch(() => undefined);
        vi.restoreAllMocks();
        await connector.stop();
      }
    }
  );

  it('closes parent Git access and retains the disabled policy when re-registering the child', async () => {
    const temporaryRoot = await temporaryDirectory();
    const repositoryRoot = join(temporaryRoot, 'repo');
    const childWorkspace = join(repositoryRoot, 'frontend');
    await mkdir(childWorkspace, { recursive: true });
    await initializeRepository(repositoryRoot);
    await writeFile(join(repositoryRoot, 'outside.txt'), 'base\n');
    await writeFile(join(childWorkspace, 'inside.txt'), 'Workspace file\n');
    await git(repositoryRoot, ['add', 'outside.txt', 'frontend/inside.txt']);
    await git(repositoryRoot, ['commit', '-m', 'initial files']);

    const database = new NodeDatabase(':memory:', 'node-parent-workbench-policy');
    const connector = connectorFor(database, [temporaryRoot]);
    try {
      const registration = (await operation(connector, 'workspace.register', {
        path: childWorkspace
      })) as { readonly workspace: NodeWorkspace };
      const workspaceId = registration.workspace.id;
      await writeFile(join(repositoryRoot, 'outside.txt'), 'changed\n');
      await operation(connector, 'workspace.changes.current', { workspaceId });

      await expect(
        operation(connector, 'workspace.git.settings.update', {
          workspaceId,
          preserveGitConfig: false,
          includeParentRepository: false
        })
      ).resolves.toMatchObject({ includeParentRepository: false });
      await expect(
        operation(connector, 'workspace.changes.current', { workspaceId })
      ).rejects.toThrow('WORKSPACE_NOT_GIT');
      await expect(
        operation(connector, 'workspace.file.read', {
          workspaceId,
          path: 'outside.txt',
          repositoryPath: ''
        })
      ).rejects.toThrow('WORKSPACE_NOT_GIT');
      await expect(
        operation(connector, 'workspace.file.read', { workspaceId, path: 'inside.txt' })
      ).resolves.toMatchObject({ file: { content: 'Workspace file\n' } });

      const reregistered = (await operation(connector, 'workspace.register', {
        path: childWorkspace
      })) as { readonly workspace: NodeWorkspace };
      expect(reregistered.workspace).toMatchObject({
        id: workspaceId,
        kind: 'DIRECTORY',
        gitSummary: null,
        includeParentRepository: false
      });
      await expect(
        operation(connector, 'workspace.file.read', { workspaceId, path: 'inside.txt' })
      ).resolves.toMatchObject({ file: { content: 'Workspace file\n' } });
      await expect(
        operation(connector, 'workspace.git.settings.get', { workspaceId })
      ).resolves.toMatchObject({ includeParentRepository: false });
    } finally {
      database.close();
    }
  });

  it('keeps concurrent Skill exclude rules scoped to each Workspace in a shared repository', async () => {
    const temporaryRoot = await temporaryDirectory();
    const repositoryRoot = join(temporaryRoot, 'repo');
    const frontendWorkspace = join(repositoryRoot, 'frontend');
    const backendWorkspace = join(repositoryRoot, 'backend');
    await mkdir(frontendWorkspace, { recursive: true });
    await mkdir(backendWorkspace, { recursive: true });
    await initializeRepository(repositoryRoot);
    const excludePath = join(repositoryRoot, '.git', 'info', 'exclude');
    await writeFile(excludePath, '# local rules\n/local-only/\n');

    await Promise.all([
      updateWorkspaceSkillGitExclude(frontendWorkspace, 'review', true),
      updateWorkspaceSkillGitExclude(backendWorkspace, 'review', true)
    ]);
    const bothRules = await readFile(excludePath, 'utf8');
    expect(bothRules).toContain('/frontend/.agents/skills/review/');
    expect(bothRules).toContain('/frontend/.claude/skills/review/');
    expect(bothRules).toContain('/backend/.agents/skills/review/');
    expect(bothRules).toContain('/backend/.claude/skills/review/');
    expect(bothRules).toContain('# local rules\n/local-only/\n');

    await updateWorkspaceSkillGitExclude(frontendWorkspace, 'review', false);
    const frontendRemoved = await readFile(excludePath, 'utf8');
    expect(frontendRemoved).not.toContain('/frontend/.agents/skills/review/');
    expect(frontendRemoved).not.toContain('/frontend/.claude/skills/review/');
    expect(frontendRemoved).toContain('/backend/.agents/skills/review/');
    expect(frontendRemoved).toContain('/backend/.claude/skills/review/');
  });

  it('defaults migrated and new Workspace policies on, then preserves false across updates and restart', async () => {
    const temporaryRoot = await temporaryDirectory();
    const databasePath = join(temporaryRoot, 'node.sqlite');
    const legacyPath = join(temporaryRoot, 'legacy-workspace');
    const legacyDatabase = new DatabaseSync(databasePath);
    try {
      migrate(legacyDatabase, NODE_SCHEMA_MIGRATIONS.slice(0, -1));
      legacyDatabase
        .prepare(
          `INSERT INTO workspaces
            (id, path, kind, git_summary, created_at, updated_at, preserve_git_config)
           VALUES (?, ?, 'DIRECTORY', NULL, 1, 1, 1)`
        )
        .run('legacy-workspace', legacyPath);
    } finally {
      legacyDatabase.close();
    }

    const database = new NodeDatabase(databasePath, 'node-workspace-parent-policy');
    let workspace: ReturnType<NodeDatabase['saveWorkspace']>;
    try {
      expect(database.getWorkspace('legacy-workspace')).toMatchObject({
        includeParentRepository: true,
        preserveGitConfig: true
      });
      workspace = database.saveWorkspace({
        path: join(temporaryRoot, 'new-workspace'),
        kind: 'DIRECTORY',
        gitSummary: null
      });
      expect(workspace.includeParentRepository).toBe(true);
      expect(database.setWorkspaceGitPolicy(workspace.id, true, false)).toMatchObject({
        includeParentRepository: false,
        preserveGitConfig: true
      });
      expect(database.setWorkspaceGitPolicy(workspace.id, true).includeParentRepository).toBe(
        false
      );
    } finally {
      database.close();
    }

    const reopened = new NodeDatabase(databasePath, 'node-workspace-parent-policy');
    try {
      expect(reopened.getWorkspace(workspace.id)).toMatchObject({
        includeParentRepository: false,
        preserveGitConfig: true
      });
      const refreshed = reopened.saveWorkspace({
        path: workspace.path,
        kind: 'GIT_WORKSPACE',
        gitSummary: { repositoryRoot: temporaryRoot }
      });
      expect(refreshed.id).toBe(workspace.id);
      expect(refreshed.includeParentRepository).toBe(false);
      expect(reopened.getWorkspace(workspace.id)?.includeParentRepository).toBe(false);
    } finally {
      reopened.close();
    }
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'mar-workspace-parent-git-'));
  directories.push(path);
  return path;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFile('git', args, { cwd });
  return result.stdout;
}

async function initializeRepository(repositoryRoot: string): Promise<void> {
  await mkdir(repositoryRoot, { recursive: true });
  await git(repositoryRoot, ['init', '-b', 'main']);
  await git(repositoryRoot, ['config', 'user.email', 'test@example.invalid']);
  await git(repositoryRoot, ['config', 'user.name', 'Test']);
}

function connectorFor(database: NodeDatabase, allowedRoots: readonly string[]): NodeConnector {
  return new NodeConnector({
    reconnect: false,
    database,
    config: { serverUrl: 'http://server.test', allowedRoots },
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

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
