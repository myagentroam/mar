import type { RemoteDesktopDirectNodeCommand } from '@myagentroam/protocol';
import { randomUUID } from 'node:crypto';
import { RemoteDesktopError } from './desktop-error.js';
import type { DirectDesktopOptions } from './direct-desktop-service.js';
import { PooledDesktopAttachment } from './pooled-desktop-attachment.js';
import { RemoteDesktopAttachment } from './remote-desktop-attachment.js';
import { TigerVncBackendPool } from './tigervnc-backend-pool.js';
import { TigerVncManagedProcess } from './tigervnc-managed-process.js';
import { X11DesktopTopology } from './x11-desktop-topology.js';
import type { X11DesktopLayout } from './x11-topology.js';

type Prepare = Extract<RemoteDesktopDirectNodeCommand, { type: 'desktop.direct.prepare' }>;
/** The backend needs no transport-specific identity, ticket or fingerprint. */
export type DesktopAttachmentBinding = Pick<
  Prepare,
  'attachmentId' | 'desktopGeneration' | 'topologyRevision' | 'mode'
>;
interface RuntimeOptions {
  readonly binaryPath: string;
  readonly display: string;
  readonly xAuthority: string;
  readonly fence: (code: string) => void;
  readonly maxPixels: number;
}

/** Composes one X11 desktop and its Remote-only backend. */
export class X11RemoteDesktopRuntime {
  readonly #pool: TigerVncBackendPool;
  #topology: X11DesktopTopology | undefined;
  #disposed = false;

  private constructor(private readonly options: RuntimeOptions) {
    this.#pool = new TigerVncBackendPool(
      (signal, onUnexpectedExit) =>
        TigerVncManagedProcess.start(
          {
            binaryPath: options.binaryPath,
            display: options.display,
            xAuthority: options.xAuthority,
            onUnexpectedExit
          },
          signal
        ),
      () => options.fence('DESKTOP_BACKEND_CLOSED')
    );
  }

  static async start(
    options: RuntimeOptions & { readonly topologyBinary: string },
    signal: AbortSignal
  ): Promise<X11RemoteDesktopRuntime> {
    if (!Number.isSafeInteger(options.maxPixels) || options.maxPixels < 1)
      throw new RemoteDesktopError('DESKTOP_BACKEND_CONFIG_INVALID');
    const runtime = new X11RemoteDesktopRuntime(options);
    try {
      runtime.#topology = await X11DesktopTopology.start(
        {
          generation: randomUUID(),
          binaryPath: options.topologyBinary,
          display: options.display,
          xAuthority: options.xAuthority,
          fence: () => options.fence('DESKTOP_TOPOLOGY_UNAVAILABLE')
        },
        signal
      );
      return runtime;
    } catch (error) {
      await runtime.dispose();
      throw error;
    }
  }

  describe(): X11DesktopLayout {
    if (this.#disposed || !this.#topology)
      throw new RemoteDesktopError('DESKTOP_BACKEND_CLOSED');
    return this.#topology.describe();
  }

  readonly isCurrent = (command: DesktopAttachmentBinding): boolean => {
    try {
      const layout = this.describe();
      return (
        this.#pool.isAvailable() &&
        layout.desktopGeneration === command.desktopGeneration &&
        layout.topologyRevision === command.topologyRevision
      );
    } catch {
      return false;
    }
  };

  readonly createAttachment = (
    command: DesktopAttachmentBinding,
    frontend: Parameters<DirectDesktopOptions['createAttachment']>[1],
    callbacks: Parameters<DirectDesktopOptions['createAttachment']>[2]
  ) =>
    new PooledDesktopAttachment(
      this.#pool,
      frontend,
      (backend) =>
        new RemoteDesktopAttachment({
          attachmentId: command.attachmentId,
          frontend,
          backend,
          mode: command.mode,
          maxPixels: this.options.maxPixels,
          isCurrentTopology: (width, height) => this.#matches(command, width, height),
          onAttached: callbacks.attached,
          onFailure: callbacks.failed
        })
    );

  async dispose(): Promise<void> {
    let failure: unknown;
    if (!this.#disposed) {
      this.#disposed = true;
      try {
        this.options.fence('DESKTOP_SESSION_UNAVAILABLE');
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      await this.#topology?.stop();
    } catch (error) {
      failure ??= error;
    }
    try {
      await this.#pool.dispose();
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw failure;
  }

  #matches(command: DesktopAttachmentBinding, width: number, height: number): boolean {
    if (!this.isCurrent(command) || !this.#topology) return false;
    return this.#topology.matches(
      command.desktopGeneration,
      this.#topology.describe().topologyRevision,
      width,
      height
    );
  }
}
