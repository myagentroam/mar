import type {
  RemoteDesktopRelayBrowserMessage,
  RemoteDesktopRelayServerMessage
} from '@myagentroam/protocol';
import {
  createRemoteDesktopClientCore,
  RemoteDesktopClientError
} from './remote-desktop-client-core.js';

export class RemoteDesktopRelayError extends RemoteDesktopClientError {}

/** Authenticates a same-origin data socket; attachment lifecycle remains owned by the shared core. */
export function createRemoteDesktopRelayClient(options: {
  readonly send: (message: RemoteDesktopRelayBrowserMessage) => boolean;
  readonly connectionId: () => string | undefined;
  readonly randomId?: () => string;
  readonly createSocket?: (url: string) => WebSocket;
}) {
  const core = createRemoteDesktopClientCore({
    path: 'relay',
    send: (message) => options.send(message as RemoteDesktopRelayBrowserMessage),
    error: (code) => new RemoteDesktopRelayError(code),
    randomId: options.randomId,
    acquire() {
      const connectionId = options.connectionId();
      if (!connectionId) return undefined;
      return {
        prepare: (requestId, input) => ({
          type: 'desktop.relay.prepare',
          requestId,
          nodeId: input.nodeId,
          nodeGeneration: input.nodeGeneration,
          desktopGeneration: input.desktopGeneration,
          topologyRevision: input.topologyRevision,
          mode: input.mode
        }),
        async connect(prepared, signal) {
          if (prepared.type !== 'desktop.relay.prepared' || signal.aborted)
            throw new RemoteDesktopRelayError('DESKTOP_CONTROL_UNAVAILABLE');
          const endpoint = new URL('/api/desktop/relay', window.location.origin);
          endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
          const raw = (options.createSocket ?? ((url) => new WebSocket(url)))(endpoint.toString());
          const authenticate = () => {
            try {
              raw.send(
                JSON.stringify({
                  type: 'desktop.relay.browser',
                  attachmentId: prepared.attachmentId,
                  workbenchConnectionId: connectionId,
                  ticket: prepared.ticket
                })
              );
            } catch {
              raw.close();
            }
          };
          if (raw.readyState === WebSocket.OPEN) authenticate();
          else raw.addEventListener('open', authenticate, { once: true });
          return { raw, maxMessageBytes: 16_384 };
        },
        release() {}
      };
    }
  });
  return { ...core, handle: (message: RemoteDesktopRelayServerMessage) => core.handle(message) };
}
