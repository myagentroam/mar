import { randomUUID } from 'node:crypto';
import { RemoteDesktopError } from './desktop-error.js';
import type { X11TopologySnapshot } from './x11-topology-source.js';

interface X11Display {
  readonly displayId: string;
  readonly name: string;
  readonly primary: boolean;
  /** X11 root coordinates and x0vncserver framebuffer pixels share this rectangle. */
  readonly nativeBounds: Readonly<{ x: number; y: number; width: number; height: number }>;
  readonly framebufferBounds: Readonly<{ x: number; y: number; width: number; height: number }>;
  readonly nativeToFramebuffer: readonly [number, number, number, number, number, number];
}

export interface X11DesktopLayout {
  readonly desktopGeneration: string;
  readonly topologyRevision: number;
  readonly framebuffer: Readonly<{ width: number; height: number }>;
  readonly displays: readonly X11Display[];
}

interface MonitorIdentity {
  readonly displayId: string;
  readonly outputs: readonly number[];
}

/** Tracks layout and display identities for one X11 session, independently of VNC processes. */
export class X11Topology {
  readonly #identities = new Map<number, MonitorIdentity>();
  #revision = 0;
  #layout: X11DesktopLayout | undefined;

  constructor(private readonly desktopGeneration: string) {
    if (!desktopGeneration) throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
  }

  /** The owner must fence attachments on every invalidation before accepting a new layout. */
  invalidate(event: { readonly resetOutput?: number; readonly resetAll?: true }): void {
    this.#layout = undefined;
    if (event.resetAll) this.#identities.clear();
    if (event.resetOutput !== undefined) {
      for (const [key, identity] of this.#identities) {
        if (identity.outputs.includes(event.resetOutput)) this.#identities.delete(key);
      }
    }
  }

  /** Lost subscriptions cannot prove which monitor identities survived. */
  unavailable(): void {
    this.invalidate({ resetAll: true });
  }

  accept(snapshot: X11TopologySnapshot): X11DesktopLayout {
    if (this.#layout) throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
    const monitors = [...snapshot.monitors].sort((a, b) => a.id - b.id);
    if (
      new Set(monitors.map((monitor) => monitor.id)).size !== monitors.length ||
      monitors.filter((monitor) => monitor.primary).length > 1 ||
      (monitors.length > 1 && !monitors.some((monitor) => monitor.primary)) ||
      monitors.some(
        (monitor) =>
          monitor.x < 0 ||
          monitor.y < 0 ||
          monitor.x + monitor.width > snapshot.width ||
          monitor.y + monitor.height > snapshot.height ||
          new Set(monitor.outputs.map((output) => output.id)).size !== monitor.outputs.length
      )
    )
      throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');

    const active = new Set(monitors.map((monitor) => monitor.id));
    for (const key of this.#identities.keys()) if (!active.has(key)) this.#identities.delete(key);
    const displays = monitors.map((monitor) => {
      const outputs = monitor.outputs.map((output) => output.id).sort((a, b) => a - b);
      let identity = this.#identities.get(monitor.id);
      if (
        !identity ||
        identity.outputs.length !== outputs.length ||
        identity.outputs.some((output, index) => output !== outputs[index])
      ) {
        identity = { displayId: randomUUID(), outputs };
        this.#identities.set(monitor.id, identity);
      }
      const bounds = { x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height };
      return {
        displayId: identity.displayId,
        name: monitor.name,
        primary: monitor.primary || monitors.length === 1,
        nativeBounds: bounds,
        framebufferBounds: { ...bounds },
        nativeToFramebuffer: [1, 0, 0, 1, 0, 0] as const
      };
    });

    // A notification may hide a transient change even when the new snapshot
    // matches the old one. Never let grants from before that fence revive.
    this.#revision++;
    this.#layout = {
      desktopGeneration: this.desktopGeneration,
      topologyRevision: this.#revision,
      framebuffer: { width: snapshot.width, height: snapshot.height },
      displays
    };
    return structuredClone(this.#layout);
  }

  describe(): X11DesktopLayout {
    if (!this.#layout) throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
    return structuredClone(this.#layout);
  }

  /** A mismatch must end the attachment, never adapt input using stale geometry. */
  matchesFramebuffer(width: number, height: number): boolean {
    return (
      !!this.#layout &&
      this.#layout.framebuffer.width === width &&
      this.#layout.framebuffer.height === height
    );
  }
}
