import { remoteDesktopAttachedFrameSchema } from '@myagentroam/protocol';
import { RemoteDesktopChannel } from './remote-desktop-channel.js';

export class RemoteDesktopWireError extends Error {
  readonly code = 'DESKTOP_TRANSPORT_ERROR';
  constructor() {
    super('The remote desktop data channel is unavailable.');
  }
}

/** Owns OPEN/ATTACHED until synchronously transferring the sole reader to noVNC's channel. */
export function openRemoteDesktopChannel(options: {
  readonly raw: RTCDataChannel | WebSocket;
  readonly attachmentId: string;
  readonly grant: string;
  readonly signal: AbortSignal;
  readonly isStopped: () => boolean;
  readonly maxMessageBytes: number;
  readonly onFailure: (code: 'DESKTOP_BACKPRESSURE' | 'DESKTOP_TRANSPORT_ERROR') => void;
  readonly onAdopt: (channel: RemoteDesktopChannel) => void;
}): Promise<RemoteDesktopChannel> {
  const { raw, signal } = options;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      raw.removeEventListener('open', open);
      raw.removeEventListener('message', message);
      raw.removeEventListener('close', failed);
      raw.removeEventListener('error', failed);
      signal.removeEventListener('abort', failed);
    };
    const failed = () => {
      cleanup();
      reject(new RemoteDesktopWireError());
    };
    const open = () => {
      if (options.isStopped() || signal.aborted) return failed();
      raw.removeEventListener('open', open);
      try {
        raw.send(
          JSON.stringify({ type: 'OPEN', attachmentId: options.attachmentId, grant: options.grant })
        );
      } catch {
        failed();
      }
    };
    const message = (event: Event) => {
      const data = (event as MessageEvent<unknown>).data;
      if (typeof data !== 'string' || data.length > 4096) return failed();
      let frame: unknown;
      try {
        frame = JSON.parse(data);
      } catch {
        return failed();
      }
      const attached = remoteDesktopAttachedFrameSchema.safeParse(frame);
      if (
        !attached.success ||
        attached.data.attachmentId !== options.attachmentId ||
        options.isStopped() ||
        signal.aborted
      )
        return failed();
      cleanup();
      let owned: RemoteDesktopChannel | undefined;
      try {
        owned = new RemoteDesktopChannel(raw, {
          preRead: [],
          maxMessageBytes: options.maxMessageBytes,
          maxQueuedBytes: 1024 * 1024,
          highWaterBytes: 1024 * 1024,
          onFailure: options.onFailure
        });
        options.onAdopt(owned);
        resolve(owned);
      } catch {
        owned?.close();
        failed();
      }
    };
    raw.addEventListener('open', open, { once: true });
    raw.addEventListener('message', message);
    raw.addEventListener('close', failed, { once: true });
    raw.addEventListener('error', failed, { once: true });
    signal.addEventListener('abort', failed, { once: true });
    if (signal.aborted || options.isStopped()) failed();
    else if (raw.readyState === 'open' || raw.readyState === 1) open();
    else if (raw.readyState !== 'connecting' && raw.readyState !== 0) failed();
  });
}
