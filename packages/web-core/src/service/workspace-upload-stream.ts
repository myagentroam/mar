import { readUploadOffsets } from '@myagentroam/protocol/file-upload-stream';
import type { NodeStream } from '@myagentroam/protocol/node-stream';

type UploadStream = Pick<NodeStream, typeof Symbol.asyncIterator | 'write' | 'endWrite' | 'close'>;

/** Owns one upload substream from OPEN through completion or cancellation. */
export async function sendFileUploadBody(
  open: () => Promise<UploadStream>,
  file: File,
  signal: AbortSignal,
  onProgress?: (offset: number) => void
): Promise<void> {
  const stream = await open();
  const abort = () => stream.close();
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    await sendWorkspaceUpload(stream, file, signal, onProgress);
  } catch (error) {
    stream.close();
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** Pumps the selected file from the Node's offset without waiting a round trip per chunk. */
export async function sendWorkspaceUpload(
  stream: UploadStream,
  file: File,
  signal: AbortSignal,
  onProgress?: (offset: number) => void
): Promise<void> {
  const receipts = readUploadOffsets(stream);
  const first = await receipts.next();
  if (first.done || first.value > file.size) throw new Error('DIRECT_OFFSET_INVALID');
  let persisted = first.value;
  signal.throwIfAborted();
  onProgress?.(persisted);
  await Promise.all([sendFrom(persisted), readReceipts()]);

  async function sendFrom(offset: number): Promise<void> {
    while (offset < file.size) {
      const end = Math.min(file.size, offset + 256 * 1024);
      const chunk = await file.slice(offset, end).arrayBuffer();
      signal.throwIfAborted();
      await stream.write(new Uint8Array(chunk));
      offset = end;
    }
    signal.throwIfAborted();
    await stream.endWrite();
  }

  async function readReceipts(): Promise<void> {
    for await (const offset of receipts) {
      signal.throwIfAborted();
      if (offset <= persisted || offset > file.size) throw new Error('DIRECT_OFFSET_INVALID');
      persisted = offset;
      onProgress?.(offset);
    }
    if (persisted !== file.size) throw new Error('DIRECT_INTEGRITY_FAILED');
  }
}
