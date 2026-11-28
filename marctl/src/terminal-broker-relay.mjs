import { connectCliNodeRelay } from './node-relay.mjs';
import { IPC_HANDSHAKE_MS } from './terminal-ipc.mjs';
import { terminalNodeStream } from './terminal-node-stream.mjs';

/** Maps Terminal records to a shared Relay path without owning path selection or the IPC pool. */
export async function connectTerminalBrokerRelay({ serverUrl, key, nodeId, client }, signal) {
  const path = await connectCliNodeRelay({ serverUrl, key, nodeId }, signal, IPC_HANDSHAKE_MS);
  return {
    get closed() {
      return path.closed;
    },
    close: path.close,
    async openStream(request, streamSignal) {
      const { terminalId, ticket } = request;
      const grant = ticket ?? (await client.createAttachTicket({ nodeId, terminalId }));
      streamSignal.throwIfAborted();
      if (path.closed) return undefined;
      const stream = await path.openStream({ kind: 'terminal', grant }, streamSignal);
      return stream === undefined ? undefined : terminalNodeStream(stream, request);
    }
  };
}
