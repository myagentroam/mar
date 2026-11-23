import { randomUUID } from 'node:crypto';

export interface BrowserSessionKey {
  workspaceId: string;
  userId: number;
}

type Session<T> = { resource: T; close: () => Promise<void> };

type Entry<T> = {
  id: string;
  opening: Promise<string>;
  session?: Session<T>;
  closing?: Promise<void>;
  idleSince?: number | undefined;
  attached?: boolean;
};

/** Owns live, isolated browser instances on this Node; the caller establishes
 * the execution boundary and supplies an already-authorized resource key.
 * An attachment borrows the interaction resource, not its close handle, and
 * keeps it alive until release. Runtime close resolves only after actual exit.
 */
export class BrowserSessionService<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private occupied = 0;

  constructor(
    private readonly options: {
      launch: (resource: BrowserSessionKey, browserId: string) => Promise<Session<T>>;
      limit: number;
      idleMs?: number;
      onCloseFailed: () => void;
    }
  ) {}

  async open(resource: BrowserSessionKey): Promise<string> {
    if (this.stopped) throw new Error('BROWSER_STOPPED');
    const key = this.key(resource);
    const current = this.entries.get(key);
    if (current && (current.closing || this.expired(current))) {
      await this.stopEntry(key, current);
      return this.open(resource);
    }
    if (current) return current.opening;

    const id = randomUUID();
    const opening = Promise.resolve().then(() => this.start(resource, key, id));
    this.entries.set(key, { id, opening });
    return opening;
  }

  lookup(resource: BrowserSessionKey): string | undefined {
    const entry = this.entries.get(this.key(resource));
    return entry?.session && !entry.closing && !this.expired(entry) ? entry.id : undefined;
  }

  pin(resource: BrowserSessionKey, id: string): { resource: T; release: () => void } {
    const entry = this.entries.get(this.key(resource));
    if (
      this.stopped ||
      entry?.id !== id ||
      !entry.session ||
      entry.closing ||
      this.expired(entry)
    ) {
      throw new Error('BROWSER_SESSION_ENDED');
    }
    if (entry.attached) throw new Error('BROWSER_ATTACHMENT_BUSY');
    entry.attached = true;
    entry.idleSince = undefined;
    this.schedule();
    let released = false;
    const release = () => {
      if (released || entry.closing) return;
      released = true;
      entry.attached = false;
      entry.idleSince = performance.now();
      this.schedule();
    };
    return { resource: entry.session.resource, release };
  }

  async close(resource: BrowserSessionKey, id: string): Promise<void> {
    const key = this.key(resource);
    const entry = this.entries.get(key);
    if (entry?.id === id) await this.stopEntry(key, entry);
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    const stopped = await Promise.allSettled(
      [...this.entries].map(([key, entry]) => this.stopEntry(key, entry))
    );
    const failure = stopped.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  private key({ workspaceId, userId }: BrowserSessionKey): string {
    return JSON.stringify([workspaceId, userId]);
  }

  private get idleMs(): number {
    return this.options.idleMs ?? 15 * 60_000;
  }

  private expired(entry: Entry<T>): boolean {
    return entry.idleSince !== undefined && performance.now() - entry.idleSince >= this.idleMs;
  }

  private async start(resource: BrowserSessionKey, key: string, id: string): Promise<string> {
    const entry = this.entries.get(key)!;
    let reserved = false;
    try {
      // Closing still owns its slot. If another opener took a freed slot while
      // awaiting exit, admission is decided against the current registry again.
      while (this.occupied >= this.options.limit) {
        if (this.stopped || entry.closing) throw new Error('BROWSER_STOPPED');
        let oldest: [string, Entry<T>] | undefined;
        for (const candidate of this.entries) {
          const idle = candidate[1].idleSince;
          if (
            idle !== undefined &&
            !candidate[1].closing &&
            (!oldest || idle < oldest[1].idleSince!)
          )
            oldest = candidate;
        }
        if (!oldest) throw new Error('BROWSER_CAPACITY');
        await this.stopEntry(...oldest);
      }
      if (this.stopped || entry.closing) throw new Error('BROWSER_STOPPED');
      this.occupied++;
      reserved = true;
      entry.session = await this.options.launch(resource, id);
    } catch (error) {
      if (reserved) this.occupied--;
      if (!entry.closing) this.entries.delete(key);
      throw error;
    }
    if (entry.closing) throw new Error('BROWSER_SESSION_ENDED');
    entry.idleSince = performance.now();
    this.schedule();
    return id;
  }

  private stopEntry(key: string, entry: Entry<T>): Promise<void> {
    entry.closing ??= (async () => {
      await entry.opening.catch(() => undefined);
      if (entry.session) {
        await entry.session.close();
        this.occupied--;
      }
      this.entries.delete(key);
    })();
    this.schedule();
    return entry.closing;
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.stopped) return;
    let next = Infinity;
    for (const entry of this.entries.values()) {
      if (entry.idleSince !== undefined && !entry.closing) next = Math.min(next, entry.idleSince);
    }
    if (!Number.isFinite(next)) return;
    this.timer = setTimeout(
      () => {
        for (const [key, entry] of this.entries) {
          if (!entry.closing && this.expired(entry)) {
            void this.stopEntry(key, entry).catch(this.options.onCloseFailed);
          }
        }
        this.schedule();
      },
      Math.max(1, Math.ceil(next + this.idleMs - performance.now()))
    );
    this.timer.unref();
  }
}
