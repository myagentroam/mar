import { createUuid } from '../util/uuid.js';
import {
  type RemoteDesktopDirectBrowserMessage,
  type RemoteDesktopDirectServerMessage,
  type RemoteDesktopRelayBrowserMessage,
  type RemoteDesktopRelayServerMessage
} from '@myagentroam/protocol';
import type { RemoteDesktopChannel } from './remote-desktop-channel.js';
import { openRemoteDesktopChannel } from './remote-desktop-open.js';
export type DesktopClientPrepared = Extract<
  RemoteDesktopDirectServerMessage | RemoteDesktopRelayServerMessage,
  { type: 'desktop.direct.prepared' | 'desktop.relay.prepared' }
>;
type Prepared = DesktopClientPrepared;
type BrowserMessage = RemoteDesktopDirectBrowserMessage | RemoteDesktopRelayBrowserMessage;
type ServerMessage = RemoteDesktopDirectServerMessage | RemoteDesktopRelayServerMessage;

export interface DesktopClientTransport {
  prepare(requestId: string, input: DesktopClientInput): BrowserMessage;
  connect(
    prepared: Prepared,
    signal: AbortSignal
  ): Promise<{ raw: RTCDataChannel | WebSocket; maxMessageBytes: number }>;
  release(): void;
}
export interface DesktopClientInput {
  readonly nodeId: string;
  readonly nodeGeneration: string;
  readonly desktopGeneration: string;
  readonly topologyRevision: number;
  readonly mode: 'VIEW' | 'CONTROL';
  readonly signal: AbortSignal;
  readonly onDisconnected: (code: string) => void;
}

export class RemoteDesktopClientError extends Error {
  /** False means cleanup is unknown; it never asserts cleanup from a timeout or disconnect. */
  settlement: Promise<boolean> = Promise.resolve(false);
  confirmedCode?: string;
  constructor(readonly code: string) {
    super('The remote desktop connection is unavailable.');
  }
}

interface Pending {
  resolve(message: Prepared): void;
  reject(error: RemoteDesktopClientError): void;
}
interface Active {
  readonly transport: DesktopClientTransport;
  readonly cancel: AbortController;
  readonly onDisconnected: (code: string) => void;
  raw?: RTCDataChannel | WebSocket;
  channel?: RemoteDesktopChannel;
  stopped: boolean;
  ready: boolean;
  lastHeartbeat: number;
  heartbeatSentAt?: number;
  controlRoundTripMs?: number;
  timer?: ReturnType<typeof setInterval>;
  settlement: Promise<boolean>;
  finishSettlement(value: boolean): void;
  settlementTimer?: ReturnType<typeof setTimeout>;
  failure?: RemoteDesktopClientError;
  finalCode?: string;
  disconnectedCode?: string;
}

