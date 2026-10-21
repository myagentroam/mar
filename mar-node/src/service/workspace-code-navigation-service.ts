import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, open, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { relative, resolve, sep } from 'node:path';
import { isNavigationSymbol, type FileReference } from '@myagentroam/code-navigation';
import { supportsSymbolNavigationPath } from '@myagentroam/code-navigation/symbol-navigation';
import { workspaceFileReferenceSchema, type WorkspaceContentSearch } from '@myagentroam/protocol';
import type { NodeWorkspace } from '../database.js';
import {
  bundledCtagsPath,
  BUNDLED_CTAGS_VERSION,
  repairBundledCtagsExecutable
} from '../ctags-binary.js';
import { nodeLog } from '../operational.js';
import { normalizeWorkspacePath, type WorkspaceFileEntry } from '../workspace.js';
import { pathSpecifierResolver } from './code-navigation/navigation-resolution-registry.js';
import { reparseFileReference } from './code-navigation/file-reference-parser.js';
import {
  acquireBuild,
  buildIncrementalTags,
  ensurePrivateDirectory,
  type IndexLocation,
  type IndexManifest,
  manifestEntry,
  readManifest,
  removeInactiveGenerations,
  runCtags,
  sourceDelta,
  sourceFingerprint,
  tagsAvailable,
  tagsPath
} from './code-navigation/ctags-index-storage.js';
import {
  compareTagNames,
  firstTagOffset,
  parseTag,
  readTagLine
} from './code-navigation/ctags-query.js';
import {
  compareTargets,
  containsSymbol,
  type NavigationTagRecord,
  sourceFileFingerprint,
  targetPreview,
  validatePathTarget,
  validateSymbolTarget
} from './code-navigation/navigation-target-validator.js';
import type { WorkspaceFileService } from './workspace-file-service.js';

const INDEX_SCHEMA_VERSION = 1;
const INDEX_OPTIONS_VERSION = 2;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_INDEX_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_TAGS_BYTES = 512 * 1024 * 1024;
const MAX_CANDIDATES = 100;
const MAX_RESULTS = 20;
const MAX_REFERENCES = 100;

export type WorkspaceSymbolIndexState = 'UNAVAILABLE' | 'BUILDING' | 'READY' | 'STALE' | 'FAILED';

export interface WorkspaceSymbolDefinitionTarget {
  readonly path: string;
  readonly line: number;
  readonly kind: string | undefined;
  readonly scope: string | undefined;
  readonly preview?: string | undefined;
}

export interface WorkspaceSymbolDefinition {
  readonly state: WorkspaceSymbolIndexState;
  readonly targets: readonly WorkspaceSymbolDefinitionTarget[];
  readonly references: readonly {
    readonly path: string;
    readonly line: number;
    readonly column: number;
    readonly preview: string;
  }[];
  readonly referenceTruncated: boolean;
  readonly paths: readonly WorkspaceSymbolDefinitionTarget[];
  readonly truncated: boolean;
  readonly failureCode?: 'SYMBOL_INDEX_BUILD_FAILED' | 'SYMBOL_INDEX_LIMIT_EXCEEDED';
}

export interface WorkspaceSymbolIndexPreparation {
  readonly state: WorkspaceSymbolIndexState;
  readonly failureCode?: WorkspaceSymbolDefinition['failureCode'];
}

interface IndexInput {
  readonly root: string;
  readonly entries: readonly WorkspaceFileEntry[];
  readonly sourceFingerprint: string;
  readonly sourceFiles: Readonly<Record<string, string>>;
  readonly truncated: boolean;
  readonly candidateScanMs: number;
  readonly revalidateSourceFingerprint: boolean;
}

interface TagRecord extends WorkspaceSymbolDefinitionTarget, NavigationTagRecord {}

type BuildFailure = WorkspaceSymbolDefinition['failureCode'];

export interface WorkspaceCodeNavigationServiceOptions {
  readonly files: WorkspaceFileService;
  readonly nodeId: () => string;
  readonly ctagsExecutable?: () => string;
  readonly indexHome?: () => string;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly searchContent?: (
    workspace: NodeWorkspace,
    query: string
  ) => Promise<WorkspaceContentSearch>;
}

/**
 * Builds a demand-driven, standard u-ctags declaration index. It never keeps
 * a complete symbol table, watcher, or idle child process in memory.
 */
