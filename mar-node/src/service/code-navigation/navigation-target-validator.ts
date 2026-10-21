import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import type { PathSpecifierResolver } from './path-specifier-resolver.js';

const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const READ_BLOCK_BYTES = 4096;
const MAX_TARGET_PREVIEW_CHARACTERS = 512;

export interface NavigationTagRecord {
  readonly name: string;
  readonly path: string;
  readonly line: number;
  readonly kind: string | undefined;
  readonly scope: string | undefined;
}

export function sourceFileFingerprint(size: number, modifiedAt: number | null): string {
  return `${size}:${modifiedAt ?? -1}`;
}

export async function validateSymbolTarget(
  root: string,
  target: NavigationTagRecord,
  symbol: string,
  expectedFingerprint: string | undefined
): Promise<string | undefined> {
  const actual = await validatedFile(root, target.path, expectedFingerprint);
  if (actual === undefined) return undefined;
  const line = await lineAt(actual, target.line);
  return line !== undefined && containsSymbol(line, symbol) ? targetPreview(line) : undefined;
}

export async function validatePathTarget(
  root: string,
  path: string,
  expectedFingerprint: string | undefined,
  anchor: string | undefined,
  anchorLine: PathSpecifierResolver['anchorLine']
): Promise<{ readonly line: number; readonly preview: string } | undefined> {
  const actual = await validatedFile(root, path, expectedFingerprint);
  if (actual === undefined) return undefined;
  const line =
    anchor === undefined || anchorLine === undefined
      ? 1
      : anchorLine(await readFile(actual, 'utf8').catch(() => ''), anchor);
  if (line === undefined) return undefined;
  const preview = await lineAt(actual, line);
  return preview === undefined ? undefined : { line, preview };
}

async function validatedFile(
  root: string,
  path: string,
  expectedFingerprint: string | undefined
): Promise<string | undefined> {
  const requested = resolve(root, ...path.split('/'));
  const requestedMetadata = await lstat(requested).catch(() => undefined);
  if (
    requestedMetadata === undefined ||
    !requestedMetadata.isFile() ||
    requestedMetadata.isSymbolicLink() ||
    requestedMetadata.size > MAX_SOURCE_BYTES
  )
    return undefined;
  const actual = await realpath(requested).catch(() => undefined);
  if (
    actual === undefined ||
    relative(root, actual)
      .split(sep)
      .some((part) => part === '..')
  )
    return undefined;
  const metadata = await lstat(actual).catch(() => undefined);
  if (
    metadata === undefined ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > MAX_SOURCE_BYTES ||
    (expectedFingerprint !== undefined &&
      sourceFileFingerprint(metadata.size, metadata.mtimeMs) !== expectedFingerprint)
  )
    return undefined;
  return actual;
}

export function targetPreview(line: string): string {
  if (line.length <= MAX_TARGET_PREVIEW_CHARACTERS) return line;
  const contentLimit = MAX_TARGET_PREVIEW_CHARACTERS - 1;
  const end = line.charCodeAt(contentLimit - 1);
  const safeEnd = end >= 0xd800 && end <= 0xdbff ? contentLimit - 1 : contentLimit;
  return `${line.slice(0, safeEnd)}…`;
}

async function lineAt(path: string, targetLine: number): Promise<string | undefined> {
  const handle = await open(path, 'r');
  try {
    let offset = 0;
    let line = 1;
    let pending = Buffer.alloc(0);
    while (offset < MAX_SOURCE_BYTES) {
      const chunk = Buffer.alloc(READ_BLOCK_BYTES);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
      if (bytesRead === 0) return line === targetLine ? pending.toString('utf8') : undefined;
      offset += bytesRead;
      let content =
        pending.length === 0
          ? chunk.subarray(0, bytesRead)
          : Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      let newline: number;
      while ((newline = content.indexOf(0x0a)) >= 0) {
        if (line === targetLine) return content.subarray(0, newline).toString('utf8');
        line += 1;
        content = content.subarray(newline + 1);
      }
      pending = content;
    }
    return line === targetLine ? pending.toString('utf8') : undefined;
  } finally {
    await handle.close();
  }
}

export function containsSymbol(line: string, symbol: string): boolean {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const optionalScssPrefix = symbol.startsWith('$') ? '' : '\\$?';
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}_$])${optionalScssPrefix}${escaped}(?![\\p{L}\\p{N}_$])`,
    'u'
  ).test(line);
}

export function compareTargets(
  left: NavigationTagRecord,
  right: NavigationTagRecord,
  currentPath: string
): number {
  const leftScore = targetScore(left, currentPath);
  const rightScore = targetScore(right, currentPath);
  return (
    rightScore - leftScore ||
    left.path.localeCompare(right.path) ||
    left.line - right.line ||
    (left.kind ?? '').localeCompare(right.kind ?? '')
  );
}

function targetScore(target: NavigationTagRecord, currentPath: string): number {
  if (target.path === currentPath) return 100;
  const currentDirectory = currentPath.includes('/')
    ? currentPath.slice(0, currentPath.lastIndexOf('/'))
    : '';
  const targetDirectory = target.path.includes('/')
    ? target.path.slice(0, target.path.lastIndexOf('/'))
    : '';
  return commonPathSegments(currentDirectory, targetDirectory);
}

function commonPathSegments(left: string, right: string): number {
  const leftParts = left === '' ? [] : left.split('/');
  const rightParts = right === '' ? [] : right.split('/');
  let count = 0;
  while (count < leftParts.length && leftParts[count] === rightParts[count]) count += 1;
  return count;
}
