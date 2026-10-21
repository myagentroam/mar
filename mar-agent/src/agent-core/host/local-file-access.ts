import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  CoreFilesBackend,
  CoreFilePath,
  CoreFileWrite,
  CoreFileRemove,
  CoreFileTransfer,
  CoreFileType
} from '../extensions/files.js';
import type { CoreOperationContext } from '../extensions/operation.js';
import { WorkspacePathResolver } from '../tools/shared/path-resolver.js';
import { MarAgentError } from '../error.js';

/** Raw native access shares the exact resolver used by the Host's model-facing tools. */
export class LocalFileAccess implements CoreFilesBackend {
  constructor(readonly paths: WorkspacePathResolver) {}
  read(input: CoreFilePath, call: CoreOperationContext) {
    return this.#execute(
      'read',
      call,
      async () =>
        new Uint8Array(await readFile(await this.#path(input.path), { signal: call.signal }))
    );
  }
  write(input: CoreFileWrite, call: CoreOperationContext) {
    return this.#execute('write', call, async () => {
      if (!(input.bytes instanceof Uint8Array))
        throw new MarAgentError('MAR_AGENT_FILE_INPUT_INVALID', 'File bytes must be a Uint8Array.');
      const bytes = Buffer.from(input.bytes);
      const path = await this.#path(input.path, true);
      call.signal.throwIfAborted();
      if (input.createParents) await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes, { signal: call.signal });
      return { bytesWritten: bytes.byteLength };
    });
  }
  stat(input: CoreFilePath, call: CoreOperationContext) {
    return this.#execute('stat', call, async () => {
      const path = await this.paths.resolveWithDisplay(this.#validatePath(input.path));
      const info = await lstat(path.physicalPath);
      return {
        path: path.displayPath,
        type: fileType(info),
        size: info.size,
        modifiedAtMs: info.mtimeMs,
        createdAtMs: info.birthtimeMs
      };
    });
  }
  list(input: CoreFilePath, call: CoreOperationContext) {
    return this.#execute('list', call, async () =>
      (await readdir(await this.#path(input.path), { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        type: fileType(entry)
      }))
    );
  }
  mkdir(input: CoreFilePath & { readonly recursive?: boolean }, call: CoreOperationContext) {
    return this.#execute('mkdir', call, async () => {
      const path = await this.#path(input.path, true);
      call.signal.throwIfAborted();
      await mkdir(path, { recursive: input.recursive ?? false });
    });
  }
  remove(input: CoreFileRemove, call: CoreOperationContext) {
    return this.#execute('remove', call, async () => {
      const path = await this.#path(input.path, true);
      call.signal.throwIfAborted();
      await rm(path, { recursive: input.recursive ?? false, force: input.force ?? false });
    });
  }
  move(input: CoreFileTransfer, call: CoreOperationContext) {
    return this.#execute('move', call, async () => {
      const from = await this.#path(input.from, true);
      const to = await this.#path(input.to, true);
      call.signal.throwIfAborted();
      await rename(from, to);
    });
  }
  copy(input: CoreFileTransfer, call: CoreOperationContext) {
    return this.#execute('copy', call, async () => {
      const from = await this.#path(input.from);
      const to = await this.#path(input.to, true);
      call.signal.throwIfAborted();
      await copyFile(from, to);
    });
  }
  #validatePath(path: string): string {
    if (typeof path !== 'string')
      throw new MarAgentError('MAR_AGENT_FILE_INPUT_INVALID', 'File path must be a string.');
    return path;
  }
  #path(path: string, write = false): Promise<string> {
    return this.paths.resolve(this.#validatePath(path), write, write ? 'write' : 'read');
  }
  async #execute<Value>(
    operation: string,
    call: CoreOperationContext,
    action: () => Promise<Value>
  ): Promise<Value> {
    call.signal.throwIfAborted();
    try {
      return await action();
    } catch (cause) {
      call.signal.throwIfAborted();
      if (cause instanceof MarAgentError) throw cause;
      throw new MarAgentError('MAR_AGENT_FILE_OPERATION_FAILED', 'Native file operation failed.', {
        details: { operation, reason: (cause as NodeJS.ErrnoException).code ?? 'UNKNOWN' },
        cause
      });
    }
  }
}
function fileType(info: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): CoreFileType {
  return info.isSymbolicLink()
    ? 'symlink'
    : info.isFile()
      ? 'file'
      : info.isDirectory()
        ? 'directory'
        : 'other';
}
