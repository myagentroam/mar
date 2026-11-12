import type {
  RemoteDesktopDirectBrowserMessage,
  RemoteDesktopDirectServerMessage
} from '@myagentroam/protocol';
import {
  createRemoteDesktopClientCore,
  RemoteDesktopClientError
} from './remote-desktop-client-core.js';
import type { createWorkspaceDirectTransferService } from './workspace-direct-transfer-service.js';

type Transport = NonNullable<
  ReturnType<ReturnType<typeof createWorkspaceDirectTransferService>['acquireDesktopTransport']>
>;

export class RemoteDesktopDirectError extends RemoteDesktopClientError {}

/** Adapts a borrowed Direct transport; the shared core owns each desktop attachment. */
export function createRemoteDesktopDirectClient(options: {
  readonly send: (message: RemoteDesktopDirectBrowserMessage) => boolean;
  readonly acquire: (nodeId: string, nodeGeneration: string) => Transport | undefined;
  readonly randomId?: () => string;
}) {
  const core = createRemoteDesktopClientCore({
    path: 'direct',
    send: (message) => options.send(message as RemoteDesktopDirectBrowserMessage),
    error: (code) => new RemoteDesktopDirectError(code),
    randomId: options.randomId,
    acquire(nodeId, nodeGeneration) {
      const transport = options.acquire(nodeId, nodeGeneration);
      if (!transport) return undefined;
      return {
        prepare: (requestId, input) => ({
          type: 'desktop.direct.prepare',
          requestId,
          nodeId: input.nodeId,
          nodeGeneration: input.nodeGeneration,
          transportSessionId: transport.transportSessionId,
          desktopGeneration: input.desktopGeneration,
          topologyRevision: input.topologyRevision,
          mode: input.mode
        }),
        connect: async (prepared, signal) => ({
          raw: await transport.waitChannel(prepared.attachmentId, signal),
          maxMessageBytes: transport.maxMessageBytes
        }),
        release: () => transport.release()
      };
    }
  });
  return { ...core, handle: (message: RemoteDesktopDirectServerMessage) => core.handle(message) };
}
