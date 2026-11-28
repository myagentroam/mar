import { once } from 'node:events';
import { createConnection, createServer } from 'node:net';
import { tcpForwardSetupMs } from '@myagentroam/protocol/tcp-forward';

/** The TCP endpoints share one backpressure and half-close adapter; neither owns the carrier. */
export async function connectForwardSocket({ host, port }, signal) {
  signal.throwIfAborted();
  const socket = createConnection({ host, port, allowHalfOpen: true });
  socket.on('error', ignoreSocketError);
  try {
    await once(socket, 'connect', {
      signal: AbortSignal.any([signal, AbortSignal.timeout(tcpForwardSetupMs)])
    });
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

export async function listenForwardSocket({ host, port }, lifetime, accept, setup = lifetime) {
  setup.throwIfAborted();
  const server = createServer({ allowHalfOpen: true, pauseOnConnect: true }, (socket) => {
    socket.on('error', ignoreSocketError);
    accept(socket);
  });
  const listening = once(server, 'listening', { signal: setup });
  server.listen({ host, port, signal: lifetime });
  try {
    await listening;
    return server;
  } catch (error) {
    server.close();
    if (setup.aborted) throw error;
    throw new Error('TCP_FORWARD_LISTEN_FAILED', { cause: error });
  }
}

export async function bridgeForwardSocket(socket, stream, signal) {
  const abort = () => socket.destroy();
  const closed = () => {
    if (!socket.readableEnded || !socket.writableFinished)
      stream.reset('TCP_FORWARD_CONNECTION_LOST');
  };
  signal.addEventListener('abort', abort, { once: true });
  socket.once('close', closed);
  void stream.finished.then(() => {
    // A reset must also wake a blocked TCP write; normal FIN lets queued bytes drain.
    if (stream.failed) socket.destroy();
  });
  try {
    signal.throwIfAborted();
    if (socket.destroyed) throw new Error('TCP_FORWARD_CONNECTION_LOST');
    await Promise.all([
      (async () => {
        // Do not let the default Readable iterator destroy the still-writable half at EOF.
        for await (const bytes of socket.iterator({ destroyOnReturn: false }))
          await stream.write(bytes);
        await stream.endWrite();
      })(),
      (async () => {
        for await (const bytes of stream) {
          // Advance the iterator (and return credit) only after the TCP write completes.
          await new Promise((resolve, reject) =>
            socket.write(bytes, (error) => (error ? reject(error) : resolve()))
          );
        }
        await new Promise((resolve, reject) =>
          socket.end((error) => (error ? reject(error) : resolve()))
        );
      })()
    ]);
  } catch {
    stream.reset('TCP_FORWARD_CONNECTION_LOST');
  } finally {
    signal.removeEventListener('abort', abort);
    socket.removeListener('close', closed);
    socket.destroy();
  }
}

// A socket may fail before the stream is admitted; close/write completion handles it.
function ignoreSocketError() {}
