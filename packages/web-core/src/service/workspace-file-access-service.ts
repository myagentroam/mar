/**
 * Workspace-bound file protocol and transport access for file tools and conversation attachments.
 * Captures full resource identity; attachment checks intentionally use uncached relay reads.
 * Preview UI/generations, file tab state and subscription lifetimes remain with their callers.
 */
import {
  isComposerAttachmentResourcePath,
  type DirectTransferResource
} from '@myagentroam/protocol';
import type { NodeWorkbenchManifest, WorkspaceTarget } from '../model/workbench.js';
import type { WorkspaceDirectFileIdentity } from '../model/workspace-direct-file.js';
import type { WorkspaceFilePreviewTarget } from '../model/workspace-file-preview.js';
import { MAX_BINARY_PREVIEW_BYTES } from '../util/file-preview.js';
import type { ScopedHttpService } from './scoped-http-service.js';
import type { createWorkspaceDirectTransferService } from './workspace-direct-transfer-service.js';
import type { createWorkspaceFileStreamClient } from './workspace-file-stream-client.js';
import { readWorkspaceFileObjectUrl } from './workspace-direct-object-url-service.js';
import { downloadWorkspaceFileToBrowser } from './workspace-direct-download-stream-service.js';
import {
  readWorkspaceDirectFileMetadata,
  readGitDirectFileMetadata,
  readWorkspaceDirectFileRange,
  readWorkspaceFileRange
} from './workspace-direct-file-read-service.js';

export interface WorkspaceFileAttachmentAccess {
  revalidate(file: { readonly path: string }): Promise<unknown>;
  sourceUrl(file: { readonly path: string }, revision?: number): string;
}

function workspaceFilePreviewUrl(target: WorkspaceFilePreviewTarget): string {
  const parameters = new URLSearchParams({ nodeId: target.nodeId, path: target.path });
  const history = target.history;
  const repositoryPath = history?.repositoryPath ?? target.repositoryPath;
  if (repositoryPath !== undefined && (history === undefined || repositoryPath !== ''))
    parameters.set('repositoryPath', repositoryPath);
  if (target.worktreePath !== undefined) parameters.set('worktreePath', target.worktreePath);
  for (const name of history?.refs ?? []) parameters.append('refs', name);
  const base = `/api/workspaces/${encodeURIComponent(target.workspaceId)}`;
  return `${base}${history === undefined ? '/files/content' : `/git/commits/${encodeURIComponent(history.commit)}/files/content`}?${parameters}`;
}

