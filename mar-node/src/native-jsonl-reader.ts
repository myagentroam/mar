import { createHash } from 'node:crypto';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface JsonlWindow {
  readonly content: string;
  readonly truncated: boolean;
  readonly size: number;
}

export interface JsonlBackwardWindow extends JsonlWindow {
  readonly pageContent: string;
  readonly start: number;
  readonly end: number;
  readonly snapshotEnd: number;
  readonly fileAnchor: string;
  readonly anchorBytes: number;
}

export async function readJsonlFileAnchor(
  path: string,
  anchorBytes: number
): Promise<string | undefined> {
  try {
    const handle = await open(path, 'r');
    try {
      const metadata = await handle.stat();
      if (anchorBytes < 0 || anchorBytes > metadata.size) return undefined;
      return createHash('sha256')
        .update(await readAt(handle, anchorBytes, 0))
        .digest('base64url');
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/** Reads one newline-aligned window backwards from an opaque byte boundary. */
export async function readJsonlBackwardWindow(
  path: string,
  options: {
    readonly headBytes: number;
    readonly targetLines: number;
    readonly maxBytes: number;
    readonly page?: {
      readonly snapshotEnd: number;
      readonly nextEnd: number;
      readonly fileAnchor: string;
      readonly anchorBytes: number;
    };
  }
): Promise<JsonlBackwardWindow | undefined> {
  try {
    const handle = await open(path, 'r');
    try {
      const metadata = await handle.stat();
      const snapshotEnd = options.page?.snapshotEnd ?? metadata.size;
      if (snapshotEnd > metadata.size) return undefined;
      const anchorBytes = options.page?.anchorBytes ?? Math.min(4096, snapshotEnd);
      if (anchorBytes < 0 || anchorBytes > snapshotEnd) return undefined;
      const anchor = await readAt(handle, anchorBytes, 0);
      const fileAnchor = createHash('sha256').update(anchor).digest('base64url');
      if (options.page !== undefined && options.page.fileAnchor !== fileAnchor) return undefined;
      const headSize = Math.min(options.headBytes, snapshotEnd);
      const end = Math.min(Math.max(options.page?.nextEnd ?? snapshotEnd, headSize), snapshotEnd);
      const rawStart = Math.max(headSize, end - options.maxBytes);
      const head = await readAt(handle, headSize, 0);
      let tail = await readAt(handle, end - rawStart, rawStart);
      let start = rawStart;
      if (rawStart > headSize) {
        const newline = tail.indexOf(0x0a);
        if (newline < 0) {
          tail = Buffer.alloc(0);
          start = end;
        } else {
          start += newline + 1;
          tail = tail.subarray(newline + 1);
        }
      }
      if (tail.length > 0) {
        let lines = tail.at(-1) === 0x0a ? 0 : 1;
        for (let index = tail.length - 1; index >= 0; index -= 1) {
          if (tail[index] !== 0x0a) continue;
          lines += 1;
          if (lines <= options.targetLines) continue;
          start += index + 1;
          tail = tail.subarray(index + 1);
          break;
        }
      }
      const contiguous = start === headSize;
      return {
        content: contiguous
          ? Buffer.concat([head, tail]).toString('utf8')
          : `${head.toString('utf8')}${headSize > 0 && tail.length > 0 ? '\n' : ''}${tail.toString('utf8')}`,
        truncated: start > headSize,
        pageContent: tail.toString('utf8'),
        size: metadata.size,
        start,
        end,
        snapshotEnd,
        fileAnchor,
        anchorBytes
      };
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/** Reads bounded head/tail windows without ever loading an unbounded transcript. */
export async function readJsonlWindow(
  path: string,
  options: { readonly headBytes?: number; readonly tailBytes?: number }
): Promise<JsonlWindow | undefined> {
  try {
    const handle = await open(path, 'r');
    try {
      const metadata = await handle.stat();
      const headSize = Math.min(options.headBytes ?? 0, metadata.size);
      const remaining = metadata.size - headSize;
      const tailSize = Math.min(options.tailBytes ?? 0, remaining);
      const head = await readAt(handle, headSize, 0);
      const tailOffset = metadata.size - tailSize;
      const tail = await readAt(handle, tailSize, tailOffset);
      const contiguous = headSize > 0 && tailSize > 0 && tailOffset === headSize;
      return {
        content: contiguous
          ? Buffer.concat([head, tail]).toString('utf8')
          : `${head.toString('utf8')}${headSize > 0 && tailSize > 0 ? '\n' : ''}${tail.toString('utf8')}`,
        truncated: headSize + tailSize < metadata.size,
        size: metadata.size
      };
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/** Parses records one at a time, avoiding the allocation of a full line array. */
export function forEachJsonlRecord(
  content: string,
  visit: (record: Record<string, unknown>) => void
): void {
  let start = 0;
  while (start < content.length) {
    const newline = content.indexOf('\n', start);
    const end = newline < 0 ? content.length : newline;
    if (end > start) {
      try {
        const value: unknown = JSON.parse(content.slice(start, end));
        if (isRecord(value)) visit(value);
      } catch {
        // A partial or damaged record does not hide subsequent valid records.
      }
    }
    if (newline < 0) return;
    start = newline + 1;
  }
}

export async function listJsonlFiles(directory: string): Promise<readonly string[]> {
  const files: string[] = [];
  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path);
    }
  };
  await walk(directory);
  return files;
}

export async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T, index: number) => Promise<R>
): Promise<readonly R[]> {
  const results = Array<R>(values.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await map(values[index] as T, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, worker)
  );
  return results;
}

async function readAt(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
  position: number
): Promise<Buffer> {
  if (size === 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(size);
  const { bytesRead } = await handle.read(buffer, 0, size, position);
  return buffer.subarray(0, bytesRead);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
