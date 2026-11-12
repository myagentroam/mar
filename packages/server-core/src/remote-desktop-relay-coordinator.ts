import { randomBytes } from 'node:crypto';
import type {
  RemoteDesktopRelayBrowserMessage,
  RemoteDesktopRelayNodeCommand,
  RemoteDesktopRelayNodeEvent,
  RemoteDesktopRelayServerMessage
} from '@myagentroam/protocol';
import type { DirectTransferBrowserIdentity } from './direct-transfer-coordinator.js';
import { NodeRequestError } from './node-request-error.js';
import type { RemoteDesktopAdmission } from './remote-desktop-admission.js';
import type { RemoteDesktopRelayPairing } from './remote-desktop-relay-pairing.js';

type Prepare = Extract<RemoteDesktopRelayBrowserMessage, { type: 'desktop.relay.prepare' }>;
type Entry = NonNullable<ReturnType<RemoteDesktopAdmission['get']>>;
type Delivery = 'delivered' | 'unavailable' | 'authorization-revoked';
interface Record {
  readonly grant: string;
  readonly browserTicket: string;
  closeCode?: string;
}

function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Desktop operation expired'));
    signal.addEventListener('abort', abort, { once: true });
    work.then(
      (result) => {
        signal.removeEventListener('abort', abort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
    if (signal.aborted) abort();
  });
}

export interface RemoteDesktopRelayOptions {
  readonly admission: RemoteDesktopAdmission;
  readonly pairing: Pick<RemoteDesktopRelayPairing, 'prepare' | 'opened' | 'cancel'>;
  readonly authorize: (
    userId: number,
    nodeId: string,
    mode: 'VIEW' | 'CONTROL'
  ) => boolean | Promise<boolean>;
  readonly preflight: (
    request: Prepare,
    identity: DirectTransferBrowserIdentity,
    signal: AbortSignal
  ) => Promise<unknown>;
  readonly sendNode: (nodeId: string, command: RemoteDesktopRelayNodeCommand) => boolean;
  readonly sendBrowser: (
    connectionId: string,
    message: RemoteDesktopRelayServerMessage
  ) => Promise<Delivery>;
  readonly now?: () => number;
}

/** Owns relay grants and control messages, not the paired socket I/O or native cleanup. */
export class RemoteDesktopRelayCoordinator {
  readonly #records = new Map<string, Record>();
  readonly #events = new Map<string, Promise<void>>();
  readonly #eventCounts = new Map<string, number>();
  readonly #now: () => number;
  readonly #timer: NodeJS.Timeout;
  #closed = false;

