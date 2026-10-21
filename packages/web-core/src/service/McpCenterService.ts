import { createCatalogPageService, readCatalogReferences } from './CatalogPageService.js';
import { computed, ref } from 'vue';

export interface McpCatalogCard<Scope extends string = string> {
  readonly id: string;
  readonly sourceId: string;
  readonly scope: Scope;
  readonly serverName: string;
  readonly displayName: string;
  readonly description: string;
  readonly version: string;
  readonly featured: boolean;
  readonly tags: readonly string[];
  readonly runtime: { readonly transport: 'STDIO' | 'HTTP' };
}

export interface McpInstallationCard {
  readonly catalogEntryId: string;
  readonly serverName: string;
  readonly displayName: string;
  readonly version: string;
  readonly origin: 'NODE' | 'WORKSPACE';
  readonly enabled: boolean;
  readonly status: 'CURRENT' | 'UPDATE_AVAILABLE' | 'INVALID' | 'UNAVAILABLE';
  readonly installedAt: number;
}

export interface McpTargetInspection {
  readonly targetKind: 'NODE' | 'WORKSPACE';
  readonly installations: readonly McpInstallationCard[];
  readonly executionBuiltIns?: readonly ('mar_schedule' | 'mar_notification')[];
}

export function createMcpCenterService<Scope extends string = string>(
  request: <T>(path: string, init?: RequestInit) => Promise<T>
) {
  const catalogPage = createCatalogPageService<McpCatalogCard<Scope>>(
    request,
    '/api/mcp-catalog',
    'entries'
  );
  const catalog = catalogPage.items;
  const installedCatalog = ref<readonly McpCatalogCard<Scope>[]>([]);
  let inspectionSequence = 0;
  const inspection = ref<McpTargetInspection>();
  const loading = ref(false);
  const loadedInstallations = computed(() => {
    const entries = new Map(installedCatalog.value.map((entry) => [entry.id, entry]));
    return (inspection.value?.installations ?? [])
      .filter((installation) => installation.enabled)
      .map((installation) => {
        const entry = entries.get(installation.catalogEntryId);
        return {
          ...installation,
          description: entry?.version === installation.version ? entry.description : undefined
        };
      });
  });

  async function loadCatalog(): Promise<void> {
    await catalogPage.refresh();
  }
  async function resolveInspection(sequence: number, result: McpTargetInspection): Promise<void> {
    if (sequence !== inspectionSequence) return;
    inspection.value = result;
    installedCatalog.value = [];
    const references = await readCatalogReferences<McpCatalogCard<Scope>>(
      request,
      '/api/mcp-catalog',
      'entries',
      result.installations.map((item) => item.catalogEntryId),
      []
    );
    if (sequence !== inspectionSequence) return;
    inspection.value = result;
    installedCatalog.value = references;
  }
  function clearTarget(): void {
    inspectionSequence++;
    inspection.value = undefined;
    installedCatalog.value = [];
  }
  function targetPath(kind: 'NODE' | 'WORKSPACE', nodeId: string, workspaceId: string): string {
    return kind === 'NODE'
      ? `/api/nodes/${encodeURIComponent(nodeId)}/mcps`
      : `/api/workspaces/${encodeURIComponent(workspaceId)}/mcps?${new URLSearchParams({ nodeId })}`;
  }

  async function inspect(
    kind: 'NODE' | 'WORKSPACE',
    nodeId: string,
    workspaceId: string
  ): Promise<void> {
    clearTarget();
    const current = ++inspectionSequence;
    await resolveInspection(
      current,
      await request<McpTargetInspection>(targetPath(kind, nodeId, workspaceId))
    );
  }

  async function loadWorkspace(nodeId: string, workspaceId: string): Promise<void> {
    await inspect('WORKSPACE', nodeId, workspaceId);
  }

  async function install(
    kind: 'NODE' | 'WORKSPACE',
    nodeId: string,
    workspaceId: string,
    catalogEntryId: string,
    enabled = true
  ): Promise<void> {
    const sequence = ++inspectionSequence;
    const result = await request<McpTargetInspection>(targetPath(kind, nodeId, workspaceId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ catalogEntryId, enabled, configuration: {} })
    });
    await resolveInspection(sequence, result);
  }

  async function remove(
    kind: 'NODE' | 'WORKSPACE',
    nodeId: string,
    workspaceId: string,
    serverName: string
  ): Promise<void> {
    const path = `${targetPath(kind, nodeId, workspaceId).split('?')[0]}/${encodeURIComponent(serverName)}`;
    const query = kind === 'WORKSPACE' ? `?${new URLSearchParams({ nodeId })}` : '';
    const sequence = ++inspectionSequence;
    await resolveInspection(
      sequence,
      await request<McpTargetInspection>(`${path}${query}`, { method: 'DELETE' })
    );
  }

  async function run(operation: () => Promise<void>): Promise<void> {
    loading.value = true;
    try {
      await operation();
    } finally {
      loading.value = false;
    }
  }

  return {
    catalog,
    installedCatalog,
    catalogPage,
    clearTarget,
    inspection,
    loadedInstallations,
    loading: computed(() => loading.value || catalogPage.loading.value),
    loadCatalog,
    loadWorkspace,
    inspect,
    install,
    remove,
    run
  };
}
