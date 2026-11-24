import { randomUUID } from 'node:crypto';
import { open, rm, stat } from 'node:fs/promises';
import {
  BROWSER_DOWNLOAD_PAGE_SIZE,
  type BrowserDownloadInfo,
  type BrowserDownloadRead,
  type BrowserDownloadRequest
} from '@myagentroam/protocol';
import type { Download, Page } from 'playwright';

const HOUR_MS = 60 * 60_000;
const RETENTION_MS = 30 * 24 * HOUR_MS;
const SAVE_GRACE_MS = 15 * 60_000;
const MAX_RETAINED_BYTES = 1024 ** 3;
const MAX_RETAINED_ENTRIES = 256;

type Entry = {
  native: Download;
  info: BrowserDownloadInfo;
  location?: { path: string; size: number };
  recentSaveUntil?: number;
  readers?: number;
  canceling?: Promise<void>;
  canceledByUser?: boolean;
  deleting?: Promise<void>;
};

/** Owns the download projection and live retention for one browser context.
 * Chromium writes the files and owns close-time cleanup. The context owner
 * stops retention on close; paths stay in Node. */
export class BrowserDownloads {
  private readonly entries = new Map<string, Entry>();
  private readonly ordered: Entry[] = [];
  private readonly active = new Set<Entry>();
  private readonly ended = new Map<Entry, number>();
  private retainedBytes = 0;
  private pendingRemovalCount = 0;
  private pendingRemovalBytes = 0;
  private readonly retention: ReturnType<typeof setInterval>;
  private disposed = false;
  private sweeping: Promise<void> | undefined;
  private sweepPending = false;
  private revision = 0;

