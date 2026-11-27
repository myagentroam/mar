import { openNodeRelayPath } from '../../../packages/protocol/src/node-relay-path.js';

interface RelaySocket {
  send(bytes: Uint8Array, done: (error?: Error) => void): void;
  terminate(): void;
  on(event: 'message', receive: (bytes: Uint8Array, binary: boolean) => void): void;
  once(event: 'close', disconnect: () => void): void;
}

export function testRelayPath(socket: RelaySocket) {
  return openNodeRelayPath({
    carrier: {
      send: (bytes) =>
        new Promise((resolve, reject) =>
          socket.send(bytes, (error) => (error ? reject(error) : resolve()))
        ),
      close: () => socket.terminate(),
      onMessage: (receive) =>
        socket.on('message', (bytes, binary) => (binary ? receive(bytes) : socket.terminate())),
      onClose: (disconnect) => socket.once('close', disconnect)
    },
    maxStreams: 4,
    signal: AbortSignal.timeout(10_000)
  });
}
