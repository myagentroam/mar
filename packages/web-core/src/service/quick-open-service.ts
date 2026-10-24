import { reactive, ref } from 'vue';
import type { WorkspaceFileList, WorkspaceSymbolDefinition } from '@myagentroam/protocol';
import type { NodeSummary, Workspace, WorkspaceTab } from '../model/workbench.js';
import type { ScopedHttpService } from './scoped-http-service.js';
import { ApiError, apiErrorFromResponse } from '../util/api-error.js';
import { workspaceFileTarget } from '../util/file-preview.js';

export interface QuickOpenWorkspaceCandidate {
  readonly kind: 'WORKSPACE';
  readonly key: string;
  readonly nodeId: string;
  readonly nodeLabel: string;
  readonly workspaceId: string;
  readonly workspaceLabel: string;
  readonly path: string;
  readonly openTabIndex?: number;
  readonly stableIndex: number;
}

export interface QuickOpenFileCandidate {
  readonly kind: 'FILE';
  readonly key: string;
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly path: string;
  readonly name: string;
  readonly score?: number;
  readonly line?: number;
  readonly column?: number;
  readonly stableIndex: number;
}

export interface QuickOpenSymbolCandidate {
  readonly kind: 'SYMBOL';
  readonly source: 'DEFINITION' | 'REFERENCE';
  readonly key: string;
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly symbol: string;
  readonly path: string;
  readonly line: number;
  readonly column?: number;
  readonly detail?: string | undefined;
  readonly stableIndex: number;
}

export interface QuickOpenSessionCandidate {
  readonly kind: 'SESSION';
  readonly key: string;
  readonly sessionId: string;
  readonly title: string;
  readonly runner: string;
  readonly stableIndex: number;
}

export type QuickOpenCandidate =
  | QuickOpenWorkspaceCandidate
  | QuickOpenFileCandidate
  | QuickOpenSymbolCandidate
  | QuickOpenSessionCandidate;

function subsequence(value: string, term: string): boolean {
  let cursor = 0;
  for (const character of term) {
    const index = value.indexOf(character, cursor);
    if (index < 0) return false;
    cursor = index + 1;
  }
  return true;
}

function termScore(value: string, term: string): number | undefined {
  if (value === term) return 1_000;
  if (value.startsWith(term)) return 700;
  if (value.includes(term)) return 500;
  return subsequence(value, term) ? 100 : undefined;
}

export function quickOpenScore(values: readonly string[], query: string): number | undefined {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return 0;
  const normalized = values.map((value) => value.toLocaleLowerCase());
  let score = 0;
  for (const term of terms) {
    const best = normalized.reduce<number | undefined>((result, value) => {
      const current = termScore(value, term);
      return current === undefined ? result : Math.max(result ?? current, current);
    }, undefined);
    if (best === undefined) return undefined;
    score += best;
  }
  return score;
}

function candidateScore(candidate: QuickOpenCandidate, query: string): number | undefined {
  if (candidate.kind === 'WORKSPACE') return quickOpenScore([candidate.workspaceLabel], query);
  if (candidate.kind === 'SYMBOL') return quickOpenScore([candidate.symbol, candidate.path], query);
  if (candidate.kind === 'SESSION') return quickOpenScore([candidate.title], query);
  if (candidate.score !== undefined) return candidate.score;
  return quickOpenScore([candidate.name, candidate.path], query);
}

function typeRank(candidate: QuickOpenCandidate): number {
  if (candidate.kind === 'WORKSPACE') return 0;
  if (candidate.kind === 'SESSION') return 1;
  if (candidate.kind === 'FILE') return 2;
  return 3;
}

export function sortQuickOpenCandidates(
  candidates: readonly QuickOpenCandidate[],
  query: string
): QuickOpenCandidate[] {
  return candidates
    .flatMap((candidate) => {
      const score = candidateScore(candidate, query);
      return score === undefined ? [] : [{ candidate, score }];
    })
    .sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      const rank = typeRank(left.candidate) - typeRank(right.candidate);
      if (rank !== 0) return rank;
      if (left.candidate.kind === 'WORKSPACE' && right.candidate.kind === 'WORKSPACE') {
        const openRank =
          (left.candidate.openTabIndex ?? Number.MAX_SAFE_INTEGER) -
          (right.candidate.openTabIndex ?? Number.MAX_SAFE_INTEGER);
        if (openRank !== 0) return openRank;
      }
      if (
        left.candidate.kind === 'SYMBOL' &&
        right.candidate.kind === 'SYMBOL' &&
        left.candidate.source !== right.candidate.source
      )
        return left.candidate.source === 'DEFINITION' ? -1 : 1;
      return left.candidate.stableIndex - right.candidate.stableIndex;
    })
    .map(({ candidate }) => candidate);
}

