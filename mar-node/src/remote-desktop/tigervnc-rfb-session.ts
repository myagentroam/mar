import type { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { RemoteDesktopError, type DesktopErrorCode } from './desktop-error.js';
import { handshakeRfbFrontend } from './rfb-frontend-handshake.js';
import { RfbClientGate } from './rfb-client-gate.js';
import { StandardRfbAttachment } from './standard-rfb-attachment.js';
import type { TigerVncManagedProcess } from './tigervnc-managed-process.js';

export interface TigerVncRfbSessionOptions {
  readonly frontend: Duplex;
  readonly backend: Pick<TigerVncManagedProcess, 'connect'> &
    Partial<Pick<TigerVncManagedProcess, 'cleanup'>>;
  readonly mode: 'VIEW' | 'CONTROL';
  readonly maxPixels: number;
  readonly isCurrentTopology: (width: number, height: number) => boolean;
  readonly isControlOwner: () => boolean;
  /** Enqueue the authorized ATTACHED envelope before starting the frontend RFB handshake. */
  readonly onAttached: () => void;
  /** Notification only; the attachment owner closes its connection and releases the backend. */
  readonly onFailure: (code: DesktopErrorCode) => void;
}

/** Keeps failed setup cleanup retryable without releasing the caller's lease. */
export class TigerVncSetupCleanupError extends RemoteDesktopError {
  constructor(
    code: DesktopErrorCode,
    private readonly attachment: StandardRfbAttachment
  ) {
    super(code);
    this.name = 'TigerVncSetupCleanupError';
  }

  retryCleanup(signal: AbortSignal): Promise<void> {
    return this.attachment.close(signal);
  }
}

/** Owns one authorized RFB stream pair, never a desktop lease. */
export class TigerVncRfbSession {
  #closed = false;
  #failed = false;
  #detached = false;
  #closing: Promise<void> | undefined;

  private constructor(
    private readonly options: TigerVncRfbSessionOptions,
    private readonly socket: Socket,
    private readonly gate: RfbClientGate,
    private readonly attachment: StandardRfbAttachment
  ) {}

  /** Called only after the surrounding Server authorization has accepted OPEN. */
  static async open(
    options: TigerVncRfbSessionOptions,
    signal: AbortSignal
  ): Promise<TigerVncRfbSession> {
    const setup = new AbortController();
    const deadline = AbortSignal.any([signal, setup.signal, AbortSignal.timeout(10_000)]);
    const frontendFailed = () => setup.abort();
    options.frontend.pause();
    options.frontend.on('error', frontendFailed);
    options.frontend.once('close', frontendFailed);
    options.frontend.once('end', frontendFailed);
    let attachment: StandardRfbAttachment | undefined;
    let socket: Socket | undefined;
    let gateFailure: DesktopErrorCode | undefined;
    try {
      const connected = await options.backend.connect(options.maxPixels, deadline);
      socket = connected.socket;
      if (!options.isCurrentTopology(connected.init.width, connected.init.height))
        throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
      let session: TigerVncRfbSession | undefined;
      const gate = new RfbClientGate(
        socket,
        options.mode,
        () =>
          options.isCurrentTopology(connected.init.width, connected.init.height) &&
          options.isControlOwner(),
        (code) => {
          if (session) session.#fail(code);
          else {
            gateFailure = code;
            setup.abort();
          }
        }
      );
      attachment = new StandardRfbAttachment(socket, gate);
      if (gateFailure) throw new RemoteDesktopError(gateFailure);
      if (deadline.aborted) throw new RemoteDesktopError('DESKTOP_SETUP_CANCELLED');
      if (!options.isCurrentTopology(connected.init.width, connected.init.height))
        throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
      options.onAttached();
      await handshakeRfbFrontend(options.frontend, connected.init.serverInit, deadline);
      if (gateFailure) throw new RemoteDesktopError(gateFailure);
      if (deadline.aborted) throw new RemoteDesktopError('DESKTOP_SETUP_CANCELLED');
      if (!options.isCurrentTopology(connected.init.width, connected.init.height))
        throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
      session = new TigerVncRfbSession(options, socket, gate, attachment);
      session.#start();
      return session;
    } catch (error) {
      const ignore = () => {};
      if (!options.frontend.closed) {
        options.frontend.on('error', ignore);
        options.frontend.once('close', () => options.frontend.off('error', ignore));
      }
      options.frontend.destroy();
      if (attachment) {
        try {
          await attachment.close(AbortSignal.timeout(5_000));
        } catch (cleanupError) {
          throw new TigerVncSetupCleanupError(
            cleanupError instanceof RemoteDesktopError
              ? cleanupError.code
              : 'DESKTOP_NATIVE_CLEANUP_FAILED',
            attachment
          );
        }
      } else if (socket) {
        if (!socket.closed) {
          socket.on('error', ignore);
          socket.once('close', () => socket?.off('error', ignore));
        }
        socket.destroy();
      }
      if (gateFailure) throw new RemoteDesktopError(gateFailure);
      if (error instanceof RemoteDesktopError) throw error;
      throw new RemoteDesktopError('DESKTOP_TRANSPORT_ERROR');
    } finally {
      options.frontend.off('error', frontendFailed);
      options.frontend.off('close', frontendFailed);
      options.frontend.off('end', frontendFailed);
    }
  }

  /** Synchronously stop frontend input and output before attachment cleanup. */
  fence(): void {
    if (this.#closed || this.#closing) return;
    void this.gate.fence().catch(() => {});
    this.#detach();
  }

  /** Fence input and await this backend's attachment cleanup contract. */
  close(signal: AbortSignal): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#closing) return this.#closing;
    this.fence();
    const pending = this.attachment.close(signal).then(() => {
      this.#closed = true;
    });
    this.#closing = pending.finally(() => {
      this.#closing = undefined;
    });
    return this.#closing;
  }

  #start(): void {
    this.options.frontend.on('data', this.#input);
    this.options.frontend.on('error', this.#transportFailed);
    this.options.frontend.on('end', this.#transportFailed);
    this.options.frontend.on('close', this.#transportFailed);
    this.socket.on('end', this.#transportFailed);
    this.socket.on('close', this.#transportFailed);
    this.socket.pipe(this.options.frontend, { end: false });
    // Handshake explicitly paused this stream; resume only after the gate owns reads.
    this.options.frontend.resume();
  }

  readonly #input = (data: unknown): void => {
    if (!(data instanceof Uint8Array)) this.#fail('DESKTOP_RFB_INVALID');
    else this.gate.receive(data);
  };
  readonly #transportFailed = (): void => this.#fail('DESKTOP_TRANSPORT_ERROR');

  #fail(code: DesktopErrorCode): void {
    if (this.#failed || this.#closed || this.#closing) return;
    this.#failed = true;
    // fence() stops admission synchronously even while its writes are draining.
    void this.gate.fence().catch(() => {});
    this.#detach();
    try {
      this.options.onFailure(code);
    } catch {
      // Resource cleanup cannot depend on a caller callback succeeding.
    }
    void this.close(AbortSignal.timeout(5_000)).catch(() => {});
  }

  #detach(): void {
    if (this.#detached) return;
    this.#detached = true;
    this.options.frontend.pause();
    this.options.frontend.off('data', this.#input);
    this.options.frontend.off('error', this.#transportFailed);
    this.options.frontend.off('end', this.#transportFailed);
    this.options.frontend.off('close', this.#transportFailed);
    this.socket.off('end', this.#transportFailed);
    this.socket.off('close', this.#transportFailed);
    this.socket.unpipe(this.options.frontend);
    // Absorb a late transport error until destroy completes.
    const ignore = () => {};
    if (!this.options.frontend.closed) {
      this.options.frontend.on('error', ignore);
      this.options.frontend.once('close', () => this.options.frontend.off('error', ignore));
    }
    this.options.frontend.destroy();
  }
}
