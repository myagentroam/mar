import type { NodeStream } from '@myagentroam/protocol/node-stream';
import type { NodeStreamOpen } from '@myagentroam/protocol/node-stream-mux';
import { ApiError } from '../util/api-error.js';
import type { WorkbenchHttpService } from './workbench-http-service.js';
import type { BrowserFileStreamRequest } from './workbench-node-connection-service.js';

/** Redeems a Browser file ticket for the chosen ICE carrier; HTTP never carries file bytes. */
export async function openBrowserDirectFile(
  request: WorkbenchHttpService['request'],
  path: {
    readonly closed: boolean;
    openStream(open: NodeStreamOpen, signal: AbortSignal): Promise<NodeStream | undefined>;
  },
  nodeId: string,
  transportId: string,
  input: BrowserFileStreamRequest,
  signal: AbortSignal
): Promise<NodeStream | undefined> {
  const { kind } = input;
  const ticket = await input.issueTicket(signal);
  signal.throwIfAborted();
  if (path.closed) return undefined;
  const url = '/api/browser/direct-file-streams';
  const release = () => {
    void request(url, { method: 'DELETE', body: JSON.stringify({ ticket }) }).catch(
      () => undefined
    );
  };
  try {
    const grant = await request<{ grant: string }>(url, {
      method: 'POST',
      body: JSON.stringify({ kind, ticket, nodeId, transportId }),
      signal
    }).then(
      (prepared) => prepared.grant,
      (error: unknown) => {
        if (error instanceof ApiError && error.code === 'BROWSER_ICE_UNAVAILABLE') return undefined;
        throw error;
      }
    );
    signal.throwIfAborted();
    if (grant === undefined) return undefined;
    const stream = await path.openStream({ kind, grant }, signal);
    // The alternate path gets a fresh ticket only when the mux confirms no OPEN was sent.
    if (stream === undefined) release();
    else void stream.finished.then(release, release);
    return stream;
  } catch (error) {
    release();
    throw error;
  }
}
