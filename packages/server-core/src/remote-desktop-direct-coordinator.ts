import { randomBytes } from 'node:crypto';
import type {
  RemoteDesktopDirectBrowserMessage,
  RemoteDesktopDirectNodeCommand,
  RemoteDesktopDirectNodeEvent,
  RemoteDesktopDirectServerMessage
} from '@myagentroam/protocol';
import type {
  DirectTransferBrowserIdentity,
  DirectTransferCoordinator
} from './direct-transfer-coordinator.js';
import { RemoteDesktopAdmission } from './remote-desktop-admission.js';
import { NodeRequestError } from './node-request-error.js';

type Prepare = Extract<RemoteDesktopDirectBrowserMessage, { type: 'desktop.direct.prepare' }>;
type Delivery = 'delivered' | 'unavailable' | 'authorization-revoked';
function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Desktop operation expired'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
    if (signal.aborted) abort();
  });
}
interface DirectRecord {
  readonly transportSessionId: string;
  readonly grant: string;
  readonly browserFingerprint: string;
  readonly nodeFingerprint: string;
  closeCode?: string;
}

export interface RemoteDesktopDirectOptions {
  readonly admission: RemoteDesktopAdmission;
  readonly transport: Pick<DirectTransferCoordinator, 'authorizedTransport'>;
  readonly authorize: (
    userId: number,
    nodeId: string,
    mode: 'VIEW' | 'CONTROL'
  ) => boolean | Promise<boolean>;
  /** Checks the current native description and Node capability. */
  readonly preflight: (
    request: Prepare,
    identity: DirectTransferBrowserIdentity,
    signal: AbortSignal
  ) => Promise<unknown>;
  /** false means the command was not submitted to the Node connection. */
  readonly sendNode: (nodeId: string, command: RemoteDesktopDirectNodeCommand) => boolean;
  readonly sendBrowser: (
    connectionId: string,
    message: RemoteDesktopDirectServerMessage
  ) => Promise<Delivery>;
  readonly now?: () => number;
}

/** Owns Direct authorization messages; admission and transport are shared external owners. */
export class RemoteDesktopDirectCoordinator {
  readonly #records = new Map<string, DirectRecord>();
  readonly #nodeEvents = new Map<string, Promise<void>>();
  readonly #nodeEventCounts = new Map<string, number>();
  readonly #now: () => number;
  readonly #timer: NodeJS.Timeout;
  #closed = false;

