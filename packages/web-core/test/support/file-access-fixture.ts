import type { ScopedHttpService } from '../../src/service/scoped-http-service.js';
import { createWorkspaceFileAccessService } from '../../src/service/workspace-file-access-service.js';
import type { WorkspaceFilePreviewTarget } from '../../src/model/workspace-file-preview.js';

type Access = ReturnType<ReturnType<typeof createWorkspaceFileAccessService>['forWorkspace']>;
type TransferName =
  | 'directFileDownload'
  | 'directFileObjectUrl'
  | 'directFileReadRange'
  | 'directGitFileDownload'
  | 'directGitFileObjectUrl'
  | 'directGitFileReadRange';
export type WorkspaceFilePreviewTransfers = Partial<Pick<Access, TransferName>>;

export function createFileAccessFixture(input: {
  readonly http: ScopedHttpService;
  readonly transfers: () => WorkspaceFilePreviewTransfers;
  readonly fetchContent?: typeof fetch;
}) {
  const access = createWorkspaceFileAccessService({
    request: input.http.request,
    http: input.http,
    ...(input.fetchContent === undefined ? {} : { fetchContent: input.fetchContent }),
    manifest: () => undefined,
    available: () => false,
    direct: { download: async () => {} }
  });
  return (target: WorkspaceFilePreviewTarget): Access => ({
    ...access.forWorkspace(target),
    ...input.transfers()
  });
}
