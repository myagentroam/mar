import type { WorkspaceTarget } from '../model/workbench.js';
import { computed, ref, type Ref } from 'vue';
import type { EffectiveWorkspaceSkill } from './effective-workspace-skill-service.js';

const SKILL_CACHE_TTL_MS = 5 * 60 * 1000;

interface SkillCacheEntry {
  readonly skills: readonly EffectiveWorkspaceSkill[];
  readonly fetchedAt: number;
}

/**
 * Caches the effective Workspace skills for the Composer Slash picker. The cache is scoped by
 * Node and Workspace for the current tab: fresh entries are used directly, stale entries are
 * shown while a background refresh runs, and a failed refresh keeps the previous data.
 */
export function createComposerSkillService(options: {
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly now?: () => number;
}) {
  const skills = ref<readonly EffectiveWorkspaceSkill[]>([]);
  const loading = ref(false);
  const failed = ref(false);
  const cache = new Map<string, SkillCacheEntry>();
  const inflight = new Map<string, Promise<void>>();
  let requestVersion = 0;
  const now = options.now ?? (() => Date.now());

  function contextKey(): string | undefined {
    const nodeId = options.workspaceTarget.value?.nodeId;
    const workspaceId = options.workspaceTarget.value?.workspaceId;
    if (nodeId === undefined || workspaceId === undefined) return undefined;
    return `${nodeId}:${workspaceId}`;
  }

  /** Ensures the picker data for the current context, refreshing stale entries in background. */
  function ensureFresh(): void {
    const key = contextKey();
    if (key === undefined) {
      skills.value = [];
      failed.value = false;
      return;
    }
    const entry = cache.get(key);
    if (entry !== undefined) {
      skills.value = entry.skills;
      failed.value = false;
      if (now() - entry.fetchedAt < SKILL_CACHE_TTL_MS) return;
    } else {
      skills.value = [];
    }
    if (inflight.has(key)) return;
    const separator = key.indexOf(':');
    const nodeId = key.slice(0, separator);
    const workspaceId = key.slice(separator + 1);
    const currentRequest = ++requestVersion;
    loading.value = entry === undefined;
    const request$ = options
      .request<{ skills: readonly EffectiveWorkspaceSkill[] }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/effective-skills?nodeId=${encodeURIComponent(nodeId)}`
      )
      .then((result) => {
        const fetched = Array.isArray(result.skills) ? result.skills : [];
        cache.set(key, { skills: fetched, fetchedAt: now() });
        if (currentRequest === requestVersion && contextKey() === key) {
          skills.value = fetched;
          failed.value = false;
        }
      })
      .catch(() => {
        if (currentRequest === requestVersion && contextKey() === key) failed.value = true;
      })
      .finally(() => {
        inflight.delete(key);
        if (currentRequest === requestVersion && contextKey() === key) loading.value = false;
      });
    inflight.set(key, request$);
  }

  return {
    skills: computed(() => skills.value),
    loading: computed(() => loading.value),
    failed: computed(() => failed.value),
    ensureFresh
  };
}
