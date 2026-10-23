import type { DirectTransferDescriptor, DirectTransferResource } from '@myagentroam/protocol';
import type { createWorkspaceDirectTransferService } from './WorkspaceDirectTransferService.js';

export interface WorkspaceDirectFileIdentity {
  readonly revision: string;
  readonly size: number;
}

export interface WorkspaceDirectFileRange extends WorkspaceDirectFileIdentity {
  readonly offset: number;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly nextOffset: number | null;
}

type MetadataRequest = (path: string) => Promise<unknown>;

function metadataIdentity(body: unknown): WorkspaceDirectFileIdentity | undefined {
  const file = (body as { readonly file?: { size?: unknown; revision?: unknown } }).file;
  return typeof file?.size === 'number' && typeof file.revision === 'string'
    ? { size: file.size, revision: file.revision }
    : undefined;
}

export async function readWorkspaceDirectFileMetadata(input: {
  readonly request: MetadataRequest;
  readonly nodeId: string;
  readonly resource: Extract<DirectTransferResource, { kind: 'WORKSPACE_FILE' }>;
}): Promise<WorkspaceDirectFileIdentity | undefined> {
  const { resource } = input;
  const parameters = new URLSearchParams({ nodeId: input.nodeId, path: resource.path });
  if (resource.repositoryPath !== undefined)
    parameters.set('repositoryPath', resource.repositoryPath);
  if (resource.worktreePath !== undefined) parameters.set('worktreePath', resource.worktreePath);
  return metadataIdentity(
    await input.request(
      `/api/workspaces/${encodeURIComponent(resource.workspaceId)}/files/direct-metadata?${parameters}`
    )
  );
}

export async function readGitDirectFileMetadata(input: {
  readonly request: MetadataRequest;
  readonly nodeId: string;
  readonly resource: Extract<DirectTransferResource, { kind: 'GIT_COMMIT_BLOB' }>;
  readonly refs: readonly string[];
}): Promise<WorkspaceDirectFileIdentity | undefined> {
  const { resource } = input;
  const parameters = new URLSearchParams({ nodeId: input.nodeId, path: resource.path });
  if (resource.repositoryPath !== undefined && resource.repositoryPath.length > 0)
    parameters.set('repositoryPath', resource.repositoryPath);
  for (const ref of input.refs) parameters.append('refs', ref);
  return metadataIdentity(
    await input.request(
      `/api/workspaces/${encodeURIComponent(resource.workspaceId)}/git/commits/${encodeURIComponent(resource.commit)}/files/direct-metadata?${parameters}`
    )
  );
}

/** The editor uses the same content revision as the relayed file read and Node write. */
export async function directFileContentRevision(
  file: WorkspaceDirectFileRange
): Promise<string | undefined> {
  if (file.offset !== 0 || file.nextOffset !== null || file.bytes.byteLength !== file.size)
    return undefined;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', file.bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function readWorkspaceDirectFileRange(input: {
  readonly direct: Pick<ReturnType<typeof createWorkspaceDirectTransferService>, 'download'>;
  readonly nodeId: string;
  readonly nodeGeneration: string;
  readonly resource: DirectTransferResource;
  readonly fileName: string;
  readonly offset: number;
  readonly length: number;
  readonly identity?: WorkspaceDirectFileIdentity;
  readonly metadata: () => Promise<WorkspaceDirectFileIdentity | undefined>;
  readonly signal?: AbortSignal;
}): Promise<WorkspaceDirectFileRange> {
  const identity = input.identity ?? (await input.metadata());
  if (identity === undefined) throw new Error('DIRECT_METADATA_UNAVAILABLE');
  const length = Math.min(input.length, identity.size - input.offset);
  if (length <= 0)
    return {
      ...identity,
      offset: input.offset,
      bytes: new Uint8Array(),
      nextOffset: null
    };
  const range = { offset: input.offset, length };

  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let received = 0;
  const descriptor: DirectTransferDescriptor = {
    direction: 'DOWNLOAD',
    resource: input.resource,
    fileName: input.fileName,
    revision: identity.revision,
    size: identity.size,
    range
  };
  await input.direct.download({
    nodeId: input.nodeId,
    nodeGeneration: input.nodeGeneration,
    descriptor,
    sink: {
      async write(bytes) {
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        chunks.push(copy);
        received += copy.byteLength;
      },
      async close() {},
      async abort() {
        chunks.length = 0;
        received = 0;
      }
    },
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  if (received !== length) throw new Error('DIRECT_INTEGRITY_FAILED');
  const bytes = new Uint8Array(length);
  let cursor = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return {
    ...identity,
    offset: input.offset,
    bytes,
    nextOffset: input.offset + length < identity.size ? input.offset + length : null
  };
}