export class WorkspaceCodeNavigationService {
  private readonly builds = new Map<string, Promise<void>>();
  private readonly preparations = new Map<string, Promise<void>>();
  private readonly candidateRefreshes = new Map<string, Promise<void>>();
  private readonly locations = new Map<string, IndexLocation>();
  private readonly failures = new Map<string, BuildFailure>();
  private readonly forgotten = new Set<string>();
  private readonly forceFreshCandidates = new Map<string, number>();

  constructor(private readonly options: WorkspaceCodeNavigationServiceOptions) {}

  async prepare(
    workspace: NodeWorkspace,
    input: Record<string, unknown>
  ): Promise<WorkspaceSymbolIndexPreparation> {
    if (typeof input.path !== 'string' || input.path.length === 0 || input.path.length > 4096)
      throw new Error('SYMBOL_DEFINITION_INVALID');
    if (!isCtagsSourcePath(input.path)) return { state: 'READY' };
    if (!(await this.available())) return { state: 'UNAVAILABLE' };

    const location = await this.indexLocation(workspace);
    this.locations.set(workspace.id, location);
    this.forgotten.delete(location.directory);
    const manifest = await readManifest(location.manifest);
    const tags =
      manifest === undefined
        ? undefined
        : await tagsPath(location, manifest).catch(() => undefined);
    const reusable =
      manifest !== undefined &&
      tags !== undefined &&
      (await tagsAvailable(tags)) &&
      manifest.sourceFiles !== undefined;
    const current =
      reusable &&
      manifest.schemaVersion === INDEX_SCHEMA_VERSION &&
      manifest.optionsVersion === INDEX_OPTIONS_VERSION &&
      manifest.ctagsVersion === BUNDLED_CTAGS_VERSION;
    const cachedCandidates = this.options.files.index(workspace).peekContentCandidates();
    const forceRefreshGeneration = this.forceFreshCandidates.get(workspace.id);
    if (reusable) {
      if (!current || cachedCandidates === undefined || forceRefreshGeneration !== undefined)
        this.refreshCandidatesInBackground(workspace, location, manifest, {
          requireFresh: forceRefreshGeneration !== undefined,
          mustBuild: !current || forceRefreshGeneration !== undefined,
          forceRefreshGeneration
        });
      return { state: current ? 'READY' : 'STALE' };
    }

    const failure = this.failures.get(location.directory);
    if (
      failure !== undefined &&
      !this.builds.has(location.directory) &&
      !this.preparations.has(location.directory)
    ) {
      this.failures.delete(location.directory);
      return { state: 'FAILED', failureCode: failure };
    }
    this.startInitialBuild(workspace, location);
    return { state: 'BUILDING' };
  }

