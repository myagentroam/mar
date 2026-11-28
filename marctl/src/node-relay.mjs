import WebSocket from 'ws';
import { openNodeRelayPath } from '@myagentroam/protocol/node-relay-path';
import { MAX_NODE_STREAM_FRAME_BYTES } from '@myagentroam/protocol/node-stream-wire';

/** Adapts an authenticated CLI WebSocket to the shared Relay stream path. */
export function connectCliNodeRelay({ serverUrl, key, nodeId }, signal, timeoutMs = 15_000) {
  signal.throwIfAborted();
  const url = new URL(`/api/relay/${encodeURIComponent(nodeId)}`, serverUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
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
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  });
}
