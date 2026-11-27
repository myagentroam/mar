import { createUuid } from '../util/uuid.js';

/** Owns staging until a complete object URL can be handed off to the preview. */
export async function readWorkspaceFileObjectUrl(
  fileName: string,
  signal: AbortSignal | undefined,
  download: (sink: WorkspaceDirectObjectUrlSink['sink']) => Promise<void>
): Promise<string> {
  signal?.throwIfAborted();
  const target = await createWorkspaceDirectObjectUrlSink(fileName);
  try {
    signal?.throwIfAborted();
    await download(target.sink);
    signal?.throwIfAborted();
    const url = await target.objectUrl();
    signal?.throwIfAborted();
    return url;
  } catch (error) {
    await target.sink.abort();
    throw error;
  }
}

export interface WorkspaceDirectObjectUrlSink {
  readonly sink: {
    write(bytes: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  };
  objectUrl(): Promise<string>;
}

const entriesByUrl = new Map<string, () => Promise<void>>();
const previewLockName = (name: string) => `mar-direct-preview:${name}`;

export function revokeWorkspaceDirectObjectUrl(url: string): void {
  URL.revokeObjectURL(url);
  const remove = entriesByUrl.get(url);
  if (remove === undefined) return;
  entriesByUrl.delete(url);
  void remove();
}

export function triggerBrowserFileDownload(url: string, fileName: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

/** Owns streamed previews and cross-window locks until URL revocation or page destruction. */
export async function createWorkspaceDirectObjectUrlSink(
  fileName: string
): Promise<WorkspaceDirectObjectUrlSink> {
  const storage = navigator.storage as StorageManager & {
    getDirectory?: () => Promise<FileSystemDirectoryHandle>;
  };
  const locks = navigator.locks;
  if (storage?.getDirectory === undefined || locks?.request === undefined)
    throw new Error('DIRECT_OPFS_UNAVAILABLE');
  const root = await storage.getDirectory();
  const previews = await root.getDirectoryHandle('mar-direct-preview', { create: true });
  // Flat legacy entries lack ownership locks and may belong to another live, older page.
  const directory = await previews.getDirectoryHandle('managed-v1', { create: true });
  const entryName = `${createUuid()}-${safeFileName(fileName)}`;
  let releaseOwnership!: () => void;
  await new Promise<void>((resolve, reject) => {
    void locks
      .request(
        previewLockName(entryName),
        () =>
          new Promise<void>((release) => {
            releaseOwnership = release;
            resolve();
          })
      )
      .catch(reject);
  });
  let removed = false;
  let closed = false;
  let aborted = false;
  let createdUrl: string | undefined;

  async function remove(): Promise<void> {
    if (removed) return;
    removed = true;
    try {
      await directory.removeEntry(entryName).catch(() => undefined);
    } finally {
      releaseOwnership();
    }
  }

  let handle: FileSystemFileHandle;
  let writable: FileSystemWritableFileStream;
  try {
    const entries = directory as FileSystemDirectoryHandle & {
      entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
    };
    for await (const [name, entry] of entries.entries()) {
      if (name === entryName || entry.kind !== 'file') continue;
      await locks.request(previewLockName(name), { ifAvailable: true }, async (lock) => {
        if (lock !== null) await directory.removeEntry(name).catch(() => undefined);
      });
    }
    handle = await directory.getFileHandle(entryName, { create: true });
    writable = await handle.createWritable();
  } catch (error) {
    await remove();
    throw error;
  }

  return {
    sink: {
      async write(bytes) {
        await writable.write(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        );
      },
      async close() {
        if (closed) return;
        closed = true;
        try {
          await writable.close();
        } catch (error) {
          await remove();
          throw error;
        }
      },
      async abort() {
        aborted = true;
        if (createdUrl !== undefined) revokeWorkspaceDirectObjectUrl(createdUrl);
        if (!closed) {
          closed = true;
          await writable.abort().catch(() => undefined);
        }
        await remove();
      }
    },
    async objectUrl() {
      if (aborted) throw new DOMException('Preview was aborted', 'AbortError');
      if (!closed) throw new Error('DIRECT_OBJECT_URL_NOT_READY');
      if (createdUrl !== undefined) return createdUrl;
      try {
        const file = await handle.getFile();
        if (aborted) throw new DOMException('Preview was aborted', 'AbortError');
        const url = URL.createObjectURL(file);
        createdUrl = url;
        entriesByUrl.set(url, remove);
        return url;
      } catch (error) {
        await remove();
        throw error;
      }
    }
  };
}

function safeFileName(fileName: string): string {
  const normalized = fileName.replaceAll(/[^A-Za-z0-9._-]/gu, '_').slice(-128);
  return normalized.length > 0 ? normalized : 'file';
}
