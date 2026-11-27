import { encodeUploadOffset } from '@myagentroam/protocol/file-upload-stream';
import type { NodeStream } from '@myagentroam/protocol/node-stream';
import { safeErrorCode } from '../util/safe-error.js';

export interface FileUploadSink {
  readonly offset: number;
  write(bytes: Uint8Array): Promise<number>;
}

/** Receives an exact byte count; the domain owns staging, commit and cleanup. */
export async function receiveFileUpload(
  stream: NodeStream,
  sink: FileUploadSink,
  size: number,
  signal: AbortSignal
): Promise<void> {
  let offset = sink.offset;
  signal.throwIfAborted();
  await stream.write(encodeUploadOffset(offset));
  for await (const chunk of stream) {
    try {
      signal.throwIfAborted();
      if (chunk.byteLength > size - offset) throw new Error('DIRECT_INTEGRITY_FAILED');
      offset = await sink.write(chunk);
      signal.throwIfAborted();
      await stream.write(encodeUploadOffset(offset));
    } catch (error) {
      // Preserve the failure code before the iterator closes with a generic cancellation.
      if (!signal.aborted) {
        const code = safeErrorCode(error, 'FILE_STREAM_FAILED');
        stream.reset(code.length <= 96 ? code : 'FILE_STREAM_FAILED');
      }
      throw error;
    }
  }
  signal.throwIfAborted();
  if (offset !== size) throw new Error('DIRECT_INTEGRITY_FAILED');
}
