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

/** Owns the current interactive macOS desktop layout and one shared macVNC backend. */
export class MacosRemoteDesktopRuntime {
  readonly #pool: TigerVncBackendPool;
  readonly #generation = randomUUID();
  #layout: ReturnType<typeof macosCombinedDesktopLayout> | undefined;
  #signature = '';
  #revision = 0;
  #disposed = false;

  private constructor(
    private readonly options: {
      binaryPath: string;
      topologyBinary: string;
      maxPixels: number;
      fence(code: string): void;
    }
  ) {
    this.#pool = new TigerVncBackendPool(
      (signal, onUnexpectedExit) =>
        MacVncManagedProcess.start({ binaryPath: options.binaryPath, onUnexpectedExit }, signal),
      () => options.fence('DESKTOP_BACKEND_CLOSED')
    );
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

  async refresh(signal: AbortSignal): Promise<void> {
    const screens = (await queryScreens(this.options.topologyBinary, signal)).sort(
      (left, right) => left.id - right.id
    );
    const signature = JSON.stringify(screens);
    if (this.#disposed) throw new RemoteDesktopError('DESKTOP_BACKEND_CLOSED');
    if (signature === this.#signature) return;
    const layout = macosCombinedDesktopLayout(
      screens.filter((screen) => screen.primary),
      this.#generation,
      this.#revision + 1
    );
    if (layout.framebuffer.width * layout.framebuffer.height > this.options.maxPixels)
      throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
    if (this.#layout) this.options.fence('DESKTOP_TOPOLOGY_UNAVAILABLE');
    this.#signature = signature;
    this.#revision++;
    this.#layout = layout;
  }

  describe() {
    if (this.#disposed || !this.#layout || !this.#pool.isAvailable())
      throw new RemoteDesktopError('DESKTOP_BACKEND_CLOSED');
    return structuredClone(this.#layout);
  }

  readonly isCurrent = (command: DesktopAttachmentBinding): boolean =>
    !this.#disposed &&
    this.#pool.isAvailable() &&
    !!this.#layout &&
    this.#layout.desktopGeneration === command.desktopGeneration &&
    this.#layout.topologyRevision === command.topologyRevision;

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
          isCurrentTopology: (width, height) =>
            this.isCurrent(command) &&
            this.#layout?.framebuffer.width === width &&
            this.#layout.framebuffer.height === height,
          onAttached: callbacks.attached,
          onFailure: callbacks.failed
        })
    );

  async dispose(): Promise<void> {
    if (!this.#disposed) {
      this.#disposed = true;
      this.options.fence('DESKTOP_SESSION_UNAVAILABLE');
    }
    await this.#pool.dispose();
  }
}
