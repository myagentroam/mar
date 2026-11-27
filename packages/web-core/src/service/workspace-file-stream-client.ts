import type { DirectTransferDescriptor } from '@myagentroam/protocol';
import {
  receiveFileDownloadBody,
  type WorkspaceDownloadSink
} from './workspace-download-stream.js';
import { sendFileUploadBody } from './workspace-upload-stream.js';
import type { OpenWorkbenchNodeStream } from './workbench-node-connection-service.js';

export interface WorkspaceFileStreamTransfer {
  readonly nodeId: string;
  readonly descriptor: DirectTransferDescriptor;
  readonly signal?: AbortSignal;
  readonly onProgress?: (offset: number) => void;
}

/** Adapts file tasks to streams without choosing or retrying a transport. */
export function createWorkspaceFileStreamClient(openStream: OpenWorkbenchNodeStream) {
  return {
    async upload(input: WorkspaceFileStreamTransfer & { file: File }): Promise<void> {
      const { descriptor, file, onProgress } = input;
      if (descriptor.direction !== 'UPLOAD') throw new Error('DIRECT_TRANSFER_INVALID');
      const signal = input.signal ?? new AbortController().signal;
      await sendFileUploadBody(
        () => openStream(input.nodeId, { kind: 'file-upload', descriptor }, signal),
        file,
        signal,
        onProgress
      );
    },
    async download(
      input: WorkspaceFileStreamTransfer & { sink: WorkspaceDownloadSink }
    ): Promise<void> {
      const { descriptor, sink, onProgress } = input;
      const signal = input.signal ?? new AbortController().signal;
      if (descriptor.direction !== 'DOWNLOAD') {
        await sink.abort().catch(() => undefined);
        throw new Error('DIRECT_TRANSFER_INVALID');
      }
      await receiveFileDownloadBody(
        () => openStream(input.nodeId, { kind: 'file-download', descriptor }, signal),
        sink,
        descriptor.range?.length ?? descriptor.size,
        signal,
        onProgress
      );
    }
  };
}
