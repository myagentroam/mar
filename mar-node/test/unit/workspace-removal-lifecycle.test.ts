import * as filesystem from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase } from '../../src/database.js';
import type { NodeRuntimeState } from '../../src/runtime-state.js';
import * as indexStorage from '../../src/service/code-navigation/ctags-index-storage.js';
import type { WorkspaceCodeNavigationService } from '../../src/service/workspace-code-navigation-service.js';
import type { WorkspaceDomainState } from '../../src/service/workspace-domain-state.js';
import type { WorkspaceWorkbenchService } from '../../src/service/workspace-workbench-service.js';
import { executeNodeOperation } from './support/node-connector.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

async function fixture(blockBuild = false) {
  const root = await mkdtemp(join(tmpdir(), 'mar-workspace-removal-'));
  const database = new NodeDatabase(':memory:', 'workspace-removal');
  const connector = new NodeConnector({ database, reconnect: false });
  const internals = connector as unknown as {
    runtime: NodeRuntimeState;
    workspaceState: WorkspaceDomainState;
    workspaceWorkbenchService: WorkspaceWorkbenchService;
    discoverWorkspaceSessions(): Promise<readonly unknown[]>;
  };
  const workbench = internals.workspaceWorkbenchService;
  const { codeNavigation: navigation, snapshots } = workbench as unknown as {
    codeNavigation: {
      forget: WorkspaceCodeNavigationService['forget'];
      options: { indexHome?: () => string; ctagsExecutable?: () => string };
      locations: Map<string, indexStorage.IndexLocation>;
      builds: Map<string, Promise<void>>;
      preparations: Map<string, Promise<void>>;
    };
    snapshots: { signatures: Map<string, string> };
  };
  // Retain the Connector's actual services; isolate only the index root and Ctags process.
  navigation.options.indexHome = () => join(root, 'indexes');
  navigation.options.ctagsExecutable = () => process.execPath;
  vi.spyOn(internals, 'discoverWorkspaceSessions').mockResolvedValue([]);
  let releaseBuild!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseBuild = resolve;
  });
  const ctags = vi.spyOn(indexStorage, 'runCtags').mockImplementation(async (_, __, list, tags) => {
    expect(await readFile(list, 'utf8')).toBe('source.ts');
    if (blockBuild) await gate;
    await writeFile(tags, 'example\tsource.ts\t1;"\tf\tline:1\n');
    return 0;
  });
  cleanups.push(async () => {
    releaseBuild();
    try {
      await Promise.all([...navigation.preparations.values(), ...navigation.builds.values()]);
    } finally {
      await connector.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
  const source = 'export function example() { return 1; }\n';
  async function createWorkspace(name: string) {
    const path = join(root, name);
    await mkdir(path);
    await writeFile(join(path, 'source.ts'), source);
    return database.saveWorkspace({ path, kind: 'DIRECTORY', gitSummary: null });
  }
  const workspace = await createWorkspace('project');
  const operation = (name: string, data: Record<string, unknown> = {}) =>
    executeNodeOperation(connector, name, { workspaceId: workspace.id, ...data });
  async function buildIndex(target = workspace) {
    await expect(
      operation('workspace.symbol.prepare', { workspaceId: target.id, path: 'source.ts' })
    ).resolves.toMatchObject({ preparation: { state: 'BUILDING' } });
    await vi.waitFor(() => expect(ctags).toHaveBeenCalled());
    const location = navigation.locations.get(target.id)!;
    if (!blockBuild) {
      await Promise.all([...navigation.preparations.values()]);
      await expect(stat(location.manifest)).resolves.toBeDefined();
    }
    return location;
  }
  const watch = {
    watchId: 'removal-watch',
    workbenchConnectionId: 'removal-page',
    mode: 'initial',
    topics: { sessions: true }
  };
  async function watchWorkspace() {
    await operation('workspace.watch', watch);
    await vi.waitFor(() => expect(snapshots.signatures.size).toBe(1));
  }
  return {
    root,
    database,
    internals,
    workbench,
    navigation,
    snapshots,
    workspace,
    source,
    operation,
    buildIndex,
    createWorkspace,
    watchWorkspace,
    watch,
    releaseBuild
  };
}

describe('Workspace removal through the Node Connector', () => {
  it('forgets only the removed Workspace index and location while clearing Workbench state and preserving project files', async () => {
    const test = await fixture();
    const removed = await test.buildIndex();
    const other = await test.createWorkspace('other-project');
    const retained = await test.buildIndex(other);
    await test.watchWorkspace();
    expect(test.internals.workspaceState.fileIndexes.has(test.workspace.id)).toBe(true);
    const clear = vi.spyOn(test.workbench, 'clearWorkspace');
    const forget = vi.spyOn(test.navigation, 'forget');

    await expect(test.operation('workspace.remove')).resolves.toMatchObject({
      workspace: { id: test.workspace.id }
    });

    expect(clear).toHaveBeenCalledExactlyOnceWith(test.workspace.id);
    expect(forget).toHaveBeenCalledExactlyOnceWith(test.workspace.id);
    expect(test.database.getWorkspace(test.workspace.id)).toBeUndefined();
    expect(test.navigation.locations.has(test.workspace.id)).toBe(false);
    expect(test.internals.workspaceState.fileIndexes.has(test.workspace.id)).toBe(false);
    expect(test.internals.workspaceState.watches.has(test.workspace.id)).toBe(false);
    expect(test.snapshots.signatures.size).toBe(0);
    await vi.waitFor(async () => {
      await expect(stat(removed.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    expect(test.database.getWorkspace(other.id)).toBeDefined();
    expect(test.navigation.locations.get(other.id)).toEqual(retained);
    await expect(stat(retained.manifest)).resolves.toBeDefined();
    await expect(readFile(join(test.workspace.path, 'source.ts'), 'utf8')).resolves.toBe(
      test.source
    );
    await expect(readFile(join(other.path, 'source.ts'), 'utf8')).resolves.toBe(test.source);
  });

  it('lets an in-flight build settle without publishing a late index after removal', async () => {
    const test = await fixture(true);
    const location = await test.buildIndex();
    const build = test.navigation.builds.get(location.directory)!;
    expect(build).toBeDefined();
    await expect(stat(location.generations)).resolves.toBeDefined();
    const rename = vi.mocked(filesystem.rename);
    rename.mockClear();

    await test.operation('workspace.remove');
    expect(test.navigation.locations.has(test.workspace.id)).toBe(false);
    test.releaseBuild();
    await build;
    await Promise.all([...test.navigation.preparations.values()]);

    expect(rename).not.toHaveBeenCalledWith(expect.any(String), location.manifest);
    await expect(stat(location.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(test.navigation.builds.size).toBe(0);
    expect(test.navigation.preparations.size).toBe(0);
    await expect(readFile(join(test.workspace.path, 'source.ts'), 'utf8')).resolves.toBe(
      test.source
    );
  });

  it('releases the last page Watch without forgetting the code index', async () => {
    const test = await fixture();
    const location = await test.buildIndex();
    const manifest = await readFile(location.manifest, 'utf8');
    await test.watchWorkspace();
    const forget = vi.spyOn(test.navigation, 'forget');

    await expect(test.operation('workspace.unwatch', test.watch)).resolves.toEqual({
      stopped: true
    });

    expect(forget).not.toHaveBeenCalled();
    expect(test.internals.workspaceState.watches.has(test.workspace.id)).toBe(false);
    expect(test.snapshots.signatures.size).toBe(0);
    expect(test.navigation.locations.get(test.workspace.id)).toEqual(location);
    await expect(readFile(location.manifest, 'utf8')).resolves.toBe(manifest);
    await expect(
      test.operation('workspace.symbol.definition', {
        path: 'source.ts',
        symbol: 'example',
        includeReferences: false
      })
    ).resolves.toMatchObject({
      definition: {
        state: 'READY',
        targets: [expect.objectContaining({ path: 'source.ts', line: 1 })]
      }
    });
  });

  it('rejects removal with an active SessionLease without clearing registration, index or Watch state', async () => {
    const test = await fixture();
    const location = await test.buildIndex();
    const manifest = await readFile(location.manifest, 'utf8');
    await test.watchWorkspace();
    const runtime = test.internals.runtime;
    const session = runtime.createAgentSession({
      workspaceId: test.workspace.id,
      runner: 'codex',
      cwd: test.workspace.path
    });
    const { run } = runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'lease-message',
      content: 'keep the Workspace busy'
    });
    const clear = vi.spyOn(test.workbench, 'clearWorkspace');
    const forget = vi.spyOn(test.navigation, 'forget');
    try {
      expect(runtime.hasActiveWorkspaceLease(test.workspace.id)).toBe(true);
      await expect(test.operation('workspace.remove')).rejects.toThrow('WORKSPACE_BUSY');
      expect(clear).not.toHaveBeenCalled();
      expect(forget).not.toHaveBeenCalled();
      expect(test.database.getWorkspace(test.workspace.id)).toBeDefined();
      expect(test.navigation.locations.get(test.workspace.id)).toEqual(location);
      expect(test.internals.workspaceState.fileIndexes.has(test.workspace.id)).toBe(true);
      expect(test.internals.workspaceState.watches.has(test.workspace.id)).toBe(true);
      expect(test.snapshots.signatures.size).toBe(1);
      await expect(readFile(location.manifest, 'utf8')).resolves.toBe(manifest);
      await expect(readFile(join(test.workspace.path, 'source.ts'), 'utf8')).resolves.toBe(
        test.source
      );
    } finally {
      runtime.transitionRun(run.id, 'CANCELLED');
    }
  });
});
