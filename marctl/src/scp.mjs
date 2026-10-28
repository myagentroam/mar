import { MarctlError } from './errors.mjs';
import { parseScpEndpoint, scpSourceBasename } from './scp-endpoint.mjs';
import { copyBytes } from './scp-copy.mjs';
import { withWorker } from './scp-workers.mjs';

export async function runScp({
  source,
  destination,
  preserve = false,
  client,
  WebSocketClass,
  resolveNodeId,
  translate,
  signal
}) {
  const from = parseScpEndpoint(source);
  const to = parseScpEndpoint(destination);
  const sourceBasename = scpSourceBasename(from.path);
  if (!from.host && !to.host) throw new MarctlError('At least one copy endpoint must be a Node.');
  const references = [...new Set([from.host, to.host].filter(Boolean))];
  const controller = new AbortController();
  let rejectResolution;
  const interrupt = () => {
    controller.abort(new MarctlError('Copy was interrupted.'));
    rejectResolution?.(controller.signal.reason);
  };
  signal?.addEventListener('abort', interrupt, { once: true });
  if (signal?.aborted) interrupt();
  try {
    controller.signal.throwIfAborted();
    const ids = await new Promise((resolve, reject) => {
      rejectResolution = reject;
      Promise.all(references.map((host) => resolveNodeId(host))).then(resolve, reject);
    });
    rejectResolution = undefined;
    controller.signal.throwIfAborted();
    const resolved = (endpoint) => ({
      path: endpoint.path,
      ...(endpoint.host ? { nodeId: ids[references.indexOf(endpoint.host)] } : {})
    });
    const context = {
      client,
      WebSocketClass,
      translate,
      controller,
      preserve,
      sourceBasename
    };
    await withWorker(resolved(from), 'read', undefined, undefined, context, (channel) =>
      copyBytes(channel, {
        open: (size, metadata, use) =>
          withWorker(resolved(to), 'write', size, metadata, context, use)
      })
    );
    controller.signal.throwIfAborted();
    return 0;
  } catch (error) {
    controller.abort(error);
    throw error;
  } finally {
    rejectResolution = undefined;
    signal?.removeEventListener('abort', interrupt);
  }
}
