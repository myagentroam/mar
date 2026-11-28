import type { BrowserUpload, BrowserUploadStream } from '@myagentroam/protocol';
import type { NodeStream } from '@myagentroam/protocol/node-stream';
import type { WorkbenchHttpService } from './workbench-http-service.js';
import { ApiError } from '../util/api-error.js';
import { createUuid } from '../util/uuid.js';
import { sendFileUploadBody } from './workspace-upload-stream.js';

/** Stages each selected file on a substream; Chromium selection is committed once by the finish control. */
export async function uploadBrowserFiles(
  request: WorkbenchHttpService['request'],
  connectionId: string,
  selection: Pick<BrowserUpload, 'attachmentId' | 'chooserId'>,
  files: readonly File[] | undefined,
  lifecycle: {
    signal: AbortSignal;
    finishing: () => void;
    openStream: (ticket: string, signal: AbortSignal) => Promise<NodeStream>;
  }
): Promise<void> {
  const send = (command: BrowserUpload['command']) => {
    lifecycle.signal.throwIfAborted();
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
    const body: BrowserUploadStream = {
      ...selection,
      command: { action: 'stream', transferId, index }
    };
    const { ticket } = await request<{ ticket: string }>(
      `/api/browser/uploads/stream-ticket?${new URLSearchParams({ connectionId })}`,
      { method: 'POST', body: JSON.stringify(body), signal: lifecycle.signal }
    );
    await sendFileUploadBody(
      await lifecycle.openStream(ticket, lifecycle.signal),
      file,
      lifecycle.signal
    );
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
