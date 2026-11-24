import { setTimeout as delay } from 'node:timers/promises';
import {
  BROWSER_CONTROL_MAX_BYTES,
  BROWSER_FRAME_MESSAGE_BYTES,
  browserAttachmentOpenSchema,
  type BrowserAttachmentRoute
} from '@myagentroam/protocol';
import type {
  BrowserAttachmentChannel,
  BrowserAttachmentService
} from './browser-attachment-service.js';
import { WebSocket } from 'ws';

/** Adapts one already paired/verified transport to Browser admission. Owns
 * its reader and never looks up a browser or interprets commands itself.
 */
export function bindBrowserDataChannel(
  service: BrowserAttachmentService,
  route: BrowserAttachmentRoute,
  link: {
    sendText: (text: string) => void;
    sendBinary: (bytes: Uint8Array, signal: AbortSignal) => Promise<void>;
    close: () => void;
  },
  diagnostic: (error: unknown) => void,
  pairedAttachmentId?: string
) {
  let attachmentId: string | undefined;
  let closed = false;
  const channel: BrowserAttachmentChannel = {
    sendControl: (event) => {
      const text = JSON.stringify(event);
      if (Buffer.byteLength(text) > BROWSER_CONTROL_MAX_BYTES)
        throw new Error('BROWSER_CONTROL_TOO_LARGE');
      link.sendText(text);
    },
    sendFrame: (bytes, signal) => link.sendBinary(bytes, signal),
    close: () => {
      if (closed) return;
      closed = true;
      link.close();
    }
  };
  const disconnect = () => {
    const id = attachmentId;
    closed = true;
    if (id) void service.disconnected(id, channel).catch(diagnostic);
  };
  const receive = (message: unknown) => {
    if (closed) return;
    try {
      if (typeof message !== 'string' || Buffer.byteLength(message) > BROWSER_CONTROL_MAX_BYTES)
        throw new Error('BROWSER_INVALID_MESSAGE');
      const value: unknown = JSON.parse(message);
      if (attachmentId) service.receive(attachmentId, channel, value);
      else {
        const open = browserAttachmentOpenSchema.parse(value);
        if (pairedAttachmentId !== undefined && open.attachmentId !== pairedAttachmentId)
          throw new Error('BROWSER_INVALID_GRANT');
        attachmentId = open.attachmentId;
        void service.open(open, route, channel).catch((error: unknown) => {
          channel.close('BROWSER_ATTACH_FAILED');
          // Parse and admission errors contain no user payload in diagnostics.
          diagnostic(
            error instanceof Error
              ? new Error(error.message.split('\n')[0])
              : new Error('BROWSER_ATTACH_FAILED')
          );
        });
      }
    } catch {
      channel.close('BROWSER_INVALID_MESSAGE');
    }
  };
  return { receive, disconnect };
}

export function openBrowserIceChannel(
  service: BrowserAttachmentService,
  route: Extract<BrowserAttachmentRoute, { type: 'ice' }>,
  rtc: RTCDataChannel,
  first: unknown,
  diagnostic: (error: unknown) => void
): void {
  const reader = bindBrowserDataChannel(
    service,
    route,
    {
      sendText: (text) => rtc.send(text),
      sendBinary: async (bytes, signal) => {
        while (rtc.readyState === 'open' && rtc.bufferedAmount >= 2 * BROWSER_FRAME_MESSAGE_BYTES)
          await delay(2, undefined, { signal });
        signal.throwIfAborted();
        if (rtc.readyState !== 'open') throw new Error('BROWSER_DISCONNECTED');
        rtc.send(bytes as Uint8Array<ArrayBuffer>);
      },
      close: () => rtc.close()
    },
    diagnostic
  );
  rtc.onmessage = ({ data }) => reader.receive(data);
  rtc.addEventListener('close', reader.disconnect, { once: true });
  reader.receive(first);
}

/** The caller establishes the authenticated, paired socket, and configures
 * its parser with the browser control size limit before handing it over. */
export function openBrowserRelayChannel(
  service: BrowserAttachmentService,
  attachmentId: string,
  ws: WebSocket,
  diagnostic: (error: unknown) => void
): void {
  const reader = bindBrowserDataChannel(
    service,
    { type: 'relay' },
    {
      sendText: (text) => {
        if (
          ws.readyState !== WebSocket.OPEN ||
          ws.bufferedAmount + Buffer.byteLength(text) > 4 * BROWSER_CONTROL_MAX_BYTES
        )
          throw new Error('BROWSER_LINK_UNAVAILABLE');
        ws.send(text);
      },
      sendBinary: (bytes, signal) =>
        new Promise<void>((resolve, reject) => {
          signal.throwIfAborted();
          if (ws.readyState !== WebSocket.OPEN) return reject(new Error('BROWSER_DISCONNECTED'));
          ws.send(bytes, { binary: true }, (error) => (error ? reject(error) : resolve()));
        }),
      close: () => ws.terminate()
    },
    diagnostic,
    attachmentId
  );
  ws.on('message', (data, binary) => reader.receive(binary ? data : data.toString()));
  ws.once('close', reader.disconnect);
  ws.on('error', () => ws.terminate());
}
