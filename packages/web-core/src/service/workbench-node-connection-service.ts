import { NodeConnection, type NodeConnectionPath } from '@myagentroam/protocol/node-connection';
import { openNodeRelayPath } from '@myagentroam/protocol/node-relay-path';
import type { NodeStream } from '@myagentroam/protocol/node-stream';
import { NODE_RELAY_OFFLINE_CLOSE_CODE } from '@myagentroam/protocol/node-stream-wire';
import type { WorkbenchStreamTransport } from '../model/workbench.js';
import { WORKBENCH_NODE_RETENTION_MS } from './active-node-transport-service.js';
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
export type BrowserFileStreamRequest = {
  /** Each path attempt needs its own unconsumed Browser file ticket. */
  readonly issueTicket: (signal: AbortSignal) => Promise<string>;
} & ({ readonly kind: 'browser-file-download' } | { readonly kind: 'browser-file-upload' });
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
  | BrowserFileStreamRequest
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
type RoutedStream = {
  readonly stream: NodeStream;
  readonly transport: WorkbenchStreamTransport;
  close(): void;
};
type Connection = NodeConnection<WorkbenchStreamRequest, RoutedStream>;
type RelayAdmission = { conversationId: string | undefined; signal: AbortSignal };
class NodeRelayOffline extends Error {
  readonly code = 'NODE_OFFLINE';

  constructor() {
    super('NODE_OFFLINE');
  }
}
type Entry = {
  connection: Connection;
  admissions: Set<RelayAdmission>;
  uses: number;
  expired: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
};
export type OpenWorkbenchNodeStream = (
  nodeId: string,
  request: WorkbenchStreamRequest,
  signal: AbortSignal
) => Promise<NodeStream>;

/** Owns page-local sharing and disposal; controls and stream semantics stay with callers. */
export function createWorkbenchNodeConnectionService(options: {
  readonly http: ScopedHttpService;
  readonly connectDirect?: (nodeId: string, signal: AbortSignal) => Promise<WorkbenchNodePath>;
  readonly isNodeActive?: (nodeId: string) => boolean;
}) {
  const connections = new Map<string, Entry>();

  const openRoutedStream = async (
    nodeId: string,
    request: WorkbenchStreamRequest,
    signal: AbortSignal
  ): Promise<RoutedStream> => {
    signal.throwIfAborted();
    let entry = connections.get(nodeId);
    if (entry === undefined) {
      const direct = options.connectDirect;
      const admissions = new Set<RelayAdmission>();
      entry = {
        admissions,
        uses: 0,
        expired: false,
        connection: new NodeConnection({
          ...(direct === undefined
            ? {}
            : { direct: async (lifetime) => routePath(await direct(nodeId, lifetime), 'ice') }),
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
                return routePath(
                  await connectRelay(nodeId, options.http, handshake, conversationId),
                  'relay'
                );
              } catch (error) {
                // A different Hosted scope cannot make the same Node ready.
                if (error instanceof NodeRelayOffline) throw error;
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
    clearTimeout(entry.idleTimer);
    entry.uses++;
    const use = entry;
    const release = () => {
      use.uses--;
      releaseIfIdle(nodeId, use);
    };
    entry.admissions.add(admission);
    try {
      const opened = await entry.connection.openStream(request, { signal });
      // OPEN alone is not the end of the lease: a file, Terminal or RFB can outlive selection.
      void opened.stream.finished.then(release);
      return opened;
    } catch (error) {
      release();
      throw error;
    } finally {
      entry.admissions.delete(admission);
    }
  };
  const openStream: OpenWorkbenchNodeStream = async (nodeId, request, signal) =>
    (await openRoutedStream(nodeId, request, signal)).stream;

  function releaseIfIdle(nodeId: string, entry: Entry): void {
    if (connections.get(nodeId) !== entry || entry.uses !== 0 || options.isNodeActive?.(nodeId))
      return;
    if (entry.expired) closeNode(nodeId);
    else {
      // Relay-only callers such as Hosted do not start a Workspace selection lease.
      entry.idleTimer = setTimeout(() => {
        if (!options.isNodeActive?.(nodeId)) closeNode(nodeId);
      }, WORKBENCH_NODE_RETENTION_MS);
    }
  }

  function expireNode(nodeId: string): void {
    const entry = connections.get(nodeId);
    if (entry === undefined) return;
    entry.expired = true;
    releaseIfIdle(nodeId, entry);
  }

  async function directReady(nodeId: string): Promise<void> {
    // A probe can finish before a Node has any streams; never create a new entry here.
    await connections
      .get(nodeId)
      ?.connection.prepareDirect()
      .catch(() => undefined);
  }

  function closeNode(nodeId: string): void {
    const entry = connections.get(nodeId);
    if (entry === undefined) return;
    connections.delete(nodeId);
    clearTimeout(entry.idleTimer);
    entry.connection.close();
  }

  function reset(): void {
    for (const nodeId of connections.keys()) closeNode(nodeId);
  }

  return { openStream, openRoutedStream, expireNode, directReady, closeNode, reset };
}

/** Only the adapter that successfully opens the stream can report its transport. */
function routePath(path: WorkbenchNodePath, transport: WorkbenchStreamTransport) {
  return {
    get closed() {
      return path.closed;
    },
    close: () => path.close(),
    async openStream(request: WorkbenchStreamRequest, signal: AbortSignal) {
      const stream = await path.openStream(request, signal);
      return stream === undefined ? undefined : { stream, transport, close: () => stream.close() };
    }
  };
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
      if (kind === 'browser-file-download' || kind === 'browser-file-upload') {
        const ticket = await request.issueTicket(signal);
        return path.openStream({ kind, grant: ticket }, signal);
      }
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
  let closeCode: number | undefined;
  return openNodeRelayPath({
    carrier: {
      async send(bytes) {
        if (socket.readyState !== WebSocket.OPEN) throw new Error('NODE_RELAY_UNAVAILABLE');
        socket.send(bytes);
      },
      close: () => socket.close(),
      onMessage: (receive) => socket.addEventListener('message', (event) => receive(event.data)),
      onClose: (disconnect) =>
        socket.addEventListener(
          'close',
          (event) => {
            closeCode = event.code;
            disconnect();
          },
          { once: true }
        )
    },
    maxStreams: 32,
    signal
  }).catch((error) => {
    signal.throwIfAborted();
    if (closeCode === NODE_RELAY_OFFLINE_CLOSE_CODE) throw new NodeRelayOffline();
    throw error;
  });
}
