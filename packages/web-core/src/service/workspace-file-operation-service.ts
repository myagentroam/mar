import type { ScopedHttpService } from './scoped-http-service.js';
import type {
  WorkspaceFileTreePage,
  WorkspaceFileTreeWorkspace
} from './workspace-file-tree-service.js';

export interface WorkspaceFileOperationTarget {
  readonly nodeId: string;
  readonly workspaceId: string;
}
export interface WorkspaceUploadCandidate {
  readonly status: 'READY' | 'EXISTS_FILE' | 'EXISTS_DIRECTORY' | 'INVALID_NAME';
  readonly path: string | null;
}

export function createWorkspaceFileOperationService(input: {
  readonly http: ScopedHttpService;
  readonly onWritten: (target: WorkspaceFileOperationTarget) => Promise<void>;
}) {
  async function list(target: WorkspaceFileOperationTarget, path: string, cursor?: string) {
    const parameters = new URLSearchParams({ nodeId: target.nodeId, path, limit: '200' });
    if (cursor !== undefined) parameters.set('cursor', cursor);
    const result = await input.http.request(
      `/api/workspaces/${encodeURIComponent(target.workspaceId)}/files?${parameters}`
    );
    if (!isFilePage(result)) throw new Error('NODE_RESPONSE_INVALID');
    const workspace = filePageWorkspace(result.workspace);
    return { ...result.files, ...(workspace === undefined ? {} : { workspace }) };
  }
  async function preflight(
    target: WorkspaceFileOperationTarget,
    directory: string,
    names: readonly string[]
  ): Promise<readonly WorkspaceUploadCandidate[]> {
    const result = await input.http.request<{ readonly uploads?: unknown }>(
      `/api/workspaces/${encodeURIComponent(target.workspaceId)}/uploads/preflight`,
      {
        method: 'POST',
        body: JSON.stringify({
          nodeId: target.nodeId,
          directory,
          files: names.map((name) => ({ name }))
        })
      }
    );
    const uploads = result.uploads;
    if (!Array.isArray(uploads)) throw new Error('NODE_RESPONSE_INVALID');
    return names.map((_, index) => {
      const value = uploads[index] as
        { readonly status?: unknown; readonly path?: unknown } | undefined;
      return {
        status:
          value?.status === 'READY' ||
          value?.status === 'EXISTS_FILE' ||
          value?.status === 'EXISTS_DIRECTORY'
            ? value.status
            : 'INVALID_NAME',
        path: typeof value?.path === 'string' ? value.path : null
      };
    });
  }
  async function mutate(
    target: WorkspaceFileOperationTarget,
    action: 'CREATE_FILE' | 'CREATE_DIRECTORY' | 'MOVE' | 'DELETE',
    path: string,
    destination?: string
  ): Promise<string | undefined> {
    target = { ...target };
    const result = await input.http.request<{ readonly file?: { readonly path?: unknown } }>(
      `/api/workspaces/${encodeURIComponent(target.workspaceId)}/files/mutate`,
      {
        method: 'POST',
        body: JSON.stringify({
          nodeId: target.nodeId,
          action,
          path,
          ...(destination === undefined ? {} : { destination })
        })
      }
    );
    // Follow-up invalidation cannot undo a completed filesystem mutation.
    try {
      await input.onWritten(target);
    } catch {
      /* The refresh path owns its diagnostics. */
    }
    return typeof result.file?.path === 'string' ? result.file.path : undefined;
  }
  async function reveal(target: WorkspaceFileOperationTarget, path: string): Promise<void> {
    target = { ...target };
    await input.http.request(
      `/api/workspaces/${encodeURIComponent(target.workspaceId)}/files/reveal`,
      {
        method: 'POST',
        body: JSON.stringify({ nodeId: target.nodeId, path })
      }
    );
  }
  return { list, preflight, mutate, reveal };
}

export function isFilePage(
  value: unknown
): value is { readonly files: WorkspaceFileTreePage; readonly workspace?: unknown } {
  if (typeof value !== 'object' || value === null || !('files' in value)) return false;
  const files = value.files as { readonly entries?: unknown; readonly nextCursor?: unknown } | null;
  return (
    typeof files === 'object' &&
    files !== null &&
    Array.isArray(files.entries) &&
    (files.nextCursor === null || typeof files.nextCursor === 'string')
  );
}

export function filePageWorkspace(value: unknown): WorkspaceFileTreeWorkspace | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const workspace = value as {
    readonly id?: unknown;
    readonly path?: unknown;
    readonly kind?: unknown;
    readonly gitSummary?: { readonly branch?: unknown } | null;
  };
  if (
    typeof workspace.id !== 'string' ||
    typeof workspace.path !== 'string' ||
    (workspace.kind !== 'DIRECTORY' && workspace.kind !== 'GIT_WORKSPACE')
  )
    return undefined;
  const branch = workspace.gitSummary?.branch;
  return {
    id: workspace.id,
    path: workspace.path,
    kind: workspace.kind,
    ...(typeof branch === 'string' || branch === null ? { gitSummary: { branch } } : {})
  };
}
