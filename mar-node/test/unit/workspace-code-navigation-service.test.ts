import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContentSearch } from '@myagentroam/protocol';
import type { NodeWorkspace } from '../../src/database.js';
import * as operational from '../../src/operational.js';
import type { WorkspaceFileEntry } from '../../src/workspace/contracts.js';
import { WorkspaceCodeNavigationService } from '../../src/workspace/workspace-code-navigation-service.js';
import { runCtags } from '../../src/service/code-navigation/ctags-index-storage.js';
import type { WorkspaceFileService } from '../../src/workspace/workspace-file-service.js';

const temporaryDirectories: string[] = [];
const fixtureCleanups: Array<() => Promise<void>> = [];

async function settleBackgroundOperations(services: readonly WorkspaceCodeNavigationService[]) {
  const states = services.map(
    (service) =>
      service as unknown as {
        preparations: Map<string, Promise<void>>;
        candidateRefreshes: Map<string, Promise<void>>;
        builds: Map<string, Promise<void>>;
      }
  );
  const errors: unknown[] = [];
  // Refresh completion can enqueue a build; drain all owners before deleting their files.
  for (;;) {
    const pending = states.flatMap((state) => [
      ...state.preparations.values(),
      ...state.candidateRefreshes.values(),
      ...state.builds.values()
    ]);
    if (pending.length === 0) break;
    for (const result of await Promise.allSettled(pending))
      if (result.status === 'rejected') errors.push(result.reason);
  }
  expect(errors).toEqual([]);
}

it('records ctags failure diagnostics without logging tags output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mar-ctags-failure-'));
  temporaryDirectories.push(directory);
  const log = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  try {
    await expect(
      runCtags(process.execPath, directory, join(directory, 'files'), join(directory, 'tags'))
    ).rejects.toThrow('SYMBOL_INDEX_BUILD_FAILED');
    const logged = log.mock.calls.map(([line]) => String(line)).join('');
    expect(logged).toContain('node.command.failed');
    expect(logged).toContain('ctags');
    expect(logged).toContain('errorDetails');
  } finally {
    log.mockRestore();
  }
});

afterEach(async () => {
  try {
    for (const cleanup of fixtureCleanups.splice(0)) await cleanup();
  } finally {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true }))
    );
    vi.restoreAllMocks();
  }
});

interface Fixture {
  readonly root: string;
  readonly service: WorkspaceCodeNavigationService;
  readonly entries: WorkspaceFileEntry[];
  readonly candidateRequests: boolean[];
  readonly refreshRequests: boolean[];
  readonly createService: (options?: {
    readonly waitForRefresh?: boolean;
  }) => WorkspaceCodeNavigationService;
  readonly refreshes: () => number;
  readonly releaseRefresh: () => void;
  readonly releaseCandidates: () => void;
}

async function fixture(
  searchContent?: (workspace: NodeWorkspace, query: string) => Promise<WorkspaceContentSearch>,
  initialOptions: { readonly waitForRefresh?: boolean; readonly waitForCandidates?: boolean } = {}
): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'mar-code-navigation-'));
  temporaryDirectories.push(directory);
  const root = resolve(directory, 'workspace');
  const home = resolve(directory, 'home');
  const executable = resolve(directory, 'fake-ctags.mjs');
  await writeFile(resolve(executable), fakeCtagsSource, { mode: 0o700 });
  await chmod(executable, 0o700);
  await writeFile(resolve(root, 'src/foo.ts'), 'export function foo() { return 1; }\\n', {
    encoding: 'utf8',
    flag: 'w'
  }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    const { mkdir } = await import('node:fs/promises');
    await mkdir(resolve(root, 'src'), { recursive: true });
    await writeFile(resolve(root, 'src/foo.ts'), 'export function foo() { return 1; }\\n');
  });
  const fooMetadata = await stat(resolve(root, 'src/foo.ts'));
  const entries: WorkspaceFileEntry[] = [
    {
      path: 'src/foo.ts',
      name: 'foo.ts',
      kind: 'FILE',
      size: fooMetadata.size,
      modifiedAt: fooMetadata.mtimeMs
    }
  ];
  const candidateRequests: boolean[] = [];
  const refreshRequests: boolean[] = [];
  const services: WorkspaceCodeNavigationService[] = [];
  const pendingRefreshReleases = new Set<() => void>();
  const log = vi.spyOn(operational, 'nodeLog');
  let closing = false;
  let refreshes = 0;
  let releaseRefresh: () => void = () => undefined;
  let releaseCandidates: () => void = () => undefined;
  const candidateBarrier = new Promise<void>((resolvePromise) => {
    releaseCandidates = resolvePromise;
  });
  fixtureCleanups.push(async () => {
    closing = true;
    releaseCandidates();
    for (const release of pendingRefreshReleases) release();
    await settleBackgroundOperations(services);
    expect(
      log.mock.calls.filter(
        ([event]) =>
          event === 'node.command.failed' || event === 'workspace.code_navigation.index.failed'
      )
    ).toEqual([]);
  });
  const createService = (options: { readonly waitForRefresh?: boolean } = {}) => {
    let loaded = false;
    const files = {
      index: () => ({
        contentCandidates: async (input: { readonly requireFresh?: boolean } = {}) => {
          candidateRequests.push(input.requireFresh === true);
          if (initialOptions.waitForCandidates) await candidateBarrier;
          loaded = true;
          return { entries, truncated: false };
        },
        peekContentCandidates: () => (loaded ? { entries, truncated: false } : undefined),
        refreshContentCandidates: (requireFresh = false) => {
          refreshRequests.push(requireFresh);
          refreshes += 1;
          loaded = true;
          if (!options.waitForRefresh || closing) return Promise.resolve();
          return new Promise<void>((resolvePromise) => {
            const release = () => {
              pendingRefreshReleases.delete(release);
              resolvePromise();
            };
            pendingRefreshReleases.add(release);
            releaseRefresh = release;
          });
        }
      })
    } as unknown as WorkspaceFileService;
    const service = new WorkspaceCodeNavigationService({
      files,
      nodeId: () => 'node_test',
      ctagsExecutable: () => executable,
      indexHome: () => home,
      ...(searchContent === undefined ? {} : { searchContent })
    });
    services.push(service);
    return service;
  };
  return {
    root,
    entries,
    candidateRequests,
    refreshRequests,
    service: createService(initialOptions),
    createService,
    refreshes: () => refreshes,
    releaseRefresh: () => releaseRefresh(),
    releaseCandidates: () => releaseCandidates()
  };
}

