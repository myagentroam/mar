import type { NodeStream } from '@myagentroam/protocol/node-stream';
import type { NodeStreamOpen } from '@myagentroam/protocol/node-stream-mux';
import type { WorkbenchHttpService } from './workbench-http-service.js';

/** Redeems a Browser file ticket for the chosen ICE carrier; HTTP never carries file bytes. */
export async function openBrowserDirectFile(
  request: WorkbenchHttpService['request'],
  path: { openStream(open: NodeStreamOpen, signal: AbortSignal): Promise<NodeStream | undefined> },
  nodeId: string,
  transportId: string,
  input: { kind: 'browser-file-download' | 'browser-file-upload'; ticket: string },
  signal: AbortSignal
): Promise<NodeStream> {
  const url = '/api/browser/direct-file-streams';
  const release = () => {
    void request(url, { method: 'DELETE', body: JSON.stringify({ ticket: input.ticket }) }).catch(
      () => undefined
    );
  };
  try {
    const { grant } = await request<{ grant: string }>(url, {
      method: 'POST',
      body: JSON.stringify({ ...input, nodeId, transportId }),
      signal
    });
    signal.throwIfAborted();
    const stream = await path.openStream({ kind: input.kind, grant }, signal);
    if (stream === undefined) throw new Error('NODE_STREAM_UNAVAILABLE');
    void stream.finished.then(release, release);
    return stream;
  } catch (error) {
    release();
    throw error;
  }
}
