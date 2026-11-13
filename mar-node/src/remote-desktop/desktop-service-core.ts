import { timingSafeEqual } from 'node:crypto';
import type WebSocket from 'ws';
import {
  remoteDesktopDirectNodeCommandSchema,
  remoteDesktopRelayNodeCommandSchema,
  remoteDesktopDirectOpenFrameSchema,
  type RemoteDesktopDirectNodeCommand,
  type RemoteDesktopDirectNodeEvent,
  type RemoteDesktopRelayNodeCommand,
  type RemoteDesktopRelayNodeEvent
} from '@myagentroam/protocol';
import { RemoteDesktopError } from './desktop-error.js';
import { DesktopByteStream } from './desktop-byte-stream.js';

export type DesktopPrepare = Extract<
  RemoteDesktopDirectNodeCommand | RemoteDesktopRelayNodeCommand,
  { type: 'desktop.direct.prepare' | 'desktop.relay.prepare' }
>;
export interface DesktopAttachment {
  open(signal: AbortSignal): Promise<void>;
  close(signal: AbortSignal): Promise<void>;
}
type LocalEvent =
  | {
      type: 'desktop.direct.ready';
      attachmentId: string;
      phase: 'PREPARED' | 'OPEN' | 'ATTACHED' | 'ACTIVE';
    }
  | { type: 'desktop.direct.closed'; attachmentId: string; code: string };
interface Entry {
  readonly command: DesktopPrepare;
  readonly channel: RTCDataChannel | WebSocket;
  readonly transport: DesktopTransport;
  readonly deadline: AbortController;
  readonly openExpiresAt: number;
  state: 'PREPARED' | 'OPEN' | 'ATTACHED' | 'ACTIVE' | 'CLOSING' | 'SETTLED';
  expiresAt: number;
  setupExpiresAt?: number;
  stream?: DesktopByteStream;
  attachment?: DesktopAttachment;
  cleanup?: Promise<void>;
  ready: boolean;
  initialized: boolean;
  closeCode: string;
}

