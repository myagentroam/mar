import { createCatalogPageService, readCatalogReferences } from './CatalogPageService.js';
import { computed, ref, type Ref } from 'vue';

export interface SkillSourceCard<Scope extends string = string> {
  readonly id: string;
  readonly name: string;
  readonly scope: Scope;
  readonly enabled: boolean;
  readonly builtIn: boolean;
  readonly kind: 'SKILLS_SH' | 'REPOSITORY';
  readonly locator: string;
  readonly manageable: boolean;
}

export interface SkillCandidateCard {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly skillPath: string | null;
  readonly installs: number | null;
}

export interface SkillFavoriteCard<Scope extends string = string> {
  readonly id: string;
  readonly sourceId: string;
  readonly scope: Scope;
  readonly normalizedName: string;
  readonly featured: boolean;
  readonly tags: readonly string[];
  readonly description: string;
  readonly repositoryIdentity: string;
  readonly skillPath: string;
  readonly commitSha: string;
  readonly currentVersionId: string;
  readonly tlsVerified: boolean;
  readonly updatedAt: number;
  readonly manageable: boolean;
}

export interface InstalledSkillCard {
  readonly name: string;
  readonly description: string;
  readonly localStatus:
    'VALID' | 'UNKNOWN_VERSION' | 'PARTIAL' | 'INVALID' | 'INVALID_LINK' | 'GIT_EXCLUDE_BROKEN';
  readonly install?: {
    readonly favoriteId: string;
    readonly versionId: string;
    readonly commitSha: string;
  };
}

export interface SkillTargetInspectionCard {
  readonly targetKind: 'NODE' | 'WORKSPACE';
  readonly compatibilityMode: 'SYMLINK' | 'JUNCTION' | 'MANAGED_COPY' | 'UNAVAILABLE';
  readonly skills: readonly InstalledSkillCard[];
}

export interface SkillManagedTargetResources {
  readonly nodes: readonly {
    readonly id: string;
    readonly displayName: string | null;
    readonly connected: boolean;
    readonly disabled: boolean;
  }[];
  readonly workspaces: readonly {
    readonly nodeId: string;
    readonly workspaceId: string;
    readonly displayName: string;
  }[];
}

export interface SkillFavoriteInput {
  readonly sourceId: string;
  readonly candidateId: string;
  readonly skillPath?: string;
  readonly featured: boolean;
  readonly tags: readonly string[];
}
export interface SkillSourceInput {
  readonly name: string;
  readonly locator: string;
}