async function eventuallyReady(
  service: WorkspaceCodeNavigationService,
  root: string,
  symbol = 'foo'
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await settleBackgroundOperations([service]);
    const result = await service.definition({ id: 'workspace-1', path: root } as never, {
      path: 'src/current.ts',
      symbol
    });
    if (result.state === 'READY') {
      await settleBackgroundOperations([service]);
      return result;
    }
  }
  throw new Error('index did not become ready');
}

function fileReference(value: string) {
  const text = sourceText(value);
  const from = text.indexOf(value);
  return {
    languageId: 'fixture',
    extractorId: 'fixture.reference',
    kind: 'module' as const,
    value,
    from,
    to: from + value.length,
    sourceContext: { text, position: from }
  };
}

function sourceText(value: string): string {
  if (value === 'child' || value.endsWith('.rs')) return `#[path = "${value}"] mod child;`;
  if (value === 'hal/ZOSHalMisc.h') return `#include "${value}"`;
  if (value === '.' || value === '..' || (/^\.+[A-Za-z_]/u.test(value) && !value.includes('/')))
    return `from ${value} import value`;
  if (value.startsWith('package.')) return `import ${value}`;
  if (value.startsWith('com.example.')) return `import static ${value};`;
  return `import "${value}";`;
}

describe('WorkspaceCodeNavigationService', () => {
  it('matches indexed declarations from files outside the Ctags source maps', async () => {
    const { service, root } = await fixture();
    await eventuallyReady(service, root);

    await expect(
      service.definition({ id: 'workspace-1', path: root } as never, {
        path: 'Dockerfile',
        symbol: 'foo',
        includeReferences: false
      })
    ).resolves.toMatchObject({
      state: 'READY',
      targets: [expect.objectContaining({ path: 'src/foo.ts', line: 1 })],
      references: [],
      referenceTruncated: false
    });

    await expect(
      service.definition({ id: 'workspace-1', path: root } as never, {
        path: 'Dockerfile',
        symbol: '-bookworm',
        includeReferences: false
      })
    ).resolves.toMatchObject({
      state: 'READY',
      targets: [],
      references: [],
      referenceTruncated: false
    });
  });

  it('returns BUILDING before a cold candidate scan finishes and joins one preparation', async () => {
    const { service, root, releaseCandidates, candidateRequests } = await fixture(undefined, {
      waitForCandidates: true
    });
    const workspace = { id: 'workspace-1', path: root } as never;
    try {
      const first = await Promise.race([
        service.definition(workspace, { path: '.', symbol: 'foo', includeReferences: false }),
        new Promise<undefined>((resolvePromise) => setTimeout(() => resolvePromise(undefined), 200))
      ]);
      expect(first?.state).toBe('BUILDING');
      await expect(
        service.definition(workspace, { path: '.', symbol: 'foo', includeReferences: false })
      ).resolves.toMatchObject({ state: 'BUILDING' });
      expect(candidateRequests).toHaveLength(1);
    } finally {
      releaseCandidates();
      await eventuallyReady(service, root);
    }
  });

  it('prewarms the first Ctags generation once for a text preview before navigation queries', async () => {
    const { service, root } = await fixture();
    const workspace = { id: 'workspace-1', path: root } as never;

    await expect(service.prepare(workspace, { path: 'src/foo.ts' })).resolves.toEqual({
      state: 'BUILDING'
    });
    await expect(eventuallyReady(service, root)).resolves.toMatchObject({
      state: 'READY',
      targets: [expect.objectContaining({ path: 'src/foo.ts', line: 1 })]
    });
    await expect(
      readFile(resolve(dirname(root), 'fake-ctags-invocations.log'), 'utf8')
    ).resolves.toBe('src/foo.ts\n');
  });

  it('indexes bundled-Ctags language maps independently from file-reference parsers', async () => {
    const { service, root, entries } = await fixture();
    const sourceFiles = [
      ['src/feature.go', 'package feature\n'],
      ['src/Feature.cs', 'class Feature {}\n'],
      ['styles/theme.css', '.button { color: red; }\n'],
      ['styles/theme.scss', '$accent: red;\n'],
      ['pages/index.html', '<main id="app">Hello</main>\n'],
      ['server/index.php', '<?php function entry() {} ?>\n'],
      ['Makefile', 'build:\n'],
      ['components/App.vue', '<template />\n'],
      ['styles/theme.sass', '$accent: red\n'],
      ['styles/theme.less', '@accent: red;\n'],
      ['docs/notes.txt', 'preview only\n']
    ] as const;
    await Promise.all(
      sourceFiles.map(async ([path, content]) => {
        await mkdir(dirname(resolve(root, path)), { recursive: true });
        await writeFile(resolve(root, path), content);
        const metadata = await stat(resolve(root, path));
        entries.push({
          path,
          name: path.slice(path.lastIndexOf('/') + 1),
          kind: 'FILE',
          size: metadata.size,
          modifiedAt: metadata.mtimeMs
        });
      })
    );

    await expect(
      service.prepare({ id: 'workspace-1', path: root } as never, { path: 'src/feature.go' })
    ).resolves.toEqual({ state: 'BUILDING' });
    await eventuallyReady(service, root);
    await expect(
      readFile(resolve(dirname(root), 'fake-ctags-invocations.log'), 'utf8')
    ).resolves.toBe(
      'Makefile,pages/index.html,server/index.php,src/Feature.cs,src/feature.go,src/foo.ts,styles/theme.css,styles/theme.scss\n'
    );
  });

  it('builds a HOME-scoped standard tags generation then binary-queries and revalidates targets', async () => {
    const { service, root, entries } = await fixture();
    await expect(
      service.definition({ id: 'workspace-1', path: root } as never, {
        path: 'src/current.ts',
        symbol: 'foo'
      })
    ).resolves.toMatchObject({ state: 'BUILDING', targets: [] });

    await expect(eventuallyReady(service, root)).resolves.toMatchObject({
      state: 'READY',
      targets: [
        {
          path: 'src/foo.ts',
          line: 1,
          kind: 'f',
          preview: 'export function foo() { return 1; }\\n'
        }
      ]
    });

    await rm(resolve(root, 'src/foo.ts'));
    entries.splice(0, 1);
    await expect(eventuallyReady(service, root)).resolves.toMatchObject({
      state: 'READY',
      targets: []
    });
  });

  it('returns stale, independently verified old candidates while a changed file list rebuilds', async () => {
    const { service, root, entries } = await fixture();
    await eventuallyReady(service, root);
    await writeFile(resolve(root, 'src/near.ts'), 'export function foo() { return 2; }\\n');
    const nearMetadata = await stat(resolve(root, 'src/near.ts'));
    entries.push({
      path: 'src/near.ts',
      name: 'near.ts',
      kind: 'FILE',
      size: nearMetadata.size,
      modifiedAt: nearMetadata.mtimeMs
    });

    await expect(
      service.definition({ id: 'workspace-1', path: root } as never, {
        path: 'src/near.ts',
        symbol: 'foo'
      })
    ).resolves.toMatchObject({
      state: 'STALE',
      targets: [{ path: 'src/foo.ts', line: 1 }]
    });

    const rebuilt = await eventuallyReady(service, root);
    expect(rebuilt.state).toBe('READY');
    expect(rebuilt.targets).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'src/near.ts', line: 1 })])
    );
  });

  it('does not force a fresh workspace scan when a complete tags generation already exists', async () => {
    const { service, root, candidateRequests } = await fixture();
    await eventuallyReady(service, root);
    candidateRequests.splice(0);

    await expect(
      service.definition({ id: 'workspace-1', path: root } as never, {
        path: 'src/current.ts',
        symbol: 'foo'
      })
    ).resolves.toMatchObject({
      state: 'READY',
      targets: [expect.objectContaining({ path: 'src/foo.ts', line: 1 })]
    });
    expect(candidateRequests).toEqual([false]);
  });

  it('reuses a persisted generation after a Node restart before the file index refresh completes', async () => {
    const { service, root, candidateRequests, createService, refreshes, releaseRefresh } =
      await fixture();
    await eventuallyReady(service, root);
    candidateRequests.splice(0);

    const restarted = createService({ waitForRefresh: true });
    await expect(
      restarted.definition({ id: 'workspace-1', path: root } as never, {
        path: 'src/current.ts',
        symbol: 'foo'
      })
    ).resolves.toMatchObject({
      state: 'STALE',
      targets: [expect.objectContaining({ path: 'src/foo.ts', line: 1 })],
      references: []
    });
    expect(candidateRequests).toEqual([]);
    expect(refreshes()).toBe(1);
    releaseRefresh();
  });

  it('returns verified stale candidates and refreshes in the background after a Node-originated invalidation', async () => {
    const { service, root, candidateRequests, refreshRequests, releaseRefresh } = await fixture(
      undefined,
      { waitForRefresh: true }
    );
    await eventuallyReady(service, root);
    candidateRequests.splice(0);
    refreshRequests.splice(0);
    service.invalidate('workspace-1');

    await expect(
      service.definition({ id: 'workspace-1', path: root } as never, {
        path: 'src/current.ts',
        symbol: 'foo'
      })
    ).resolves.toMatchObject({
      state: 'STALE',
      targets: [expect.objectContaining({ path: 'src/foo.ts', line: 1 })],
      references: []
    });
    expect(candidateRequests).toEqual([]);
    expect(refreshRequests).toEqual([true]);
    releaseRefresh();
    await expect(eventuallyReady(service, root)).resolves.toMatchObject({ state: 'READY' });
  });

  it('uses an incompatible persisted generation immediately then rebuilds it in the background', async () => {
    const { service, root, candidateRequests, refreshRequests, releaseRefresh } = await fixture(
      undefined,
      { waitForRefresh: true }
    );
    await eventuallyReady(service, root);
    const [pathHash] = await readdir(resolve(root, '..', 'home', 'node_test'));
    const manifestPath = resolve(root, '..', 'home', 'node_test', pathHash!, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    await writeFile(manifestPath, JSON.stringify({ ...manifest, schemaVersion: 0 }));
    candidateRequests.splice(0);
    refreshRequests.splice(0);

    await expect(
      service.definition({ id: 'workspace-1', path: root } as never, {
        path: 'src/current.ts',
        symbol: 'foo'
      })
    ).resolves.toMatchObject({
      state: 'STALE',
      targets: [expect.objectContaining({ path: 'src/foo.ts', line: 1 })],
      references: []
    });
    expect(candidateRequests).toEqual([]);
    expect(refreshRequests).toEqual([false]);
    releaseRefresh();
    await expect(eventuallyReady(service, root)).resolves.toMatchObject({ state: 'READY' });
  });

  it('does not return a changed or deleted stale target from a persisted generation', async () => {
    const { service, root, createService, releaseRefresh } = await fixture();
    await eventuallyReady(service, root);
    await writeFile(resolve(root, 'src/foo.ts'), 'export function bar() { return 1; }\n');
    const restarted = createService({ waitForRefresh: true });

    await expect(
      restarted.definition({ id: 'workspace-1', path: root } as never, {
        path: 'src/current.ts',
        symbol: 'foo'
      })
    ).resolves.toMatchObject({ state: 'STALE', targets: [] });
    releaseRefresh();

    const deleted = createService({ waitForRefresh: true });
    await rm(resolve(root, 'src/foo.ts'));
    await expect(
      deleted.definition({ id: 'workspace-1', path: root } as never, {
        path: 'src/current.ts',
        symbol: 'foo'
      })
    ).resolves.toMatchObject({ state: 'STALE', targets: [] });
    releaseRefresh();
  });

  it('updates changed and removed paths without rerunning Ctags for unchanged files', async () => {
    const { service, root, entries } = await fixture();
    const stable = 'export function stable() { return 1; }\n';
    await writeFile(resolve(root, 'src/stable.ts'), stable);
    const stableMetadata = await stat(resolve(root, 'src/stable.ts'));
    entries.push({
      path: 'src/stable.ts',
      name: 'stable.ts',
      kind: 'FILE',
      size: stableMetadata.size,
      modifiedAt: stableMetadata.mtimeMs
    });

    await eventuallyReady(service, root);
    const updated = 'export function bar() { return 2; }\n';
    await writeFile(resolve(root, 'src/foo.ts'), updated);
    const updatedMetadata = await stat(resolve(root, 'src/foo.ts'));
    entries[0] = {
      ...entries[0]!,
      size: updatedMetadata.size,
      modifiedAt: updatedMetadata.mtimeMs
    };
    await expect(eventuallyReady(service, root, 'bar')).resolves.toMatchObject({
      state: 'READY',
      targets: [expect.objectContaining({ path: 'src/foo.ts', line: 1 })]
    });

    const log = resolve(dirname(root), 'fake-ctags-invocations.log');
    const expectOnlyChangedFileReindexed = async () => {
      const [initial, ...updates] = (await readFile(log, 'utf8')).trim().split('\n');
      expect(initial).toBe('src/foo.ts,src/stable.ts');
      expect(updates.length).toBeGreaterThan(0);
      expect(new Set(updates)).toEqual(new Set(['src/foo.ts']));
    };
    await expectOnlyChangedFileReindexed();

    await rm(resolve(root, 'src/foo.ts'));
    entries.splice(
      entries.findIndex((entry) => entry.path === 'src/foo.ts'),
      1
    );
    await expect(eventuallyReady(service, root, 'stable')).resolves.toMatchObject({
      state: 'READY',
      targets: [expect.objectContaining({ path: 'src/stable.ts', line: 1 })]
    });
    await expect(eventuallyReady(service, root, 'bar')).resolves.toMatchObject({
      state: 'READY',
      targets: []
    });
    await expectOnlyChangedFileReindexed();
  });

  it('returns textual references after indexed declarations while excluding definition lines', async () => {
    let searches = 0;
    const { service, root } = await fixture(async () => {
      searches += 1;
      return {
        matches: [
          {
            path: 'src/foo.ts',
            line: 1,
            column: 17,
            preview: 'export function foo() { return 1; }'
          },
          { path: 'src/use.ts', line: 4, column: 1, preview: 'foo();' }
        ],
        engine: 'NODE',
        truncated: true,
        skippedFiles: 0
      };
    });

    await expect(eventuallyReady(service, root)).resolves.toMatchObject({
      state: 'READY',
      targets: [expect.objectContaining({ path: 'src/foo.ts', line: 1 })],
      references: [{ path: 'src/use.ts', line: 4, column: 1, preview: 'foo();' }],
      referenceTruncated: true
    });
    expect(searches).toBe(1);

    await expect(
      service.definition({ id: 'workspace-1', path: root } as never, {
        path: 'src/current.ts',
        symbol: 'foo',
        includeReferences: false
      })
    ).resolves.toMatchObject({
      state: 'READY',
      targets: [expect.objectContaining({ path: 'src/foo.ts', line: 1 })],
      references: [],
      referenceTruncated: false
    });
    expect(searches).toBe(1);
  });

  it('resolves file specifiers through the current language handler without escaping the workspace', async () => {
    const { service, root, entries, candidateRequests } = await fixture();
    const sourceFiles = [
      ['src/model/workbench.ts', 'export const workbench = true;\n'],
      ['src/model/module.mts', 'export const module = true;\n'],
      ['src/model/common.cts', 'export const common = true;\n'],
      ['src/features/account/Profile.ts', 'export const profile = true;\n'],
      ['src/legacy/Profile.ts', 'export const legacyProfile = true;\n'],
      ['com/example/Service.java', 'package com.example;\nclass Service {}\n'],
      ['package/module.py', 'value = 1\n'],
      ['package/sub/sibling.py', 'value = 1\n'],
      ['package/sub/__init__.py', 'value = 1\n'],
      ['package/__init__.py', 'value = 1\n'],
      ['package/parent.py', 'value = 1\n'],
      ['packages/web-core/src/management.ts', 'export const management = true;\n'],
      ['src/hal/ZOSHalMisc.h', '#pragma once\n'],
      ['src/generated/config.inc', '#define ENABLED 1\n'],
      ['docs/guides/setup.md', '# Setup\n\n## Install Now\n\nUse the installer.\n'],
      ['docs/images/diagram.png', 'PNG fixture\n'],
      ['src/rust/child.rs', 'pub fn child() {}\n'],
      ['internal/feature/feature.go', 'package feature\n'],
      ['Company/Project/Models/Widget.cs', 'namespace Company.Project.Models;\nclass Widget {}\n'],
      ['styles/theme.css', '.theme { color: red; }\n'],
      ['styles/_palette.scss', '$accent: red;\n'],
      ['assets/logo.svg', '<svg />\n'],
      ['components/Child.vue', '<template />\n']
    ] as const;
    await Promise.all(
      sourceFiles.map(async ([path, content], index) => {
        await mkdir(dirname(resolve(root, path)), { recursive: true });
        await writeFile(resolve(root, path), content);
        entries.push({
          path,
          name: path.slice(path.lastIndexOf('/') + 1),
          kind: 'FILE',
          size: Buffer.byteLength(content),
          modifiedAt: index + 2
        });
      })
    );
    const workspace = { id: 'workspace-1', path: root } as never;

    await expect(
      service.definition(workspace, {
        path: 'src/view/current.ts',
        reference: fileReference('../model/workbench.js')
      })
    ).resolves.toMatchObject({
      state: 'READY',
      paths: [expect.objectContaining({ path: 'src/model/workbench.ts', line: 1 })]
    });
    await expect(
      service.definition(workspace, {
        path: 'src/view/current.ts',
        reference: { ...fileReference('../model/workbench.js'), value: '../model/module.mjs' }
      })
    ).resolves.toMatchObject({ state: 'READY', paths: [] });
    await expect(
      service.definition(workspace, {
        path: 'src/view/current.ts',
        reference: {
          ...fileReference('../model/workbench.js'),
          sourceContext: { text: 'import "../model/workbench.js";', position: 100_000 }
        }
      })
    ).resolves.toMatchObject({
      paths: [expect.objectContaining({ path: 'src/model/workbench.ts', line: 1 })]
    });
    await expect(
      service.definition(workspace, {
        path: 'src/view/current.ts',
        reference: fileReference('../model/module.mjs')
      })
    ).resolves.toMatchObject({
      paths: [expect.objectContaining({ path: 'src/model/module.mts', line: 1 })]
    });
    await expect(
      service.definition(workspace, {
        path: 'src/view/current.ts',
        reference: fileReference('../model/common.cjs')
      })
    ).resolves.toMatchObject({
      paths: [expect.objectContaining({ path: 'src/model/common.cts', line: 1 })]
    });
    await expect(
      service.definition(workspace, {
        path: 'src/view/current.ts',
        reference: fileReference('@/features/account/Profile')
      })
    ).resolves.toMatchObject({
      paths: [
        expect.objectContaining({ path: 'src/features/account/Profile.ts', line: 1 }),
        expect.objectContaining({ path: 'src/legacy/Profile.ts', line: 1 })
      ]
    });
    await expect(
      service.definition(workspace, {
        path: 'com/example/Current.java',
        reference: fileReference('com.example.Service')
      })
    ).resolves.toMatchObject({
      paths: [expect.objectContaining({ path: 'com/example/Service.java', line: 1 })]
    });
    await expect(
      service.definition(workspace, {
        path: 'com/example/Current.java',
        reference: fileReference('com.example.Service.member')
      })
    ).resolves.toMatchObject({
      paths: [expect.objectContaining({ path: 'com/example/Service.java', line: 1 })]
    });
    await expect(
      service.definition(workspace, {
        path: 'package/current.py',
        reference: fileReference('package.module')
      })
    ).resolves.toMatchObject({
      paths: [expect.objectContaining({ path: 'package/module.py', line: 1 })]
    });
    await expect(
      service.definition(workspace, {
        path: 'package/sub/current.py',
        reference: fileReference('.sibling')
      })
    ).resolves.toMatchObject({
      paths: [expect.objectContaining({ path: 'package/sub/sibling.py', line: 1 })]
    });
    await expect(
      service.definition(workspace, {
        path: 'package/sub/current.py',
        reference: fileReference('.')
      })
    ).resolves.toMatchObject({
      paths: [expect.objectContaining({ path: 'package/sub/__init__.py', line: 1 })]
    });
    await expect(
      service.definition(workspace, {
        path: 'package/sub/current.py',
        reference: fileReference('..')
      })
    ).resolves.toMatchObject({
      paths: [expect.objectContaining({ path: 'package/__init__.py', line: 1 })]
    });
    await expect(
      service.definition(workspace, {
        path: 'package/sub/current.py',
        reference: fileReference('..parent')
      })
    ).resolves.toMatchObject({
      paths: [expect.objectContaining({ path: 'package/parent.py', line: 1 })]
    });
    await expect(
      service.definition(workspace, {
        path: 'src/view/current.ts',
        reference: fileReference('@myagentroam/web-core/management')
      })
    ).resolves.toMatchObject({
      paths: [expect.objectContaining({ path: 'packages/web-core/src/management.ts', line: 1 })]
    });
    await expect(
      service.definition(workspace, {
        path: 'src/main.cpp',
        reference: fileReference('hal/ZOSHalMisc.h')
      })
    ).resolves.toMatchObject({
      paths: [expect.objectContaining({ path: 'src/hal/ZOSHalMisc.h', line: 1 })]
    });
    const includeSource = '#include "generated/config.inc"';
    await expect(
      service.definition(workspace, {
        path: 'src/main.c',
        reference: {
          ...fileReference('generated/config.inc'),
          sourceContext: {
            text: includeSource,
            position: includeSource.indexOf('generated/config.inc')
          }
        }
      })
    ).resolves.toMatchObject({
      paths: [expect.objectContaining({ path: 'src/generated/config.inc', line: 1 })]
    });
    const markdownInline = 'See [setup](../guides/setup.md#Install%20Now).';
    await expect(
      service.definition(workspace, {
        path: 'docs/notes/current.md',
        reference: {
          ...fileReference('../guides/setup.md'),
          anchor: 'Install%20Now',
          sourceContext: {
            text: markdownInline,
            position: markdownInline.indexOf('../guides/setup.md')
          }
        }
      })
    ).resolves.toMatchObject({
      paths: [expect.objectContaining({ path: 'docs/guides/setup.md', line: 3 })]
    });
    const markdownImage = '![diagram](../images/diagram.png)';
    await expect(
      service.definition(workspace, {
        path: 'docs/notes/current.md',
        reference: {
          ...fileReference('../images/diagram.png'),
          sourceContext: {
            text: markdownImage,
            position: markdownImage.indexOf('../images/diagram.png')
          }
        }
      })
    ).resolves.toMatchObject({
      paths: [expect.objectContaining({ path: 'docs/images/diagram.png', line: 1 })]
    });
    const markdownReference = '[Setup][guide]\n\n[guide]: ../guides/setup.md#install-now';
    await expect(
      service.definition(workspace, {
        path: 'docs/notes/current.md',
        reference: {
          ...fileReference('../guides/setup.md'),
          anchor: 'install-now',
          sourceContext: {
            text: markdownReference,
            position: markdownReference.indexOf('Setup')
          }
        }
      })
    ).resolves.toMatchObject({
      paths: [expect.objectContaining({ path: 'docs/guides/setup.md', line: 3 })]
    });
    await expect(
      service.definition(workspace, {
        path: 'src/rust/parent.rs',
        reference: fileReference('child')
      })
    ).resolves.toMatchObject({
      paths: [expect.objectContaining({ path: 'src/rust/child.rs', line: 1 })]
    });
    const goImport = 'import "example.test/project/internal/feature"';
    await expect(
      service.definition(workspace, {
        path: 'cmd/main.go',
        reference: {
          ...fileReference('example.test/project/internal/feature'),
          sourceContext: {
            text: goImport,
            position: goImport.indexOf('example.test/project/internal/feature')
          }
        }
      })
    ).resolves.toMatchObject({
      paths: [expect.objectContaining({ path: 'internal/feature/feature.go', line: 1 })]
    });
    const csharpUsing = 'using Company.Project.Models;';
    await expect(
      service.definition(workspace, {
        path: 'src/Program.cs',
        reference: {
          ...fileReference('Company.Project.Models'),
          sourceContext: {
            text: csharpUsing,
            position: csharpUsing.indexOf('Company.Project.Models')
          }
        }
      })
    ).resolves.toMatchObject({
      paths: [expect.objectContaining({ path: 'Company/Project/Models/Widget.cs', line: 1 })]
    });
    const cssImport = '@import "./theme.css";';
    await expect(
      service.definition(workspace, {
        path: 'styles/main.css',
        reference: {
          ...fileReference('./theme.css'),
          sourceContext: { text: cssImport, position: cssImport.indexOf('./theme.css') }
        }
      })
    ).resolves.toMatchObject({
      paths: [expect.objectContaining({ path: 'styles/theme.css', line: 1 })]
    });
    const scssUse = '@use "palette";';
    await expect(
      service.definition(workspace, {
        path: 'styles/main.scss',
        reference: {
          ...fileReference('palette'),
          sourceContext: { text: scssUse, position: scssUse.indexOf('palette') }
        }
      })
    ).resolves.toMatchObject({
      paths: [expect.objectContaining({ path: 'styles/_palette.scss', line: 1 })]
    });
    const aliasedScssUse = '@use "@/styles/palette";';
    await expect(
      service.definition(workspace, {
        path: 'styles/main.scss',
        reference: {
          ...fileReference('@/styles/palette'),
          sourceContext: {
            text: aliasedScssUse,
            position: aliasedScssUse.indexOf('@/styles/palette')
          }
        }
      })
    ).resolves.toMatchObject({
      paths: [expect.objectContaining({ path: 'styles/_palette.scss', line: 1 })]
    });
    const vueAsset = '<template><img src="../assets/logo.svg"></template>';
    await expect(
      service.definition(workspace, {
        path: 'components/App.vue',
        reference: {
          ...fileReference('../assets/logo.svg'),
          sourceContext: { text: vueAsset, position: vueAsset.indexOf('../assets/logo.svg') }
        }
      })
    ).resolves.toMatchObject({
      paths: [expect.objectContaining({ path: 'assets/logo.svg', line: 1 })]
    });
    const vueScss = '<style lang="scss">@use "../styles/palette";</style>';
    await expect(
      service.definition(workspace, {
        path: 'components/App.vue',
        reference: {
          ...fileReference('../styles/palette'),
          sourceContext: { text: vueScss, position: vueScss.indexOf('../styles/palette') }
        }
      })
    ).resolves.toMatchObject({
      paths: [expect.objectContaining({ path: 'styles/_palette.scss', line: 1 })]
    });
    const boundedVueScss =
      '.root { color: red; }\n@use "../styles/palette";\n.tail { color: blue; }';
    const boundedVueScssFrom = boundedVueScss.indexOf('../styles/palette');
    await expect(
      service.definition(workspace, {
        path: 'components/App.vue',
        reference: {
          languageId: 'scss',
          extractorId: 'scss.import',
          kind: 'relative-file',
          value: '../styles/palette',
          from: boundedVueScssFrom,
          to: boundedVueScssFrom + '../styles/palette'.length,
          sourceContext: {
            text: boundedVueScss,
            position: boundedVueScssFrom
          }
        }
      })
    ).resolves.toMatchObject({
      paths: [expect.objectContaining({ path: 'styles/_palette.scss', line: 1 })]
    });
    await expect(
      service.definition(workspace, {
        path: 'src/rust/parent.rs',
        reference: fileReference('child.rs')
      })
    ).resolves.toMatchObject({
      paths: [expect.objectContaining({ path: 'src/rust/child.rs', line: 1 })]
    });
    await expect(
      service.definition(workspace, {
        path: 'src/view/current.ts',
        reference: fileReference('../../outside')
      })
    ).resolves.toMatchObject({ paths: [] });
    expect(candidateRequests).toHaveLength(9);
    expect(candidateRequests.every((requested) => requested === false)).toBe(true);
  });

  it('rebuilds an incompatible persisted generation in the background after a restart', async () => {
    const {
      service,
      root,
      entries,
      candidateRequests,
      refreshRequests,
      createService,
      releaseRefresh
    } = await fixture();
    const content = 'export const workbench = true;\n';
    await mkdir(resolve(root, 'src/model'), { recursive: true });
    await writeFile(resolve(root, 'src/foo.ts'), content);
    const metadata = await stat(resolve(root, 'src/foo.ts'));
    entries.push({
      path: 'src/foo.ts',
      name: 'workbench.ts',
      kind: 'FILE',
      size: metadata.size,
      modifiedAt: metadata.mtimeMs
    });
    await eventuallyReady(service, root);
    const [pathHash] = await readdir(resolve(root, '..', 'home', 'node_test'));
    const manifestPath = resolve(root, '..', 'home', 'node_test', pathHash!, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    await writeFile(manifestPath, JSON.stringify({ ...manifest, optionsVersion: 0 }));
    candidateRequests.splice(0);
    refreshRequests.splice(0);
    const restarted = createService({ waitForRefresh: true });

    await expect(
      restarted.definition({ id: 'workspace-1', path: root } as never, {
        path: 'src/view/current.ts',
        symbol: 'foo'
      })
    ).resolves.toMatchObject({ state: 'STALE', targets: [] });
    expect(candidateRequests).toEqual([]);
    expect(refreshRequests).toEqual([false]);
    await writeFile(resolve(root, 'src/foo.ts'), 'export const changed = true;\n');
    await expect(
      restarted.definition({ id: 'workspace-1', path: root } as never, {
        path: 'src/view/current.ts',
        symbol: 'foo'
      })
    ).resolves.toMatchObject({ state: 'STALE', targets: [] });
    releaseRefresh();
    await expect(eventuallyReady(restarted, root)).resolves.toMatchObject({ state: 'READY' });
  });

  it('does not start a process when the fixed Ctags resource is unavailable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-code-navigation-unavailable-'));
    temporaryDirectories.push(directory);
    const files = {
      index: () => ({
        contentCandidates: async () => ({ entries: [], truncated: false })
      })
    } as unknown as WorkspaceFileService;
    const service = new WorkspaceCodeNavigationService({
      files,
      nodeId: () => 'node_test',
      ctagsExecutable: () => resolve(directory, 'missing-ctags'),
      indexHome: () => resolve(directory, 'home')
    });
    await expect(
      service.definition({ id: 'workspace-1', path: directory } as never, {
        path: 'main.ts',
        symbol: 'foo'
      })
    ).resolves.toEqual({
      state: 'UNAVAILABLE',
      targets: [],
      references: [],
      referenceTruncated: false,
      paths: [],
      truncated: false
    });
  });

  it.runIf(process.platform === 'linux' && process.arch === 'x64')(
    'indexes the declared language set with the bundled Linux Ctags resource',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'mar-code-navigation-real-'));
      temporaryDirectories.push(directory);
      const source = {
        'sample.ts': 'export function typeScriptDefinition() {}\n',
        'sample.js': 'export function javaScriptDefinition() {}\n',
        'sample.py': 'def pythonDefinition():\n    pass\n',
        'Sample.java': 'class Sample { void javaDefinition() {} }\n',
        'Sample.kt': 'class Sample { fun kotlinDefinition() {} }\n',
        'sample.go': 'package sample\nfunc goDefinition() {}\n',
        'sample.rs': 'fn rustDefinition() {}\n',
        'sample.c': 'void cDefinition(void) {}\n',
        'sample.cpp': 'void cppDefinition() {}\n',
        'Sample.cs': 'class Sample { void csharpDefinition() {} }\n',
        'style.scss': '$accent: red;\n',
        'page.html': '<main id="app">Hello</main>\n'
      };
      await Promise.all(
        Object.entries(source).map(([path, content]) =>
          writeFile(resolve(directory, path), content)
        )
      );
      let loaded = false;
      const entries = await Promise.all(
        Object.keys(source).map(async (path) => {
          const metadata = await stat(resolve(directory, path));
          return {
            path,
            name: path.slice(path.lastIndexOf('/') + 1),
            kind: 'FILE' as const,
            size: metadata.size,
            modifiedAt: metadata.mtimeMs
          };
        })
      );
      const files = {
        index: () => ({
          contentCandidates: async () => {
            loaded = true;
            return { entries, truncated: false };
          },
          peekContentCandidates: () => (loaded ? { entries, truncated: false } : undefined),
          refreshContentCandidates: () => Promise.resolve()
        })
      } as unknown as WorkspaceFileService;
      const service = new WorkspaceCodeNavigationService({
        files,
        nodeId: () => 'node_test',
        indexHome: () => resolve(directory, 'home'),
        platform: 'linux',
        architecture: 'x64'
      });
      const workspace = { id: 'workspace-1', path: directory } as never;
      expect(
        (
          await service.definition(workspace, {
            path: 'sample.ts',
            symbol: 'typeScriptDefinition'
          })
        ).state
      ).toBe('BUILDING');
      for (const [symbol, path] of [
        ['typeScriptDefinition', 'sample.ts'],
        ['javaScriptDefinition', 'sample.js'],
        ['pythonDefinition', 'sample.py'],
        ['javaDefinition', 'Sample.java'],
        ['kotlinDefinition', 'Sample.kt'],
        ['goDefinition', 'sample.go'],
        ['rustDefinition', 'sample.rs'],
        ['cDefinition', 'sample.c'],
        ['cppDefinition', 'sample.cpp'],
        ['csharpDefinition', 'Sample.cs'],
        ['accent', 'style.scss'],
        ['app', 'page.html']
      ] as const) {
        const definition = await eventuallyReady(service, directory, symbol);
        expect(definition.targets).toEqual(
          expect.arrayContaining([expect.objectContaining({ path, line: expect.any(Number) })])
        );
      }
      const [pathHash] = await readdir(resolve(directory, 'home', 'node_test'));
      const manifest = JSON.parse(
        await readFile(resolve(directory, 'home', 'node_test', pathHash!, 'manifest.json'), 'utf8')
      ) as { generation: string };
      await expect(
        readFile(
          resolve(
            directory,
            'home',
            'node_test',
            pathHash!,
            'generations',
            manifest.generation,
            'tags'
          ),
          'utf8'
        )
      ).resolves.not.toContain(directory);
    },
    30_000
  );
});

const fakeCtagsSource = `#!/usr/bin/env node
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
const args = process.argv.slice(2);
const list = args[args.indexOf('-L') + 1];
const output = args[args.indexOf('-f') + 1];
const newline = String.fromCharCode(10);
const tab = String.fromCharCode(9);
const files = (await readFile(list, 'utf8')).split(newline).filter(Boolean).sort();
await appendFile(resolve(dirname(process.argv[1]), 'fake-ctags-invocations.log'), files.join(',') + newline);
const tags = ['!_TAG_FILE_FORMAT' + tab + '2' + tab + '/extended format/'];
for (const file of files) {
  const content = await readFile(file, 'utf8');
  const tagPath = file.split('\\\\').join('/');
  for (const [index, line] of content.split(newline).entries()) {
    const match = /function +([A-Za-z_$][A-Za-z0-9_$]*)/.exec(line);
    if (match) tags.push(match[1] + tab + tagPath + tab + (index + 1) + ';"' + tab + 'f');
  }
}
await writeFile(output, [tags[0], ...tags.slice(1).sort()].join(newline) + newline);
`;
