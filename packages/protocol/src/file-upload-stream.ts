const OFFSET_BYTES = 8;

/** Upload receipts are contiguous offsets persisted by the Node, independent of DATA boundaries. */
export function encodeUploadOffset(offset: number): Uint8Array {
  const record = new Uint8Array(OFFSET_BYTES);
  new DataView(record.buffer).setBigUint64(0, BigInt(offset));
  return record;
}

export async function* readUploadOffsets(
  chunks: AsyncIterable<Uint8Array>
): AsyncGenerator<number> {
  const record = new Uint8Array(OFFSET_BYTES);
  const view = new DataView(record.buffer);
  let filled = 0;
  for await (const chunk of chunks) {
    for (let start = 0; start < chunk.length;) {
      const size = Math.min(OFFSET_BYTES - filled, chunk.length - start);
      record.set(chunk.subarray(start, start + size), filled);
      filled += size;
      start += size;
      if (filled !== OFFSET_BYTES) continue;
      const offset = Number(view.getBigUint64(0));
      if (!Number.isSafeInteger(offset)) throw new Error('DIRECT_OFFSET_INVALID');
      filled = 0;
      yield offset;
    }
  }
  if (filled !== 0) throw new Error('DIRECT_FRAME_INVALID');
}
