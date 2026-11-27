// One application frame per WebSocket or DataChannel message.
const VERSION = 1;
const HEADER_BYTES = 3;
const MAX_METADATA_BYTES = 4096;
export const MAX_BYTE_FRAME_PAYLOAD = 64 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Shared wire layout; each domain sets its own payload bound and validates its own message types. */
export class ByteFrameCodec {
  constructor(
    private readonly maxPayload: number,
    private readonly maxMetadata = MAX_METADATA_BYTES
  ) {}

  encode(metadata: object, payload?: Uint8Array): Uint8Array<ArrayBuffer> {
    const header = encoder.encode(JSON.stringify(metadata));
    const size = payload?.byteLength ?? 0;
    if (header.length > this.maxMetadata || header.length > 0xffff || size > this.maxPayload)
      throw new Error('BYTE_FRAME_LIMIT');
    const frame = new Uint8Array(HEADER_BYTES + header.length + size);
    frame[0] = VERSION;
    new DataView(frame.buffer).setUint16(1, header.length);
    frame.set(header, HEADER_BYTES);
    if (payload !== undefined) frame.set(payload, HEADER_BYTES + header.length);
    return frame;
  }

  decode(input: unknown): { metadata: Record<string, unknown>; payload: Uint8Array } {
    const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
    if (!(bytes instanceof Uint8Array) || bytes.length < HEADER_BYTES || bytes[0] !== VERSION)
      throw new Error('BYTE_FRAME_INVALID');
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(1);
    const end = HEADER_BYTES + size;
    if (size > this.maxMetadata || end > bytes.length || bytes.length - end > this.maxPayload)
      throw new Error('BYTE_FRAME_LIMIT');
    const metadata: unknown = JSON.parse(decoder.decode(bytes.subarray(HEADER_BYTES, end)));
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata))
      throw new Error('BYTE_FRAME_INVALID');
    return { metadata: metadata as Record<string, unknown>, payload: bytes.subarray(end) };
  }
}

const terminalCodec = new ByteFrameCodec(MAX_BYTE_FRAME_PAYLOAD);
export const encodeByteFrame = terminalCodec.encode.bind(terminalCodec);
export const decodeByteFrame = terminalCodec.decode.bind(terminalCodec);

type TerminalWireMessage = { readonly type: string; readonly data?: Uint8Array };

export function encodeTerminalMessage(message: object): Uint8Array<ArrayBuffer> {
  const envelope = 'frame' in message ? (message as { frame: TerminalWireMessage }) : undefined;
  const { data, ...metadata } = envelope?.frame ?? (message as TerminalWireMessage);
  return encodeByteFrame(
    envelope === undefined ? metadata : { ...envelope, frame: metadata },
    data
  );
}

export function decodeTerminalMessage(input: unknown): Record<string, unknown> {
  const { metadata, payload } = decodeByteFrame(input);
  const target = metadata.type === 'frame' ? metadata.frame : metadata;
  if (target === null || typeof target !== 'object' || Array.isArray(target) || 'data' in target)
    throw new Error('BYTE_FRAME_INVALID');
  const body = target as Record<string, unknown>;
  if (body.type === 'input' || body.type === 'output') {
    if (payload.length === 0) throw new Error('BYTE_FRAME_INVALID');
    body.data = payload;
  } else if (payload.length !== 0) throw new Error('BYTE_FRAME_INVALID');
  return metadata;
}

// CLI relay only: prefix an opaque Terminal frame with an operation and stream ID.
export const MAX_TERMINAL_MUX_BYTES =
  5 + HEADER_BYTES + MAX_METADATA_BYTES + MAX_BYTE_FRAME_PAYLOAD;
export const TERMINAL_MUX = { open: 1, data: 2, close: 3, ready: 4 } as const;

export function encodeTerminalMux(type: number, stream: number, payload?: Uint8Array) {
  const size = payload?.byteLength ?? 0;
  validateTerminalMux(type, stream, size);
  const bytes = new Uint8Array(5 + size);
  bytes[0] = type;
  new DataView(bytes.buffer).setUint32(1, stream);
  if (payload !== undefined) bytes.set(payload, 5);
  return bytes;
}

export function decodeTerminalMux(bytes: Uint8Array) {
  if (bytes.length < 5 || bytes.length > MAX_TERMINAL_MUX_BYTES)
    throw new Error('TERMINAL_MUX_INVALID');
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = header.getUint8(0);
  const stream = header.getUint32(1);
  const payload = bytes.subarray(5);
  validateTerminalMux(type, stream, payload.length);
  return { type, stream, payload };
}

function validateTerminalMux(
  type: number,
  stream: number,
  size: number
): asserts type is (typeof TERMINAL_MUX)[keyof typeof TERMINAL_MUX] {
  if (type === TERMINAL_MUX.ready && stream === 0 && size === 0) return;
  if (
    !Number.isInteger(stream) ||
    stream < 1 ||
    stream > 0xffffffff ||
    size + 5 > MAX_TERMINAL_MUX_BYTES ||
    (type === TERMINAL_MUX.open && (size === 0 || size > 1024)) ||
    (type === TERMINAL_MUX.data && size < HEADER_BYTES) ||
    (type === TERMINAL_MUX.close && size !== 0) ||
    (type !== TERMINAL_MUX.open && type !== TERMINAL_MUX.data && type !== TERMINAL_MUX.close)
  )
    throw new Error('TERMINAL_MUX_INVALID');
}
