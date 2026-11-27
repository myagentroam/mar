import { sha256, sha256Chunks } from './sha256.js';

export async function workspaceFileSha256(file: Blob, signal?: AbortSignal): Promise<string> {
  const stride = 512 * 1024;
  signal?.throwIfAborted();
  if (file.size <= stride) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    signal?.throwIfAborted();
    return sha256(bytes);
  }
  return sha256Chunks(
    (async function* () {
      for (let offset = 0; offset < file.size; offset += stride) {
        signal?.throwIfAborted();
        const bytes = new Uint8Array(await file.slice(offset, offset + stride).arrayBuffer());
        signal?.throwIfAborted();
        yield bytes;
      }
    })()
  );
}