export interface DesktopTransport {
  readonly channel: RTCDataChannel | WebSocket;
  readonly valid: () => boolean;
  readonly maxMessageBytes: () => number;
  /** Relay sends its authenticated first frame on open before PREPARED. */
  readonly start?: () => void;
}
/** Owns per-Node attachment identities and takeover across Direct and relay. */
export class DesktopAttachmentRegistry {
  readonly #ids = new Set<string>();
  readonly #opened = new Map<string, () => void>();
  has(id: string): boolean {
    return this.#ids.has(id);
  }
  reserve(id: string): boolean {
    if (this.#ids.has(id)) return false;
    this.#ids.add(id);
    return true;
  }
  release(id: string): void {
    this.#ids.delete(id);
    this.#opened.delete(id);
  }
  /** A validated OPEN replaces only already-open attachments, not pending requests. */
  opened(id: string, replace: () => void): void {
    const previous = [...this.#opened.values()];
    this.#opened.clear();
    this.#opened.set(id, replace);
    for (const close of previous) close();
  }
}
export interface DesktopServiceOptions {
  readonly path: 'direct' | 'relay';
  readonly registry?: DesktopAttachmentRegistry;
  readonly nodeGeneration: () => string;
  readonly transport: (command: DesktopPrepare) => DesktopTransport | undefined;
  readonly isCurrent: (command: DesktopPrepare) => boolean;
  readonly createAttachment: (
    command: DesktopPrepare,
    stream: DesktopByteStream,
    callbacks: { readonly attached: () => void; readonly failed: (code: string) => void }
  ) => DesktopAttachment;
  readonly emit: (event: RemoteDesktopDirectNodeEvent | RemoteDesktopRelayNodeEvent) => boolean;
  readonly now?: () => number;
}

/** Owns attachment channels, deadlines and cleanup for either path; never owns the shared backend. */
export class DesktopServiceCore {
  readonly #entries = new Map<string, Entry>();
  readonly #registry: DesktopAttachmentRegistry;
  readonly #now: () => number;
  readonly #timer: NodeJS.Timeout;
  readonly #cleanupWaiters = new Set<() => void>();
  #disposed = false;
  #suspended = false;

  constructor(private readonly options: DesktopServiceOptions) {
    this.#registry = options.registry ?? new DesktopAttachmentRegistry();
    const epoch = Date.now() - performance.now();
    this.#now = options.now ?? (() => Math.floor(epoch + performance.now()));
    this.#timer = setInterval(() => this.#sweep(), 1_000);
    this.#timer.unref();
  }

  handle(raw: unknown): boolean {
    const parsed = (
      this.options.path === 'direct'
        ? remoteDesktopDirectNodeCommandSchema
        : remoteDesktopRelayNodeCommandSchema
    ).safeParse(raw);
    if (!parsed.success) return false;
    const command = parsed.data;
    if (command.type === 'desktop.direct.prepare' || command.type === 'desktop.relay.prepare') {
      this.#prepare(command);
      return true;
    }
    const entry = this.#entries.get(command.attachmentId);
    if (!entry) {
      // A shared ready event must reach the path that actually owns the attachment.
      if (command.type === 'desktop.ready') return false;
      // Never claim another path's live attachment has already been cleaned up.
      if (this.#registry.has(command.attachmentId)) return true;
      if (command.type === 'desktop.direct.cancel' || command.type === 'desktop.relay.cancel')
        this.#emit({
          type: 'desktop.direct.closed',
          attachmentId: command.attachmentId,
          code: command.code
        });
      return true;
    }
    if (command.type === 'desktop.direct.cancel' || command.type === 'desktop.relay.cancel') {
      this.#close(entry, command.code);
    } else if (
      command.type === 'desktop.direct.heartbeat' ||
      command.type === 'desktop.relay.heartbeat'
    ) {
      if (!this.#valid(entry) || command.expiresAt <= this.#now())
        this.#close(entry, 'DESKTOP_LEASE_EXPIRED');
      else entry.expiresAt = Math.min(command.expiresAt, this.#now() + 30_000);
    } else if (entry.state === 'OPEN' || entry.state === 'ATTACHED') {
      entry.ready = true;
      this.#activate(entry);
    }
    return true;
  }

  /** Called synchronously on topology, security session or notification-source invalidation. */
  invalidate(code: string): void {
    for (const entry of this.#entries.values()) this.#close(entry, code);
  }

  removeTransport(transportSessionId: string): void {
    for (const entry of this.#entries.values())
      if (
        'transportSessionId' in entry.command &&
        entry.command.transportSessionId === transportSessionId
      )
        this.#close(entry, 'DESKTOP_TRANSPORT_ERROR');
  }

  dispose(): void {
    this.#disposed = true;
    this.invalidate('DESKTOP_SERVER_SHUTDOWN');
    if (this.#entries.size === 0) clearInterval(this.#timer);
  }

  /** Fence synchronously and wait for native cleanup, not delivery of the closed event. */
  shutdown(signal: AbortSignal): Promise<void> {
    this.dispose();
    return this.#waitForCleanup(signal);
  }

  /** Disable Remote admission without disposing the borrowed transport or its retry owner. */
  suspend(signal: AbortSignal): Promise<void> {
    this.#suspended = true;
    this.invalidate('DESKTOP_UNAVAILABLE');
    return this.#waitForCleanup(signal);
  }

  /** A failed or incomplete native cleanup must keep admission fenced. */
  canResume(): boolean {
    return (
      !this.#disposed && [...this.#entries.values()].every((entry) => entry.state === 'SETTLED')
    );
  }

  resume(): boolean {
    if (!this.canResume()) return false;
    this.#suspended = false;
    return true;
  }

  #waitForCleanup(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (): void => {
        if ([...this.#entries.values()].some((entry) => entry.state !== 'SETTLED')) {
          if (!signal.aborted) return;
          cleanup();
          reject(new RemoteDesktopError('DESKTOP_NATIVE_CLEANUP_TIMEOUT'));
          return;
        }
        cleanup();
        resolve();
      };
      const cleanup = (): void => {
        this.#cleanupWaiters.delete(finish);
        signal.removeEventListener('abort', finish);
      };
      this.#cleanupWaiters.add(finish);
      signal.addEventListener('abort', finish, { once: true });
      finish();
    });
  }

  #prepare(command: DesktopPrepare): void {
    const existing = this.#entries.get(command.attachmentId);
    if (existing) return this.#close(existing, 'DESKTOP_RFB_INVALID');
    // Another path owns this ID; it alone may confirm its cleanup.
    if (this.#registry.has(command.attachmentId)) return;
    if (
      this.#disposed ||
      this.#suspended ||
      !this.#current(command) ||
      command.openExpiresAt <= this.#now() ||
      command.expiresAt <= this.#now() ||
      !this.#registry.reserve(command.attachmentId)
    ) {
      this.#emit({
        type: 'desktop.direct.closed',
        attachmentId: command.attachmentId,
        code: 'DESKTOP_CONTROL_UNAVAILABLE'
      });
      return;
    }
    let transport: DesktopTransport | undefined;
    try {
      transport = this.options.transport(command);
    } catch {
      this.#registry.release(command.attachmentId);
      this.#emit({
        type: 'desktop.direct.closed',
        attachmentId: command.attachmentId,
        code: 'DESKTOP_TRANSPORT_ERROR'
      });
      return;
    }
    if (!transport) {
      this.#registry.release(command.attachmentId);
      this.#emit({
        type: 'desktop.direct.closed',
        attachmentId: command.attachmentId,
        code: 'DESKTOP_CONTROL_UNAVAILABLE'
      });
      return;
    }
    const channel = transport.channel;
    const entry: Entry = {
      command,
      channel,
      transport,
      deadline: new AbortController(),
      openExpiresAt: Math.min(command.openExpiresAt, this.#now() + 15_000),
      state: 'PREPARED',
      expiresAt: Math.min(command.expiresAt, this.#now() + 30_000),
      ready: false,
      initialized: false,
      closeCode: 'DESKTOP_TRANSPORT_ERROR'
    };
    this.#entries.set(command.attachmentId, entry);
    channel.onmessage = (event: { readonly data: unknown }) => this.#open(entry, event.data);
    channel.onclose = () => this.#close(entry, 'DESKTOP_TRANSPORT_ERROR');
    channel.onerror = () => this.#close(entry, 'DESKTOP_TRANSPORT_ERROR');
    const prepared = () => {
      if (!this.#valid(entry)) return this.#close(entry, 'DESKTOP_TRANSPORT_ERROR');
      try {
        transport.start?.();
      } catch {
        return this.#close(entry, 'DESKTOP_TRANSPORT_ERROR');
      }
      if (
        !this.#emit({
          type: 'desktop.direct.ready',
          attachmentId: command.attachmentId,
          phase: 'PREPARED'
        })
      )
        this.#close(entry, 'DESKTOP_TRANSPORT_ERROR');
    };
    if (transport.start && channel.readyState !== 'open' && channel.readyState !== 1)
      channel.onopen = prepared;
    else prepared();
  }

  #open(entry: Entry, data: unknown): void {
    if (
      entry.state !== 'PREPARED' ||
      (entry.channel.readyState !== 'open' && entry.channel.readyState !== 1) ||
      !this.#valid(entry) ||
      typeof data !== 'string' ||
      data.length > 8192
    )
      return this.#close(entry, 'DESKTOP_RFB_INVALID');
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      return this.#close(entry, 'DESKTOP_RFB_INVALID');
    }
    const parsed = remoteDesktopDirectOpenFrameSchema.safeParse(frame);
    const expected = Buffer.from(entry.command.grant);
    const received = parsed.success ? Buffer.from(parsed.data.grant) : Buffer.alloc(0);
    if (
      !parsed.success ||
      parsed.data.attachmentId !== entry.command.attachmentId ||
      expected.length !== received.length ||
      !timingSafeEqual(expected, received)
    )
      return this.#close(entry, 'DESKTOP_NOT_AUTHORIZED');
    entry.state = 'OPEN';
    entry.setupExpiresAt = this.#now() + 15_000;
    if (
      !this.#emit({
        type: 'desktop.direct.ready',
        attachmentId: entry.command.attachmentId,
        phase: 'OPEN'
      })
    )
      return this.#close(entry, 'DESKTOP_TRANSPORT_ERROR');
    try {
      this.#registry.opened(entry.command.attachmentId, () =>
        this.#close(entry, 'DESKTOP_CONNECTION_REPLACED')
      );
      entry.stream = new DesktopByteStream(entry.channel, entry.transport.maxMessageBytes());
      entry.attachment = this.options.createAttachment(entry.command, entry.stream, {
        attached: () => {
          if (!this.#valid(entry)) throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
          entry.channel.send(
            JSON.stringify({ type: 'ATTACHED', attachmentId: entry.command.attachmentId })
          );
          entry.state = 'ATTACHED';
          if (
            !this.#emit({
              type: 'desktop.direct.ready',
              attachmentId: entry.command.attachmentId,
              phase: 'ATTACHED'
            })
          )
            throw new RemoteDesktopError('DESKTOP_TRANSPORT_ERROR');
        },
        failed: (code) => this.#close(entry, code)
      });
      void entry.attachment.open(entry.deadline.signal).then(
        () => {
          entry.initialized = true;
          this.#activate(entry);
        },
        (error: unknown) =>
          this.#close(
            entry,
            error instanceof RemoteDesktopError ? error.code : 'DESKTOP_TRANSPORT_ERROR'
          )
      );
    } catch (error) {
      this.#close(
        entry,
        error instanceof RemoteDesktopError ? error.code : 'DESKTOP_TRANSPORT_ERROR'
      );
    }
  }

  #activate(entry: Entry): void {
    if (!entry.ready || !entry.initialized || entry.state !== 'ATTACHED') return;
    if (!this.#valid(entry)) return this.#close(entry, 'DESKTOP_TOPOLOGY_UNAVAILABLE');
    entry.state = 'ACTIVE';
    if (
      !this.#emit({
        type: 'desktop.direct.ready',
        attachmentId: entry.command.attachmentId,
        phase: 'ACTIVE'
      })
    )
      this.#close(entry, 'DESKTOP_TRANSPORT_ERROR');
  }

  #valid(entry: Entry): boolean {
    if (
      this.#disposed ||
      entry.state === 'CLOSING' ||
      entry.state === 'SETTLED' ||
      entry.expiresAt <= this.#now() ||
      (entry.state === 'PREPARED' && entry.openExpiresAt <= this.#now()) ||
      ((entry.state === 'OPEN' || entry.state === 'ATTACHED') &&
        entry.setupExpiresAt! <= this.#now()) ||
      !this.#current(entry.command)
    )
      return false;
    try {
      return entry.transport.valid();
    } catch {
      return false;
    }
  }

  #current(command: DesktopPrepare): boolean {
    try {
      return this.options.isCurrent(command);
    } catch {
      return false;
    }
  }

  #close(entry: Entry, code: string): void {
    if (entry.state === 'SETTLED') return this.#announceClosed(entry);
    if (entry.state !== 'CLOSING') {
      entry.state = 'CLOSING';
      entry.closeCode = code;
      entry.deadline.abort();
      if (!entry.attachment && entry.stream) entry.stream.destroy();
      else if (!entry.attachment) {
        entry.channel.onmessage = null;
        entry.channel.onopen = null;
        entry.channel.onclose = null;
        entry.channel.onerror = null;
        try {
          if ('terminate' in entry.channel) entry.channel.terminate();
          else entry.channel.close();
        } catch {
          /* already closed */
        }
      }
    }
    if (entry.cleanup) return;
    const cleanup = entry.attachment?.close(AbortSignal.timeout(5_000)) ?? Promise.resolve();
    entry.cleanup = cleanup
      .then(
        () => {
          entry.state = 'SETTLED';
          this.#announceClosed(entry);
          for (const notify of this.#cleanupWaiters) notify();
        },
        () => {}
      )
      .finally(() => {
        delete entry.cleanup;
      });
  }

  #announceClosed(entry: Entry): void {
    if (
      this.#emit({
        type: 'desktop.direct.closed',
        attachmentId: entry.command.attachmentId,
        code: entry.closeCode
      })
    ) {
      this.#entries.delete(entry.command.attachmentId);
      this.#registry.release(entry.command.attachmentId);
      if (this.#disposed && this.#entries.size === 0) clearInterval(this.#timer);
    }
  }

  #sweep(): void {
    for (const entry of this.#entries.values()) {
      if (entry.state === 'CLOSING' || entry.state === 'SETTLED')
        this.#close(entry, entry.closeCode);
      else if (!this.#valid(entry)) this.#close(entry, 'DESKTOP_LEASE_EXPIRED');
    }
  }

  #emit(event: LocalEvent): boolean {
    try {
      const type = event.type.replace('desktop.direct.', `desktop.${this.options.path}.`);
      return this.options.emit({ ...event, type, nodeGeneration: this.options.nodeGeneration() } as
        RemoteDesktopDirectNodeEvent | RemoteDesktopRelayNodeEvent);
    } catch {
      return false;
    }
  }
}
