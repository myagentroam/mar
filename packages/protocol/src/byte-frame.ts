// One application frame per WebSocket or DataChannel message.
const VERSION = 1;
const HEADER_BYTES = 3;
const MAX_METADATA_BYTES = 4096;
export const MAX_BYTE_FRAME_PAYLOAD = 64 * 1024;
export const MAX_TERMINAL_FRAME_BYTES = HEADER_BYTES + MAX_METADATA_BYTES + MAX_BYTE_FRAME_PAYLOAD;
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
  const { data, ...metadata } = message as TerminalWireMessage;
  return encodeByteFrame(metadata, data);
}

export function decodeTerminalMessage(input: unknown): Record<string, unknown> {
  const { metadata: body, payload } = decodeByteFrame(input);
  if ('data' in body) throw new Error('BYTE_FRAME_INVALID');
  if (body.type === 'input' || body.type === 'output') {
    if (payload.length === 0) throw new Error('BYTE_FRAME_INVALID');
    body.data = payload;
  } else if (payload.length !== 0) throw new Error('BYTE_FRAME_INVALID');
  return body;
}
