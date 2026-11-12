import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { remoteDesktopDescriptionSchema } from '@myagentroam/protocol';
import { RemoteDesktopError } from './desktop-error.js';
import { startDesktopTopologyNotifications } from './desktop-topology-notifications.js';
import type { DirectDesktopOptions } from './direct-desktop-service.js';
import { PooledDesktopAttachment } from './pooled-desktop-attachment.js';
import { RemoteDesktopAttachment } from './remote-desktop-attachment.js';
import { TigerVncBackendPool } from './tigervnc-backend-pool.js';
import { UltraVncManagedProcess } from './ultravnc-managed-process.js';
import type { DesktopAttachmentBinding } from './x11-remote-desktop-runtime.js';

interface WindowsScreen {
  readonly name: string;
  readonly primary: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const run = promisify(execFile);
const SCREEN_QUERY = `
$ErrorActionPreference = "Stop"
if (-not [Environment]::UserInteractive) { exit 2 }
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$screens = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  @{ name=$_.DeviceName; primary=$_.Primary; x=$_.Bounds.X; y=$_.Bounds.Y;
     width=$_.Bounds.Width; height=$_.Bounds.Height }
})
ConvertTo-Json -InputObject $screens -Compress
`;

const SCREEN_WATCH = `
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$events = @('DisplaySettingsChanging', 'DisplaySettingsChanged')
foreach ($name in $events) {
  Register-ObjectEvent -InputObject ([Microsoft.Win32.SystemEvents]) -EventName $name -SourceIdentifier $name | Out-Null
}
[Console]::WriteLine('ready')
while ($true) {
  $event = Wait-Event
  [Console]::WriteLine('invalidated')
  Remove-Event -EventIdentifier $event.EventIdentifier
}
`;

/** Maps Windows virtual-screen coordinates into the full VNC framebuffer. */
export function windowsDesktopLayout(
  screens: readonly WindowsScreen[],
  generation: string,
  revision: number
) {
  if (!screens.length) throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
  const minX = Math.min(...screens.map((screen) => screen.x));
  const minY = Math.min(...screens.map((screen) => screen.y));
  const maxX = Math.max(...screens.map((screen) => screen.x + screen.width));
  const maxY = Math.max(...screens.map((screen) => screen.y + screen.height));
  const result = remoteDesktopDescriptionSchema.safeParse({
    desktopGeneration: generation,
    topologyRevision: revision,
    framebuffer: { width: maxX - minX, height: maxY - minY },
    displays: screens.map((screen) => ({
      displayId: Buffer.from(screen.name, 'utf8').toString('base64url').padEnd(8, '_'),
      name: screen.name,
      primary: screen.primary,
      nativeBounds: { x: screen.x, y: screen.y, width: screen.width, height: screen.height },
      framebufferBounds: {
        x: screen.x - minX,
        y: screen.y - minY,
        width: screen.width,
        height: screen.height
      },
      nativeToFramebuffer: [1, 0, 0, 1, minX === 0 ? 0 : -minX, minY === 0 ? 0 : -minY]
    }))
  });
  if (!result.success) throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
  return result.data;
}

async function queryScreens(signal: AbortSignal): Promise<WindowsScreen[]> {
  const { stdout } = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', SCREEN_QUERY],
    {
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      signal
    }
  );
  return JSON.parse(stdout) as WindowsScreen[];
}

/** Owns the current interactive Windows GUI layout and one shared UltraVNC backend. */
export class WindowsRemoteDesktopRuntime {
  readonly #pool: TigerVncBackendPool;
  readonly #generation = randomUUID();
  #layout: ReturnType<typeof windowsDesktopLayout> | undefined;
  #signature = '';
  #revision = 0;
  #disposed = false;
  #epoch = 0;
  #notifications: Awaited<ReturnType<typeof startDesktopTopologyNotifications>> | undefined;

  readonly #invalidate = (): void => {
    if (this.#disposed) return;
    this.#epoch++;
    this.#layout = undefined;
    this.#signature = '';
    this.options.fence('DESKTOP_TOPOLOGY_UNAVAILABLE');
  };

  private constructor(
    private readonly options: { binaryPath: string; maxPixels: number; fence(code: string): void }
  ) {
    this.#pool = new TigerVncBackendPool(
      (signal, onUnexpectedExit) =>
        UltraVncManagedProcess.start({ binaryPath: options.binaryPath, onUnexpectedExit }, signal),
      () => options.fence('DESKTOP_BACKEND_CLOSED')
    );
  }

  static async start(
    options: { binaryPath: string; maxPixels: number; fence(code: string): void },
    signal: AbortSignal
  ) {
    const runtime = new WindowsRemoteDesktopRuntime(options);
    try {
      runtime.#notifications = await startDesktopTopologyNotifications(
        {
          binary: 'powershell.exe',
          args: ['-NoProfile', '-NonInteractive', '-Command', SCREEN_WATCH],
          invalidate: runtime.#invalidate,
          unavailable: runtime.#invalidate
        },
        signal
      );
      await runtime.refresh(signal);
      return runtime;
    } catch (error) {
      await runtime.dispose();
      throw error;
    }
  }

  async refresh(signal: AbortSignal): Promise<void> {
    const epoch = this.#epoch;
    if (!this.#notifications?.isAvailable())
      throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
    const screens = (
      await queryScreens(signal).catch((error: unknown) => {
        this.#invalidate();
        throw error;
      })
    ).sort((left, right) => left.name.localeCompare(right.name));
    const signature = JSON.stringify(
      screens.map((screen) => [
        screen.name,
        screen.primary,
        screen.x,
        screen.y,
        screen.width,
        screen.height
      ])
    );
    if (this.#disposed) throw new RemoteDesktopError('DESKTOP_BACKEND_CLOSED');
    if (epoch !== this.#epoch) throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
    if (signature === this.#signature) return;
    if (this.#layout) this.#invalidate();
    const layout = windowsDesktopLayout(screens, this.#generation, this.#revision + 1);
    if (layout.framebuffer.width * layout.framebuffer.height > this.options.maxPixels)
      throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
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
    await this.#notifications?.stop();
    await this.#pool.dispose();
  }
}