  async definition(
    workspace: NodeWorkspace,
    input: Record<string, unknown>
  ): Promise<WorkspaceSymbolDefinition> {
    const path = input.path;
    const symbol = input.symbol;
    const includeReferences = input.includeReferences;
    const reference =
      input.reference === undefined
        ? undefined
        : workspaceFileReferenceSchema.safeParse(input.reference);
    if (
      typeof path !== 'string' ||
      path.length === 0 ||
      path.length > 4096 ||
      (typeof symbol === 'string' && reference !== undefined) ||
      (typeof symbol !== 'string' && reference === undefined) ||
      (typeof symbol === 'string' && !isNavigationSymbol(path, symbol)) ||
      (includeReferences !== undefined && typeof includeReferences !== 'boolean') ||
      (reference !== undefined && !reference.success)
    )
      throw new Error('SYMBOL_DEFINITION_INVALID');
    if (reference !== undefined) {
      const parsedReference = reparseFileReference(path, reference.data);
      if (parsedReference === undefined) return emptyDefinitionResult({ state: 'READY' });
      return this.resolvePath(workspace, path, parsedReference);
    }
    const requestedSymbol = symbol as string;
    if (!(await this.available())) return emptyDefinitionResult({ state: 'UNAVAILABLE' });

    const location = await this.indexLocation(workspace);
    this.locations.set(workspace.id, location);
    this.forgotten.delete(location.directory);
    const manifest = await readManifest(location.manifest);
    const tags =
      manifest === undefined
        ? undefined
        : await tagsPath(location, manifest).catch(() => undefined);
    const tagsReady = tags !== undefined && (await tagsAvailable(tags));
    const reusable =
      manifest !== undefined &&
      tags !== undefined &&
      tagsReady &&
      manifest.sourceFiles !== undefined;
    const current =
      reusable &&
      manifest.schemaVersion === INDEX_SCHEMA_VERSION &&
      manifest.optionsVersion === INDEX_OPTIONS_VERSION &&
      manifest.ctagsVersion === BUNDLED_CTAGS_VERSION;
    const fileIndex = this.options.files.index(workspace);
    const cachedCandidates = fileIndex.peekContentCandidates();
    const forceRefreshGeneration = this.forceFreshCandidates.get(workspace.id);
    if (
      reusable &&
      (!current || cachedCandidates === undefined || forceRefreshGeneration !== undefined)
    ) {
      const prepared = await this.manifestInput(workspace, manifest);
      const targets = await this.findTargets(tags, requestedSymbol, path, prepared);
      this.refreshCandidatesInBackground(workspace, location, manifest, {
        requireFresh: forceRefreshGeneration !== undefined,
        mustBuild: !current || forceRefreshGeneration !== undefined,
        forceRefreshGeneration
      });
      return {
        state: 'STALE',
        targets: targets.slice(0, MAX_RESULTS),
        references: [],
        referenceTruncated: false,
        paths: [],
        truncated: targets.length > MAX_RESULTS || manifest.truncated
      };
    }
    if (!current && cachedCandidates === undefined) {
      const failure = this.failures.get(location.directory);
      if (failure !== undefined) {
        this.failures.delete(location.directory);
        return emptyDefinitionResult({ state: 'FAILED', failureCode: failure });
      }
      this.startInitialBuild(workspace, location);
      return emptyDefinitionResult({ state: 'BUILDING' });
    }
    const requireFresh = !current;
    const prepared = await this.indexInput(workspace, requireFresh);
    if (!current) {
      const failure = this.failures.get(location.directory);
      if (failure !== undefined) {
        this.failures.delete(location.directory);
        return emptyDefinitionResult({ state: 'FAILED', failureCode: failure });
      }
      this.startBuild(prepared, location);
      return emptyDefinitionResult({ state: 'BUILDING' });
    }

    const fresh = manifest.sourceFingerprint === prepared.sourceFingerprint;
    const targets = await this.findTargets(tags, requestedSymbol, path, prepared);
    if (!fresh) {
      const failure = this.failures.get(location.directory);
      if (failure !== undefined && targets.length === 0) {
        this.failures.delete(location.directory);
        return emptyDefinitionResult({ state: 'FAILED', failureCode: failure });
      }
      this.startBuild(prepared, location, manifest);
      if (targets.length === 0) {
        return emptyDefinitionResult({
          state: 'BUILDING',
          truncated: prepared.truncated || manifest.truncated
        });
      }
    }
    const references =
      includeReferences === false
        ? { matches: [], truncated: false }
        : await this.findReferences(workspace, requestedSymbol, targets);
    return {
      state: fresh ? 'READY' : 'STALE',
      targets: targets.slice(0, MAX_RESULTS),
      references: references.matches,
      referenceTruncated: references.truncated,
      paths: [],
      truncated: targets.length > MAX_RESULTS || prepared.truncated || manifest.truncated
    };
  }

  forget(workspaceId: string): void {
    const location = this.locations.get(workspaceId);
    this.locations.delete(workspaceId);
    this.forceFreshCandidates.delete(workspaceId);
    if (location !== undefined) {
      this.failures.delete(location.directory);
      this.forgotten.add(location.directory);
      if (!this.builds.has(location.directory))
        void rm(location.directory, { recursive: true, force: true });
    }
  }

  /** A Node-originated write makes the next background refresh authoritative. */
  invalidate(workspaceId: string): void {
    this.forceFreshCandidates.set(
      workspaceId,
      (this.forceFreshCandidates.get(workspaceId) ?? 0) + 1
    );
  }

