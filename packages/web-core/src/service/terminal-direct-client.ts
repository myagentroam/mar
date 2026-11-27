import { createUuid } from '../util/uuid.js';
import type {
  TerminalDirectBrowserMessage,
  TerminalDirectServerMessage
} from '@myagentroam/protocol';
import { NodeStreamError, type NodeStream } from '@myagentroam/protocol/node-stream';
import type { NodeStreamOpen } from '@myagentroam/protocol/node-stream-mux';
import type { NodeConnectionPath } from '@myagentroam/protocol/node-connection';

export interface TerminalAttachmentRequest {
  readonly terminalId: string;
  readonly workspaceId?: string;
  readonly afterSequence: number;
}

type Binding = { readonly transportSessionId: string; readonly nodeGeneration: string };
const UNAVAILABLE = new Set([
  'NODE_OFFLINE',
  'TERMINAL_DIRECT_TIMEOUT',
  'TERMINAL_DIRECT_UNAVAILABLE',
  'TERMINAL_DIRECT_CONTROL_UNAVAILABLE'
]);

interface Pending {
  readonly resolve: (
    message: Extract<TerminalDirectServerMessage, { type: 'terminal.direct.prepared' }>
  ) => void;
  readonly reject: (error: NodeStreamError) => void;
}

interface Active {
  readonly scope: AbortController;
  stream?: NodeStream;
  lastHeartbeat: number;
  timer?: ReturnType<typeof setInterval>;
  removeAbort(): void;
}

export interface TerminalDirectClientOptions {
  readonly send: (message: TerminalDirectBrowserMessage) => boolean;
}

/** Owns per-terminal grants and leases; the page transport owns the shared ICE carrier. */
export function createTerminalDirectClient(options: TerminalDirectClientOptions) {
  const pending = new Map<string, Pending>();
  const active = new Map<string, Active>();

  function handle(message: TerminalDirectServerMessage): void {
    if (message.type === 'terminal.direct.prepared') {
      const waiting = pending.get(message.requestId);
      if (waiting === undefined) {
        options.send({ type: 'terminal.direct.cancel', directSessionId: message.directSessionId });
        return;
      }
      pending.delete(message.requestId);
      waiting.resolve(message);
      return;
    }
    if (message.type === 'terminal.direct.error') {
      const waiting = pending.get(message.requestId ?? '');
      if (waiting !== undefined) {
        pending.delete(message.requestId!);
        waiting.reject(new NodeStreamError(message.code));
      }
      return;
    }
    const session = active.get(message.directSessionId);
    if (session === undefined) return;
    if (message.type === 'terminal.direct.heartbeat') session.lastHeartbeat = Date.now();
    else stop(message.directSessionId, session, message.code);
  }

  function stop(id: string, session: Active, code?: string): void {
    if (!active.delete(id)) return;
    if (session.timer !== undefined) clearInterval(session.timer);
    session.removeAbort();
    session.scope.abort(new NodeStreamError(code ?? 'NODE_STREAM_CANCELLED'));
    if (code !== undefined) session.stream?.reset(code);
    else session.stream?.close();
    options.send({ type: 'terminal.direct.cancel', directSessionId: id });
  }

  async function openStream(
    nodeId: string,
    input: TerminalAttachmentRequest,
    binding: Binding,
    path: NodeConnectionPath<NodeStreamOpen, NodeStream>,
    signal: AbortSignal
  ): Promise<NodeStream | undefined> {
    const requestId = createUuid().replaceAll('-', '');
    let removeAbort = () => {};
    let prepared: Extract<TerminalDirectServerMessage, { type: 'terminal.direct.prepared' }>;
    try {
      prepared = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(requestId);
          reject(new NodeStreamError('TERMINAL_DIRECT_TIMEOUT'));
        }, 5_000);
        const abort = () => {
          pending.delete(requestId);
          reject(signal.reason);
        };
        removeAbort = () => {
          clearTimeout(timeout);
          signal.removeEventListener('abort', abort);
        };
        signal.addEventListener('abort', abort, { once: true });
        pending.set(requestId, { resolve, reject });
        if (signal.aborted) abort();
        else if (
          !options.send({
            type: 'terminal.direct.prepare',
            requestId,
            nodeId,
            ...binding,
            ...input,
            readonly: false
          })
        ) {
          pending.delete(requestId);
          reject(new NodeStreamError('TERMINAL_DIRECT_CONTROL_UNAVAILABLE'));
        }
      });
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof NodeStreamError && UNAVAILABLE.has(error.code)) return undefined;
      throw error;
    } finally {
      removeAbort();
    }
    const id = prepared.directSessionId;
    const cancelled = () => stop(id, session);
    const session: Active = {
      scope: new AbortController(),
      lastHeartbeat: Date.now(),
      removeAbort: () => signal.removeEventListener('abort', cancelled)
    };
    active.set(id, session);
    signal.addEventListener('abort', cancelled, { once: true });
    const opening = AbortSignal.any([signal, session.scope.signal]);
    try {
      opening.throwIfAborted();
      // Beyond this boundary an uncertain OPEN must never fall back to Relay.
      const stream = await path.openStream({ kind: 'terminal', grant: prepared.grant }, opening);
      if (opening.aborted) {
        stream?.close();
        opening.throwIfAborted();
      }
      if (stream === undefined) {
        stop(id, session);
        return undefined;
      }
      session.stream = stream;
      void stream.finished.then(() => stop(id, session));
      session.timer = setInterval(() => {
        if (
          Date.now() - session.lastHeartbeat > 30_000 ||
          !options.send({ type: 'terminal.direct.heartbeat', directSessionId: id })
        )
          stop(id, session, 'TERMINAL_DIRECT_CONTROL_UNAVAILABLE');
      }, 10_000);
      return stream;
    } catch (error) {
      const reason = opening.aborted ? opening.reason : error;
      stop(id, session);
      throw reason;
    }
  }

  function invalidate(): void {
    for (const [id, item] of pending) {
      pending.delete(id);
      item.reject(new NodeStreamError('TERMINAL_DIRECT_CONTROL_UNAVAILABLE'));
    }
    for (const [id, item] of active) stop(id, item, 'TERMINAL_DIRECT_CONTROL_UNAVAILABLE');
  }

  return { openStream, handle, invalidate };
}