export function openWorkspaceTabIndex(
  tabs: readonly WorkspaceTab[],
  nodeId: string,
  workspaceId: string
): number | undefined {
  const index = tabs.findIndex((tab) => tab.nodeId === nodeId && tab.workspaceId === workspaceId);
  return index < 0 ? undefined : index;
}

export type QuickOpenTab = 'ALL' | 'WORKSPACE' | 'SESSION' | 'SYMBOL' | 'FILE';
export type QuickOpenQueryPhase =
  'IDLE' | 'SEARCHING' | 'BUILDING' | 'READY' | 'FAILED' | 'UNAVAILABLE' | 'TIMED_OUT' | 'INVALID';
export interface QuickOpenSourceStatus {
  phase: QuickOpenQueryPhase;
  error: unknown;
  truncated: boolean;
}

interface QuickOpenQueryOptions {
  readonly open: () => boolean;
  readonly query: () => string;
  readonly tab: () => QuickOpenTab;
  readonly nodeId: () => string | undefined;
  readonly workspaceId: () => string | undefined;
  readonly filesReady: () => boolean;
  readonly symbolsReady: () => boolean;
  readonly nonblockingFiles: () => boolean;
  readonly nodes: () => readonly NodeSummary[];
  readonly workspaceTabs: () => readonly WorkspaceTab[];
  readonly origin: () => string;
  readonly http: ScopedHttpService;
  readonly deadlineMs?: number;
}

interface QueryScope {
  readonly controller: AbortController;
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly query: string;
  readonly tab: QuickOpenTab;
  readonly deadline: ReturnType<typeof setTimeout>;
  pending: number;
}

type FileSearchResult = Omit<WorkspaceFileList, 'entries'> & {
  readonly entries: readonly (WorkspaceFileList['entries'][number] & { readonly score?: number })[];
  readonly indexState?: 'BUILDING' | 'READY';
};