  private async available(): Promise<boolean> {
    const executable = this.executable();
    try {
      await access(executable, constants.X_OK);
      return true;
    } catch {
      if (this.options.ctagsExecutable !== undefined) return false;
      try {
        await repairBundledCtagsExecutable(
          this.options.platform ?? process.platform,
          this.options.architecture ?? process.arch
        );
        await access(executable, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }
  }

  private executable(): string {
    return (
      this.options.ctagsExecutable?.() ??
      bundledCtagsPath(
        this.options.platform ?? process.platform,
        this.options.architecture ?? process.arch
      )
    );
  }

  private async indexInput(workspace: NodeWorkspace, requireFresh: boolean): Promise<IndexInput> {
    const startedAt = Date.now();
    const candidates = await this.options.files
      .index(workspace)
      .contentCandidates({ requireFresh });
    return this.indexInputFromCandidates(
      await realpath(workspace.path),
      candidates.entries,
      candidates.truncated,
      Date.now() - startedAt
    );
  }

  private async manifestInput(
    workspace: NodeWorkspace,
    manifest: IndexManifest
  ): Promise<IndexInput> {
    const entries = Object.entries(manifest.sourceFiles ?? {})
      .map(([path, fingerprint]) => manifestEntry(path, fingerprint))
      .filter((entry): entry is WorkspaceFileEntry => entry !== undefined);
    return this.indexInputFromCandidates(
      await realpath(workspace.path),
      entries,
      manifest.truncated,
      0,
      manifest.sourceFingerprint,
      manifest.sourceFiles ?? {},
      true
    );
  }

  private indexInputFromCandidates(
    root: string,
    candidates: readonly WorkspaceFileEntry[],
    truncated: boolean,
    candidateScanMs: number,
    knownFingerprint?: string,
    knownSourceFiles?: Readonly<Record<string, string>>,
    revalidateSourceFingerprint = false
  ): IndexInput {
    const entries = candidates
      .filter(
        (entry) =>
          entry.size !== null &&
          entry.size <= MAX_SOURCE_BYTES &&
          isCtagsSourcePath(entry.path) &&
          !entry.path.includes('\n') &&
          !entry.path.includes('\r')
      )
      .sort((left, right) => left.path.localeCompare(right.path));
    let bytes = 0;
    const bounded: WorkspaceFileEntry[] = [];
    for (const entry of entries) {
      if (entry.size === null || bytes + entry.size > MAX_INDEX_BYTES) break;
      bytes += entry.size;
      bounded.push(entry);
    }
    const sourceFiles =
      knownSourceFiles ??
      Object.fromEntries(
        bounded.map((entry) => [entry.path, sourceFileFingerprint(entry.size!, entry.modifiedAt)])
      );
    return {
      root,
      entries: bounded,
      sourceFingerprint: knownFingerprint ?? sourceFingerprint(bounded),
      sourceFiles,
      truncated: truncated || bounded.length !== entries.length,
      candidateScanMs,
      revalidateSourceFingerprint
    };
  }

  private async indexLocation(workspace: NodeWorkspace): Promise<IndexLocation> {
    const path = normalizeWorkspacePath(await realpath(workspace.path));
    const hash = createHash('sha256').update(path).digest('hex');
    const nodeId = this.options.nodeId();
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(nodeId)) throw new Error('SYMBOL_INDEX_UNAVAILABLE');
    const base = this.options.indexHome?.() ?? resolve(homedir(), '.mar', 'workspace-indexes');
    const nodeDirectory = resolve(base, nodeId);
    const directory = resolve(nodeDirectory, hash);
    if (
      relative(nodeDirectory, directory)
        .split(sep)
        .some((part) => part === '..')
    )
      throw new Error('SYMBOL_INDEX_UNAVAILABLE');
    return {
      directory,
      manifest: resolve(directory, 'manifest.json'),
      generations: resolve(directory, 'generations')
    };
  }

  private startBuild(input: IndexInput, location: IndexLocation, previous?: IndexManifest): void {
    void this.ensureBuild(input, location, previous).catch((error: unknown) =>
      this.recordBuildFailure(location, error, input)
    );
  }

  private startInitialBuild(workspace: NodeWorkspace, location: IndexLocation): void {
    if (this.builds.has(location.directory) || this.preparations.has(location.directory)) return;
    const preparation = this.indexInput(workspace, true)
      .then((input) => {
        if (this.forgotten.has(location.directory)) return;
        return this.ensureBuild(input, location);
      })
      .catch((error: unknown) => this.recordBuildFailure(location, error))
      .finally(() => {
        if (this.preparations.get(location.directory) === preparation)
          this.preparations.delete(location.directory);
      });
    this.preparations.set(location.directory, preparation);
  }

  private recordBuildFailure(location: IndexLocation, error: unknown, input?: IndexInput): void {
    const failure = buildFailure(error);
    this.failures.set(location.directory, failure);
    nodeLog('workspace.code_navigation.index.failed', {
      nodeId: this.options.nodeId(),
      failureCode: failure,
      sourceFiles: input?.entries.length ?? 0,
      candidateScanMs: input?.candidateScanMs ?? 0
    });
  }

  private refreshCandidatesInBackground(
    workspace: NodeWorkspace,
    location: IndexLocation,
    manifest: IndexManifest,
    options: {
      readonly requireFresh: boolean;
      readonly mustBuild: boolean;
      readonly forceRefreshGeneration: number | undefined;
    } = {
      requireFresh: false,
      mustBuild: false,
      forceRefreshGeneration: undefined
    }
  ): void {
    if (this.candidateRefreshes.has(location.directory)) return;
    const startedAt = Date.now();
    const refresh = this.options.files
      .index(workspace)
      .refreshContentCandidates(options.requireFresh)
      .then(async () => {
        const prepared = await this.indexInput(workspace, false);
        const changed = prepared.sourceFingerprint !== manifest.sourceFingerprint;
        nodeLog('workspace.code_navigation.candidates.refreshed', {
          nodeId: this.options.nodeId(),
          sourceFiles: prepared.entries.length,
          candidateScanMs: prepared.candidateScanMs,
          elapsedMs: Date.now() - startedAt,
          changed
        });
        if (changed || options.mustBuild) this.startBuild(prepared, location, manifest);
        if (
          options.forceRefreshGeneration !== undefined &&
          this.forceFreshCandidates.get(workspace.id) === options.forceRefreshGeneration
        )
          this.forceFreshCandidates.delete(workspace.id);
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.candidateRefreshes.get(location.directory) === refresh)
          this.candidateRefreshes.delete(location.directory);
      });
    this.candidateRefreshes.set(location.directory, refresh);
  }

