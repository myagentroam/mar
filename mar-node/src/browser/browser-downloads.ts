import { randomUUID } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import {
  BROWSER_DOWNLOAD_PAGE_SIZE,
  type BrowserDownloadInfo,
  type BrowserDownloadRead,
  type BrowserDownloadRequest
} from '@myagentroam/protocol';
import type { Download, Page } from 'playwright';

type Entry = {
  native: Download;
  info: BrowserDownloadInfo;
  location?: { path: string; size: number };
  canceling?: Promise<void>;
  canceledByUser?: boolean;
};

/** Owns the download projection for a single browser context. Chromium owns
 * writing and close-time deletion; paths never cross the Node boundary. */
export class BrowserDownloads {
  private readonly entries = new Map<string, Entry>();
  private readonly ordered: Entry[] = [];
  private revision = 0;

  constructor(private readonly changed: () => void) {}

  get version(): number {
    return this.revision;
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
    const location = entry.location;
    if (!location) throw new Error('BROWSER_DOWNLOAD_NOT_READY');
    if (command.action === 'info') return entry.info;
    const content = Buffer.alloc(
      Math.min(command.limit, Math.max(0, location.size - command.offset))
    );
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
  }

  async cancelActive(): Promise<void> {
    await Promise.allSettled(
      this.ordered
        .filter(({ info }) => info.state === 'downloading')
        .map(({ info }) => this.execute({ action: 'cancel', id: info.id }))
    );
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
    this.notify();
  }

  private notify(): void {
    this.revision++;
    this.changed();
  }
}