  constructor(
    private readonly changed: () => void,
    private readonly failed: (error: unknown) => void
  ) {
    this.retention = setInterval(() => this.scheduleSweep(), HOUR_MS).unref();
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.retention);
  }

  get version(): number {
    return this.revision;
  }

  get activeCount(): number {
    return this.active.size;
  }

  listen(page: Page): void {
    page.on('download', (native) => {
      const id = randomUUID();
      const name =
        native
          .suggestedFilename()
          .split(/[\\/]/u)
          .at(-1)
          ?.replace(/[\u0000-\u001f\u007f]/gu, '')
          .slice(0, 255)
          .toWellFormed() || 'download';
      const entry: Entry = { native, info: { id, name, state: 'downloading' } };
      this.entries.set(id, entry);
      this.ordered.push(entry);
      this.active.add(entry);
      this.notify();
      void this.settle(entry);
    });
  }

  async execute(
    command: BrowserDownloadRequest['command'] | BrowserDownloadRead['command']
  ): Promise<unknown> {
    if (command.action === 'list') {
      const end = Math.max(0, this.ordered.length - command.offset);
      const start = Math.max(0, end - BROWSER_DOWNLOAD_PAGE_SIZE);
      return {
        items: this.ordered
          .slice(start, end)
          .reverse()
          .map(({ info }) => info),
        more: start > 0
      };
    }
    const entry = this.entries.get(command.id);
    if (!entry) throw new Error('BROWSER_DOWNLOAD_ENDED');
    if (command.action === 'cancel') {
      if (entry.info.state === 'downloading') {
        entry.canceledByUser = true;
        const cancel = (entry.canceling ??= entry.native.cancel());
        try {
          await cancel;
        } catch (error) {
          entry.canceledByUser = false;
          throw error;
        } finally {
          if (entry.canceling === cancel) delete entry.canceling;
        }
      }
      return {};
    }
    if (command.action === 'delete') {
      if (this.active.has(entry)) throw new Error('BROWSER_DOWNLOAD_IN_PROGRESS');
      await this.deleteEntry(entry);
      this.notify();
      return {};
    }
    if (entry.deleting) throw new Error('BROWSER_DOWNLOAD_ENDED');
    const location = entry.location;
    if (!location) throw new Error('BROWSER_DOWNLOAD_NOT_READY');
    // Info admits a save. The HTTP response may wait between pull requests.
    entry.recentSaveUntil = performance.now() + SAVE_GRACE_MS;
    if (command.action === 'info') return entry.info;
    const content = Buffer.alloc(
      Math.min(command.limit, Math.max(0, location.size - command.offset))
    );
    entry.readers = (entry.readers ?? 0) + 1;
    try {
      const handle = await open(location.path, 'r');
      try {
        const { bytesRead } = await handle.read(content, 0, content.length, command.offset);
        return {
          contentBase64: content.subarray(0, bytesRead).toString('base64'),
          offset: command.offset
        };
      } finally {
        await handle.close();
      }
    } finally {
      entry.readers--;
      entry.recentSaveUntil = performance.now() + SAVE_GRACE_MS;
    }
  }

  async cancelActive(): Promise<void> {
    await Promise.allSettled(
      [...this.active].map(({ info }) => this.execute({ action: 'cancel', id: info.id }))
    );
  }

  private deleteEntry(entry: Entry): Promise<void> {
    if (entry.deleting) return entry.deleting;
    const size = entry.location?.size ?? 0;
    // Concurrent removals already free this capacity if they succeed.
    this.pendingRemovalCount++;
    this.pendingRemovalBytes += size;
    return (entry.deleting = this.remove(entry).finally(() => {
      this.pendingRemovalCount--;
      this.pendingRemovalBytes -= size;
      delete entry.deleting;
    }));
  }

  private async remove(entry: Entry): Promise<void> {
    if (entry.location) await rm(entry.location.path, { force: true });
    this.retainedBytes -= entry.location?.size ?? 0;
    this.ended.delete(entry);
    this.entries.delete(entry.info.id);
    this.ordered.splice(this.ordered.indexOf(entry), 1);
  }

  private scheduleSweep(): void {
    if (this.disposed) return;
    this.sweepPending = true;
    if (this.sweeping) return;
    this.sweeping = this.sweep().finally(() => {
      this.sweeping = undefined;
      if (this.sweepPending) this.scheduleSweep();
    });
  }

  private async sweep(): Promise<void> {
    this.sweepPending = false;
    const ended = [...this.ended];
    const latestFile = () =>
      ended.findLast(([entry]) => entry.location && !entry.deleting && this.ended.has(entry))?.[0];
    let newestFile = latestFile();
    let removed = false;
    for (const [entry, at] of ended) {
      if (this.disposed) break;
      const now = performance.now();
      if (
        !this.ended.has(entry) ||
        entry.deleting ||
        entry.readers ||
        (entry.recentSaveUntil ?? 0) > now
      )
        continue;
      const expired = now - at >= RETENTION_MS;
      const overCount = this.ended.size - this.pendingRemovalCount > MAX_RETAINED_ENTRIES;
      const overBytes =
        entry.location !== undefined &&
        this.retainedBytes - this.pendingRemovalBytes > MAX_RETAINED_BYTES;
      if (newestFile && (!this.ended.has(newestFile) || newestFile.deleting))
        newestFile = latestFile();
      if (!expired && (entry === newestFile || (!overCount && !overBytes))) continue;
      try {
        await this.deleteEntry(entry);
        removed = true;
      } catch (error) {
        this.failed(error);
      }
    }
    if (removed && !this.disposed) this.notify();
  }

  private async settle(entry: Entry): Promise<void> {
    try {
      const failure = await entry.native.failure();
      // Chromium also reports `canceled` for interrupted network responses.
      if (failure)
        entry.info = { ...entry.info, state: entry.canceledByUser ? 'canceled' : 'failed' };
      else {
        const path = await entry.native.path();
        const { size } = await stat(path);
        entry.location = { path, size };
        entry.info = { ...entry.info, state: 'ready', size };
      }
    } catch {
      entry.info = { ...entry.info, state: 'failed' };
    }
    this.active.delete(entry);
    if (this.disposed) return;
    this.ended.set(entry, performance.now());
    this.retainedBytes += entry.location?.size ?? 0;
    this.notify();
    if (this.ended.size > MAX_RETAINED_ENTRIES || this.retainedBytes > MAX_RETAINED_BYTES)
      this.scheduleSweep();
  }

  private notify(): void {
    this.revision++;
    this.changed();
  }
}