  private ensureBuild(
    input: IndexInput,
    location: IndexLocation,
    previous?: IndexManifest
  ): Promise<void> {
    const active = this.builds.get(location.directory);
    if (active !== undefined) return active;
    const build = this.build(input, location, previous).finally(async () => {
      if (this.builds.get(location.directory) === build) this.builds.delete(location.directory);
      if (this.forgotten.delete(location.directory))
        await rm(location.directory, { recursive: true, force: true });
    });
    this.builds.set(location.directory, build);
    return build;
  }

  private async build(
    input: IndexInput,
    location: IndexLocation,
    previous?: IndexManifest
  ): Promise<void> {
    const startedAt = Date.now();
    const executable = this.executable();
    await access(executable, constants.X_OK);
    await ensurePrivateDirectory(location.directory);
    await ensurePrivateDirectory(location.generations);
    const generation = randomUUID();
    const staging = resolve(location.generations, `${generation}.staging`);
    const committed = resolve(location.generations, generation);
    try {
      await ensurePrivateDirectory(staging);
      const fileList = resolve(staging, 'files.list');
      const tags = resolve(staging, 'tags');
      const oldTags =
        previous?.sourceFiles === undefined
          ? undefined
          : await tagsPath(location, previous).catch(() => undefined);
      const delta =
        oldTags === undefined || previous?.sourceFiles === undefined
          ? undefined
          : sourceDelta(previous.sourceFiles, input.sourceFiles);
      let ctagsMs: number;
      let mode: 'full' | 'incremental';
      if (delta === undefined || delta.changed.length + delta.removed.length > 1024) {
        mode = 'full';
        await writeFile(fileList, input.entries.map((entry) => entry.path).join('\n'), {
          encoding: 'utf8',
          mode: 0o600
        });
        const release = await acquireBuild();
        try {
          ctagsMs = await runCtags(executable, input.root, fileList, tags);
        } finally {
          release();
        }
      } else {
        mode = 'incremental';
        ctagsMs = await buildIncrementalTags(
          executable,
          input.root,
          oldTags!,
          delta,
          staging,
          tags
        );
      }
      const tagsMetadata = await stat(tags);
      if (!tagsMetadata.isFile() || tagsMetadata.size > MAX_TAGS_BYTES)
        throw new Error('SYMBOL_INDEX_LIMIT_EXCEEDED');
      if (this.forgotten.has(location.directory)) return;
      await rename(staging, committed);
      const manifest: IndexManifest = {
        schemaVersion: INDEX_SCHEMA_VERSION,
        optionsVersion: INDEX_OPTIONS_VERSION,
        ctagsVersion: BUNDLED_CTAGS_VERSION,
        sourceFingerprint: input.sourceFingerprint,
        sourceFiles: input.sourceFiles,
        truncated: input.truncated,
        generation
      };
      const manifestNext = resolve(location.directory, `manifest.${generation}.next.json`);
      await writeFile(manifestNext, JSON.stringify(manifest), { encoding: 'utf8', mode: 0o600 });
      await rename(manifestNext, location.manifest);
      this.failures.delete(location.directory);
      await removeInactiveGenerations(location.generations, generation);
      nodeLog('workspace.code_navigation.index.completed', {
        nodeId: this.options.nodeId(),
        mode,
        sourceFiles: input.entries.length,
        sourceBytes: input.entries.reduce((total, entry) => total + (entry.size ?? 0), 0),
        candidateScanMs: input.candidateScanMs,
        ctagsMs,
        tagsBytes: tagsMetadata.size,
        elapsedMs: Date.now() - startedAt
      });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  private async findTargets(
    tags: string,
    symbol: string,
    currentPath: string,
    input: IndexInput
  ): Promise<WorkspaceSymbolDefinitionTarget[]> {
    const handle = await open(tags, 'r');
    try {
      const size = (await handle.stat()).size;
      const first = await firstTagOffset(handle, size, symbol);
      const candidates = new Set(input.entries.map((entry) => entry.path));
      const records: TagRecord[] = [];
      let offset = first;
      while (offset < size && records.length < MAX_CANDIDATES) {
        const line = await readTagLine(handle, offset, size);
        if (line === undefined) break;
        offset = line.nextOffset;
        const tag = parseTag(line.text);
        if (tag === undefined || tag.name !== symbol) {
          if (tag !== undefined && compareTagNames(tag.name, symbol) > 0) break;
          continue;
        }
        if (!candidates.has(tag.path)) continue;
        records.push(tag);
      }
      const valid = await Promise.all(
        records.map(async (record) => ({
          record,
          preview: await validateSymbolTarget(
            input.root,
            record,
            symbol,
            input.revalidateSourceFingerprint ? input.sourceFiles[record.path] : undefined
          )
        }))
      );
      return valid
        .flatMap(({ record, preview }) => (preview === undefined ? [] : [{ ...record, preview }]))
        .sort((left, right) => compareTargets(left, right, currentPath))
        .map(({ path, line, kind, scope, preview }) => ({ path, line, kind, scope, preview }));
    } finally {
      await handle.close();
    }
  }

  private async findReferences(
    workspace: NodeWorkspace,
    symbol: string,
    definitions: readonly WorkspaceSymbolDefinitionTarget[]
  ): Promise<{
    readonly matches: WorkspaceSymbolDefinition['references'];
    readonly truncated: boolean;
  }> {
    if (this.options.searchContent === undefined) return { matches: [], truncated: false };
    try {
      const search = await this.options.searchContent(workspace, symbol);
      const definitionLocations = new Set(
        definitions.map((target) => `${target.path}:${target.line}`)
      );
      const matches = search.matches
        .filter(
          (match) =>
            !definitionLocations.has(`${match.path}:${match.line}`) &&
            containsSymbol(match.preview, symbol)
        )
        .slice(0, MAX_REFERENCES)
        .map(({ path, line, column, preview }) => ({ path, line, column, preview }));
      return {
        matches,
        truncated: search.truncated || search.matches.length > MAX_REFERENCES
      };
    } catch {
      return { matches: [], truncated: false };
    }
  }

  private async resolvePath(
    workspace: NodeWorkspace,
    currentPath: string,
    reference: FileReference
  ): Promise<WorkspaceSymbolDefinition> {
    const direct = await this.resolveDirectPathTargets(workspace, currentPath, reference);
    if (direct.length > 0)
      return {
        state: 'READY',
        targets: [],
        references: [],
        referenceTruncated: false,
        paths: direct,
        truncated: false
      };
    const location = await this.indexLocation(workspace);
    this.locations.set(workspace.id, location);
    this.forgotten.delete(location.directory);
    const manifest = await readManifest(location.manifest);
    const tags =
      manifest === undefined
        ? undefined
        : await tagsPath(location, manifest).catch(() => undefined);
    const tagsReady = tags !== undefined && (await tagsAvailable(tags));
    const fileIndex = this.options.files.index(workspace);
    const cachedCandidates = fileIndex.peekContentCandidates();
    const forceRefreshGeneration = this.forceFreshCandidates.get(workspace.id);
    const reusable =
      manifest !== undefined &&
      tags !== undefined &&
      tagsReady &&
      manifest.sourceFiles !== undefined;
    const current =
      reusable &&
      manifest.schemaVersion === INDEX_SCHEMA_VERSION &&
      manifest.optionsVersion === INDEX_OPTIONS_VERSION &&
      manifest.ctagsVersion === BUNDLED_CTAGS_VERSION;
    const stale =
      reusable &&
      (!current || cachedCandidates === undefined || forceRefreshGeneration !== undefined);
    const input = stale
      ? await this.manifestInput(workspace, manifest)
      : await this.indexInput(workspace, false);
    if (stale)
      this.refreshCandidatesInBackground(workspace, location, manifest, {
        requireFresh: forceRefreshGeneration !== undefined,
        mustBuild: !current || forceRefreshGeneration !== undefined,
        forceRefreshGeneration
      });
    const resolved = await this.resolvePathTargets(input, currentPath, reference);
    return {
      state: stale ? 'STALE' : 'READY',
      targets: [],
      references: [],
      referenceTruncated: false,
      paths: resolved.targets,
      truncated: input.truncated || resolved.truncated
    };
  }

  private async resolveDirectPathTargets(
    workspace: NodeWorkspace,
    currentPath: string,
    reference: FileReference
  ): Promise<WorkspaceSymbolDefinition['paths']> {
    const handler = pathSpecifierResolver(reference.languageId, reference.value);
    const candidates = handler?.directCandidates?.(currentPath, reference.value) ?? [];
    const targets = await Promise.all(
      candidates.slice(0, MAX_RESULTS).map(async (path) => {
        const target = await validatePathTarget(
          workspace.path,
          path,
          undefined,
          reference.anchor,
          handler?.anchorLine
        );
        return target === undefined
          ? undefined
          : {
              path,
              line: target.line,
              kind: 'file' as const,
              ...(target.preview.length === 0 ? {} : { preview: targetPreview(target.preview) }),
              scope: undefined
            };
      })
    );
    return targets.flatMap((target) => (target === undefined ? [] : [target]));
  }

  private async resolvePathTargets(
    input: IndexInput,
    currentPath: string,
    reference: FileReference
  ): Promise<{
    readonly targets: WorkspaceSymbolDefinition['paths'];
    readonly truncated: boolean;
  }> {
    const handler = pathSpecifierResolver(reference.languageId, reference.value);
    if (handler === undefined) return { targets: [], truncated: false };
    const targets = input.entries
      .map((entry) => entry.path)
      .filter((path) => handler.matches(path, currentPath, reference.value))
      .sort(
        (left, right) =>
          handler.score(left, currentPath, reference.value) -
          handler.score(right, currentPath, reference.value)
      )
      .slice(0, MAX_RESULTS);
    const resolved = await Promise.all(
      targets.map(async (path) => {
        const target = await validatePathTarget(
          input.root,
          path,
          input.revalidateSourceFingerprint ? input.sourceFiles[path] : undefined,
          reference.anchor,
          handler.anchorLine
        );
        return target === undefined
          ? undefined
          : {
              path,
              line: target.line,
              kind: 'file' as const,
              ...(target.preview.length === 0 ? {} : { preview: targetPreview(target.preview) }),
              scope: undefined
            };
      })
    );
    return {
      targets: resolved.flatMap((target) => (target === undefined ? [] : [target])),
      truncated: targets.length >= MAX_RESULTS
    };
  }
}

function emptyDefinitionResult(
  input: Pick<WorkspaceSymbolDefinition, 'state'> &
    Partial<Pick<WorkspaceSymbolDefinition, 'truncated' | 'failureCode'>>
): WorkspaceSymbolDefinition {
  return {
    state: input.state,
    targets: [],
    references: [],
    referenceTruncated: false,
    paths: [],
    truncated: input.truncated ?? false,
    ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode })
  };
}

function isCtagsSourcePath(path: string): boolean {
  return supportsSymbolNavigationPath(path);
}

function buildFailure(error: unknown): BuildFailure {
  return error instanceof Error && error.message === 'SYMBOL_INDEX_LIMIT_EXCEEDED'
    ? 'SYMBOL_INDEX_LIMIT_EXCEEDED'
    : 'SYMBOL_INDEX_BUILD_FAILED';
}
