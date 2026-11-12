import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { remoteDesktopDescriptionSchema } from '@myagentroam/protocol';
import { RemoteDesktopError } from './desktop-error.js';
import type { DirectDesktopOptions } from './direct-desktop-service.js';
import { PooledDesktopAttachment } from './pooled-desktop-attachment.js';
import { RemoteDesktopAttachment } from './remote-desktop-attachment.js';
import { TigerVncBackendPool } from './tigervnc-backend-pool.js';
import { MacVncManagedProcess } from './macvnc-managed-process.js';
import type { DesktopAttachmentBinding } from './x11-remote-desktop-runtime.js';

interface MacScreen {
  readonly id: number;
  readonly primary: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
}

const run = promisify(execFile);

/** Maps native display bounds to macVNC pixels without rounding the display scale. */
export function macosCombinedDesktopLayout(
  screens: readonly MacScreen[],
  generation: string,
  revision: number
) {
  if (screens.length === 0) throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
  const left = Math.min(...screens.map((screen) => screen.x));
  const top = Math.min(...screens.map((screen) => screen.y));
  const right = Math.max(...screens.map((screen) => screen.x + screen.width));
  const bottom = Math.max(...screens.map((screen) => screen.y + screen.height));
  const scaleX = Math.max(...screens.map((screen) => screen.pixelWidth / screen.width));
  const scaleY = Math.max(...screens.map((screen) => screen.pixelHeight / screen.height));
  const result = remoteDesktopDescriptionSchema.safeParse({
    desktopGeneration: generation,
    topologyRevision: revision,
    framebuffer: {
      width: Math.round((right - left) * scaleX),
      height: Math.round((bottom - top) * scaleY)
    },
    displays: screens.map((screen) => ({
      displayId: `display_${screen.id}`,
      name: `Display ${screen.id}`,
      primary: screen.primary,
      nativeBounds: { x: screen.x, y: screen.y, width: screen.width, height: screen.height },
      framebufferBounds: {
        x: Math.round((screen.x - left) * scaleX),
        y: Math.round((screen.y - top) * scaleY),
        width:
          Math.round((screen.x + screen.width - left) * scaleX) -
          Math.round((screen.x - left) * scaleX),
        height:
          Math.round((screen.y + screen.height - top) * scaleY) -
          Math.round((screen.y - top) * scaleY)
      },
      nativeToFramebuffer: [scaleX, 0, 0, scaleY, -left * scaleX || 0, -top * scaleY || 0]
    }))
  });
  if (!result.success) throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
  return result.data;
}

async function queryScreens(binary: string, signal: AbortSignal): Promise<MacScreen[]> {
  const { stdout } = await run(binary, [], { encoding: 'utf8', maxBuffer: 64 * 1024, signal });
  const parsed: unknown = JSON.parse(stdout);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('displays' in parsed) ||
    !Array.isArray(parsed.displays)
  )
    throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
  return parsed.displays as MacScreen[];
}

/** Owns per-display capture identities and backend pools; selecting a display never changes another page. */
export class MacosRemoteDesktopRuntime {
  readonly #pools = new Set<TigerVncBackendPool>();
  #entries = new Map<
    string,
    { layout: ReturnType<typeof macosCombinedDesktopLayout>; pool: TigerVncBackendPool }
  >();
  #screens: MacScreen[] = [];
  #signature = '';
  #revision = 0;
  #disposed = false;
  #topologyAvailable = false;
  #refreshTail: Promise<void> = Promise.resolve();

  private constructor(
    private readonly options: {
      binaryPath: string;
      topologyBinary: string;
      maxPixels: number;
      fence(code: string): void;
    }
  ) {}

