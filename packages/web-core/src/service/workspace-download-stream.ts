import type { NodeStream } from '@myagentroam/protocol/node-stream';

export interface WorkspaceDownloadSink {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

/** Opens once and binds the sink and the individual stream to the transfer lifetime. */
export async function receiveFileDownloadBody(
  open: () => Promise<NodeStream>,
  sink: WorkspaceDownloadSink,
  size: number,
  signal: AbortSignal,
  onProgress?: (offset: number) => void
): Promise<void> {
  try {
    const stream = await open();
    const abort = () => stream.close();
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      await receiveWorkspaceDownload(stream, sink, size, signal, onProgress);
    } catch (error) {
      stream.close();
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  } catch (error) {
    await sink.abort().catch(() => undefined);
    throw error;
  }
}

/** Writes raw stream bytes into an existing sink. Its caller owns cancellation and sink abort. */
export async function receiveWorkspaceDownload(
  stream: NodeStream,
  sink: WorkspaceDownloadSink,
  size: number,
  signal: AbortSignal,
  onProgress?: (offset: number) => void
): Promise<void> {
  let received = 0;
  for await (const chunk of stream) {
    signal.throwIfAborted();
    received += chunk.byteLength;
    if (received > size) throw new Error('DIRECT_INTEGRITY_FAILED');
    await sink.write(chunk);
    onProgress?.(received);
  }
  signal.throwIfAborted();
  if (received !== size) throw new Error('DIRECT_INTEGRITY_FAILED');
  await sink.close();
  signal.throwIfAborted();
  await stream.endWrite();
}
