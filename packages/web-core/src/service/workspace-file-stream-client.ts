import type { DirectTransferDescriptor } from '@myagentroam/protocol';
import type { NodeStream } from '@myagentroam/protocol/node-stream';
import type { WorkbenchStreamTransport } from '../model/workbench.js';
import {
  receiveFileDownloadBody,
  type WorkspaceDownloadSink
} from './workspace-download-stream.js';
import { sendFileUploadBody } from './workspace-upload-stream.js';
import type { WorkbenchFileStreamRequest } from './workbench-node-connection-service.js';

export interface WorkspaceFileStreamTransfer {
  readonly nodeId: string;
  readonly descriptor: DirectTransferDescriptor;
  readonly signal?: AbortSignal;
  readonly onProgress?: (offset: number) => void;
}

/** Adapts file tasks to streams without choosing or retrying a transport. */
export function createWorkspaceFileStreamClient(
  openStream: (
    nodeId: string,
    request: WorkbenchFileStreamRequest,
    signal: AbortSignal
  ) => Promise<{ stream: NodeStream; transport: WorkbenchStreamTransport }>
) {
  return {
    async upload(
      input: WorkspaceFileStreamTransfer & {
        file: File;
        onTransport?: (transport: WorkbenchStreamTransport) => void;
      }
    ): Promise<void> {
      const { descriptor, file, onProgress, onTransport } = input;
      if (descriptor.direction !== 'UPLOAD') throw new Error('DIRECT_TRANSFER_INVALID');
      const signal = input.signal ?? new AbortController().signal;
      const { stream, transport } = await openStream(
        input.nodeId,
        { kind: 'file-upload', descriptor },
        signal
      );
      await sendFileUploadBody(stream, file, signal, onProgress, () => onTransport?.(transport));
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
        async () =>
          (await openStream(input.nodeId, { kind: 'file-download', descriptor }, signal)).stream,
        sink,
        descriptor.range?.length ?? descriptor.size,
        signal,
        onProgress
      );
    }
  };
}
