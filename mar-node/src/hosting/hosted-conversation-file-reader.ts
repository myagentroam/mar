import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import type { ConversationFileProjection } from '@myagentroam/protocol';
import { NODE_STREAM_CHUNK_BYTES } from '@myagentroam/protocol/node-stream-wire';
import { openRegularFile, regularFileMetadata } from './hosted-conversation-file-identity.js';

interface HostedFileSnapshot {
  readonly file: ConversationFileProjection;
  read(offset: number, length: number): Promise<Buffer>;
  assertUnchanged(): Promise<void>;
}

/** Reads the authorized logical range without revalidating filesystem identity at stream FIN. */
export async function* readHostedFileRange(
  path: string,
  offset: number,
  length: number
): AsyncIterable<Uint8Array> {
  const { handle } = await openRegularFile(path);
  try {
    for (let remaining = length; remaining > 0;) {
      const bytes = await readExactly(handle, offset, Math.min(remaining, NODE_STREAM_CHUNK_BYTES));
      offset += bytes.byteLength;
      remaining -= bytes.byteLength;
      yield bytes;
    }
  } finally {
    await handle.close();
  }
}

/** Owns the existing HTTP preview's source checks; NodeConnection does not use this path. */
export async function withHostedFileSnapshot<T>(
  path: string,
  file: ConversationFileProjection,
  use: (source: HostedFileSnapshot) => Promise<T>
): Promise<T> {
  const { handle, metadata: before } = await openRegularFile(path);
  try {
    async function assertUnchanged(): Promise<void> {
      // The current path stat detects both replacement and mutation of the open source.
      if (!sameSnapshot(before, await regularFileMetadata(path)))
        throw new Error('HOSTED_CONVERSATION_FILE_INVALID');
    }
    return await use({
      file: projectFile(file, before),
      read: (offset, length) => readExactly(handle, offset, length),
      assertUnchanged
    });
  } finally {
    await handle.close();
  }
}

async function readExactly(handle: FileHandle, offset: number, length: number): Promise<Buffer> {
  const bytes = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const next = await handle.read(bytes, read, length - read, offset + read);
    if (next.bytesRead === 0) throw new Error('HOSTED_CONVERSATION_FILE_INVALID');
    read += next.bytesRead;
  }
  return bytes;
}

function projectFile(file: ConversationFileProjection, stat: Stats): ConversationFileProjection {
  return {
    ...file,
    size: stat.size,
    updatedAt: Math.max(file.createdAt, fileTimestamp(stat.mtimeMs), fileTimestamp(stat.ctimeMs))
  };
}

function sameSnapshot(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function fileTimestamp(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value));
}
