import { z } from 'zod';
import { ByteFrameCodec } from './byte-frame.js';

export const NODE_STREAM_CHUNK_BYTES = 32 * 1024;
export const NODE_STREAM_WINDOW_BYTES = 256 * 1024;
export const NODE_STREAM_WINDOW_UNIT = 1024;
export const MAX_NODE_STREAM_FRAME_BYTES = NODE_STREAM_CHUNK_BYTES + 4096 + 3;

export const nodeStreamCreditCost = (length: number) =>
  Math.ceil(length / NODE_STREAM_WINDOW_UNIT) * NODE_STREAM_WINDOW_UNIT;

const codec = new ByteFrameCodec(NODE_STREAM_CHUNK_BYTES);
const relayHandshake = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('RELAY_AUTH'),
      nodeId: z.string().min(1).max(128),
      credential: z.string().min(1).max(1024),
      controlBinding: z.string().min(1).max(128)
    })
    .strict(),
  z.object({ type: z.literal('RELAY_READY') }).strict()
]);
export type NodeRelayHandshake = z.infer<typeof relayHandshake>;

export function encodeNodeRelayHandshake(message: NodeRelayHandshake): Uint8Array<ArrayBuffer> {
  return codec.encode(relayHandshake.parse(message));
}

export function decodeNodeRelayHandshake(input: unknown): NodeRelayHandshake {
  const { metadata, payload } = codec.decode(input);
  if (payload.byteLength !== 0) throw new Error('NODE_RELAY_HANDSHAKE_INVALID');
  return relayHandshake.parse(metadata);
}

const streamId = z.number().int().min(1).max(0xffffffff);
const header = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('OPEN'),
      streamId,
      kind: z
        .string()
        .max(64)
        .regex(/^[a-z][a-z0-9.-]*$/u),
      grant: z.string().min(1).max(2048)
    })
    .strict(),
  z.object({ type: z.literal('OPENED'), streamId }).strict(),
  z.object({ type: z.literal('DATA'), streamId }).strict(),
  z
    .object({
      type: z.literal('WINDOW'),
      streamId,
      bytes: z
        .number()
        .int()
        .min(NODE_STREAM_WINDOW_UNIT)
        .max(NODE_STREAM_WINDOW_BYTES)
        .multipleOf(NODE_STREAM_WINDOW_UNIT)
    })
    .strict(),
  z.object({ type: z.literal('FIN'), streamId }).strict(),
  z
    .object({
      type: z.literal('RESET'),
      streamId,
      code: z
        .string()
        .max(96)
        .regex(/^[A-Z][A-Z0-9_]*$/u)
    })
    .strict()
]);

type Header = z.infer<typeof header>;
export type NodeStreamFrame =
  | Exclude<Header, { type: 'DATA' }>
  | {
      type: 'DATA';
      streamId: number;
      bytes: Uint8Array;
    };

export function encodeNodeStreamFrame(frame: NodeStreamFrame): Uint8Array<ArrayBuffer> {
  if (frame.type === 'DATA') {
    const { bytes, ...metadata } = frame;
    if (bytes.byteLength === 0) throw new Error('NODE_STREAM_FRAME_INVALID');
    return codec.encode(header.parse(metadata), bytes);
  }
  return codec.encode(header.parse(frame));
}

export function decodeNodeStreamFrame(input: unknown): NodeStreamFrame {
  const { metadata, payload } = codec.decode(input);
  const frame = header.parse(metadata);
  if (frame.type === 'DATA') {
    if (payload.byteLength === 0) throw new Error('NODE_STREAM_FRAME_INVALID');
    return { ...frame, bytes: payload };
  }
  if (payload.byteLength !== 0) throw new Error('NODE_STREAM_FRAME_INVALID');
  return frame;
}