/** Owns foreground query cancellation; it does not create a Workspace Watch. */
export function createQuickOpenQueryService(options: QuickOpenQueryOptions) {
  const workspaces = ref<QuickOpenWorkspaceCandidate[]>([]);
  const files = ref<QuickOpenFileCandidate[]>([]);
  const symbols = ref<QuickOpenSymbolCandidate[]>([]);
  const fileCursor = ref<string | null>(null);
  const status = () =>
    reactive<QuickOpenSourceStatus>({ phase: 'IDLE', error: undefined, truncated: false });
  const workspaceStatus = status();
  const fileStatus = status();
  const symbolStatus = status();
  const referenceStatus = status();
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let scope: QueryScope | undefined;
  let workspaceController: AbortController | undefined;
  let workspaceDeadline: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const workspaceCache = new Map<string, { at: number; entries: readonly Workspace[] }>();

  function reset(source: QuickOpenSourceStatus, phase: QuickOpenQueryPhase = 'IDLE'): void {
    source.phase = phase;
    source.error = undefined;
    source.truncated = false;
  }

  function current(value: QueryScope): boolean {
    return (
      !disposed &&
      scope === value &&
      !value.controller.signal.aborted &&
      options.open() &&
      value.query === options.query().trim() &&
      value.tab === options.tab() &&
      value.nodeId === options.nodeId() &&
      value.workspaceId === options.workspaceId()
    );
  }

  function pause(value: QueryScope, milliseconds: number): Promise<boolean> {
    if (!current(value)) return Promise.resolve(false);
    return new Promise((resolve) => {
      const signal = value.controller.signal;
      const finish = (continued: boolean) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', aborted);
        resolve(continued && current(value));
      };
      const aborted = () => finish(false);
      const timer = setTimeout(() => finish(true), milliseconds);
      signal.addEventListener('abort', aborted, { once: true });
    });
  }

  function cancelQuery(): void {
    if (debounce !== undefined) clearTimeout(debounce);
    debounce = undefined;
    if (scope !== undefined) {
      clearTimeout(scope.deadline);
      scope.controller.abort();
      scope = undefined;
    }
  }

  function cancel(): void {
    cancelQuery();
    workspaceController?.abort();
    workspaceController = undefined;
    if (workspaceDeadline !== undefined) clearTimeout(workspaceDeadline);
    workspaceDeadline = undefined;
    [workspaceStatus, fileStatus, symbolStatus, referenceStatus].forEach((source) => reset(source));
  }

  function timedOut(value: QueryScope): void {
    if (!current(value)) return;
    for (const source of [fileStatus, symbolStatus, referenceStatus]) {
      if (source.phase === 'SEARCHING' || source.phase === 'BUILDING') source.phase = 'TIMED_OUT';
    }
    value.controller.abort();
  }

  async function run(value: QueryScope, operation: () => Promise<void>): Promise<void> {
    value.pending += 1;
    try {
      await operation();
    } finally {
      value.pending -= 1;
      if (value.pending === 0) clearTimeout(value.deadline);
    }
  }

  function scheduleSearch(): void {
    const retain =
      scope !== undefined &&
      scope.query === options.query().trim() &&
      scope.nodeId === options.nodeId() &&
      scope.workspaceId === options.workspaceId() &&
      scope.tab === options.tab();
    cancelQuery();
    if (!retain) {
      files.value = [];
      symbols.value = [];
    }
    fileCursor.value = null;
    [fileStatus, symbolStatus, referenceStatus].forEach((source) => reset(source));
    if (disposed || !options.open() || options.query().trim() === '') return;
    const tab = options.tab();
    const hasTarget = options.nodeId() !== undefined && options.workspaceId() !== undefined;
    const searchFile = (tab === 'ALL' || tab === 'FILE') && options.filesReady() && hasTarget;
    const validSymbol = /^-*[\p{L}_$][\p{L}\p{N}_$-]*$/u.test(options.query().trim());
    const searchSymbol =
      (tab === 'ALL' || tab === 'SYMBOL') && options.symbolsReady() && hasTarget && validSymbol;
    if (searchFile) fileStatus.phase = 'SEARCHING';
    else if (tab === 'FILE') fileStatus.phase = 'UNAVAILABLE';
    if (searchSymbol) symbolStatus.phase = 'SEARCHING';
    else if (tab === 'SYMBOL') symbolStatus.phase = !validSymbol ? 'INVALID' : 'UNAVAILABLE';
    if (!searchFile && !searchSymbol) return;
    debounce = setTimeout(() => {
      debounce = undefined;
      if (disposed || !options.open() || !hasTarget) return;
      const value: QueryScope = {
        controller: new AbortController(),
        nodeId: options.nodeId()!,
        workspaceId: options.workspaceId()!,
        query: options.query().trim(),
        tab: options.tab(),
        pending: 0,
        deadline: setTimeout(() => timedOut(value), options.deadlineMs ?? 30_000)
      };
      scope = value;
      if (searchFile) void run(value, () => searchFiles(value));
      if (searchSymbol)
        void run(value, async () => {
          if (value.tab === 'ALL' && !(await pause(value, 180))) return;
          await searchSymbols(value);
        });
    }, 120);
  }

  async function searchFiles(value: QueryScope): Promise<void> {
    const location = workspaceFileTarget(value.query, undefined, options.origin());
    const parameters = new URLSearchParams({
      nodeId: value.nodeId,
      q: location?.path ?? value.query
    });
    if (options.nonblockingFiles()) parameters.set('waitForIndex', 'false');
    try {
      for (let attempt = 0; current(value); attempt += 1) {
        const result = await options.http.request<{ files: FileSearchResult }>(
          `/api/workspaces/${encodeURIComponent(value.workspaceId)}/files/search?${parameters}`,
          { signal: value.controller.signal }
        );
        if (!current(value)) return;
        if (!Array.isArray(result.files?.entries))
          throw new ApiError(
            'NODE_RESPONSE_INVALID',
            'The Node returned an invalid file search result.'
          );
        if (result.files.indexState === 'BUILDING') {
          fileStatus.phase = 'BUILDING';
          if (!(await pause(value, Math.min(250 * 2 ** attempt, 2_000)))) return;
          continue;
        }
        files.value = result.files.entries.flatMap((entry, index) =>
          entry.kind === 'FILE'
            ? [
                {
                  kind: 'FILE' as const,
                  key: `file\0${value.nodeId}\0${value.workspaceId}\0${entry.path}`,
                  nodeId: value.nodeId,
                  workspaceId: value.workspaceId,
                  path: entry.path,
                  name: entry.name,
                  ...(entry.score === undefined ? {} : { score: entry.score }),
                  ...(location?.line === undefined ? {} : { line: location.line }),
                  ...(location?.column === undefined ? {} : { column: location.column }),
                  stableIndex: index
                }
              ]
            : []
        );
        fileCursor.value = result.files.nextCursor ?? null;
        fileStatus.truncated = result.files.truncated === true || fileCursor.value !== null;
        fileStatus.phase = 'READY';
        return;
      }
    } catch (error) {
      if (current(value)) {
        fileStatus.phase = 'FAILED';
        fileStatus.error = error;
      }
    }
  }

  function definitionCandidates(
    value: QueryScope,
    result: WorkspaceSymbolDefinition
  ): QuickOpenSymbolCandidate[] {
    return result.targets.map((target, index) => ({
      kind: 'SYMBOL',
      source: 'DEFINITION',
      key: `symbol\0definition\0${target.path}\0${target.line}\0${value.query}`,
      nodeId: value.nodeId,
      workspaceId: value.workspaceId,
      symbol: value.query,
      path: target.path,
      line: target.line,
      detail: [target.kind, target.scope].filter(Boolean).join(' · ') || target.preview,
      stableIndex: index
    }));
  }

  function applyReferences(value: QueryScope, result: WorkspaceSymbolDefinition): void {
    const definitions = symbols.value.filter((entry) => entry.source === 'DEFINITION');
    symbols.value = [
      ...definitions,
      ...result.references.map((reference, index): QuickOpenSymbolCandidate => ({
        kind: 'SYMBOL',
        source: 'REFERENCE',
        key: `symbol\0reference\0${reference.path}\0${reference.line}\0${reference.column}\0${value.query}`,
        nodeId: value.nodeId,
        workspaceId: value.workspaceId,
        symbol: value.query,
        path: reference.path,
        line: reference.line,
        column: reference.column,
        detail: reference.preview,
        stableIndex: definitions.length + index
      }))
    ];
    referenceStatus.truncated = result.referenceTruncated === true;
  }

  function definitionFailure(
    source: QuickOpenSourceStatus,
    result: WorkspaceSymbolDefinition
  ): boolean {
    if (result.state === 'UNAVAILABLE') {
      source.phase = 'UNAVAILABLE';
      return true;
    }
    if (result.state !== 'FAILED') return false;
    source.phase = 'FAILED';
    source.error = apiErrorFromResponse(
      { error: result.failureCode ?? 'SYMBOL_INDEX_BUILD_FAILED' },
      503
    );
    return true;
  }

  async function requestDefinition(
    value: QueryScope,
    references: boolean
  ): Promise<WorkspaceSymbolDefinition> {
    const parameters = new URLSearchParams({
      nodeId: value.nodeId,
      path: '.',
      symbol: value.query,
      references: references ? '1' : '0'
    });
    const result = await options.http.request<{ definition: WorkspaceSymbolDefinition }>(
      `/api/workspaces/${encodeURIComponent(value.workspaceId)}/symbols/definition?${parameters}`,
      { signal: value.controller.signal }
    );
    if (
      !result.definition ||
      !Array.isArray(result.definition.targets) ||
      !Array.isArray(result.definition.references)
    )
      throw new ApiError('NODE_RESPONSE_INVALID', 'The Node returned an invalid symbol result.');
    return result.definition;
  }

  async function searchSymbols(value: QueryScope): Promise<void> {
    try {
      for (let attempt = 0; current(value); attempt += 1) {
        const result = await requestDefinition(value, false);
        if (!current(value)) return;
        if (definitionFailure(symbolStatus, result)) return;
        if (result.targets.length > 0 || result.state === 'READY')
          symbols.value = definitionCandidates(value, result);
        symbolStatus.truncated = result.truncated === true;
        if (result.state === 'READY') {
          symbolStatus.phase = 'READY';
          referenceStatus.phase = 'SEARCHING';
          await searchReferences(value);
          return;
        }
        symbolStatus.phase = 'BUILDING';
        if (!(await pause(value, Math.min(250 * 2 ** attempt, 2_000)))) return;
      }
    } catch (error) {
      if (current(value)) {
        symbolStatus.phase = 'FAILED';
        symbolStatus.error = error;
      }
    }
  }

  async function searchReferences(value: QueryScope): Promise<void> {
    try {
      for (let attempt = 0; current(value); attempt += 1) {
        const result = await requestDefinition(value, true);
        if (!current(value)) return;
        if (definitionFailure(referenceStatus, result)) return;
        if (result.references.length > 0 || result.state === 'READY')
          applyReferences(value, result);
        if (result.state === 'READY') {
          referenceStatus.phase = 'READY';
          return;
        }
        referenceStatus.phase = 'BUILDING';
        if (!(await pause(value, Math.min(250 * 2 ** attempt, 2_000)))) return;
      }
    } catch (error) {
      if (current(value)) {
        referenceStatus.phase = 'FAILED';
        referenceStatus.error = error;
      }
    }
  }

  function workspaceCandidate(
    node: NodeSummary,
    workspace: Pick<Workspace, 'id' | 'displayName' | 'path'>,
    stableIndex: number
  ): QuickOpenWorkspaceCandidate {
    const openTabIndex = openWorkspaceTabIndex(options.workspaceTabs(), node.id, workspace.id);
    return {
      kind: 'WORKSPACE',
      key: `workspace\0${node.id}\0${workspace.id}`,
      nodeId: node.id,
      nodeLabel: node.displayName?.trim() || node.registeredAddress || node.id,
      workspaceId: workspace.id,
      workspaceLabel: workspace.displayName?.trim() || workspace.path,
      path: workspace.path,
      ...(openTabIndex === undefined ? {} : { openTabIndex }),
      stableIndex
    };
  }

  async function loadWorkspaces(): Promise<void> {
    workspaceController?.abort();
    if (workspaceDeadline !== undefined) clearTimeout(workspaceDeadline);
    if (disposed || !options.open()) return;
    reset(workspaceStatus);
    const nodes = options.nodes().filter((node) => node.connected && !node.disabled);
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const candidates = new Map<string, QuickOpenWorkspaceCandidate>();
    options.workspaceTabs().forEach((tab, index) => {
      const node = nodesById.get(tab.nodeId);
      if (node !== undefined) {
        const candidate = workspaceCandidate(
          node,
          { id: tab.workspaceId, displayName: tab.label, path: tab.label },
          index
        );
        candidates.set(candidate.key, candidate);
      }
    });
    function merge(node: NodeSummary, entries: readonly Workspace[], nodeIndex: number): void {
      entries.forEach((entry, index) => {
        const candidate = workspaceCandidate(
          node,
          entry,
          options.workspaceTabs().length + nodeIndex * 100_000 + index
        );
        const previous = candidates.get(candidate.key);
        candidates.set(
          candidate.key,
          previous?.openTabIndex === undefined
            ? candidate
            : { ...candidate, stableIndex: previous.stableIndex }
        );
      });
      workspaces.value = [...candidates.values()];
    }
    const missing: Array<{ node: NodeSummary; index: number }> = [];
    nodes.forEach((node, index) => {
      const cached = workspaceCache.get(node.id);
      if (cached !== undefined && Date.now() - cached.at < 30_000)
        merge(node, cached.entries, index);
      else missing.push({ node, index });
    });
    workspaces.value = [...candidates.values()];
    if (missing.length === 0) {
      workspaceStatus.phase = 'READY';
      return;
    }
    const controller = new AbortController();
    workspaceController = controller;
    const live = () =>
      !disposed &&
      workspaceController === controller &&
      !controller.signal.aborted &&
      options.open();
    workspaceStatus.phase = 'SEARCHING';
    workspaceDeadline = setTimeout(() => {
      if (!live()) return;
      workspaceStatus.phase = 'TIMED_OUT';
      controller.abort();
    }, options.deadlineMs ?? 30_000);
    let cursor = 0;
    const worker = async () => {
      while (live()) {
        const target = missing[cursor++];
        if (target === undefined) return;
        try {
          const result = await options.http.request<{ workspaces: Workspace[] }>(
            `/api/workspaces?nodeId=${encodeURIComponent(target.node.id)}`,
            { signal: controller.signal }
          );
          if (!live()) return;
          if (!Array.isArray(result.workspaces))
            throw new ApiError(
              'NODE_RESPONSE_INVALID',
              'The Node returned an invalid Workspace list.'
            );
          workspaceCache.delete(target.node.id);
          workspaceCache.set(target.node.id, { at: Date.now(), entries: result.workspaces });
          if (workspaceCache.size > 32) workspaceCache.delete(workspaceCache.keys().next().value!);
          merge(target.node, result.workspaces, target.index);
        } catch (error) {
          if (live()) workspaceStatus.error = error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, missing.length) }, worker));
    if (workspaceController === controller) {
      clearTimeout(workspaceDeadline);
      workspaceDeadline = undefined;
      if (live()) workspaceStatus.phase = workspaceStatus.error === undefined ? 'READY' : 'FAILED';
    }
  }

  function dispose(): void {
    disposed = true;
    cancel();
    workspaceCache.clear();
  }

  return {
    workspaces,
    files,
    symbols,
    fileCursor,
    workspaceStatus,
    fileStatus,
    symbolStatus,
    referenceStatus,
    scheduleSearch,
    loadWorkspaces,
    cancel,
    dispose
  };
}
