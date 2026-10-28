import { constants, type Stats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

export async function assertRegularFile(path: string, expectedSize: number): Promise<void> {
  const metadata = await regularFileMetadata(path);
  if (metadata.size !== expectedSize) throw new Error('HOSTED_CONVERSATION_FILE_INVALID');
}

export async function openRegularFile(path: string) {
  return open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new Error('HOSTED_CONVERSATION_FILE_INVALID');
  });
}

export async function regularFileMetadata(path: string) {
  const metadata = await lstat(path).catch(() => {
    throw new Error('HOSTED_CONVERSATION_FILE_INVALID');
  });
  assertRegularFileMetadata(metadata);
  return metadata;
}

export function assertRegularFileMetadata(metadata: Stats): void {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    !Number.isSafeInteger(metadata.size) ||
    metadata.size < 0
  )
    throw new Error('HOSTED_CONVERSATION_FILE_INVALID');
}
