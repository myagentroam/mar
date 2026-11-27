import { receiveFileUpload, type FileUploadSink } from '../connection/file-upload-stream.js';
import type { NodeStream } from '@myagentroam/protocol/node-stream';

export interface WorkspaceUploadTarget extends FileUploadSink {
  complete(size: number, signal?: AbortSignal): Promise<void>;
  cancel(): Promise<void>;
  release?(): void;
}

/** Moves bytes into an authorized upload. The caller owns target lifetime and abort cleanup. */
export async function receiveWorkspaceUpload(
  stream: NodeStream,
  target: WorkspaceUploadTarget,
  size: number,
  signal: AbortSignal
): Promise<void> {
  await receiveFileUpload(stream, target, size, signal);
  await target.complete(size, signal);
}
