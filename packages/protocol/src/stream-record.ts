const HEADER_BYTES = 4;

/** Bounded length-prefixed records over a byte stream; each domain owns its payload. */
export function writeStreamRecord(frame: Uint8Array, maxBytes: number, code: string) {
  validateLength(frame.byteLength, maxBytes, code);
  const bytes = new Uint8Array(HEADER_BYTES + frame.byteLength);
  new DataView(bytes.buffer).setUint32(0, frame.byteLength);
  bytes.set(frame, HEADER_BYTES);
  return bytes;
}

export async function* readStreamRecords(
  source: AsyncIterable<Uint8Array>,
  maxBytes: number,
  invalid: string,
  truncated: string
): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  const header = new Uint8Array(HEADER_BYTES);
  let frame: Uint8Array<ArrayBuffer> | undefined;
  let used = 0;
  for await (const chunk of source) {
    for (let start = 0; start < chunk.byteLength;) {
      const target = frame ?? header;
      const length = Math.min(target.byteLength - used, chunk.byteLength - start);
      target.set(chunk.subarray(start, start + length), used);
      start += length;
      used += length;
      if (used !== target.byteLength) continue;
      used = 0;
      if (frame === undefined) {
        const size = new DataView(header.buffer).getUint32(0);
        validateLength(size, maxBytes, invalid);
        frame = new Uint8Array(size);
      } else {
        yield frame;
        frame = undefined;
      }
    }
  }
  if (frame !== undefined || used !== 0) throw new Error(truncated);
}

function validateLength(length: number, maxBytes: number, code: string): void {
  if (length === 0 || length > maxBytes) throw new Error(code);
}