  constructor(private readonly options: RemoteDesktopRelayOptions) {
    const epoch = Date.now() - performance.now();
    this.#now = options.now ?? (() => Math.floor(epoch + performance.now()));
    this.#timer = setInterval(() => {
      this.#closeEntries(options.admission.expire(this.#now(), 'RELAY'), 'DESKTOP_TIMEOUT');
      for (const entry of options.admission.retireExpiredGonePages(this.#now(), 'RELAY'))
        this.#records.delete(entry.attachmentId);
      for (const entry of options.admission.pendingClosures('RELAY')) {
        this.#sendNode(entry.nodeId, {
          type: 'desktop.relay.cancel',
          attachmentId: entry.attachmentId,
          code: this.#records.get(entry.attachmentId)?.closeCode ?? 'DESKTOP_CANCELLED'
        });
      }
    }, 1000);
    this.#timer.unref();
  }

  async handleBrowser(
    identity: DirectTransferBrowserIdentity,
    message: RemoteDesktopRelayBrowserMessage
  ): Promise<void> {
    if (message.type === 'desktop.relay.prepare') return this.#prepare(identity, message);
    const entry = this.options.admission.get(message.attachmentId);
    const record = this.#records.get(message.attachmentId);
    if (!entry || entry.path !== 'RELAY' || !record || !this.#samePage(entry, identity)) return;
    if (message.type === 'desktop.relay.cancel') {
      this.#closeEntries(
        [this.options.admission.beginClose(entry.attachmentId)],
        'DESKTOP_CANCELLED'
      );
      return;
    }
    if (!(await this.#authorized(entry)) || !this.#current(entry.attachmentId, record)) {
      this.#closeEntries(
        [this.options.admission.beginClose(entry.attachmentId)],
        'DESKTOP_NOT_AUTHORIZED'
      );
      return;
    }
    if (message.type === 'desktop.ready') {
      if (!this.options.admission.browserReady(entry.attachmentId, identity, this.#now())) return;
      if (
        !this.#sendNode(entry.nodeId, { type: 'desktop.ready', attachmentId: entry.attachmentId })
      )
        this.#closeEntries([this.options.admission.beginClose(entry.attachmentId)], 'NODE_OFFLINE');
      return;
    }
    if (!this.options.admission.heartbeat(entry.attachmentId, identity, this.#now())) return;
    const current = this.options.admission.get(entry.attachmentId)!;
    if (
      !this.#sendNode(entry.nodeId, {
        type: 'desktop.relay.heartbeat',
        attachmentId: entry.attachmentId,
        expiresAt: current.expiresAt
      })
    ) {
      this.#closeEntries([this.options.admission.beginClose(entry.attachmentId)], 'NODE_OFFLINE');
      return;
    }
    if (
      (await this.#sendBrowser(entry.workbenchConnectionId, {
        type: 'desktop.relay.heartbeat',
        attachmentId: entry.attachmentId,
        expiresAt: current.expiresAt
      })) !== 'delivered'
    )
      this.#closeEntries(
        [this.options.admission.beginClose(entry.attachmentId)],
        'DESKTOP_CONTROL_UNAVAILABLE'
      );
  }

  onNodeEvent(
    nodeId: string,
    generation: string,
    event: RemoteDesktopRelayNodeEvent
  ): Promise<void> {
    if (event.nodeGeneration !== generation) return Promise.resolve();
    if (event.type === 'desktop.relay.closed') return this.#nodeEvent(nodeId, generation, event);
    const entry = this.options.admission.get(event.attachmentId);
    if (
      !entry ||
      entry.path !== 'RELAY' ||
      entry.nodeId !== nodeId ||
      entry.nodeGeneration !== generation ||
      !this.#records.has(event.attachmentId)
    )
      return Promise.resolve();
    const count = this.#eventCounts.get(event.attachmentId) ?? 0;
    if (count >= 4) {
      this.#closeEntries(
        [this.options.admission.beginClose(event.attachmentId)],
        'DESKTOP_PROTOCOL_ERROR'
      );
      return Promise.resolve();
    }
    this.#eventCounts.set(event.attachmentId, count + 1);
    const next = (this.#events.get(event.attachmentId) ?? Promise.resolve()).then(() =>
      this.#nodeEvent(nodeId, generation, event)
    );
    this.#events.set(event.attachmentId, next);
    const release = () => {
      const remaining = (this.#eventCounts.get(event.attachmentId) ?? 1) - 1;
      if (remaining) this.#eventCounts.set(event.attachmentId, remaining);
      else this.#eventCounts.delete(event.attachmentId);
      if (this.#events.get(event.attachmentId) === next) this.#events.delete(event.attachmentId);
    };
    void next.then(release, release);
    return next;
  }

  /** Pairing has already fenced admission before invoking this callback. */
  pairingClosed(id: string): void {
    const entry = this.options.admission.get(id);
    if (entry?.path === 'RELAY' && this.#records.has(id))
      this.#closeEntries([entry], 'DESKTOP_TRANSPORT_ERROR');
  }

  revokeConnection(id: string): void {
    this.#closeEntries(
      this.options.admission.closeForConnection(id, 'RELAY'),
      'DESKTOP_NOT_AUTHORIZED'
    );
  }
  revokeSession(id: string): void {
    this.#closeEntries(
      this.options.admission.closeForSession(id, 'RELAY'),
      'DESKTOP_NOT_AUTHORIZED'
    );
  }
  revokeUser(id: number): void {
    this.#closeEntries(this.options.admission.closeForUser(id, 'RELAY'), 'DESKTOP_NOT_AUTHORIZED');
  }
  revokeNode(id: string): void {
    this.#closeEntries(this.options.admission.closeForNode(id, 'RELAY'), 'NODE_OFFLINE');
  }

  retireOtherGenerations(nodeId: string, currentGeneration: string): void {
    for (const entry of this.options.admission.retireOtherGenerations(
      nodeId,
      currentGeneration,
      'RELAY'
    )) {
      this.#records.delete(entry.attachmentId);
      this.options.pairing.cancel(entry.attachmentId);
      if (entry.phase !== 'CLOSING')
        void this.#sendBrowser(entry.workbenchConnectionId, {
          type: 'desktop.relay.closed',
          attachmentId: entry.attachmentId,
          code: 'NODE_CONNECTION_REPLACED'
        });
    }
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    this.#closeEntries(this.options.admission.closeAll('RELAY'), 'DESKTOP_SERVER_SHUTDOWN');
  }

  async #prepare(identity: DirectTransferBrowserIdentity, request: Prepare): Promise<void> {
    if (this.#closed)
      return this.#error(identity, request.requestId, 'DESKTOP_CONTROL_UNAVAILABLE', true);
    const attachmentId = randomBytes(24).toString('base64url');
    const grant = randomBytes(32).toString('base64url');
    const entry = this.options.admission.reserve(
      {
        ...identity,
        attachmentId,
        requestId: request.requestId,
        nodeId: request.nodeId,
        nodeGeneration: request.nodeGeneration,
        desktopGeneration: request.desktopGeneration,
        topologyRevision: request.topologyRevision,
        mode: request.mode,
        path: 'RELAY'
      },
      this.#now()
    );
    if (!entry)
      return this.#error(identity, request.requestId, 'DESKTOP_CONTROL_UNAVAILABLE', true);
    let failureCode = 'DESKTOP_CONTROL_UNAVAILABLE';
    const deadline = AbortSignal.timeout(15_000);
    try {
      if (
        !(await bounded(
          Promise.resolve(this.options.authorize(identity.userId, request.nodeId, request.mode)),
          deadline
        ))
      ) {
        failureCode = 'DESKTOP_NOT_AUTHORIZED';
        throw new Error();
      }
      await bounded(this.options.preflight(request, identity, deadline), deadline);
      if (
        !(await bounded(
          Promise.resolve(this.options.authorize(identity.userId, request.nodeId, request.mode)),
          deadline
        ))
      ) {
        failureCode = 'DESKTOP_NOT_AUTHORIZED';
        throw new Error();
      }
    } catch (error) {
      if (
        error instanceof NodeRequestError &&
        [
          'DESKTOP_TOPOLOGY_UNAVAILABLE',
          'DESKTOP_SESSION_UNAVAILABLE',
          'DESKTOP_UNAVAILABLE'
        ].includes(error.code)
      )
        failureCode = error.code;
      this.options.admission.beginClose(attachmentId);
      return this.#error(identity, request.requestId, failureCode, true);
    }
    // Admission revocation removes only matching pending reservations before dispatch.
    if (this.#closed || !this.options.admission.dispatched(attachmentId, this.#now())) {
      this.options.admission.beginClose(attachmentId);
      return this.#error(identity, request.requestId, 'DESKTOP_CONTROL_UNAVAILABLE', true);
    }
    let tickets: ReturnType<RemoteDesktopRelayPairing['prepare']>;
    try {
      tickets = this.options.pairing.prepare(attachmentId);
    } catch {
      this.options.admission.notSubmitted(attachmentId);
      return this.#error(identity, request.requestId, 'DESKTOP_CONTROL_UNAVAILABLE', true);
    }
    if (!tickets) {
      this.options.admission.notSubmitted(attachmentId);
      return this.#error(identity, request.requestId, 'DESKTOP_CONTROL_UNAVAILABLE', true);
    }
    this.#records.set(attachmentId, { grant, browserTicket: tickets.browserTicket });
    const command: RemoteDesktopRelayNodeCommand = {
      type: 'desktop.relay.prepare',
      attachmentId,
      workbenchConnectionId: entry.workbenchConnectionId,
      nodeGeneration: entry.nodeGeneration,
      desktopGeneration: entry.desktopGeneration,
      topologyRevision: entry.topologyRevision,
      mode: entry.mode,
      grant,
      ticket: tickets.nodeTicket,
      openExpiresAt: entry.openExpiresAt,
      expiresAt: entry.expiresAt
    };
    let sent: boolean;
    try {
      sent = this.options.sendNode(entry.nodeId, command);
    } catch {
      this.#closeEntries([this.options.admission.beginClose(attachmentId)], 'NODE_OFFLINE');
      return this.#error(identity, request.requestId, 'NODE_OFFLINE');
    }
    if (!sent) {
      const notSubmitted = this.options.admission.notSubmitted(attachmentId);
      if (notSubmitted) {
        this.#records.delete(attachmentId);
        this.options.pairing.cancel(attachmentId);
      } else this.#closeEntries([this.options.admission.beginClose(attachmentId)], 'NODE_OFFLINE');
      return this.#error(identity, request.requestId, 'NODE_OFFLINE', notSubmitted);
    }
  }

  async #nodeEvent(
    nodeId: string,
    generation: string,
    event: RemoteDesktopRelayNodeEvent
  ): Promise<void> {
    const entry = this.options.admission.get(event.attachmentId);
    const record = this.#records.get(event.attachmentId);
    if (
      !entry ||
      entry.path !== 'RELAY' ||
      !record ||
      entry.nodeId !== nodeId ||
      entry.nodeGeneration !== generation
    )
      return;
    if (event.type === 'desktop.relay.closed') {
      this.options.admission.beginClose(entry.attachmentId);
      if (this.options.admission.settled(entry.attachmentId, nodeId, generation)) {
        this.#records.delete(entry.attachmentId);
        this.options.pairing.cancel(entry.attachmentId);
        void this.#error(entry, entry.requestId, event.code, true);
        if (entry.phase !== 'CLOSING')
          await this.#sendBrowser(entry.workbenchConnectionId, {
            type: 'desktop.relay.closed',
            attachmentId: entry.attachmentId,
            code: event.code
          });
        void this.#sendBrowser(entry.workbenchConnectionId, {
          type: 'desktop.relay.settled',
          attachmentId: entry.attachmentId,
          code: event.code
        });
      }
      return;
    }
    if (!(await this.#authorized(entry)) || !this.#current(entry.attachmentId, record)) {
      this.#closeEntries(
        [this.options.admission.beginClose(entry.attachmentId)],
        'DESKTOP_NOT_AUTHORIZED'
      );
      return;
    }
    const now = this.#now();
    if (event.phase === 'OPEN') {
      if (
        !this.options.admission.open(entry.attachmentId, nodeId, generation, now) ||
        !this.options.pairing.opened(entry.attachmentId)
      )
        this.#closeEntries(
          [this.options.admission.beginClose(entry.attachmentId)],
          'DESKTOP_PROTOCOL_ERROR'
        );
      return;
    }
    if (event.phase === 'ATTACHED' || event.phase === 'ACTIVE') {
      const valid =
        event.phase === 'ATTACHED'
          ? this.options.admission.attached(entry.attachmentId, nodeId, generation, now)
          : this.options.admission.active(entry.attachmentId, nodeId, generation, now);
      if (!valid)
        this.#closeEntries(
          [this.options.admission.beginClose(entry.attachmentId)],
          'DESKTOP_PROTOCOL_ERROR'
        );
      return;
    }
    if (!this.options.admission.prepared(entry.attachmentId, nodeId, generation, now)) {
      this.#closeEntries(
        [this.options.admission.beginClose(entry.attachmentId)],
        'DESKTOP_PROTOCOL_ERROR'
      );
      return;
    }
    const current = this.options.admission.get(entry.attachmentId)!;
    if (
      (await this.#sendBrowser(entry.workbenchConnectionId, {
        type: 'desktop.relay.prepared',
        requestId: entry.requestId,
        attachmentId: entry.attachmentId,
        grant: record.grant,
        ticket: record.browserTicket,
        openExpiresAt: current.openExpiresAt,
        expiresAt: current.expiresAt
      })) !== 'delivered'
    )
      this.#closeEntries(
        [this.options.admission.beginClose(entry.attachmentId)],
        'DESKTOP_CONTROL_UNAVAILABLE'
      );
  }

  async #authorized(entry: Entry): Promise<boolean> {
    try {
      return await bounded(
        Promise.resolve(this.options.authorize(entry.userId, entry.nodeId, entry.mode)),
        AbortSignal.timeout(10_000)
      );
    } catch {
      return false;
    }
  }
  #current(id: string, record: Record): boolean {
    const entry = this.options.admission.get(id);
    return (
      !this.#closed && this.#records.get(id) === record && !!entry && entry.phase !== 'CLOSING'
    );
  }
  #samePage(a: DirectTransferBrowserIdentity, b: DirectTransferBrowserIdentity): boolean {
    return (
      a.userId === b.userId &&
      a.sessionHash === b.sessionHash &&
      a.workbenchConnectionId === b.workbenchConnectionId
    );
  }
  #closeEntries(entries: readonly (Entry | undefined)[], code: string): void {
    for (const entry of entries) {
      if (!entry || entry.path !== 'RELAY') continue;
      const record = this.#records.get(entry.attachmentId);
      if (record?.closeCode) continue;
      if (record) record.closeCode = code;
      this.options.pairing.cancel(entry.attachmentId);
      if (entry.dispatched)
        this.#sendNode(entry.nodeId, {
          type: 'desktop.relay.cancel',
          attachmentId: entry.attachmentId,
          code
        });
      else this.#records.delete(entry.attachmentId);
      void this.#sendBrowser(entry.workbenchConnectionId, {
        type: 'desktop.relay.closed',
        attachmentId: entry.attachmentId,
        code
      });
      if (!entry.dispatched)
        void this.#sendBrowser(entry.workbenchConnectionId, {
          type: 'desktop.relay.settled',
          attachmentId: entry.attachmentId,
          code
        });
    }
  }
  #sendNode(nodeId: string, command: RemoteDesktopRelayNodeCommand): boolean {
    try {
      return this.options.sendNode(nodeId, command);
    } catch {
      return false;
    }
  }
  async #sendBrowser(
    connectionId: string,
    message: RemoteDesktopRelayServerMessage
  ): Promise<Delivery> {
    try {
      return await bounded(
        this.options.sendBrowser(connectionId, message),
        AbortSignal.timeout(10_000)
      );
    } catch {
      return 'unavailable';
    }
  }
  async #error(
    identity: DirectTransferBrowserIdentity,
    requestId: string,
    code: string,
    settled = false
  ): Promise<void> {
    await this.#sendBrowser(identity.workbenchConnectionId, {
      type: 'desktop.relay.error',
      requestId,
      code,
      ...(settled ? { settled: true as const } : {}),
      message: 'The desktop attachment could not be prepared.'
    });
  }
}
