import { ref } from 'vue';
import {
  resolveMarAgentDefaultReasoningEffort,
  type MarAgentModelSummary
} from '@myagentroam/protocol';

export type ModelReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type ManagedModelSummary = Omit<
  MarAgentModelSummary,
  'reasoningEfforts' | 'defaultReasoningEffort'
> & {
  reasoningEfforts: ModelReasoningEffort[];
  defaultReasoningEffort: ModelReasoningEffort;
};

export function createModelManagementCollectionService(
  request: <T>(path: string, init?: RequestInit) => Promise<T>,
  path: '/api/admin/mar-agent/models' | '/api/mar-agent/models',
  canRefresh: () => boolean
) {
  const models = ref<ManagedModelSummary[]>([]);
  const loading = ref(false);
  const ready = ref(false);
  const savingOrder = ref(false);
  let sequence = 0;
  let disposed = false;

  async function load(showLoading = true): Promise<void> {
    if (disposed) return;
    const current = ++sequence;
    if (showLoading) loading.value = true;
    try {
      const response = await request<{ models: ManagedModelSummary[] }>(path, {
        cache: 'no-store'
      });
      if (disposed || current !== sequence) return;
      models.value = response.models.map((model) => ({
        ...model,
        defaultReasoningEffort: resolveMarAgentDefaultReasoningEffort(
          model.defaultReasoningEffort,
          model.reasoningEfforts
        )
      }));
      ready.value = true;
    } catch (error) {
      if (!disposed && current === sequence) throw error;
    } finally {
      if (current === sequence) loading.value = false;
    }
  }

  async function saveOrder(): Promise<{ refreshError?: unknown } | undefined> {
    if (disposed || savingOrder.value) return undefined;
    savingOrder.value = true;
    try {
      await request(`${path}/order`, {
        method: 'PUT',
        body: JSON.stringify({ modelIds: models.value.map((model) => model.id) })
      });
      if (disposed) return undefined;
      try {
        await load(false);
        return disposed ? undefined : {};
      } catch (refreshError) {
        return disposed ? undefined : { refreshError };
      }
    } catch (error) {
      if (disposed) return undefined;
      throw error;
    } finally {
      savingOrder.value = false;
    }
  }

  async function commitModelMutation(
    endpoint: string,
    init: RequestInit
  ): Promise<{ readonly refresh?: Promise<unknown | undefined> } | undefined> {
    if (disposed) return undefined;
    try {
      await request(endpoint, init);
    } catch (error) {
      if (disposed) return undefined;
      throw error;
    }
    if (disposed) return undefined;
    return canRefresh()
      ? {
          refresh: load(false).then(
            () => undefined,
            (error: unknown) => error
          )
        }
      : {};
  }

  function saveModel(input: {
    readonly editingId?: string;
    readonly duplicatingId?: string;
    readonly body: Record<string, unknown>;
  }) {
    const endpoint = input.duplicatingId
      ? `${path}/${input.duplicatingId}/duplicate`
      : input.editingId
        ? `${path}/${input.editingId}`
        : path;
    return commitModelMutation(endpoint, {
      method: input.editingId ? 'PUT' : 'POST',
      body: JSON.stringify(input.body)
    });
  }

  function removeModel(id: string) {
    return commitModelMutation(`${path}/${id}`, { method: 'DELETE' });
  }

  function dispose(): void {
    disposed = true;
    sequence += 1;
    loading.value = false;
  }

  return { models, loading, ready, savingOrder, load, saveOrder, saveModel, removeModel, dispose };
}