  #createPool(displayId: number): TigerVncBackendPool {
    const pool = new TigerVncBackendPool(
      async (signal, onUnexpectedExit) => {
        const signature = this.#signature;
        const screens = await this.#probeTopology(signal);
        if (JSON.stringify(screens) !== this.#signature) this.#invalidateTopology();
        const displayIndex = screens.findIndex((screen) => screen.id === displayId);
        if (
          this.#disposed ||
          !this.#topologyAvailable ||
          displayIndex < 0 ||
          this.#signature !== signature
        )
          throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
        const backend = await MacVncManagedProcess.start(
          { binaryPath: this.options.binaryPath, displayIndex, onUnexpectedExit },
          signal
        );
        // The pool owns cleanup before the post-launch check can fail. A failed stop
        // must retain the backend/reference so its attachment can retry cleanup.
        return {
          stop: () => backend.stop(),
          connect: async (maxPixels, connectSignal) => {
            const current = await this.#probeTopology(connectSignal);
            if (JSON.stringify(current) !== this.#signature) this.#invalidateTopology();
            if (this.#disposed || !this.#topologyAvailable || this.#signature !== signature)
              throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
            return backend.connect(maxPixels, connectSignal);
          }
        };
      },
      () => this.options.fence('DESKTOP_BACKEND_CLOSED')
    );
    this.#pools.add(pool);
    return pool;
  }

  static async start(
    options: {
      binaryPath: string;
      topologyBinary: string;
      maxPixels: number;
      fence(code: string): void;
    },
    signal: AbortSignal
  ) {
    const runtime = new MacosRemoteDesktopRuntime(options);
    await runtime.refresh(signal);
    return runtime;
  }

  refresh(signal: AbortSignal): Promise<void> {
    const result = this.#refreshTail.then(() => this.#refresh(signal));
    this.#refreshTail = result.catch(() => {});
    return result;
  }

  #invalidateTopology(): void {
    const wasAvailable = this.#topologyAvailable;
    this.#topologyAvailable = false;
    if (wasAvailable) this.options.fence('DESKTOP_TOPOLOGY_UNAVAILABLE');
  }

  async #probeTopology(signal: AbortSignal): Promise<MacScreen[]> {
    if (this.#disposed) throw new RemoteDesktopError('DESKTOP_BACKEND_CLOSED');
    try {
      return await queryScreens(this.options.topologyBinary, signal);
    } catch (error) {
      // Closing one page aborts its probe; it is not evidence of desktop loss.
      if (!signal.aborted) this.#invalidateTopology();
      throw error;
    }
  }

  async #refresh(signal: AbortSignal): Promise<void> {
    // Keep native enumeration order: macVNC's -display takes an index, not a display ID.
    const screens = await this.#probeTopology(signal);
    const signature = JSON.stringify(screens);
    if (this.#disposed) throw new RemoteDesktopError('DESKTOP_BACKEND_CLOSED');
    if (signature === this.#signature && this.#topologyAvailable) return;
    // Revoke old captures before validating new geometry. A failed probe/layout
    // must not leave the previous grants current or revive them after recovery.
    this.#invalidateTopology();
    const selectableDisplays = screens.map((screen) => ({
      displayId: `display_${screen.id}`,
      name: `Display ${screen.id}`,
      primary: screen.primary
    }));
    const layouts = screens.map((screen) => {
      const displayId = `display_${screen.id}`;
      const layout = remoteDesktopDescriptionSchema.parse({
        ...macosCombinedDesktopLayout(
          [{ ...screen, primary: true }],
          this.#entries.get(displayId)?.layout.desktopGeneration ?? randomUUID(),
          this.#revision + 1
        ),
        selectableDisplays
      });
      if (layout.framebuffer.width * layout.framebuffer.height > this.options.maxPixels)
        throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
      return { screen, displayId, layout };
    });
    if (!layouts.length) throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
    this.#entries = new Map(
      layouts.map(({ screen, displayId, layout }) => [
        displayId,
        { layout, pool: this.#entries.get(displayId)?.pool ?? this.#createPool(screen.id) }
      ])
    );
    this.#screens = screens;
    this.#signature = signature;
    this.#revision++;
    this.#topologyAvailable = true;
  }

  describe(
    selection: { displayId?: string | undefined; desktopGeneration?: string | undefined } = {}
  ) {
    const entry =
      selection.desktopGeneration !== undefined
        ? [...this.#entries.values()].find(
            (candidate) => candidate.layout.desktopGeneration === selection.desktopGeneration
          )
        : this.#entries.get(
            selection.displayId ?? `display_${this.#screens.find((screen) => screen.primary)?.id}`
          );
    if (this.#disposed) throw new RemoteDesktopError('DESKTOP_BACKEND_CLOSED');
    if (!this.#topologyAvailable) throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
    if (!entry) throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
    if (!entry.pool.isAvailable()) throw new RemoteDesktopError('DESKTOP_BACKEND_CLOSED');
    return structuredClone(entry.layout);
  }

  readonly isCurrent = (command: DesktopAttachmentBinding): boolean =>
    !this.#disposed &&
    this.#topologyAvailable &&
    [...this.#entries.values()].some(
      (entry) =>
        entry.pool.isAvailable() &&
        entry.layout.desktopGeneration === command.desktopGeneration &&
        entry.layout.topologyRevision === command.topologyRevision
    );

  readonly createAttachment = (
    command: DesktopAttachmentBinding,
    frontend: Parameters<DirectDesktopOptions['createAttachment']>[1],
    callbacks: Parameters<DirectDesktopOptions['createAttachment']>[2]
  ) => {
    const entry = [...this.#entries.values()].find(
      (candidate) => candidate.layout.desktopGeneration === command.desktopGeneration
    );
    if (!entry || !this.isCurrent(command))
      throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
    return new PooledDesktopAttachment(
      entry.pool,
      frontend,
      (backend) =>
        new RemoteDesktopAttachment({
          attachmentId: command.attachmentId,
          frontend,
          backend,
          mode: command.mode,
          maxPixels: this.options.maxPixels,
          isCurrentTopology: (width, height) =>
            this.isCurrent(command) &&
            entry.layout.framebuffer.width === width &&
            entry.layout.framebuffer.height === height,
          onAttached: callbacks.attached,
          onFailure: callbacks.failed
        })
    );
  };

  async dispose(): Promise<void> {
    if (!this.#disposed) {
      this.#disposed = true;
      this.options.fence('DESKTOP_SESSION_UNAVAILABLE');
    }
    const results = await Promise.allSettled([...this.#pools].map((pool) => pool.dispose()));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    this.#pools.clear();
  }
}
