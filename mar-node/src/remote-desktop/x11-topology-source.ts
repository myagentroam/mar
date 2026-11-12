import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { RemoteDesktopError } from './desktop-error.js';

const coordinate = z.number().int().min(-0x80000000).max(0x7fffffff);
const dimension = z.number().int().min(1).max(65535);
const identifier = z.number().int().min(1).max(0xffffffff);
const outputSchema = z
  .object({
    id: identifier,
    name: z.string().min(1).max(256),
    x: coordinate,
    y: coordinate,
    width: dimension,
    height: dimension,
    rotation: z.number().int().min(1).max(63),
    transform: z.array(coordinate).length(9)
  })
  .strict();
const snapshotSchema = z
  .object({
    type: z.literal('snapshot'),
    width: dimension,
    height: dimension,
    monitors: z
      .array(
        z
          .object({
            id: identifier,
            name: z.string().min(1).max(256),
            primary: z.boolean(),
            x: coordinate,
            y: coordinate,
            width: dimension,
            height: dimension,
            mmWidth: z.number().int().min(0).max(0x7fffffff),
            mmHeight: z.number().int().min(0).max(0x7fffffff),
            outputs: z.array(outputSchema).min(1).max(64)
          })
          .strict()
      )
      .min(1)
      .max(64)
  })
  .strict();
const eventSchema = z.discriminatedUnion('type', [
  snapshotSchema,
  z
    .object({
      type: z.literal('invalidated'),
      resetOutput: identifier.optional(),
      resetAll: z.literal(true).optional()
    })
    .strict()
]);
const maxLineBytes = 256 * 1024;

export type X11TopologySnapshot = z.infer<typeof snapshotSchema>;

interface X11TopologyOptions {
  binaryPath: string;
  display: string;
  xAuthority: string;
  onInvalidated(event: { readonly resetOutput?: number; readonly resetAll?: true }): void;
  onSnapshot(snapshot: X11TopologySnapshot): void;
  onUnavailable(): void;
}

/** Owns one native XRandR subscription, not the X11 session or any control lease. */
export class X11TopologySource {
  readonly #exit: Promise<void>;
  readonly #initial: Promise<void>;
  #resolveInitial!: () => void;
  #rejectInitial!: (error: RemoteDesktopError) => void;
  #line = Buffer.alloc(0);
  #waitingSnapshot = true;
  #ready = false;
  #stopping = false;
  #failed = false;
  #stopPromise: Promise<void> | undefined;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly options: X11TopologyOptions
  ) {
    this.#initial = new Promise((resolve, reject) => {
      this.#resolveInitial = resolve;
      this.#rejectInitial = reject;
    });
    this.#exit = new Promise((resolve) =>
      child.once('close', () => {
        this.#fail();
        resolve();
      })
    );
    child.on('error', () => this.#fail());
    child.stdout.on('error', () => this.#fail());
    child.stdout.on('end', () => this.#fail());
    child.stdout.on('close', () => this.#fail());
    child.stdin.on('error', () => this.#fail());
    child.stderr.resume();
    child.stdout.on('data', (chunk: Buffer) => this.#receive(chunk));
  }

  static async start(options: X11TopologyOptions, signal: AbortSignal): Promise<X11TopologySource> {
    if (
      process.platform !== 'linux' ||
      !isAbsolute(options.binaryPath) ||
      !isAbsolute(options.xAuthority) ||
      !options.display ||
      signal.aborted
    )
      throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(options.binaryPath, [], {
        env: { PATH: '/usr/bin:/bin', DISPLAY: options.display, XAUTHORITY: options.xAuthority },
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch {
      throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
    }
    const source = new X11TopologySource(child, options);
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    const abort = () => source.#fail();
    deadline.addEventListener('abort', abort, { once: true });
    if (deadline.aborted) abort();
    try {
      await source.#initial;
      if (source.#failed) throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
      return source;
    } catch {
      await source.stop();
      throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
    } finally {
      deadline.removeEventListener('abort', abort);
    }
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopping = true;
    this.child.stdin.end();
    this.#stopPromise = (async () => {
      if (
        await Promise.race([
          this.#exit.then(() => false),
          delay(5_000, undefined, { ref: false }).then(() => true)
        ])
      ) {
        this.child.kill('SIGKILL');
        if (
          await Promise.race([
            this.#exit.then(() => false),
            delay(5_000, undefined, { ref: false }).then(() => true)
          ])
        )
          throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
      }
    })();
    return this.#stopPromise;
  }

  #receive(chunk: Buffer): void {
    if (this.#failed || this.#stopping) return;
    let offset = 0;
    while (offset < chunk.length && !this.#failed && !this.#stopping) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      if (this.#line.length + end - offset > maxLineBytes) return this.#fail();
      this.#line = Buffer.concat([this.#line, chunk.subarray(offset, end)]);
      if (newline < 0) return;
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(this.#line);
        const event = eventSchema.parse(JSON.parse(text));
        this.#line = Buffer.alloc(0);
        if (event.type === 'invalidated') {
          if (this.#waitingSnapshot) return this.#fail();
          this.#waitingSnapshot = true;
          this.options.onInvalidated({
            ...(event.resetOutput === undefined ? {} : { resetOutput: event.resetOutput }),
            ...(event.resetAll === undefined ? {} : { resetAll: event.resetAll })
          });
        } else {
          if (!this.#waitingSnapshot) return this.#fail();
          this.#waitingSnapshot = false;
          this.options.onSnapshot(event);
          if (!this.#ready) {
            this.#ready = true;
            this.#resolveInitial();
          }
        }
      } catch {
        this.#fail();
      }
      offset = newline + 1;
    }
  }

  #fail(): void {
    if (this.#failed || this.#stopping) return;
    this.#failed = true;
    try {
      if (!this.#ready) this.#rejectInitial(new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE'));
      else this.options.onUnavailable();
    } catch {
      // A consumer failure must not prevent the owned native process stopping.
    } finally {
      void this.stop().catch(() => {});
    }
  }
}
