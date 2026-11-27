import { NodeConnection, type NodeConnectionPath } from '@myagentroam/protocol/node-connection';
import { openNodeRelayPath } from '@myagentroam/protocol/node-relay-path';
import type { NodeStream } from '@myagentroam/protocol/node-stream';
import type { ScopedHttpService } from './scoped-http-service.js';
import type { TerminalAttachmentRequest } from './terminal-direct-client.js';
import type {
  DirectTransferDescriptor,
  HostedConversationFileStreamInput
} from '@myagentroam/protocol';

export type WorkbenchFileStreamRequest =
  | {
      readonly kind: 'file-upload';
      readonly descriptor: Extract<DirectTransferDescriptor, { direction: 'UPLOAD' }>;
    }
  | {
      readonly kind: 'file-download';
      readonly descriptor: Extract<DirectTransferDescriptor, { direction: 'DOWNLOAD' }>;
    };
export type WorkbenchStreamRequest =
  | (TerminalAttachmentRequest & { readonly kind: 'terminal' })
  | WorkbenchFileStreamRequest
  | {
      readonly kind: 'browser-rfb';
      readonly prepare: (
        transportId: string | undefined,
        signal: AbortSignal
      ) => Promise<string | undefined>;
    }
  | { readonly kind: 'browser-file-download'; readonly ticket: string }
  | { readonly kind: 'browser-file-upload'; readonly ticket: string }
  | {
      readonly kind: 'hosted-file-upload';
      readonly conversationId: string;
      readonly uploadId: string;
    }
  | {
      readonly kind: 'hosted-file-download';
      readonly descriptor: HostedConversationFileStreamInput;
    };
export type WorkbenchNodePath = NodeConnectionPath<WorkbenchStreamRequest, NodeStream>;
type Connection = NodeConnection<WorkbenchStreamRequest, NodeStream>;
type RelayAdmission = { conversationId: string | undefined; signal: AbortSignal };
export type OpenWorkbenchNodeStream = (
  nodeId: string,
  request: WorkbenchStreamRequest,
  signal: AbortSignal
) => Promise<NodeStream>;

/** Owns page-local sharing and disposal; controls and stream semantics stay with callers. */
export function createWorkbenchNodeConnectionService(options: {
  readonly http: ScopedHttpService;
  readonly connectDirect?: (nodeId: string, signal: AbortSignal) => Promise<WorkbenchNodePath>;
}) {
  const connections = new Map<
    string,
    { connection: Connection; admissions: Set<RelayAdmission> }
  >();

  const openStream: OpenWorkbenchNodeStream = async (nodeId, request, signal) => {
    signal.throwIfAborted();
    let entry = connections.get(nodeId);
    if (entry === undefined) {
      const direct = options.connectDirect;
      const admissions = new Set<RelayAdmission>();
      entry = {
        admissions,
        connection: new NodeConnection({
          ...(direct === undefined ? {} : { direct: (lifetime) => direct(nodeId, lifetime) }),
          relay: async (lifetime) => {
            // Only cold Relay admission uses these hints. An admitted carrier is not conversation-owned.
            const handshake = nodeRelayHandshakeSignal(lifetime);
            const attempted = new Set<string | undefined>();
            let failure: unknown = new Error('NODE_RELAY_UNAVAILABLE');
            for (const { conversationId, signal } of admissions) {
              handshake.throwIfAborted();
              if (signal.aborted || attempted.has(conversationId)) continue;
              attempted.add(conversationId);
              try {
                return await connectRelay(nodeId, options.http, handshake, conversationId);
              } catch (error) {
                failure = error;
              }
            }
            throw failure;
          }
        })
      };
      connections.set(nodeId, entry);
    }
    const admission = {
      signal,
      conversationId:
        request.kind === 'hosted-file-upload'
          ? request.conversationId
          : request.kind === 'hosted-file-download'
            ? request.descriptor.conversationId
            : undefined
    };
    entry.admissions.add(admission);
    try {
      return await entry.connection.openStream(request, { signal });
    } finally {
      entry.admissions.delete(admission);
    }
  };

  function closeNode(nodeId: string): void {
    const connection = connections.get(nodeId);
    connections.delete(nodeId);
    connection?.connection.close();
  }

  function reset(): void {
    for (const nodeId of connections.keys()) closeNode(nodeId);
  }

  return { openStream, closeNode, reset };
}

async function connectRelay(
  nodeId: string,
  http: ScopedHttpService,
  handshake: AbortSignal,
  hostedConversationId?: string
): Promise<WorkbenchNodePath> {
  const url = new URL(`/api/relay/${encodeURIComponent(nodeId)}`, window.location.origin);
  if (hostedConversationId !== undefined)
    url.searchParams.set('hostedConversationId', hostedConversationId);
  const path = await openBrowserNodeRelay(url, handshake);
  return {
    get closed() {
      return path.closed;
    },
    close: () => path.close(),
    async openStream(request, signal) {
      const { kind } = request;
      if (kind === 'browser-rfb') {
        const grant = await request.prepare(undefined, signal);
        if (grant !== undefined) return path.openStream({ kind, grant }, signal);
        return undefined;
      }
      if (kind === 'browser-file-download' || kind === 'browser-file-upload')
        return path.openStream({ kind, grant: request.ticket }, signal);
      let url: string;
      let input: object;
      if (kind === 'terminal') {
        const { kind: _kind, terminalId, ...options } = request;
        url = `/api/terminals/${encodeURIComponent(terminalId)}/attach-ticket`;
        input = { nodeId, ...options };
      } else if (kind === 'hosted-file-upload') {
        const { conversationId, uploadId } = request;
        url = `/api/nodes/${encodeURIComponent(nodeId)}/hosted-conversations/${encodeURIComponent(conversationId)}/uploads/${encodeURIComponent(uploadId)}/stream-ticket`;
        input = {};
      } else if (kind === 'hosted-file-download') {
        const { conversationId, fileId, ...descriptor } = request.descriptor;
        url = `/api/nodes/${encodeURIComponent(nodeId)}/hosted-conversations/${encodeURIComponent(conversationId)}/files/${encodeURIComponent(fileId)}/stream-ticket`;
        input = descriptor;
      } else {
        const { descriptor } = request;
        url = `/api/workspaces/${encodeURIComponent(descriptor.resource.workspaceId)}/file-stream-ticket`;
        input = { nodeId, descriptor };
      }
      const { ticket } = await http.request<{ ticket: string }>(url, {
        method: 'POST',
        body: JSON.stringify(input),
        signal
      });
      signal.throwIfAborted();
      return path.openStream({ kind, grant: ticket }, signal);
    }
  };
}

export function nodeRelayHandshakeSignal(lifetime: AbortSignal): AbortSignal {
  return AbortSignal.any([lifetime, AbortSignal.timeout(15_000)]);
}

/** Uses the same byte carrier for account and share-scoped Relay admission. */
export async function openBrowserNodeRelay(url: URL, signal: AbortSignal) {
  signal.throwIfAborted();
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  return openNodeRelayPath({
    carrier: {
      async send(bytes) {
        if (socket.readyState !== WebSocket.OPEN) throw new Error('NODE_RELAY_UNAVAILABLE');
        socket.send(bytes);
      },
      close: () => socket.close(),
      onMessage: (receive) => socket.addEventListener('message', (event) => receive(event.data)),
      onClose: (disconnect) => socket.addEventListener('close', disconnect, { once: true })
    },
    maxStreams: 32,
    signal
  });
}
