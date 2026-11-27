// One application frame per WebSocket or DataChannel message.
const VERSION = 1;
const HEADER_BYTES = 3;
const MAX_METADATA_BYTES = 4096;
export const MAX_BYTE_FRAME_PAYLOAD = 64 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function encodeByteFrame(metadata: object, payload?: Uint8Array): Uint8Array<ArrayBuffer> {
  const header = encoder.encode(JSON.stringify(metadata));
  const size = payload?.byteLength ?? 0;
  if (header.length > MAX_METADATA_BYTES || size > MAX_BYTE_FRAME_PAYLOAD)
    throw new Error('BYTE_FRAME_LIMIT');
  const frame = new Uint8Array(HEADER_BYTES + header.length + size);
  frame[0] = VERSION;
  new DataView(frame.buffer).setUint16(1, header.length);
  frame.set(header, HEADER_BYTES);
  if (payload !== undefined) frame.set(payload, HEADER_BYTES + header.length);
  return frame;
}

export function decodeByteFrame(input: unknown): {
  metadata: Record<string, unknown>;
  payload: Uint8Array;
} {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  if (!(bytes instanceof Uint8Array) || bytes.length < HEADER_BYTES || bytes[0] !== VERSION)
    throw new Error('BYTE_FRAME_INVALID');
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(1);
  const end = HEADER_BYTES + size;
  if (
    size > MAX_METADATA_BYTES ||
    end > bytes.length ||
    bytes.length - end > MAX_BYTE_FRAME_PAYLOAD
  )
    throw new Error('BYTE_FRAME_LIMIT');
  const metadata: unknown = JSON.parse(decoder.decode(bytes.subarray(HEADER_BYTES, end)));
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata))
    throw new Error('BYTE_FRAME_INVALID');
  return { metadata: metadata as Record<string, unknown>, payload: bytes.subarray(end) };
}

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