export function createSkillCenterService<Scope extends string = string, Context = void>(
  request: <T>(path: string, init?: RequestInit) => Promise<T>,
  extensions: {
    readonly submitFavorite?: (
      input: SkillFavoriteInput,
      context: Context | undefined
    ) => Promise<unknown>;
    readonly submitSource?: (
      input: SkillSourceInput,
      context: Context | undefined
    ) => Promise<unknown>;
  } = {}
) {
  const sources = ref<readonly SkillSourceCard<Scope>[]>([]) as Ref<
    readonly SkillSourceCard<Scope>[]
  >;
  const candidates = ref<readonly SkillCandidateCard[]>([]);
  const catalogPage = createCatalogPageService<SkillFavoriteCard<Scope>>(
    request,
    '/api/skill-favorites',
    'favorites'
  );
  const favorites = catalogPage.items;
  const installedFavorites = ref<readonly SkillFavoriteCard<Scope>[]>([]) as Ref<
    readonly SkillFavoriteCard<Scope>[]
  >;
  const candidateFavorites = ref<readonly SkillFavoriteCard<Scope>[]>([]) as Ref<
    readonly SkillFavoriteCard<Scope>[]
  >;
  const selectedSourceId = ref('');
  const query = ref('');
  const loading = ref(false);
  let loadingRequests = 0;
  const targetLoading = ref(false);
  const target = ref<SkillTargetInspectionCard>();
  const managedTargets = ref<SkillManagedTargetResources>({ nodes: [], workspaces: [] });
  let searchSequence = 0;
  let targetSequence = 0;
  const favoriteIds = computed(
    () =>
      new Set(
        candidateFavorites.value.map(
          (favorite) => `${favorite.sourceId}:${favorite.normalizedName}`
        )
      )
  );

  function beginLoading(): void {
    loadingRequests += 1;
    loading.value = true;
  }

  function endLoading(): void {
    loadingRequests = Math.max(0, loadingRequests - 1);
    loading.value = loadingRequests > 0;
  }

  async function withLoading<T>(operation: () => Promise<T>): Promise<T> {
    beginLoading();
    try {
      return await operation();
    } finally {
      endLoading();
    }
  }

  async function load(): Promise<void> {
    await Promise.all([loadSources(), loadCatalog()]);
  }
  async function loadCatalog(): Promise<void> {
    await withLoading(async () => {
      await catalogPage.refresh();
      if (candidates.value.length)
        candidateFavorites.value = await readCatalogReferences<SkillFavoriteCard<Scope>>(
          request,
          '/api/skill-favorites',
          'favorites',
          [],
          candidates.value.map((candidate) => candidate.name)
        );
    });
  }
  async function loadSources(): Promise<void> {
    beginLoading();
    const previousSourceId = selectedSourceId.value;
    try {
      sources.value = (
        await request<{ sources: readonly SkillSourceCard<Scope>[] }>('/api/skill-sources')
      ).sources;
      if (!sources.value.some((source) => source.id === selectedSourceId.value && source.enabled))
        selectedSourceId.value = defaultSourceId(sources.value);
      if (selectedSourceId.value !== previousSourceId) candidates.value = [];
    } finally {
      endLoading();
    }
  }

  async function loadManagedTargets(): Promise<void> {
    managedTargets.value = await request<SkillManagedTargetResources>('/api/resources');
  }

  async function requestCandidates(searchQuery?: string): Promise<void> {
    if (selectedSourceId.value === '') return;
    const sequence = ++searchSequence;
    const sourceId = selectedSourceId.value;
    beginLoading();
    try {
      const path = `/api/skill-sources/${encodeURIComponent(sourceId)}/skills`;
      const params =
        searchQuery === undefined
          ? ''
          : `?${new URLSearchParams({ query: searchQuery, limit: '40' })}`;
      const result = await request<{ skills: readonly SkillCandidateCard[] }>(`${path}${params}`);
      if (sequence !== searchSequence || sourceId !== selectedSourceId.value) return;
      const references = await readCatalogReferences<SkillFavoriteCard<Scope>>(
        request,
        '/api/skill-favorites',
        'favorites',
        [],
        result.skills.map((candidate) => candidate.name)
      );
      if (sequence === searchSequence && sourceId === selectedSourceId.value) {
        candidates.value = result.skills;
        candidateFavorites.value = references;
      }
    } catch (error) {
      if (sequence !== searchSequence || sourceId !== selectedSourceId.value) return;
      throw error;
    } finally {
      endLoading();
    }
  }

  async function loadCandidates(): Promise<void> {
    if (selectedSource()?.kind === 'SKILLS_SH') {
      candidates.value = [];
      return;
    }
    await requestCandidates();
  }

  async function search(): Promise<void> {
    const searchQuery = query.value.trim();
    if (selectedSource()?.kind === 'SKILLS_SH' && searchQuery === '') {
      candidates.value = [];
      return;
    }
    await requestCandidates(searchQuery);
  }

  function selectedSource(): SkillSourceCard<Scope> | undefined {
    return sources.value.find((source) => source.id === selectedSourceId.value);
  }

  async function favorite(
    candidate: SkillCandidateCard,
    presentation: { featured: boolean; tags: readonly string[] } = { featured: false, tags: [] },
    context?: Context
  ): Promise<void> {
    await withLoading(async () => {
      const input: SkillFavoriteInput = {
        sourceId: selectedSourceId.value,
        candidateId: candidate.id,
        ...(candidate.skillPath === null ? {} : { skillPath: candidate.skillPath }),
        featured: presentation.featured,
        tags: presentation.tags
      };
      if (extensions.submitFavorite !== undefined) await extensions.submitFavorite(input, context);
      else
        await request('/api/skill-favorites', {
          method: 'POST',
          body: JSON.stringify({ ...input, scope: 'PERSONAL' })
        });
      await Promise.all([loadCatalog(), loadSources()]);
    });
  }

  async function upgrade(favoriteId: string): Promise<void> {
    await withLoading(async () => {
      await request(`/api/skill-favorites/${encodeURIComponent(favoriteId)}/upgrade`, {
        method: 'POST'
      });
      await loadCatalog();
    });
  }

  async function checkUpdate(
    favoriteId: string
  ): Promise<{ readonly updateAvailable: boolean; readonly latestCommitSha: string }> {
    return request(`/api/skill-favorites/${encodeURIComponent(favoriteId)}/check-update`, {
      method: 'POST'
    });
  }

  async function updatePresentation(
    favoriteId: string,
    presentation: { readonly featured: boolean; readonly tags: readonly string[] }
  ): Promise<void> {
    await withLoading(async () => {
      await request(`/api/skill-favorites/${encodeURIComponent(favoriteId)}`, {
        method: 'PATCH',
        body: JSON.stringify(presentation)
      });
      await loadCatalog();
    });
  }

  async function remove(favoriteId: string): Promise<void> {
    await withLoading(async () => {
      await request(`/api/skill-favorites/${encodeURIComponent(favoriteId)}`, {
        method: 'DELETE'
      });
      await loadCatalog();
    });
  }

  async function addSource(input: SkillSourceInput, context?: Context): Promise<void> {
    await withLoading(async () => {
      if (extensions.submitSource !== undefined) await extensions.submitSource(input, context);
      else
        await request('/api/skill-sources', {
          method: 'POST',
          body: JSON.stringify({ kind: 'REPOSITORY', enabled: true, ...input, scope: 'PERSONAL' })
        });
      await loadSources();
    });
  }

  async function setSourceEnabled(sourceId: string, enabled: boolean): Promise<void> {
    await withLoading(async () => {
      await request(`/api/skill-sources/${encodeURIComponent(sourceId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled })
      });
      await loadSources();
    });
  }

  async function removeSource(sourceId: string): Promise<void> {
    await withLoading(async () => {
      await request(`/api/skill-sources/${encodeURIComponent(sourceId)}`, { method: 'DELETE' });
      await loadSources();
    });
  }

  async function inspectTarget(nodeId: string, workspaceId?: string): Promise<void> {
    const sequence = ++targetSequence;
    targetLoading.value = true;
    try {
      const result = await request<SkillTargetInspectionCard>(
        workspaceId === undefined
          ? `/api/nodes/${encodeURIComponent(nodeId)}/skills`
          : `/api/workspaces/${encodeURIComponent(workspaceId)}/skills?nodeId=${encodeURIComponent(nodeId)}`
      );
      if (sequence !== targetSequence) return;
      target.value = result;
      installedFavorites.value = [];
      const references = await readCatalogReferences<SkillFavoriteCard<Scope>>(
        request,
        '/api/skill-favorites',
        'favorites',
        result.skills.flatMap((skill) => (skill.install ? [skill.install.favoriteId] : [])),
        result.skills.map((skill) => skill.name)
      );
      if (sequence === targetSequence) {
        target.value = result;
        installedFavorites.value = references;
      }
    } catch (error) {
      if (sequence !== targetSequence) return;
      throw error;
    } finally {
      if (sequence === targetSequence) targetLoading.value = false;
    }
  }

  function clearTarget(): void {
    targetSequence += 1;
    target.value = undefined;
    installedFavorites.value = [];
    targetLoading.value = false;
  }

  async function install(
    favoriteId: string,
    nodeId: string,
    workspaceId?: string,
    confirmTracked = false
  ): Promise<void> {
    const path =
      workspaceId === undefined
        ? `/api/nodes/${encodeURIComponent(nodeId)}/skills`
        : `/api/workspaces/${encodeURIComponent(workspaceId)}/skills?nodeId=${encodeURIComponent(nodeId)}`;
    const accepted = await request<{ installJobId: string }>(path, {
      method: 'POST',
      body: JSON.stringify({ favoriteId, ...(workspaceId === undefined ? {} : { confirmTracked }) })
    });
    await waitForInstallJob(accepted.installJobId);
  }

  async function waitForInstallJob(installJobId: string): Promise<void> {
    for (let attempt = 0; attempt < 180; attempt += 1) {
      const job = await request<{ status: 'RUNNING' | 'SUCCEEDED' | 'FAILED'; errorCode?: string }>(
        `/api/skill-install-jobs/${encodeURIComponent(installJobId)}`
      );
      if (job.status === 'SUCCEEDED') return;
      if (job.status === 'FAILED') throw new Error(job.errorCode ?? 'SKILL_INSTALL_FAILED');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('SKILL_INSTALL_STATUS_TIMEOUT');
  }

  async function removeInstalled(
    name: string,
    nodeId: string,
    workspaceId?: string
  ): Promise<void> {
    const path =
      workspaceId === undefined
        ? `/api/nodes/${encodeURIComponent(nodeId)}/skills/${encodeURIComponent(name)}`
        : `/api/workspaces/${encodeURIComponent(workspaceId)}/skills/${encodeURIComponent(name)}?nodeId=${encodeURIComponent(nodeId)}`;
    await request(path, { method: 'DELETE' });
  }

  async function repairGitExclude(nodeId: string, workspaceId: string): Promise<void> {
    await request(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/skills/git-exclude-repair?nodeId=${encodeURIComponent(nodeId)}`,
      { method: 'POST' }
    );
  }

  return {
    sources,
    candidates,
    favorites,
    installedFavorites,
    catalogPage,
    selectedSourceId,
    query,
    loading: computed(() => loading.value || catalogPage.loading.value),
    targetLoading,
    target,
    managedTargets,
    favoriteIds,
    load,
    loadCatalog,
    loadSources,
    loadManagedTargets,
    loadCandidates,
    search,
    favorite,
    upgrade,
    checkUpdate,
    updatePresentation,
    remove,
    addSource,
    setSourceEnabled,
    removeSource,
    inspectTarget,
    clearTarget,
    install,
    removeInstalled,
    repairGitExclude
  };
}

function defaultSourceId(sources: readonly SkillSourceCard[]): string {
  return (
    (
      sources.find((source) => source.enabled && source.kind === 'SKILLS_SH') ??
      sources.find((source) => source.enabled)
    )?.id ?? ''
  );
}
