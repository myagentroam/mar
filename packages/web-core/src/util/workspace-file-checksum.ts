import { sha256 } from './sha256.js';

export async function workspaceFileSha256(file: Blob): Promise<string> {
  return sha256(new Uint8Array(await file.arrayBuffer()));
}
