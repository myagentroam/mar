import { BROWSER_UPLOAD_CHUNK_BYTES, type BrowserUpload } from '@myagentroam/protocol';
import type { WorkbenchHttpService } from './workbench-http-service.js';
import { ApiError } from '../util/api-error.js';
import { createUuid } from '../util/uuid.js';

/** Sends only the files explicitly chosen for this attachment. Each chunk is
 * acknowledged before reading the next; a lost response never causes a replay. */
export async function uploadBrowserFiles(
  request: WorkbenchHttpService['request'],
  connectionId: string,
  selection: Pick<BrowserUpload, 'attachmentId' | 'chooserId'>,
  files: readonly File[] | undefined,
  lifecycle: { signal: AbortSignal; finishing: () => void }
): Promise<void> {
  const send = (command: BrowserUpload['command']) => {
    lifecycle.signal.throwIfAborted();
    if (command.action === 'chunk') {
      const { bytes, transferId, index, offset } = command;
      const query = new URLSearchParams({
        connectionId,
        ...selection,
        transferId,
        index: String(index),
        offset: String(offset)
      });
      return request(`/api/browser/uploads?${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: new Blob([new Uint8Array(bytes)]),
        signal: lifecycle.signal
      });
    }
    return request(`/api/browser/uploads?${new URLSearchParams({ connectionId })}`, {
      method: 'POST',
      body: JSON.stringify({ ...selection, command }),
      signal: lifecycle.signal
    });
  };
  if (!files) {
    await send({ action: 'cancel' });
    return;
  }
  const transferId = createUuid();
  await send({ action: 'begin', transferId });
  for (const [index, file] of files.entries()) {
    await send({ action: 'file', transferId, index, name: file.name, size: file.size });
    for (let offset = 0; offset < file.size; offset += BROWSER_UPLOAD_CHUNK_BYTES) {
      lifecycle.signal.throwIfAborted();
      const bytes = new Uint8Array(
        await file.slice(offset, offset + BROWSER_UPLOAD_CHUNK_BYTES).arrayBuffer()
      );
      await send({ action: 'chunk', transferId, index, offset, bytes });
    }
  }
  lifecycle.finishing();
  try {
    await send({ action: 'finish', transferId });
  } catch (error) {
    // Losing the response is not evidence the selected files were not delivered.
    if (
      error instanceof ApiError &&
      (error.code === 'NETWORK_UNAVAILABLE' || error.code === 'NODE_REQUEST_TIMEOUT')
    )
      throw new Error('BROWSER_OUTCOME_UNKNOWN', { cause: error });
    throw error;
  }
}
