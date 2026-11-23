import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserSessionKey } from './browser-session-service.js';

const RETENTION_MS = 30 * 24 * 60 * 60_000;
const PROFILE_ENTRY = /^[0-9a-f]{64}$/u;
type Metadata = { id: string; open: boolean; lastUsedAt: number };

/** Owns managed persistent profile directories and their retention metadata.
 * The deployment provides a private root and proves post-crash quiescence;
 * callers may only expose the data child and release after the browser exits.
 */
export class BrowserProfiles {
  private readonly active = new Set<string>();
  private operation = Promise.resolve();

  constructor(
    private readonly options: {
      root: string;
      isUnused: (dataPath: string) => Promise<boolean>;
      failed: (error: unknown) => void;
      now?: () => number;
    }
  ) {}

  acquire(scope: BrowserSessionKey): Promise<{ path: string; release: () => Promise<void> }> {
    return this.acquireEntry(scope);
  }

  inspect(scope: BrowserSessionKey): Promise<string | undefined> {
    return this.serial(async () => {
      const name = this.name(scope);
      if (this.active.has(name) || !(await this.stat(this.options.root))?.isDirectory()) return;
      const entry = join(this.options.root, name);
      if (
        !(await this.stat(entry))?.isDirectory() ||
        !(await this.stat(join(entry, 'data')))?.isDirectory()
      )
        return;
      const metadata = await this.metadata(entry);
      if (!metadata || metadata.open || this.now() - metadata.lastUsedAt >= RETENTION_MS) return;
      return metadata.id;
    });
  }

  maintain(
    scope: BrowserSessionKey,
    id: string
  ): Promise<{ path: string; release: () => Promise<void> }> {
    return this.acquireEntry(scope, id);
  }

  private acquireEntry(
    scope: BrowserSessionKey,
    expectedId?: string
  ): Promise<{ path: string; release: () => Promise<void> }> {
    const name = this.name(scope);
    return this.serial(async () => {
      const entry = join(this.options.root, name);
      const path = join(entry, 'data');
      if (this.active.has(name)) throw new Error('BROWSER_PROFILE_BUSY');
      await mkdir(this.options.root, { recursive: true, mode: 0o700 });
      if (!(await this.stat(this.options.root))?.isDirectory())
        throw new Error('BROWSER_PROFILE_INVALID');
      const existing = await this.stat(entry);
      let metadata: Metadata | undefined;
      if (existing) {
        metadata = existing.isDirectory() ? await this.metadata(entry) : undefined;
        if (!metadata || !(await this.stat(path))?.isDirectory())
          throw new Error('BROWSER_PROFILE_INVALID');
        if (
          expectedId &&
          (metadata.id !== expectedId ||
            metadata.open ||
            this.now() - metadata.lastUsedAt >= RETENTION_MS)
        )
          throw new Error('BROWSER_PROFILE_CHANGED');
        if (metadata.open && !(await this.options.isUnused(path)))
          throw new Error('BROWSER_PROFILE_BUSY');
      } else {
        if (expectedId) throw new Error('BROWSER_PROFILE_CHANGED');
        await mkdir(entry, { mode: 0o700 });
      }
      const id = metadata?.id ?? randomUUID();
      const lastUsedAt = expectedId ? metadata!.lastUsedAt : this.now();
      try {
        if (!existing) await mkdir(path, { mode: 0o700 });
        await this.mark(entry, { id, open: true, lastUsedAt });
      } catch (error) {
        // Only this call's new entry can be rolled back; existing data is retained.
        if (!existing) await rm(entry, { recursive: true, force: true }).catch(this.options.failed);
        throw error;
      }
      this.active.add(name);
      let released = false;
      return {
        path,
        release: () =>
          this.serial(async () => {
            if (released) return;
            released = true;
            this.active.delete(name);
            // The process has already exited. A failed marker write leaves
            // the old marker for normal post-crash reconciliation, not a live lease.
            await this.mark(entry, {
              id,
              open: false,
              lastUsedAt: expectedId ? lastUsedAt : this.now()
            }).catch(this.options.failed);
          })
      };
    });
  }

  sweep(): Promise<void> {
    return this.serial(async () => {
      if (!(await this.stat(this.options.root))?.isDirectory()) return;
      for (const item of await readdir(this.options.root, { withFileTypes: true })) {
        if (!item.isDirectory() || !PROFILE_ENTRY.test(item.name) || this.active.has(item.name))
          continue;
        const entry = join(this.options.root, item.name);
        const path = join(entry, 'data');
        try {
          const metadata = await this.metadata(entry);
          if (!metadata || !(await this.stat(path))?.isDirectory()) continue;
          if (metadata.open) {
            if (await this.options.isUnused(path))
              await this.mark(entry, { id: metadata.id, open: false, lastUsedAt: this.now() });
          } else if (this.now() - metadata.lastUsedAt >= RETENTION_MS) {
            await rm(entry, { recursive: true });
          }
        } catch (error) {
          this.options.failed(error);
        }
      }
    });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private name(scope: BrowserSessionKey): string {
    return createHash('sha256')
      .update(JSON.stringify([scope.workspaceId, scope.userId]))
      .digest('hex');
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.operation.then(run);
    this.operation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async stat(path: string) {
    try {
      return await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return undefined;
    }
  }

  private async metadata(entry: string): Promise<Metadata | undefined> {
    const path = join(entry, 'retention.json');
    const info = await this.stat(path);
    if (!info?.isFile() || info.size > 256) return undefined;
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (
      typeof value !== 'object' ||
      value === null ||
      !('id' in value) ||
      typeof value.id !== 'string' ||
      !('open' in value) ||
      typeof value.open !== 'boolean' ||
      !('lastUsedAt' in value) ||
      typeof value.lastUsedAt !== 'number' ||
      !Number.isSafeInteger(value.lastUsedAt) ||
      value.lastUsedAt < 0
    )
      return undefined;
    return { id: value.id, open: value.open, lastUsedAt: value.lastUsedAt };
  }

  private async mark(entry: string, metadata: Metadata): Promise<void> {
    const temp = join(entry, 'retention.tmp');
    await writeFile(temp, JSON.stringify(metadata), { mode: 0o600 });
    await rename(temp, join(entry, 'retention.json'));
  }
}
