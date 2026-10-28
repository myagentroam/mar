import {
  WorkspaceSessionService,
  type WorkspaceSessionServiceOptions
} from '../workspace/workspace-session-service.js';
import {
  WorkspaceWatchService,
  type WorkspaceWatch
} from '../workspace/workspace-watch-service.js';
import { WorkspaceFileService } from '../workspace/workspace-file-service.js';
import { WorkspaceUploadService } from '../workspace/workspace-upload-service.js';

/** Composes the mutually dependent workspace resource and observation owners. */
export function composeWorkspaceResources(input: {
  readonly discover: WorkspaceSessionServiceOptions['discover'];
  readonly listPage: WorkspaceSessionServiceOptions['listPage'];
  readonly invalidateSessions: (workspaceId: string) => void;
  readonly invalidateFiles: (workspaceId: string) => void;
  readonly releaseWatch: (workspaceId: string) => void;
  readonly removeWatch: (watch: WorkspaceWatch) => void;
  readonly temporaryRoot: () => string;
  readonly attachmentResource: (workspaceId: string, path: string) => string | undefined;
}) {
  const watch = new WorkspaceWatchService(
    (id) => sessions.ensureWatch(id),
    (id) => sessions.stopWatch(id),
    input.releaseWatch,
    input.removeWatch
  );
  const sessions = new WorkspaceSessionService({
    discover: input.discover,
    listPage: input.listPage,
    active: (id) => watch.topicActive(id, 'sessions'),
    invalidate: input.invalidateSessions
  });
  const invalidateFiles = (id: string): void => {
    files.dispose(id);
    input.invalidateFiles(id);
  };
  const uploads = new WorkspaceUploadService(invalidateFiles, input.temporaryRoot);
  const files = new WorkspaceFileService(
    invalidateFiles,
    {},
    (id, path) => uploads.fileResource(id, path) ?? input.attachmentResource(id, path)
  );
  return { watch, sessions, files, uploads, invalidateFiles };
}
