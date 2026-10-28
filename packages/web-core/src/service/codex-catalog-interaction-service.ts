import { ref } from 'vue';
import type {
  CodexModelCatalog,
  CodexModelImportRequest,
  CodexModelImportResult
} from '@myagentroam/protocol';

export function createCodexCatalogInteractionService(client: {
  readonly loadCatalog: (credentialId: string) => Promise<CodexModelCatalog>;
  readonly importModels: (
    credentialId: string,
    request: CodexModelImportRequest
  ) => Promise<CodexModelImportResult>;
}) {
  const catalog = ref<CodexModelCatalog>();
  const loading = ref(false);
  const importing = ref(false);
  let revision = 0;
  let disposed = false;

  function isCurrent(value: number): boolean {
    return !disposed && value === revision;
  }

  async function open(credentialId: string, prepare: () => Promise<void>) {
    if (disposed) return undefined;
    const current = ++revision;
    loading.value = true;
    importing.value = false;
    catalog.value = undefined;
    try {
      await prepare();
      if (!isCurrent(current)) return undefined;
      const result = await client.loadCatalog(credentialId);
      if (!isCurrent(current)) return undefined;
      catalog.value = result;
      return result;
    } catch (error) {
      if (!isCurrent(current)) return undefined;
      throw error;
    } finally {
      if (isCurrent(current)) loading.value = false;
    }
  }

  async function importModels(
    current: number,
    credentialId: string,
    request: CodexModelImportRequest,
    accept: (result: CodexModelImportResult) => Promise<void>
  ): Promise<void> {
    if (!isCurrent(current) || importing.value) return;
    importing.value = true;
    try {
      const result = await client.importModels(credentialId, request);
      if (isCurrent(current)) await accept(result);
    } catch (error) {
      if (isCurrent(current)) throw error;
    } finally {
      if (isCurrent(current)) importing.value = false;
    }
  }

  function reset(): void {
    revision += 1;
    loading.value = false;
    importing.value = false;
    catalog.value = undefined;
  }

  function dispose(): void {
    disposed = true;
    reset();
  }

  return {
    catalog: catalog as Readonly<typeof catalog>,
    loading: loading as Readonly<typeof loading>,
    importing: importing as Readonly<typeof importing>,
    currentRevision: () => revision,
    isCurrent,
    open,
    importModels,
    reset,
    dispose
  };
}