/** Owns desktop authorization and OPEN/ATTACHED only; noVNC takes over RFB and channel I/O. */
export function createRemoteDesktopClientCore(options: {
  readonly path: 'direct' | 'relay';
  readonly send: (message: BrowserMessage) => boolean;
  readonly acquire: (nodeId: string, nodeGeneration: string) => DesktopClientTransport | undefined;
  readonly error: (code: string) => RemoteDesktopClientError;
  readonly randomId?: (() => string) | undefined;
}) {
  const pending = new Map<string, Pending>();
  const active = new Map<string, Active>();
  const closing = new Map<string, Active>();
  let uncertain = false;
  let disposed = false;
  const randomId = options.randomId ?? (() => createUuid().replaceAll('-', ''));
  const send = (message: BrowserMessage): boolean => {
    try {
      return options.send(message);
    } catch {
      return false;
    }
  };

  function stop(id: string, session: Active, code?: string): void {
    if (session.stopped) return;
    session.stopped = true;
    active.delete(id);
    closing.set(id, session);
    session.settlementTimer = setTimeout(() => finishSettlement(id, session, false), 30_000);
    session.cancel.abort();
    if (session.timer !== undefined) clearInterval(session.timer);
    if (session.channel) session.channel.close();
    else session.raw?.close();
    send({
      type: options.path === 'direct' ? 'desktop.direct.cancel' : 'desktop.relay.cancel',
      attachmentId: id
    });
    session.transport.release();
    if (code) {
      session.disconnectedCode = code;
      session.onDisconnected(code);
    }
  }

  function finishSettlement(id: string, session: Active, settled: boolean, code?: string): void {
    if (closing.get(id) !== session) return;
    closing.delete(id);
    if (session.settlementTimer !== undefined) clearTimeout(session.settlementTimer);
    if (!settled) uncertain = true;
    if (settled && code) {
      session.finalCode = code;
      if (session.failure) {
        session.failure.confirmedCode = code;
      }
      if (session.disconnectedCode !== undefined && session.disconnectedCode !== code) {
        session.disconnectedCode = code;
        session.onDisconnected(code);
      }
    }
    session.finishSettlement(settled);
  }

  function handle(message: ServerMessage): void {
    if (message.type === `desktop.${options.path}.prepared`) {
      if (message.type !== 'desktop.direct.prepared' && message.type !== 'desktop.relay.prepared')
        return;
      const waiter = pending.get(message.requestId);
      if (!waiter) {
        send({
          type: options.path === 'direct' ? 'desktop.direct.cancel' : 'desktop.relay.cancel',
          attachmentId: message.attachmentId
        });
        return;
      }
      pending.delete(message.requestId);
      waiter.resolve(message);
      return;
    }
    if (
      message.type === `desktop.${options.path}.error` &&
      (message.type === 'desktop.direct.error' || message.type === 'desktop.relay.error') &&
      message.requestId
    ) {
      const waiter = pending.get(message.requestId);
      if (waiter) {
        pending.delete(message.requestId);
        const failure = options.error(message.code);
        if (message.settled === true) {
          failure.settlement = Promise.resolve(true);
          failure.confirmedCode = message.code;
        }
        waiter.reject(failure);
        return;
      }
    }
    if (!message.type.startsWith(`desktop.${options.path}.`) || !message.attachmentId) return;
    if (message.type === 'desktop.direct.settled' || message.type === 'desktop.relay.settled') {
      const session = closing.get(message.attachmentId) ?? active.get(message.attachmentId);
      if (!session) return;
      if (!session.stopped) stop(message.attachmentId, session, 'DESKTOP_CONTROL_UNAVAILABLE');
      finishSettlement(message.attachmentId, session, true, message.code);
      return;
    }
    const session = active.get(message.attachmentId);
    if (!session) return;
    if (message.type === `desktop.${options.path}.heartbeat`) {
      session.lastHeartbeat = performance.now();
      if (session.heartbeatSentAt !== undefined) {
        session.controlRoundTripMs = session.lastHeartbeat - session.heartbeatSentAt;
        delete session.heartbeatSentAt;
      }
    } else if (
      message.type === 'desktop.direct.closed' ||
      message.type === 'desktop.direct.error' ||
      message.type === 'desktop.relay.closed' ||
      message.type === 'desktop.relay.error'
    )
      stop(message.attachmentId, session, message.code);
  }

  async function attach(input: DesktopClientInput): Promise<
    | {
        readonly channel: RemoteDesktopChannel;
        readonly controlRoundTripMs: number | undefined;
        ready(): void;
        close(): Promise<boolean>;
      }
    | undefined
  > {
    if (disposed || uncertain) throw options.error('DESKTOP_CONTROL_UNAVAILABLE');
    const transport = options.acquire(input.nodeId, input.nodeGeneration);
    if (!transport) return undefined;
    const requestId = randomId();
    let prepared: Prepared | undefined;
    let session: Active | undefined;
    let submissionAttempted = false;
    let removePending = () => {};
    try {
      if (pending.has(requestId) || pending.size + active.size + closing.size >= 4)
        throw options.error('DESKTOP_CONTROL_UNAVAILABLE');
      prepared = await new Promise<Prepared>((resolve, reject) => {
        const finish = () => {
          clearTimeout(timer);
          input.signal.removeEventListener('abort', abort);
          pending.delete(requestId);
        };
        const abort = () => {
          finish();
          reject(options.error('DESKTOP_CONTROL_UNAVAILABLE'));
        };
        const timer = setTimeout(abort, 15_000);
        removePending = finish;
        pending.set(requestId, {
          resolve: (value) => {
            finish();
            if (active.has(value.attachmentId) || closing.has(value.attachmentId)) {
              send({
                type: options.path === 'direct' ? 'desktop.direct.cancel' : 'desktop.relay.cancel',
                attachmentId: value.attachmentId
              });
              reject(options.error('DESKTOP_CONTROL_UNAVAILABLE'));
              return;
            }
            const id = value.attachmentId;
            let resolveSettlement!: (value: boolean) => void;
            const settlement = new Promise<boolean>((resolve) => {
              resolveSettlement = resolve;
            });
            const current: Active = {
              transport,
              cancel: new AbortController(),
              onDisconnected: input.onDisconnected,
              stopped: false,
              ready: false,
              lastHeartbeat: performance.now(),
              settlement,
              finishSettlement: resolveSettlement
            };
            session = current;
            active.set(id, current);
            const abort = () => stop(id, current);
            input.signal.addEventListener('abort', abort, { once: true });
            current.cancel.signal.addEventListener(
              'abort',
              () => input.signal.removeEventListener('abort', abort),
              { once: true }
            );
            current.timer = setInterval(() => {
              current.heartbeatSentAt ??= performance.now();
              if (
                performance.now() - current.lastHeartbeat > 30_000 ||
                !send({
                  type:
                    options.path === 'direct'
                      ? 'desktop.direct.heartbeat'
                      : 'desktop.relay.heartbeat',
                  attachmentId: id
                })
              )
                stop(id, current, 'DESKTOP_CONTROL_UNAVAILABLE');
            }, 10_000);
            if (input.signal.aborted) abort();
            resolve(value);
          },
          reject: (error) => {
            finish();
            reject(error);
          }
        });
        input.signal.addEventListener('abort', abort, { once: true });
        if (input.signal.aborted) abort();
        else {
          submissionAttempted = true;
          if (!send(transport.prepare(requestId, input))) abort();
        }
      });
      if (input.signal.aborted) throw options.error('DESKTOP_CONTROL_UNAVAILABLE');
      const id = prepared.attachmentId;
      const current = session!;
      if (current.stopped) throw options.error('DESKTOP_CONTROL_UNAVAILABLE');
      const setup = AbortSignal.any([current.cancel.signal, AbortSignal.timeout(15_000)]);
      const { raw, maxMessageBytes } = await transport.connect(prepared, setup);
      if (current.stopped || setup.aborted) {
        raw.close();
        throw options.error('DESKTOP_CONTROL_UNAVAILABLE');
      }
      current.raw = raw;
      const channel = await openRemoteDesktopChannel({
        raw,
        attachmentId: id,
        grant: prepared.grant,
        signal: setup,
        isStopped: () => current.stopped,
        maxMessageBytes,
        onFailure: (code) => stop(id, current, code),
        onAdopt: (owned) => {
          current.channel = owned;
        }
      });
      return {
        channel,
        get controlRoundTripMs() {
          return current.stopped ? undefined : current.controlRoundTripMs;
        },
        ready() {
          if (current.stopped || current.ready) return;
          current.ready = true;
          if (!send({ type: 'desktop.ready', attachmentId: id }))
            stop(id, current, 'DESKTOP_CONTROL_UNAVAILABLE');
        },
        close: () => {
          stop(id, current);
          return current.settlement;
        }
      };
    } catch (error) {
      removePending();
      if (prepared && session) stop(prepared.attachmentId, session);
      else {
        if (prepared)
          send({
            type: options.path === 'direct' ? 'desktop.direct.cancel' : 'desktop.relay.cancel',
            attachmentId: prepared.attachmentId
          });
        transport.release();
        if (
          submissionAttempted &&
          (!(error instanceof RemoteDesktopClientError) || !(await error.settlement))
        )
          uncertain = true;
      }
      const failure =
        error instanceof RemoteDesktopClientError
          ? error
          : options.error('DESKTOP_TRANSPORT_ERROR');
      if (session) {
        failure.settlement = session.settlement;
        session.failure = failure;
        if (session.finalCode) {
          failure.confirmedCode = session.finalCode;
        }
      }
      throw failure;
    }
  }

  function close(): void {
    disposed = true;
    for (const waiter of pending.values())
      waiter.reject(options.error('DESKTOP_CONTROL_UNAVAILABLE'));
    for (const [id, session] of active) stop(id, session);
    for (const [id, session] of closing) finishSettlement(id, session, false);
  }
  return { attach, handle, close };
}
