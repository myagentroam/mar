import { RemoteDesktopError } from './desktop-error.js';
import { X11TopologySource } from './x11-topology-source.js';
import { X11Topology, type X11DesktopLayout } from './x11-topology.js';

type SourceStart = typeof X11TopologySource.start;

/** Owns one XRandR subscription and synchronously fences users before accepting a new layout. */
export class X11DesktopTopology {
  readonly #topology: X11Topology;
  #source: Pick<X11TopologySource, 'stop'> | undefined;
  #stopped = false;
  #unavailable = false;
  #stopPromise: Promise<void> | undefined;

  private constructor(
    generation: string,
    private readonly fence: () => void
  ) {
    this.#topology = new X11Topology(generation);
  }

  static async start(
    options: {
      readonly generation: string;
      readonly binaryPath: string;
      readonly display: string;
      readonly xAuthority: string;
      readonly fence: () => void;
    },
    signal: AbortSignal,
    startSource: SourceStart = X11TopologySource.start
  ): Promise<X11DesktopTopology> {
    const owner = new X11DesktopTopology(options.generation, options.fence);
    owner.#source = await startSource(
      {
        binaryPath: options.binaryPath,
        display: options.display,
        xAuthority: options.xAuthority,
        onSnapshot: (snapshot) => {
          if (!owner.#stopped && !owner.#unavailable) owner.#topology.accept(snapshot);
        },
        onInvalidated: (event) => {
          if (owner.#stopped || owner.#unavailable) return;
          owner.#topology.invalidate(event);
          owner.fence();
        },
        onUnavailable: () => {
          if (owner.#stopped || owner.#unavailable) return;
          owner.#unavailable = true;
          owner.#topology.unavailable();
          owner.fence();
        }
      },
      signal
    );
    // A source must not become usable merely because its start promise resolved.
    try {
      owner.describe();
    } catch (error) {
      await owner.stop();
      throw error;
    }
    return owner;
  }

  describe(): X11DesktopLayout {
    if (this.#stopped || this.#unavailable)
      throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
    return this.#topology.describe();
  }

  matches(generation: string, revision: number, width: number, height: number): boolean {
    try {
      const layout = this.describe();
      return (
        layout.desktopGeneration === generation &&
        layout.topologyRevision === revision &&
        layout.framebuffer.width === width &&
        layout.framebuffer.height === height
      );
    } catch {
      return false;
    }
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopped = true;
    this.#topology.unavailable();
    this.#stopPromise = (async () => {
      try {
        this.fence();
      } finally {
        await this.#source?.stop();
      }
    })();
    return this.#stopPromise;
  }
}
