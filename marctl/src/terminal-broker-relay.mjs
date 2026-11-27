import WebSocket from 'ws';
import { openNodeRelayPath } from '@myagentroam/protocol/node-relay-path';
import { MAX_NODE_STREAM_FRAME_BYTES } from '@myagentroam/protocol/node-stream-wire';
import { IPC_HANDSHAKE_MS } from './terminal-ipc.mjs';
import { terminalNodeStream } from './terminal-node-stream.mjs';

/** Maps Terminal records to a shared Relay path without owning path selection or the IPC pool. */
export async function connectTerminalBrokerRelay({ serverUrl, key, nodeId, client }, signal) {
  const url = new URL(`/api/relay/${encodeURIComponent(nodeId)}`, serverUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const path = await connectCliNodeRelay(url, key, signal);
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

/** CLI authentication stays on the carrier handshake, never in stream payloads. */
function connectCliNodeRelay(url, key, signal) {
  const socket = new WebSocket(url, {
    headers: { Authorization: `Bearer ${key}` },
    maxPayload: MAX_NODE_STREAM_FRAME_BYTES
  });
  const carrier = {
    send: (bytes) =>
      new Promise((resolve, reject) =>
        socket.send(bytes, (error) => (error ? reject(error) : resolve()))
      ),
    close: () => socket.terminate(),
    onMessage: (receive) =>
      socket.on('message', (raw, binary) => {
        if (binary) receive(raw);
        else socket.terminate();
      }),
    onClose: (disconnect) => socket.once('close', disconnect)
  };
  socket.on('error', () => socket.terminate());
  return openNodeRelayPath({
    carrier,
    maxStreams: 10,
    signal: AbortSignal.any([signal, AbortSignal.timeout(IPC_HANDSHAKE_MS)])
  });
}
