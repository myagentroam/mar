import { readonly, ref, shallowRef } from 'vue';
import {
  workspaceSymbolDefinitionSchema,
  workspaceSymbolIndexPreparationSchema,
  type WorkspaceSymbolDefinition
} from '@myagentroam/protocol';
import type { ScopedHttpService } from './scoped-http-service.js';
import type {
  FileNavigationRequest,
  WorkspaceNavigationNotice,
  WorkspaceNavigationTarget
} from '../model/workspace-navigation.js';

interface NavigationSource {
  readonly pageId: number;
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly path: string;
}

function createPageState() {
  return {
    navigationLoading: ref(false),
    navigationTargets: shallowRef<readonly WorkspaceNavigationTarget[]>([]),
    navigationNoDefinition: ref(false),
    navigationNotice: ref<WorkspaceNavigationNotice>()
  };
}

function navigationNotice(
  definition: WorkspaceSymbolDefinition
): WorkspaceNavigationNotice | undefined {
  if (definition.state === 'UNAVAILABLE') return 'UNAVAILABLE';
  if (definition.state === 'FAILED' && definition.failureCode === 'SYMBOL_INDEX_LIMIT_EXCEEDED')
    return 'LIMITED';
  return;
}

export function createWorkspaceCodeNavigationService(options: {
  readonly http: ScopedHttpService;
  readonly onFailure: (error: unknown) => void;
  readonly onFileTarget: (target: WorkspaceNavigationTarget, pageId: number) => void;
}) {
  const pages = new Map<number, ReturnType<typeof createPageState>>();
  let generation = 0;
  let activePageId: number | undefined;
  let finishWait: (() => void) | undefined;

  function page(pageId: number) {
    let state = pages.get(pageId);
    if (state === undefined) {
      state = createPageState();
      pages.set(pageId, state);
    }
    return {
      navigationLoading: readonly(state.navigationLoading),
      navigationTargets: readonly(state.navigationTargets),
      navigationNoDefinition: readonly(state.navigationNoDefinition),
      navigationNotice: readonly(state.navigationNotice)
    };
  }

  function cancel(): void {
    generation += 1;
    finishWait?.();
    const state = activePageId === undefined ? undefined : pages.get(activePageId);
    if (state !== undefined) state.navigationLoading.value = false;
    activePageId = undefined;
  }

  function clear(pageId?: number): void {
    cancel();
    const state = pageId === undefined ? undefined : pages.get(pageId);
    if (state === undefined) return;
    state.navigationLoading.value = false;
    state.navigationTargets.value = [];
    state.navigationNoDefinition.value = false;
    state.navigationNotice.value = undefined;
  }

  function release(pageId: number): void {
    clear(pageId);
    pages.delete(pageId);
  }

  function reset(): void {
    cancel();
    pages.clear();
  }

  function wait(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, 1_000);
      function done(): void {
        clearTimeout(timer);
        finishWait = undefined;
        resolve();
      }
      finishWait = done;
    });
  }

  function endpoint(source: Pick<NavigationSource, 'workspaceId'>): string {
    return `/api/workspaces/${encodeURIComponent(source.workspaceId)}/symbols`;
  }

  async function query(
    request: () => Promise<unknown>,
    current: () => boolean
  ): Promise<WorkspaceSymbolDefinition | undefined> {
    for (let attempt = 0; attempt < 120 && current(); attempt += 1) {
      const result = await request();
      if (!current()) return;
      const parsed = workspaceSymbolDefinitionSchema.safeParse(
        (result as { readonly definition?: unknown } | null)?.definition
      );
      if (!parsed.success) throw new Error('NODE_RESPONSE_INVALID');
      if (parsed.data.state === 'BUILDING') {
        await wait();
        continue;
      }
      if (parsed.data.state === 'FAILED' && navigationNotice(parsed.data) === undefined)
        throw new Error(parsed.data.failureCode ?? 'SYMBOL_INDEX_BUILD_FAILED');
      return parsed.data;
    }
    if (current()) throw new Error('SYMBOL_INDEX_BUILD_FAILED');
    return;
  }

  async function navigate(
    sourceInput: NavigationSource,
    input: { readonly symbol: string } | FileNavigationRequest
  ): Promise<void> {
    const source = { ...sourceInput };
    const symbol = 'symbol' in input ? input.symbol : undefined;
    const fileBody =
      'symbol' in input
        ? null
        : JSON.stringify({
            nodeId: source.nodeId,
            path: source.path,
            reference: { ...input.reference, sourceContext: input.sourceContext }
          });
    clear(source.pageId);
    const state = pages.get(source.pageId);
    if (state === undefined) return;
    activePageId = source.pageId;
    const requestGeneration = generation;
    const current = () => requestGeneration === generation;
    state.navigationLoading.value = true;
    const symbolRequest = (symbol: string, references: '0' | '1') =>
      options.http.request(
        `${endpoint(source)}/definition?${new URLSearchParams({
          nodeId: source.nodeId,
          path: source.path,
          symbol,
          references
        })}`
      );
    try {
      const definition = await query(
        symbol !== undefined
          ? () => symbolRequest(symbol, '0')
          : () =>
              options.http.request(`${endpoint(source)}/definition`, {
                method: 'POST',
                body: fileBody
              }),
        current
      );
      if (definition === undefined || !current()) return;
      const notice = navigationNotice(definition);
      if (notice !== undefined) {
        state.navigationNotice.value = notice;
        return;
      }
      if (symbol !== undefined) {
        const definitions = definition.targets.map((target) => ({
          ...target,
          source: 'DEFINITION' as const
        }));
        state.navigationTargets.value = definitions;
        state.navigationLoading.value = definitions.length === 0;
        // References supplement the accepted declarations without blocking their presentation.
        const loadReferences = async () => {
          try {
            const result = await query(() => symbolRequest(symbol, '1'), current);
            if (result === undefined || !current()) return;
            state.navigationNotice.value = navigationNotice(result);
            if (state.navigationNotice.value !== undefined) return;
            const targets =
              result.targets.length === 0
                ? definitions
                : result.targets.map((target) => ({
                    ...target,
                    source: 'DEFINITION' as const
                  }));
            const references = result.references.map((target) => ({
              ...target,
              source: 'REFERENCE' as const
            }));
            state.navigationTargets.value = [...targets, ...references];
            state.navigationNoDefinition.value = targets.length === 0 && references.length === 0;
          } catch (error) {
            if (current()) options.onFailure(error);
          }
        };
        if (definitions.length === 0) await loadReferences();
        else void loadReferences();
      } else {
        const targets = definition.paths.map((target) => ({ ...target, source: 'FILE' as const }));
        if (targets.length === 0) state.navigationNoDefinition.value = true;
        else if (targets.length === 1) options.onFileTarget(targets[0]!, source.pageId);
        else state.navigationTargets.value = targets;
      }
    } catch (error) {
      if (current()) options.onFailure(error);
    } finally {
      if (current()) state.navigationLoading.value = false;
    }
  }

  async function prewarm(source: Omit<NavigationSource, 'pageId'>): Promise<void> {
    try {
      const result = await options.http.request<{ readonly preparation?: unknown }>(
        `${endpoint(source)}/prepare?${new URLSearchParams({ nodeId: source.nodeId, path: source.path })}`
      );
      if (!workspaceSymbolIndexPreparationSchema.safeParse(result?.preparation).success)
        throw new Error('NODE_RESPONSE_INVALID');
    } catch {
      // Prewarming is opportunistic; the foreground query reports actionable failures.
    }
  }

  return { page, navigate, prewarm, cancel, clear, release, reset };
}
