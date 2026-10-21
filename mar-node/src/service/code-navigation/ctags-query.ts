import type { FileHandle } from 'node:fs/promises';
import type { NavigationTagRecord } from './navigation-target-validator.js';

const MAX_TAG_LINE_BYTES = 16 * 1024;
const READ_BLOCK_BYTES = 4096;

export async function firstTagOffset(
  handle: FileHandle,
  size: number,
  symbol: string
): Promise<number> {
  let low = 0;
  let high = size;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const start = await findTagLineStart(handle, middle);
    if (start === undefined) {
      high = middle;
      continue;
    }
    const line = await readTagLine(handle, start, size);
    if (line === undefined) {
      high = middle;
      continue;
    }
    const tag = parseTag(line.text);
    if (tag === undefined || compareTagNames(tag.name, symbol) < 0) low = line.nextOffset;
    else high = line.start;
  }
  return low;
}

async function findTagLineStart(handle: FileHandle, offset: number): Promise<number | undefined> {
  let cursor = offset;
  let scanned = 0;
  while (cursor > 0 && scanned < MAX_TAG_LINE_BYTES) {
    const start = Math.max(0, cursor - Math.min(READ_BLOCK_BYTES, MAX_TAG_LINE_BYTES - scanned));
    const chunk = Buffer.alloc(cursor - start);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, start);
    if (bytesRead === 0) return undefined;
    const newline = chunk.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (newline >= 0) return start + newline + 1;
    cursor = start;
    scanned += bytesRead;
  }
  return cursor === 0 ? 0 : undefined;
}

export async function readTagLine(
  handle: FileHandle,
  offset: number,
  size: number
): Promise<
  { readonly start: number; readonly nextOffset: number; readonly text: string } | undefined
> {
  if (offset >= size) return undefined;
  let start = offset;
  if (start > 0) {
    const before = Buffer.alloc(1);
    await handle.read(before, 0, 1, start - 1);
    if (before[0] !== 0x0a) {
      const aligned = await findNewline(handle, start, size, MAX_TAG_LINE_BYTES);
      if (aligned === undefined) return undefined;
      start = aligned + 1;
    }
  }
  if (start >= size) return undefined;
  const bytes: Buffer[] = [];
  let total = 0;
  let cursor = start;
  while (cursor < size && total <= MAX_TAG_LINE_BYTES) {
    const chunk = Buffer.alloc(Math.min(READ_BLOCK_BYTES, size - cursor));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, cursor);
    if (bytesRead === 0) break;
    const content = chunk.subarray(0, bytesRead);
    const newline = content.indexOf(0x0a);
    const part = newline >= 0 ? content.subarray(0, newline) : content;
    total += part.length;
    if (total > MAX_TAG_LINE_BYTES) return undefined;
    bytes.push(part);
    if (newline >= 0)
      return {
        start,
        nextOffset: cursor + newline + 1,
        text: Buffer.concat(bytes, total).toString('utf8')
      };
    cursor += bytesRead;
  }
  return undefined;
}

async function findNewline(
  handle: FileHandle,
  offset: number,
  size: number,
  limit: number
): Promise<number | undefined> {
  let cursor = offset;
  let remaining = limit;
  while (cursor < size && remaining > 0) {
    const chunk = Buffer.alloc(Math.min(READ_BLOCK_BYTES, size - cursor, remaining));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, cursor);
    if (bytesRead === 0) return undefined;
    const newline = chunk.subarray(0, bytesRead).indexOf(0x0a);
    if (newline >= 0) return cursor + newline;
    cursor += bytesRead;
    remaining -= bytesRead;
  }
  return undefined;
}

export function parseTag(text: string): NavigationTagRecord | undefined {
  if (
    text.length === 0 ||
    text.startsWith('!_TAG_') ||
    Buffer.byteLength(text) > MAX_TAG_LINE_BYTES
  )
    return undefined;
  const fields = text.split('\t');
  if (fields.length < 3) return undefined;
  const [name, path, excmd, ...extensions] = fields;
  if (
    name === undefined ||
    path === undefined ||
    excmd === undefined ||
    name.length === 0 ||
    path.length === 0 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    return undefined;
  const match = /^([1-9][0-9]*);?"?$/u.exec(excmd);
  if (match === null) return undefined;
  const line = Number(match[1]);
  if (!Number.isSafeInteger(line) || line < 1) return undefined;
  let kind: string | undefined;
  let scope: string | undefined;
  for (const extension of extensions) {
    if (extension.length === 1) kind ??= extension;
    else if (extension.startsWith('kind:')) kind ??= extension.slice('kind:'.length);
    else if (
      extension.startsWith('scope:') ||
      extension.startsWith('class:') ||
      extension.startsWith('namespace:')
    )
      scope ??= extension.slice(extension.indexOf(':') + 1);
  }
  return { name, path, line, kind, scope };
}

export function compareTagNames(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
