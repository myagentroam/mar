import { readonly, ref, shallowRef } from 'vue';
import type { ScopedHttpService } from './scoped-http-service.js';

export interface WorkspaceContentMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly preview: string;
}

function isContentSearch(value: unknown): value is {
  readonly matches: readonly WorkspaceContentMatch[];
  readonly truncated: boolean;
} {
  if (typeof value !== 'object' || value === null) return false;
  const search = value as { matches?: unknown; truncated?: unknown };
  return (
    Array.isArray(search.matches) &&
    search.matches.every(
      (match) =>
        typeof match === 'object' &&
        match !== null &&
        typeof (match as WorkspaceContentMatch).path === 'string' &&
        Number.isInteger((match as WorkspaceContentMatch).line) &&
        (match as WorkspaceContentMatch).line > 0 &&
        Number.isInteger((match as WorkspaceContentMatch).column) &&
        (match as WorkspaceContentMatch).column > 0 &&
        typeof (match as WorkspaceContentMatch).preview === 'string'
    ) &&
    typeof search.truncated === 'boolean'
  );
}

export function createWorkspaceContentSearchService(options: {
  readonly http: ScopedHttpService;
  readonly onFailure: (error: unknown) => void;
}) {
  const matches = shallowRef<readonly WorkspaceContentMatch[]>([]);
  const truncated = ref(false);
  const appliedQuery = ref('');
  const appliedUseRegex = ref(false);
  const loading = ref(false);
  const error = shallowRef<unknown>();
  let generation = 0;

  async function search(input: {
    readonly nodeId: string;
    readonly workspaceId: string;
    readonly query: string;
    readonly useRegex: boolean;
  }): Promise<void> {
    if (input.query === '') return;
    const request = ++generation;
    // Capture both applied conditions before awaiting any response.
    const { nodeId, workspaceId, query, useRegex } = input;
    loading.value = true;
    error.value = undefined;
    try {
      const parameters = new URLSearchParams({ nodeId, q: query });
      if (useRegex) parameters.set('regex', 'true');
      const result = await options.http.request<{ readonly search?: unknown }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/content/search?${parameters}`
      );
      if (request !== generation) return;
      if (!isContentSearch(result?.search)) throw new Error('NODE_RESPONSE_INVALID');
      matches.value = [...result.search.matches];
      truncated.value = result.search.truncated;
      appliedQuery.value = query;
      appliedUseRegex.value = useRegex;
    } catch (failure) {
      if (request !== generation) return;
      error.value = failure;
      options.onFailure(failure);
    } finally {
      if (request === generation) loading.value = false;
    }
  }

  function reset(): void {
    generation += 1;
    matches.value = [];
    truncated.value = false;
    appliedQuery.value = '';
    appliedUseRegex.value = false;
    loading.value = false;
    error.value = undefined;
  }

  function restore(input: {
    readonly contentMatches?: unknown;
    readonly contentSearchTruncated?: unknown;
    readonly contentAppliedQuery?: unknown;
    readonly contentAppliedUseRegex?: unknown;
  }): void {
    reset();
    matches.value = Array.isArray(input.contentMatches)
      ? input.contentMatches.filter((match): match is WorkspaceContentMatch =>
          isContentSearch({ matches: [match], truncated: false })
        )
      : [];
    truncated.value = input.contentSearchTruncated === true;
    appliedQuery.value =
      typeof input.contentAppliedQuery === 'string' ? input.contentAppliedQuery : '';
    appliedUseRegex.value = input.contentAppliedUseRegex === true;
  }

  return {
    matches: readonly(matches),
    truncated: readonly(truncated),
    appliedQuery: readonly(appliedQuery),
    appliedUseRegex: readonly(appliedUseRegex),
    loading: readonly(loading),
    error: readonly(error),
    search,
    restore,
    reset
  };
}
