import type { DirectTransferDescriptor } from '@myagentroam/protocol';
import type { NodeStreamHandler } from '@myagentroam/protocol/node-stream-mux';
import { NodeStreamGrants } from '../connection/node-stream-grants.js';
import { sendFileDownload } from '../connection/file-download-stream.js';
import { receiveWorkspaceUpload, type WorkspaceUploadTarget } from './workspace-upload-stream.js';

type Upload = Extract<DirectTransferDescriptor, { direction: 'UPLOAD' }>;
type Download = Extract<DirectTransferDescriptor, { direction: 'DOWNLOAD' }>;

/** Owns one-use Relay file grants. The workspace owns snapshots and staging, not the carrier. */
export class WorkspaceFileStreamService {
  private readonly grants = new NodeStreamGrants();

  constructor(
    private readonly sources: {
      openUpload(descriptor: Upload): Promise<WorkspaceUploadTarget>;
      openDownload(descriptor: Download): Promise<{ chunks: AsyncIterable<Uint8Array> }>;
    }
  ) {}

  prepare(descriptor: DirectTransferDescriptor): string {
    const kind = descriptor.direction === 'UPLOAD' ? 'file-upload' : 'file-download';
    return this.grants.issue(kind, async (stream, signal) => {
      let upload: WorkspaceUploadTarget | undefined;
      try {
        signal.throwIfAborted();
        if (descriptor.direction === 'UPLOAD') {
          upload = await this.sources.openUpload(descriptor);
          await receiveWorkspaceUpload(stream, upload, descriptor.size, signal);
          upload.release?.();
          upload = undefined; // Body accepted; a lost final FIN must not discard staging.
          await stream.endWrite();
        } else {
          const source = await this.sources.openDownload(descriptor);
          await sendFileDownload(
            stream,
            source.chunks,
            descriptor.range?.length ?? descriptor.size,
            signal
          );
        }
      } catch (error) {
        const disconnected =
          signal.reason instanceof Error && signal.reason.message === 'NODE_STREAM_DISCONNECTED';
        if (
          upload !== undefined &&
          !(
            disconnected &&
            descriptor.direction === 'UPLOAD' &&
            descriptor.composerAttachment === undefined
          )
        ) {
          await upload.cancel();
        }
        if (!signal.aborted) {
          const code =
            error instanceof Error && /^[A-Z][A-Z0-9_]{0,95}$/u.test(error.message)
              ? error.message
              : 'FILE_STREAM_FAILED';
          stream.reset(code);
        }
      } finally {
        upload?.release?.();
      }
    });
  }

  consume(kind: string, grant: string): NodeStreamHandler | undefined {
    return this.grants.consume(kind, grant);
  }

  clear(): void {
    this.grants.clear();
  }
}
