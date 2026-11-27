import { describe, expect, it } from 'vitest';
import { encodeUploadOffset, readUploadOffsets } from '../../src/file-upload-stream.js';

async function* chunks(...values: Uint8Array[]) {
  yield* values;
}

async function offsets(...values: Uint8Array[]) {
  const collected: number[] = [];
  for await (const offset of readUploadOffsets(chunks(...values))) collected.push(offset);
  return collected;
}

describe('file upload receipts', () => {
  it('decodes offsets regardless of how the byte stream is split', async () => {
    const offset = 8_000_000_001;
    const records = new Uint8Array([...encodeUploadOffset(0), ...encodeUploadOffset(offset)]);
    expect([...encodeUploadOffset(256)]).toEqual([0, 0, 0, 0, 0, 0, 1, 0]);
    expect(await offsets(records.slice(0, 3), records.slice(3))).toEqual([0, offset]);
  });

  it('rejects truncated or unrepresentable offsets', async () => {
    await expect(offsets(Uint8Array.of(0))).rejects.toThrow('DIRECT_FRAME_INVALID');
    await expect(offsets(new Uint8Array(8).fill(255))).rejects.toThrow('DIRECT_OFFSET_INVALID');
  });
});
