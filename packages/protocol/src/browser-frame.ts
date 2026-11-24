export const BROWSER_FRAME_MESSAGE_BYTES = 16 * 1024;
// Bounded by a full 1920×1080 RGBX framebuffer plus rectangle headers.
export const BROWSER_FRAME_MAX_BYTES = 8 * 1024 * 1024;
const HEADER_BYTES = 21;
const PAYLOAD_BYTES = BROWSER_FRAME_MESSAGE_BYTES - HEADER_BYTES;

export interface BrowserFrame {
  sequence: number;
  viewVersion: number;
  width: number;
  height: number;
  key: boolean;
  data: Uint8Array;
}

function headerOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, HEADER_BYTES);
}

function uint(value: number, max: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= max;
}

/** Segments one RFB update lazily while the transport waits for capacity. */
export function* encodeBrowserFrame(
  frame: BrowserFrame
): Generator<{ bytes: Uint8Array; final: boolean }> {
  const { sequence, viewVersion, width, height, key, data } = frame;
  if (
    !uint(sequence, 0xffffffff) ||
    !uint(viewVersion, 0xffffffff) ||
    !uint(width, 0xffff) ||
    !uint(height, 0xffff) ||
    !uint(data.byteLength, BROWSER_FRAME_MAX_BYTES)
  )
    throw new RangeError('Invalid browser frame.');

  for (let offset = 0; offset < data.byteLength; offset += PAYLOAD_BYTES) {
    const payload = data.subarray(offset, offset + PAYLOAD_BYTES);
    const chunk = new Uint8Array(HEADER_BYTES + payload.byteLength);
    const header = headerOf(chunk);
    header.setUint32(0, sequence);
    header.setUint32(4, viewVersion);
    header.setUint16(8, width);
    header.setUint16(10, height);
    header.setUint32(12, offset);
    header.setUint32(16, data.byteLength);
    header.setUint8(20, key ? 1 : 0);
    chunk.set(payload, HEADER_BYTES);
    yield { bytes: chunk, final: offset + payload.byteLength === data.byteLength };
  }
}

/** One receiver per ordered attachment. A malformed message invalidates that attachment. */
export class BrowserFrameReceiver {
  private lastSequence = 0;
  private offset = 0;
  private frame: (BrowserFrame & { data: Uint8Array<ArrayBuffer> }) | undefined;

  push(bytes: Uint8Array) {
    if (bytes.byteLength <= HEADER_BYTES || bytes.byteLength > BROWSER_FRAME_MESSAGE_BYTES) {
      throw new RangeError('Invalid browser frame message size.');
    }
    const header = headerOf(bytes);
    const sequence = header.getUint32(0);
    const viewVersion = header.getUint32(4);
    const width = header.getUint16(8);
    const height = header.getUint16(10);
    const offset = header.getUint32(12);
    const total = header.getUint32(16);
    const flags = header.getUint8(20);
    const key = flags === 1;
    const length = bytes.byteLength - HEADER_BYTES;
    if (
      !sequence ||
      !viewVersion ||
      !width ||
      !height ||
      !total ||
      flags > 1 ||
      total > BROWSER_FRAME_MAX_BYTES ||
      offset !== this.offset ||
      length !== Math.min(PAYLOAD_BYTES, total - offset)
    ) {
      throw new RangeError('Invalid browser frame chunk.');
    }
    let frame = this.frame;
    if (frame === undefined) {
      if (sequence <= this.lastSequence) throw new RangeError('Old browser frame.');
      frame = { sequence, viewVersion, width, height, key, data: new Uint8Array(total) };
      this.frame = frame;
    } else if (
      frame.sequence !== sequence ||
      frame.viewVersion !== viewVersion ||
      frame.width !== width ||
      frame.height !== height ||
      frame.key !== key ||
      frame.data.byteLength !== total
    ) {
      throw new RangeError('Browser frame changed mid-message.');
    }

    frame.data.set(bytes.subarray(HEADER_BYTES), offset);
    this.offset += length;
    if (this.offset !== total) return undefined;
    this.frame = undefined;
    this.offset = 0;
    this.lastSequence = sequence;
    return frame;
  }
}
