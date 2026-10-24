import type { DirectTransferResource } from '@myagentroam/protocol';
import type { createWorkspaceDirectTransferService } from './workspace-direct-transfer-service.js';
import type { WorkspaceDirectFileIdentity } from './workspace-direct-file-read-service.js';

export async function readWorkspaceDirectObjectUrl(input: {
  readonly direct: Pick<ReturnType<typeof createWorkspaceDirectTransferService>, 'download'>;
  readonly nodeId: string;
  readonly nodeGeneration: string;
  readonly resource: DirectTransferResource;
  readonly metadata: () => Promise<WorkspaceDirectFileIdentity | undefined>;
}): Promise<({ readonly url: string } & WorkspaceDirectFileIdentity) | undefined> {
  let target: WorkspaceDirectObjectUrlSink | undefined;
  try {
    const identity = await input.metadata();
    if (identity === undefined) return undefined;
    const fileName = input.resource.path.split('/').at(-1) ?? 'file';
    target = await createWorkspaceDirectObjectUrlSink(fileName);
    await input.direct.download({
      nodeId: input.nodeId,
      nodeGeneration: input.nodeGeneration,
      descriptor: { direction: 'DOWNLOAD', resource: input.resource, fileName, ...identity },
      sink: target.sink
    });
    return { url: await target.objectUrl(), ...identity };
  } catch {
    await target?.sink.abort().catch(() => undefined);
    return undefined;
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

export async function createWorkspaceDirectObjectUrlSink(
  fileName: string
): Promise<WorkspaceDirectObjectUrlSink> {
  const storage = navigator.storage as StorageManager & {
    getDirectory?: () => Promise<FileSystemDirectoryHandle>;
  };
  if (storage.getDirectory === undefined) throw new Error('DIRECT_OPFS_UNAVAILABLE');
  const root = await storage.getDirectory();
  const directory = await root.getDirectoryHandle('mar-direct-preview', { create: true });
  const entryName = `${crypto.randomUUID()}-${safeFileName(fileName)}`;
  const handle = await directory.getFileHandle(entryName, { create: true });
  const writable = await handle.createWritable();
  let closed = false;
  let createdUrl: string | undefined;

  async function remove(): Promise<void> {
    await directory.removeEntry(entryName).catch(() => undefined);
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
        await writable.close();
      },
      async abort() {
        if (!closed) {
          closed = true;
          await writable.abort().catch(() => undefined);
        }
        await remove();
      }
    },
    async objectUrl() {
      if (!closed) throw new Error('DIRECT_OBJECT_URL_NOT_READY');
      if (createdUrl !== undefined) return createdUrl;
      try {
        const file = await handle.getFile();
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