export function createWorkspaceFileAccessService(input: {
  request: (path: string, init?: RequestInit) => Promise<unknown>;
  http: ScopedHttpService;
  fetchContent?: typeof fetch;
  manifest: (nodeId: string) => NodeWorkbenchManifest | undefined;
  available: (nodeId: string) => boolean;
  direct: Pick<ReturnType<typeof createWorkspaceDirectTransferService>, 'download'>;
  downloads: Pick<ReturnType<typeof createWorkspaceFileStreamClient>, 'download'>;
  activeWorker?: () => Promise<ServiceWorker | undefined>;
}) {
  function forWorkspace(source: WorkspaceTarget) {
    const workspace = { nodeId: source.nodeId, workspaceId: source.workspaceId };
    type FileSource = Omit<WorkspaceFilePreviewTarget, 'nodeId' | 'workspaceId'>;
    function contentUrl(file: FileSource): string {
      return workspaceFilePreviewUrl({ ...file, ...workspace });
    }
    function readUrl(file: FileSource, limit: number): string {
      const parameters = new URLSearchParams({
        nodeId: workspace.nodeId,
        path: file.path,
        offset: '0',
        limit: String(limit)
      });
      if (file.repositoryPath !== undefined) parameters.set('repositoryPath', file.repositoryPath);
      if (file.worktreePath !== undefined) parameters.set('worktreePath', file.worktreePath);
      return `/api/workspaces/${encodeURIComponent(workspace.workspaceId)}/files/read?${parameters}`;
    }
    function read(file: FileSource, limit: number, signal?: AbortSignal): Promise<unknown> {
      const path = readUrl(file, limit);
      return signal === undefined ? input.http.request(path) : input.http.request(path, { signal });
    }
    const attachments: WorkspaceFileAttachmentAccess = {
      revalidate: (file) => input.request(readUrl(file, 1), { cache: 'no-store' }),
      sourceUrl: (file, revision) => {
        const url = contentUrl(file);
        return revision === undefined ? url : `${url}&preview=${encodeURIComponent(revision)}`;
      }
    };
    function write(path: string, content: string, expectedRevision: string) {
      return input.http.request<{
        readonly file?: { readonly revision?: unknown; readonly size?: unknown };
      }>(`/api/workspaces/${encodeURIComponent(workspace.workspaceId)}/files/write`, {
        method: 'PUT',
        body: JSON.stringify({ nodeId: workspace.nodeId, path, content, expectedRevision })
      });
    }
    function fetchFile(file: FileSource, init: RequestInit): Promise<Response> {
      return (input.fetchContent ?? fetch)(contentUrl(file), {
        credentials: 'same-origin',
        ...init
      });
    }
    function previewResource(file: FileSource) {
      const { path, history, worktreePath, repositoryPath } = file;
      const { workspaceId } = workspace;
      const resource =
        history === undefined
          ? {
              kind: 'WORKSPACE_FILE' as const,
              path,
              workspaceId,
              ...(worktreePath === undefined ? {} : { worktreePath }),
              ...(repositoryPath === undefined ? {} : { repositoryPath })
            }
          : {
              kind: 'GIT_COMMIT_BLOB' as const,
              path,
              workspaceId,
              commit: history.commit,
              refs: [...history.refs],
              ...(history.repositoryPath === '' ? {} : { repositoryPath: history.repositoryPath })
            };
      return resource;
    }
    function previewMetadata(resource: ReturnType<typeof previewResource>, signal: AbortSignal) {
      const { nodeId } = workspace;
      const request = input.request;
      return resource.kind === 'GIT_COMMIT_BLOB'
        ? readGitDirectFileMetadata({ request, nodeId, resource, refs: resource.refs, signal })
        : readWorkspaceDirectFileMetadata({ request, nodeId, resource, signal });
    }
    function readPreviewRange(
      file: FileSource,
      length: number,
      identity: WorkspaceDirectFileIdentity | undefined,
      signal: AbortSignal
    ) {
      const resource = previewResource(file);
      const { nodeId } = workspace;
      return readWorkspaceFileRange(
        {
          resource,
          length,
          offset: 0,
          fileName: file.path.split('/').at(-1) ?? 'file',
          ...(identity === undefined ? {} : { identity }),
          signal,
          metadata: () => previewMetadata(resource, signal)
        },
        (transfer) => input.downloads.download({ ...transfer, nodeId })
      );
    }
    async function readPreviewObject(
      file: FileSource,
      signal: AbortSignal
    ): Promise<WorkspaceDirectFileIdentity & { readonly url?: string }> {
      const resource = previewResource(file);
      const identity = await previewMetadata(resource, signal);
      signal.throwIfAborted();
      if (identity === undefined) throw new Error('NODE_RESPONSE_INVALID');
      if (identity.size > MAX_BINARY_PREVIEW_BYTES) return identity;
      const fileName = file.path.split('/').at(-1) ?? 'file';
      const url = await readWorkspaceFileObjectUrl(fileName, signal, (sink) =>
        input.downloads.download({
          nodeId: workspace.nodeId,
          descriptor: { direction: 'DOWNLOAD', resource, fileName, ...identity },
          sink,
          signal
        })
      );
      return { url, ...identity };
    }
    function workspaceDirectFile(
      path: string,
      worktreePath?: string,
      repositoryPath?: string,
      signal?: AbortSignal
    ) {
      if (isComposerAttachmentResourcePath(path)) return undefined;
      const { nodeId, workspaceId } = workspace;
      const manifest = input.manifest(nodeId);
      const nodeGeneration = manifest?.nodeGeneration;
      if (nodeGeneration === undefined || !input.available(nodeId)) return undefined;
      const resource = {
        kind: 'WORKSPACE_FILE' as const,
        workspaceId,
        path,
        ...(repositoryPath === undefined ? {} : { repositoryPath }),
        ...(worktreePath === undefined ? {} : { worktreePath })
      };
      return {
        direct: input.direct,
        nodeId,
        nodeGeneration,
        resource,
        metadata: () =>
          manifest?.directTransfer?.download === true
            ? readWorkspaceDirectFileMetadata({
                request: input.request,
                nodeId,
                resource,
                ...(signal === undefined ? {} : { signal })
              })
            : Promise.resolve(undefined)
      };
    }

    function gitDirectFile(
      commit: string,
      path: string,
      repositoryPath: string,
      refs: readonly string[],
      signal?: AbortSignal
    ) {
      const { nodeId, workspaceId } = workspace;
      const manifest = input.manifest(nodeId);
      const nodeGeneration = manifest?.nodeGeneration;
      if (
        nodeGeneration === undefined ||
        manifest?.directTransfer?.gitCommitBlob !== true ||
        !input.available(nodeId)
      )
        return undefined;
      const resource = {
        kind: 'GIT_COMMIT_BLOB' as const,
        workspaceId,
        commit,
        path,
        ...(repositoryPath.length === 0 ? {} : { repositoryPath })
      };
      const capturedRefs = [...refs];
      return {
        direct: input.direct,
        nodeId,
        nodeGeneration,
        resource,
        metadata: () =>
          readGitDirectFileMetadata({
            request: input.request,
            nodeId,
            resource,
            refs: capturedRefs,
            ...(signal === undefined ? {} : { signal })
          })
      };
    }

    async function directWorkspaceFileReadRange(
      path: string,
      offset: number,
      length: number,
      worktreePath?: string,
      identity?: WorkspaceDirectFileIdentity,
      repositoryPath?: string,
      signal?: AbortSignal
    ) {
      if (input.manifest(workspace.nodeId)?.directTransfer?.range !== true) return undefined;
      const target = workspaceDirectFile(path, worktreePath, repositoryPath, signal);
      if (target === undefined) return undefined;
      return readWorkspaceDirectFileRange({
        ...target,
        fileName: path.split('/').at(-1) ?? 'file',
        offset,
        length,
        ...(signal === undefined ? {} : { signal }),
        ...(identity === undefined ? {} : { identity })
      }).catch(() => undefined);
    }

    async function directGitFileReadRange(
      commit: string,
      path: string,
      repositoryPath: string,
      refs: readonly string[],
      offset: number,
      length: number,
      identity?: WorkspaceDirectFileIdentity,
      signal?: AbortSignal
    ) {
      if (input.manifest(workspace.nodeId)?.directTransfer?.range !== true) return undefined;
      const target = gitDirectFile(commit, path, repositoryPath, refs, signal);
      if (target === undefined) return undefined;
      return readWorkspaceDirectFileRange({
        ...target,
        fileName: path.split('/').at(-1) ?? 'file',
        offset,
        length,
        ...(signal === undefined ? {} : { signal }),
        ...(identity === undefined ? {} : { identity })
      }).catch(() => undefined);
    }

    async function directWorkspaceFileDownload(
      path: string,
      worktreePath?: string,
      repositoryPath?: string
    ) {
      const resource = {
        kind: 'WORKSPACE_FILE' as const,
        workspaceId: workspace.workspaceId,
        path,
        ...(worktreePath === undefined ? {} : { worktreePath }),
        ...(repositoryPath === undefined ? {} : { repositoryPath })
      };
      const identity = await readWorkspaceDirectFileMetadata({
        request: input.request,
        nodeId: workspace.nodeId,
        resource
      });
      return download(resource, identity);
    }

    async function directGitFileDownload(
      commit: string,
      path: string,
      repositoryPath: string,
      refs: readonly string[]
    ) {
      const resource = {
        kind: 'GIT_COMMIT_BLOB' as const,
        workspaceId: workspace.workspaceId,
        path,
        commit,
        refs: [...refs],
        ...(repositoryPath.length === 0 ? {} : { repositoryPath })
      };
      const identity = await readGitDirectFileMetadata({
        request: input.request,
        nodeId: workspace.nodeId,
        resource,
        refs: resource.refs
      });
      return download(resource, identity);
    }

    async function download(
      resource: DirectTransferResource,
      identity: WorkspaceDirectFileIdentity | undefined
    ) {
      if (identity === undefined) throw new Error('NODE_RESPONSE_INVALID');
      const fileName = resource.path.split('/').at(-1) ?? 'download';
      return downloadWorkspaceFileToBrowser({
        fileName,
        size: identity.size,
        ...(input.activeWorker === undefined ? {} : { activeWorker: input.activeWorker }),
        download: (sink, signal) =>
          input.downloads.download({
            nodeId: workspace.nodeId,
            descriptor: { direction: 'DOWNLOAD', resource, fileName, ...identity },
            sink,
            ...(signal === undefined ? {} : { signal })
          })
      });
    }

    return {
      attachments,
      contentUrl,
      read,
      readPreviewRange,
      readPreviewObject,
      write,
      fetchFile,
      directFileReadRange: directWorkspaceFileReadRange,
      directFileDownload: directWorkspaceFileDownload,
      directGitFileReadRange,
      directGitFileDownload
    };
  }
  return { forWorkspace };
}
