import { ByteFrameCodec } from './byte-frame.js';
import type { NodeEnvelope } from './index.js';

export const FILE_RELAY_CHUNK_BYTES = 512 * 1024;
const FILE_RELAY_METADATA_BYTES = 32 * 1024;
export const FILE_RELAY_MAX_FRAME_BYTES = FILE_RELAY_CHUNK_BYTES + FILE_RELAY_METADATA_BYTES + 3;
export const FILE_RELAY_MAX_PENDING = 16;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

type FileOperation =
  | 'workspace.files.upload.chunk'
  | 'workspace.file.content.read'
  | 'workspace.git.commit.file.content.read'
  | 'conversation.hosted.files.upload.chunk'
  | 'conversation.hosted.file.read'
  | 'browser.upload'
  | 'browser.download';

/** Only bulk file chunks use this channel, not control actions or generated image resources. */
export function isFileRelayOperation(
  operation: unknown,
  data: unknown
): operation is FileOperation {
  switch (operation) {
    case 'workspace.files.upload.chunk':
    case 'workspace.git.commit.file.content.read':
    case 'conversation.hosted.files.upload.chunk':
      return true;
    case 'workspace.file.content.read':
    case 'conversation.hosted.file.read':
      return record(data)?.preview === undefined;
    case 'browser.upload':
    case 'browser.download':
      return (
        record(record(record(data)?.payload)?.command)?.action ===
        (operation === 'browser.upload' ? 'chunk' : 'read')
      );
    default:
      return false;
  }
}

const codec = new ByteFrameCodec(FILE_RELAY_CHUNK_BYTES, FILE_RELAY_METADATA_BYTES);
export const encodeFileRelayFrame = codec.encode.bind(codec);
export const decodeFileRelayFrame = codec.decode.bind(codec);

function bodyPath(envelope: NodeEnvelope, operation: FileOperation): readonly string[] {
  const payload = record(envelope.payload);
  if (!payload) throw new Error('MESSAGE_INVALID');
  if (envelope.type === 'node.request') {
    if (
      operation === 'workspace.files.upload.chunk' ||
      operation === 'conversation.hosted.files.upload.chunk'
    )
      return ['data'];
    if (operation === 'browser.upload') return ['data', 'payload', 'command'];
    return [];
  }
  if (envelope.type !== 'node.response') throw new Error('MESSAGE_INVALID');
  if ('error' in payload) return [];
  if (
    operation === 'workspace.file.content.read' ||
    operation === 'workspace.git.commit.file.content.read'
  )
    return ['result', 'file'];
  if (operation === 'conversation.hosted.file.read' || operation === 'browser.download')
    return ['result'];
  return [];
}

function stripBody(
  value: unknown,
  path: readonly string[]
): { metadata: object; bytes: Uint8Array } {
  const object = record(value);
  if (!object) throw new Error('MESSAGE_INVALID');
  const [key, ...rest] = path;
  if (key === undefined) {
    const { bytes, ...metadata } = object;
    if (!(bytes instanceof Uint8Array)) throw new Error('MESSAGE_INVALID');
    return { metadata, bytes };
  }
  const result = stripBody(object[key], rest);
  return { metadata: { ...object, [key]: result.metadata }, bytes: result.bytes };
}

export function encodeFileRelayEnvelope(envelope: NodeEnvelope, operation: FileOperation) {
  const path = bodyPath(envelope, operation);
  const type = envelope.type === 'node.request' ? 'file.request' : 'file.response';
  if (path.length === 0) return encodeFileRelayFrame({ type, envelope });
  const { metadata, bytes } = stripBody(envelope.payload, path);
  if (type === 'file.request' && bytes.byteLength === 0) throw new Error('MESSAGE_INVALID');
  return encodeFileRelayFrame(
    { type, envelope: { ...envelope, payload: metadata }, byteLength: bytes.byteLength },
    bytes
  );
}

export function restoreFileRelayBody(
  envelope: NodeEnvelope,
  operation: FileOperation,
  bytes: Uint8Array,
  declaredLength: unknown
): void {
  const path = bodyPath(envelope, operation);
  if (path.length === 0) {
    if (bytes.byteLength !== 0 || declaredLength !== undefined) throw new Error('MESSAGE_INVALID');
    return;
  }
  let slot = record(envelope.payload);
  for (const key of path) slot = record(slot?.[key]);
  if (
    !slot ||
    'bytes' in slot ||
    declaredLength !== bytes.byteLength ||
    (envelope.type === 'node.request' && bytes.byteLength === 0)
  )
    throw new Error('MESSAGE_INVALID');
  slot.bytes = bytes;
}