  constructor(private readonly options: RemoteDesktopDirectOptions) {
    const epoch = Date.now() - performance.now();
    this.#now = options.now ?? (() => Math.floor(epoch + performance.now()));
    this.#timer = setInterval(() => {
      this.#closeEntries(this.options.admission.expire(this.#now(), 'DIRECT'), 'DESKTOP_TIMEOUT');
      for (const entry of this.options.admission.retireExpiredGonePages(this.#now(), 'DIRECT'))
        this.#records.delete(entry.attachmentId);
      for (const entry of this.options.admission.pendingClosures('DIRECT'))
        this.#sendNode(entry.nodeId, {
          type: 'desktop.direct.cancel',
          attachmentId: entry.attachmentId,
          code: this.#records.get(entry.attachmentId)?.closeCode ?? 'DESKTOP_CANCELLED'
        });
    }, 1000);
    this.#timer.unref();
  }

  async handleBrowser(
    identity: DirectTransferBrowserIdentity,
    message: RemoteDesktopDirectBrowserMessage
  ): Promise<void> {
    if (message.type === 'desktop.direct.prepare') return this.#prepare(identity, message);
    const entry = this.options.admission.get(message.attachmentId);
    const record = this.#records.get(message.attachmentId);
    if (!entry || entry.path !== 'DIRECT' || !record || !this.#samePage(entry, identity)) return;
    if (message.type === 'desktop.direct.cancel') {
      this.#closeEntries(
        [this.options.admission.beginClose(entry.attachmentId)],
        'DESKTOP_CANCELLED'
      );
      return;
    }
    if (!(await this.#authorized(entry, record)) || !this.#current(entry.attachmentId, record)) {
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
        type: 'desktop.direct.heartbeat',
        attachmentId: entry.attachmentId,
        expiresAt: current.expiresAt
      })
    ) {
      this.#closeEntries([this.options.admission.beginClose(entry.attachmentId)], 'NODE_OFFLINE');
      return;
    }
    const delivered = await this.#sendBrowser(entry.workbenchConnectionId, {
      type: 'desktop.direct.heartbeat',
      attachmentId: entry.attachmentId,
      expiresAt: current.expiresAt
    });
    if (delivered !== 'delivered')
      this.#closeEntries(
        [this.options.admission.beginClose(entry.attachmentId)],
        'DESKTOP_CONTROL_UNAVAILABLE'
      );
  }

  onNodeEvent(
    nodeId: string,
    nodeGeneration: string,
    event: RemoteDesktopDirectNodeEvent
  ): Promise<void> {
    if (event.nodeGeneration !== nodeGeneration) return Promise.resolve();
    if (event.type === 'desktop.direct.closed')
      return this.#handleNodeEvent(nodeId, nodeGeneration, event);
    const entry = this.options.admission.get(event.attachmentId);
    if (
      !entry ||
      entry.path !== 'DIRECT' ||
      !this.#records.has(event.attachmentId) ||
      entry.nodeId !== nodeId ||
      entry.nodeGeneration !== nodeGeneration
    )
      return Promise.resolve();
    const count = this.#nodeEventCounts.get(event.attachmentId) ?? 0;
    if (count >= 4) {
      this.#closeEntries(
        [this.options.admission.beginClose(event.attachmentId)],
        'DESKTOP_PROTOCOL_ERROR'
      );
      return Promise.resolve();
    }
    this.#nodeEventCounts.set(event.attachmentId, count + 1);
    const previous = this.#nodeEvents.get(event.attachmentId) ?? Promise.resolve();
    const pending = previous.then(() => this.#handleNodeEvent(nodeId, nodeGeneration, event));
    this.#nodeEvents.set(event.attachmentId, pending);
    const release = () => {
      const remaining = (this.#nodeEventCounts.get(event.attachmentId) ?? 1) - 1;
      if (remaining) this.#nodeEventCounts.set(event.attachmentId, remaining);
      else this.#nodeEventCounts.delete(event.attachmentId);
      if (this.#nodeEvents.get(event.attachmentId) === pending)
        this.#nodeEvents.delete(event.attachmentId);
    };
    void pending.then(release, release);
    return pending;
  }

  async #handleNodeEvent(
    nodeId: string,
    nodeGeneration: string,
    event: RemoteDesktopDirectNodeEvent
  ): Promise<void> {
    const entry = this.options.admission.get(event.attachmentId);
    const record = this.#records.get(event.attachmentId);
    if (!entry || !record || entry.nodeId !== nodeId || entry.nodeGeneration !== nodeGeneration)
      return;
    if (event.type === 'desktop.direct.closed') {
      this.options.admission.beginClose(entry.attachmentId);
      if (this.options.admission.settled(entry.attachmentId, nodeId, nodeGeneration)) {
        this.#records.delete(entry.attachmentId);
        void this.#error(entry, entry.requestId, event.code, true);
        if (entry.phase !== 'CLOSING')
          await this.#sendBrowser(entry.workbenchConnectionId, {
            type: 'desktop.direct.closed',
            attachmentId: entry.attachmentId,
            code: event.code
          });
        void this.#sendBrowser(entry.workbenchConnectionId, {
          type: 'desktop.direct.settled',
          attachmentId: entry.attachmentId,
          code: event.code
        });
      }
      return;
    }
    if (!(await this.#authorized(entry, record)) || !this.#current(entry.attachmentId, record)) {
      this.#closeEntries(
        [this.options.admission.beginClose(entry.attachmentId)],
        'DESKTOP_NOT_AUTHORIZED'
      );
      return;
    }
    const now = this.#now();
    if (event.phase === 'OPEN') {
      if (!this.options.admission.open(entry.attachmentId, nodeId, nodeGeneration, now))
        this.#closeEntries(
          [this.options.admission.beginClose(entry.attachmentId)],
          'DESKTOP_PROTOCOL_ERROR'
        );
      return;
    }
    if (event.phase === 'ATTACHED') {
      if (!this.options.admission.attached(entry.attachmentId, nodeId, nodeGeneration, now))
        this.#closeEntries(
          [this.options.admission.beginClose(entry.attachmentId)],
          'DESKTOP_PROTOCOL_ERROR'
        );
      return;
    }
    if (event.phase === 'ACTIVE') {
      if (!this.options.admission.active(entry.attachmentId, nodeId, nodeGeneration, now))
        this.#closeEntries(
          [this.options.admission.beginClose(entry.attachmentId)],
          'DESKTOP_PROTOCOL_ERROR'
        );
      return;
    }
    if (!this.options.admission.prepared(entry.attachmentId, nodeId, nodeGeneration, now)) {
      this.#closeEntries(
        [this.options.admission.beginClose(entry.attachmentId)],
        'DESKTOP_PROTOCOL_ERROR'
      );
      return;
    }
    const current = this.options.admission.get(entry.attachmentId)!;
    const delivered = await this.#sendBrowser(entry.workbenchConnectionId, {
      type: 'desktop.direct.prepared',
      requestId: entry.requestId,
      attachmentId: entry.attachmentId,
      grant: record.grant,
      openExpiresAt: current.openExpiresAt,
      expiresAt: current.expiresAt
    });
    if (delivered !== 'delivered')
      this.#closeEntries(
        [this.options.admission.beginClose(entry.attachmentId)],
        'DESKTOP_CONTROL_UNAVAILABLE'
      );
  }

  revokeConnection(id: string, code = 'DESKTOP_NOT_AUTHORIZED'): void {
    this.#closeEntries(this.options.admission.closeForConnection(id, 'DIRECT'), code);
  }
  revokeSession(id: string): void {
    this.#closeEntries(
      this.options.admission.closeForSession(id, 'DIRECT'),
      'DESKTOP_NOT_AUTHORIZED'
    );
  }
  revokeUser(id: number): void {
    this.#closeEntries(this.options.admission.closeForUser(id, 'DIRECT'), 'DESKTOP_NOT_AUTHORIZED');
  }
  revokeNode(id: string, code = 'NODE_OFFLINE'): void {
    this.#closeEntries(this.options.admission.closeForNode(id, 'DIRECT'), code);
  }

  retireOtherGenerations(nodeId: string, currentGeneration: string): void {
    for (const entry of this.options.admission.retireOtherGenerations(
      nodeId,
      currentGeneration,
      'DIRECT'
    )) {
      this.#records.delete(entry.attachmentId);
      if (entry.phase !== 'CLOSING')
        void this.#sendBrowser(entry.workbenchConnectionId, {
          type: 'desktop.direct.closed',
          attachmentId: entry.attachmentId,
          code: 'NODE_CONNECTION_REPLACED'
        });
    }
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    this.#closeEntries(this.options.admission.closeAll('DIRECT'), 'DESKTOP_SERVER_SHUTDOWN');
  }

  async #prepare(identity: DirectTransferBrowserIdentity, request: Prepare): Promise<void> {
    const transport = () => {
      try {
        return this.options.transport.authorizedTransport(
          identity,
          request.transportSessionId,
          request.nodeId,
          request.nodeGeneration
        );
      } catch {
        return undefined;
      }
    };
    if (this.#closed || !transport()) {
      await this.#error(identity, request.requestId, 'DESKTOP_CONTROL_UNAVAILABLE', true);
      return;
    }
    const attachmentId = randomBytes(24).toString('base64url');
    const grant = randomBytes(32).toString('base64url');
    const now = this.#now();
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
        path: 'DIRECT'
      },
      now
    );
    if (!entry) {
      await this.#error(identity, request.requestId, 'DESKTOP_CONTROL_UNAVAILABLE', true);
      return;
    }
    const deadline = AbortSignal.timeout(15_000);
    let failureCode = 'DESKTOP_CONTROL_UNAVAILABLE';
    try {
      if (
        !(await untilAbort(
          Promise.resolve(this.options.authorize(identity.userId, request.nodeId, request.mode)),
          deadline
        ))
      ) {
        failureCode = 'DESKTOP_NOT_AUTHORIZED';
        throw new Error();
      }
      await untilAbort(this.options.preflight(request, identity, deadline), deadline);
      if (
        !(await untilAbort(
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
      await this.#error(identity, request.requestId, failureCode, true);
      return;
    }
    const current = transport();
    // Admission revocation removes only matching pending reservations before dispatch.
    if (this.#closed || !current || !this.options.admission.dispatched(attachmentId, this.#now())) {
      this.options.admission.beginClose(attachmentId);
      await this.#error(identity, request.requestId, 'DESKTOP_CONTROL_UNAVAILABLE', true);
      return;
    }
    this.#records.set(attachmentId, {
      transportSessionId: request.transportSessionId,
      grant,
      ...current
    });
    const command: RemoteDesktopDirectNodeCommand = {
      type: 'desktop.direct.prepare',
      attachmentId,
      transportSessionId: request.transportSessionId,
      workbenchConnectionId: entry.workbenchConnectionId,
      nodeGeneration: entry.nodeGeneration,
      desktopGeneration: entry.desktopGeneration,
      topologyRevision: entry.topologyRevision,
      mode: entry.mode,
      grant,
      browserFingerprint: current.browserFingerprint,
      nodeFingerprint: current.nodeFingerprint,
      openExpiresAt: entry.openExpiresAt,
      expiresAt: entry.expiresAt
    };
    let sent: boolean;
    try {
      sent = this.options.sendNode(entry.nodeId, command);
    } catch {
      // Submission is ambiguous: fence and retain the record until Node confirms cleanup.
      this.#closeEntries([this.options.admission.beginClose(attachmentId)], 'NODE_OFFLINE');
      await this.#error(identity, request.requestId, 'NODE_OFFLINE');
      return;
    }
    if (!sent) {
      const notSubmitted = this.options.admission.notSubmitted(attachmentId);
      if (notSubmitted) this.#records.delete(attachmentId);
      else this.#closeEntries([this.options.admission.beginClose(attachmentId)], 'NODE_OFFLINE');
      await this.#error(identity, request.requestId, 'NODE_OFFLINE', notSubmitted);
      return;
    }
  }

  async #authorized(
    entry: NonNullable<ReturnType<RemoteDesktopAdmission['get']>>,
    record: DirectRecord
  ): Promise<boolean> {
    try {
      const transportMatches = () => {
        const current = this.options.transport.authorizedTransport(
          entry,
          record.transportSessionId,
          entry.nodeId,
          entry.nodeGeneration
        );
        return (
          current?.browserFingerprint === record.browserFingerprint &&
          current.nodeFingerprint === record.nodeFingerprint
        );
      };
      return (
        transportMatches() &&
        (await untilAbort(
          Promise.resolve(this.options.authorize(entry.userId, entry.nodeId, entry.mode)),
          AbortSignal.timeout(10_000)
        )) &&
        transportMatches()
      );
    } catch {
      return false;
    }
  }
  #current(id: string, record: DirectRecord): boolean {
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
  #closeEntries(
    entries: readonly ReturnType<RemoteDesktopAdmission['beginClose']>[],
    code: string
  ): void {
    for (const entry of entries) {
      if (!entry || entry.path !== 'DIRECT') continue;
      const record = this.#records.get(entry.attachmentId);
      if (record) record.closeCode = code;
      if (entry.dispatched)
        this.#sendNode(entry.nodeId, {
          type: 'desktop.direct.cancel',
          attachmentId: entry.attachmentId,
          code
        });
      else this.#records.delete(entry.attachmentId);
      void this.#sendBrowser(entry.workbenchConnectionId, {
        type: 'desktop.direct.closed',
        attachmentId: entry.attachmentId,
        code
      });
      if (!entry.dispatched)
        void this.#sendBrowser(entry.workbenchConnectionId, {
          type: 'desktop.direct.settled',
          attachmentId: entry.attachmentId,
          code
        });
    }
  }
  #sendNode(nodeId: string, command: RemoteDesktopDirectNodeCommand): boolean {
    try {
      return this.options.sendNode(nodeId, command);
    } catch {
      return false;
    }
  }
  async #sendBrowser(
    connectionId: string,
    message: RemoteDesktopDirectServerMessage
  ): Promise<Delivery> {
    try {
      return await untilAbort(
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
      type: 'desktop.direct.error',
      requestId,
      code,
      ...(settled ? { settled: true as const } : {}),
      message: 'The desktop attachment could not be prepared.'
    });
  }
}
