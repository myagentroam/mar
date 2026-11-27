import {
  bindNodeDirectPath,
  NODE_STREAM_CHANNEL_LABEL
} from '@myagentroam/protocol/node-stream-path';
import { withTimeout } from './direct-control.mjs';
import { DirectFallbackError } from './direct-errors.mjs';

/** Owns the ordered native channel; the Direct connection owns its peer. */
export async function openDirectStreamPath(peer, timeoutMs, signal, closePeer) {
  signal.throwIfAborted();
  const channel = peer.createDataChannel(NODE_STREAM_CHANNEL_LABEL, { unordered: false });
  const ready = Promise.withResolvers();
  let onClose;
  let closed = false;
  const disconnect = () => {
    if (closed) return;
    closed = true;
    ready.reject(new DirectFallbackError('DIRECT_STREAM_CHANNEL_CLOSED'));
    onClose?.();
  };
  const close = () => {
    if (closed) return;
    disconnect();
    channel.close();
    closePeer();
  };
  const path = bindNodeDirectPath({
    maxStreams: 10,
    carrier: {
      async send(bytes) {
        if (!channel.isOpen()) throw new Error('NODE_STREAM_DISCONNECTED');
        // A false result may mean queued, not failed. Stream credits bound the queue.
        channel.sendMessageBinary(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      },
      close,
      onMessage: (receive) => channel.onMessage(receive),
      onClose: (receive) => {
        onClose = receive;
      }
    }
  });
  channel.onClosed(() => {
    disconnect();
    closePeer();
  });
  channel.onError(close);
  channel.onOpen(ready.resolve);
  if (channel.isOpen()) ready.resolve();
  try {
    await withTimeout(ready.promise, timeoutMs, 'DIRECT_STREAM_CHANNEL_TIMEOUT', signal);
    if (closed) throw new DirectFallbackError('DIRECT_STREAM_CHANNEL_CLOSED');
    return path;
  } catch (error) {
    path.close();
    throw error;
  }
}
