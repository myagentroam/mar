import type { NodeStream } from '@myagentroam/protocol/node-stream';

/** Moves bytes and checks their count; the file source owns authorization and version checks. */
export async function sendFileDownload(
  stream: NodeStream,
  chunks: AsyncIterable<Uint8Array>,
  size: number,
  signal: AbortSignal
): Promise<void> {
  let sent = 0;
  for await (const chunk of chunks) {
    signal.throwIfAborted();
    sent += chunk.byteLength;
    if (sent > size) throw new Error('DIRECT_INTEGRITY_FAILED');
    await stream.write(chunk);
  }
  signal.throwIfAborted();
  if (sent !== size) throw new Error('DIRECT_INTEGRITY_FAILED');
  await stream.endWrite();
  // The reverse FIN acknowledges a closed destination sink.
  for await (const chunk of stream)
    if (chunk.byteLength !== 0) throw new Error('DIRECT_FRAME_INVALID');
  signal.throwIfAborted();
}
