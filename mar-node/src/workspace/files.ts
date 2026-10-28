import { isUtf8ContinuationByte, isValidUtf8 } from './utf8.js';
import type { WorkspaceFileEntry, WorkspaceFilePage } from './contracts.js';
import {
  assertWorkspaceMutationPathHasNoSymlinks,
  isWithinAllowedRoot,
  resolveNewWorkspaceEntry,
  resolveRegisteredWorkspaceRoot,
  resolveWorkspaceEntry,
  resolveWorkspaceEntryFromCanonicalRoot,
  resolveWorkspaceEntryMetadata
} from './path-access.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path';

const FILE_READ_LIMIT = 512 * 1024;
const DIRECTORY_PAGE_LIMIT = 200;
const DIRECTORY_PICKER_LIMIT = 200;

export type WorkspaceUploadPreflightStatus =
  'READY' | 'EXISTS_FILE' | 'EXISTS_DIRECTORY' | 'INVALID_NAME';

export interface WorkspaceUploadTarget {
  readonly path: string;
  readonly absolutePath: string;
  readonly status: WorkspaceUploadPreflightStatus;
}

export interface WorkspaceDirectoryEntry {
  readonly path: string;
  readonly name: string;
  readonly selectable: boolean;
}

export interface WorkspaceDirectoryListing {
  readonly homePath: string;
  readonly currentPath: string;
  readonly parentPath: string | null;
  readonly browseRoots: readonly string[];
  readonly selectable: boolean;
  readonly entries: readonly WorkspaceDirectoryEntry[];
  readonly truncated: boolean;
}

export async function createWorkspaceDirectory(
  parentPath: string,
  directoryName: string,
  allowedRoots: readonly string[]
): Promise<string> {
  const name = directoryName.trim();
  if (
    name.length === 0 ||
    name.length > 255 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  )
    throw new Error('WORKSPACE_DIRECTORY_NAME_INVALID');
  const roots = await Promise.all(allowedRoots.map((root) => realpath(root)));
  const parent = await realpath(parentPath).catch(() => {
    throw new Error('WORKSPACE_DIRECTORY_NOT_ALLOWED');
  });
  const metadata = await stat(parent).catch(() => undefined);
  if (metadata?.isDirectory() !== true || !isWithinAllowedRoot(parent, roots))
    throw new Error('WORKSPACE_DIRECTORY_NOT_ALLOWED');
  const target = resolve(parent, name);
  if (dirname(target) !== parent || !isWithinAllowedRoot(target, roots))
    throw new Error('WORKSPACE_DIRECTORY_NAME_INVALID');
  try {
    await mkdir(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error('WORKSPACE_DIRECTORY_EXISTS');
    throw error;
  }
  return target;
}

/**
 * Lists directory names only for the Workspace picker. Browsing begins at the
 * first allowed root when configured, while the Node account home remains a
 * browse boundary and terminal default.
 */
export async function listWorkspaceDirectories(
  requestedPath: string | undefined,
  allowedRoots: readonly string[],
  homePath = homedir()
): Promise<WorkspaceDirectoryListing> {
  const home = await realpath(homePath);
  const roots = await Promise.all(allowedRoots.map((root) => realpath(root)));
  const browseRoots = [...new Set([home, ...roots])];
  const requested =
    requestedPath === undefined ? (roots[0] ?? home) : await realpath(requestedPath);
  const directory = await stat(requested);
  if (!directory.isDirectory() || !isWithinAllowedRoot(requested, browseRoots))
    throw new Error('WORKSPACE_DIRECTORY_NOT_ALLOWED');

  const children = await readdir(requested, { withFileTypes: true });
  const entries: WorkspaceDirectoryEntry[] = [];
  for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!child.isDirectory() && !child.isSymbolicLink()) continue;
    const path = await realpath(resolve(requested, child.name)).catch(() => undefined);
    if (path === undefined || !isWithinAllowedRoot(path, browseRoots)) continue;
    const metadata = await stat(path).catch(() => undefined);
    if (metadata === undefined || !metadata.isDirectory()) continue;
    entries.push({ path, name: child.name, selectable: isWithinAllowedRoot(path, roots) });
    if (entries.length > DIRECTORY_PICKER_LIMIT) break;
  }
  const parent = dirname(requested);
  return {
    homePath: home,
    currentPath: requested,
    parentPath: parent === requested || !isWithinAllowedRoot(parent, browseRoots) ? null : parent,
    browseRoots: roots,
    selectable: isWithinAllowedRoot(requested, roots),
    entries: entries.slice(0, DIRECTORY_PICKER_LIMIT),
    truncated: entries.length > DIRECTORY_PICKER_LIMIT
  };
}

export async function listWorkspaceFiles(
  workspaceRoot: string,
  requestedPath = '.',
  cursor?: string,
  limit = DIRECTORY_PAGE_LIMIT
): Promise<WorkspaceFilePage> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DIRECTORY_PAGE_LIMIT)
    throw new Error('DIRECTORY_CURSOR_INVALID');
  const root = await resolveRegisteredWorkspaceRoot(workspaceRoot);
  const directory = await resolveWorkspaceEntryFromCanonicalRoot(root, requestedPath, true);
  const entries = await readdir(directory, { withFileTypes: true });
  const cursorValue = decodeDirectoryCursor(cursor, requestedPath);
  const names = entries
    .filter((entry) => entry.name !== '.git' && !isWorkspaceUploadTemporaryName(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const start = cursorValue === undefined ? 0 : names.findIndex((name) => name > cursorValue);
  if (cursorValue !== undefined && start === -1)
    return { entries: [], nextCursor: null, truncated: false };
  const pageNames = names.slice(start, start + limit);
  const output: WorkspaceFileEntry[] = [];
  for (const name of pageNames) {
    const child = await resolveWorkspaceEntry(
      root,
      relative(root, resolve(directory, name)),
      false
    ).catch((error: unknown) => {
      if (isSkippableWorkspaceEntryError(error)) return undefined;
      throw error;
    });
    if (child === undefined) continue;
    const metadata = await lstat(child).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (metadata === undefined || (!metadata.isFile() && !metadata.isDirectory())) continue;
    output.push({
      path: relative(root, child).split(sep).join('/'),
      name,
      kind: metadata.isDirectory() ? 'DIRECTORY' : 'FILE',
      size: metadata.isFile() ? metadata.size : null,
      modifiedAt: metadata.mtimeMs
    });
  }
  const nextName = names[start + pageNames.length];
  return {
    entries: output,
    nextCursor:
      nextName === undefined || pageNames.length === 0
        ? null
        : encodeDirectoryCursor(requestedPath, pageNames[pageNames.length - 1] as string),
    truncated: nextName !== undefined
  };
}

export type WorkspaceFileMutation =
  | { readonly action: 'CREATE_FILE'; readonly path: string }
  | { readonly action: 'CREATE_DIRECTORY'; readonly path: string }
  | { readonly action: 'MOVE'; readonly path: string; readonly destination: string }
  | { readonly action: 'DELETE'; readonly path: string };

export async function mutateWorkspaceFile(
  workspaceRoot: string,
  mutation: WorkspaceFileMutation
): Promise<{ readonly path?: string; readonly deleted?: true }> {
  const root = await resolveRegisteredWorkspaceRoot(workspaceRoot);
  if (mutation.action === 'CREATE_FILE' || mutation.action === 'CREATE_DIRECTORY') {
    const target = await resolveNewWorkspaceEntry(root, mutation.path);
    if (mutation.action === 'CREATE_FILE') await writeFile(target, '', { flag: 'wx' });
    else await mkdir(target);
    return { path: workspaceRelativePath(root, target) };
  }
  await assertWorkspaceMutationPathHasNoSymlinks(root, mutation.path);
  const source = await resolveWorkspaceEntryMetadata(root, mutation.path);
  if (workspaceRelativePath(root, source.path) === '.')
    throw new Error('FILE_ROOT_MUTATION_INVALID');
  if (mutation.action === 'DELETE') {
    await rm(source.path, { recursive: source.metadata.isDirectory(), force: false });
    return { deleted: true };
  }
  const destination = await resolveNewWorkspaceEntry(root, mutation.destination);
  if (source.metadata.isDirectory()) {
    const destinationFromSource = relative(source.path, destination);
    if (
      destinationFromSource === '' ||
      (!isAbsolute(destinationFromSource) &&
        destinationFromSource !== '..' &&
        !destinationFromSource.startsWith(`..${sep}`))
    )
      throw new Error('FILE_MOVE_DESCENDANT_INVALID');
  }
  await rename(source.path, destination);
  return { path: workspaceRelativePath(root, destination) };
}

function workspaceRelativePath(root: string, path: string): string {
  const value = relative(root, path).split(sep).join('/');
  return value.length === 0 ? '.' : value;
}

function isSkippableWorkspaceEntryError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === 'FILE_PATH_ESCAPE' ||
      error.message === 'FILE_NOT_FOUND' ||
      error.message === 'FILE_NOT_REGULAR')
  );
}

/** Validates an upload destination without following an existing target symlink. */
export async function preflightWorkspaceUpload(
  workspaceRoot: string,
  requestedDirectory: string,
  name: string
): Promise<WorkspaceUploadTarget> {
  if (
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    name.includes('\0') ||
    name.includes('/') ||
    name.includes('\\') ||
    isWorkspaceUploadTemporaryName(name)
  ) {
    return { path: '', absolutePath: '', status: 'INVALID_NAME' };
  }
  const root = await resolveRegisteredWorkspaceRoot(workspaceRoot);
  const directory = await resolveWorkspaceEntry(root, requestedDirectory, true);
  const absolutePath = resolve(directory, name);
  if (dirname(absolutePath) !== directory) throw new Error('FILE_PATH_ESCAPE');
  const relativePath = relative(root, absolutePath).split(sep).join('/');
  const metadata = await lstat(absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (metadata === undefined) return { path: relativePath, absolutePath, status: 'READY' };
  if (metadata.isSymbolicLink()) throw new Error('FILE_PATH_ESCAPE');
  if (metadata.isFile()) return { path: relativePath, absolutePath, status: 'EXISTS_FILE' };
  return { path: relativePath, absolutePath, status: 'EXISTS_DIRECTORY' };
}

export function workspaceUploadTemporaryName(uploadId: string): string {
  return `.mar-upload-${uploadId}.part`;
}

function isWorkspaceUploadTemporaryName(name: string): boolean {
  return (
    /^\.mar-upload-[0-9a-f-]{36}\.part$/iu.test(name) ||
    /^\.mar-edit-[0-9a-f-]{36}\.part$/iu.test(name)
  );
}

export async function readWorkspaceTextFile(
  workspaceRoot: string,
  requestedPath: string,
  offset = 0,
  limit = FILE_READ_LIMIT
): Promise<{
  readonly path: string;
  readonly encoding: 'utf-8' | 'base64';
  readonly size: number;
  readonly content: string;
  readonly truncated: boolean;
  readonly nextOffset: number | null;
  readonly revision: string;
}> {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > FILE_READ_LIMIT
  )
    throw new Error('FILE_RANGE_INVALID');
  const root = await resolveRegisteredWorkspaceRoot(workspaceRoot);
  const file = await resolveWorkspaceEntry(root, requestedPath, false);
  const metadata = await lstat(file);
  if (!metadata.isFile()) throw new Error('FILE_NOT_REGULAR');
  if (metadata.size > FILE_READ_LIMIT * 16) throw new Error('FILE_TOO_LARGE');
  const source = await readFile(file);
  const revision = createHash('sha256').update(source).digest('hex');
  const binary = source.includes(0) || !isValidUtf8(source);
  if (binary) {
    const end = Math.min(source.length, offset + limit);
    const slice = source.subarray(offset, end);
    return {
      path: relative(root, file).split(sep).join('/'),
      encoding: 'base64',
      size: source.length,
      content: slice.toString('base64'),
      truncated: end < source.length,
      nextOffset: end < source.length ? end : null,
      revision
    };
  }
  if (offset > 0 && offset < source.length && isUtf8ContinuationByte(source[offset] as number))
    throw new Error('FILE_RANGE_INVALID');
  let end = Math.min(source.length, offset + limit);
  if (end < source.length && isUtf8ContinuationByte(source[end] as number)) {
    while (end > offset && isUtf8ContinuationByte(source[end] as number)) end -= 1;
    if (end === offset) {
      end += 1;
      while (end < source.length && isUtf8ContinuationByte(source[end] as number)) end += 1;
    }
  }
  const slice = source.subarray(offset, end);
  const content = new TextDecoder('utf-8', { fatal: true }).decode(slice);
  const nextOffset = end < source.length ? end : null;
  return {
    path: relative(root, file).split(sep).join('/'),
    encoding: 'utf-8',
    size: source.length,
    content,
    truncated: nextOffset !== null,
    nextOffset,
    revision
  };
}

export async function writeWorkspaceTextFile(
  workspaceRoot: string,
  requestedPath: string,
  content: string,
  expectedRevision: string
): Promise<{ readonly path: string; readonly revision: string; readonly size: number }> {
  if (!/^[0-9a-f]{64}$/u.test(expectedRevision)) throw new Error('FILE_REVISION_INVALID');
  const source = Buffer.from(content, 'utf8');
  if (source.length > FILE_READ_LIMIT * 16) throw new Error('FILE_TOO_LARGE');
  if (source.includes(0)) throw new Error('FILE_NOT_TEXT');
  const root = await resolveRegisteredWorkspaceRoot(workspaceRoot);
  await assertWorkspaceMutationPathHasNoSymlinks(root, requestedPath);
  const file = await resolveWorkspaceEntry(root, requestedPath, false);
  const metadata = await lstat(file);
  if (!metadata.isFile()) throw new Error('FILE_NOT_REGULAR');
  const current = await readFile(file);
  if (current.includes(0) || !isValidUtf8(current)) throw new Error('FILE_NOT_TEXT');
  const currentRevision = createHash('sha256').update(current).digest('hex');
  if (currentRevision !== expectedRevision) throw new Error('FILE_WRITE_CONFLICT');
  const revision = createHash('sha256').update(source).digest('hex');
  const staging = resolve(dirname(file), `.mar-edit-${randomUUID()}.part`);
  try {
    await writeFile(staging, source, { flag: 'wx', mode: metadata.mode });
    await rename(staging, file);
  } finally {
    await rm(staging, { force: true }).catch(() => undefined);
  }
  return { path: workspaceRelativePath(root, file), revision, size: source.length };
}

export async function readWorkspaceFileContentRange(
  workspaceRoot: string,
  requestedPath: string,
  offset = 0,
  limit = FILE_READ_LIMIT
): Promise<{
  readonly path: string;
  readonly size: number;
  readonly sourceRevision: string;
  readonly offset: number;
  readonly contentBase64: string;
  readonly nextOffset: number | null;
}> {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > FILE_READ_LIMIT
  )
    throw new Error('FILE_RANGE_INVALID');
  const root = await resolveRegisteredWorkspaceRoot(workspaceRoot);
  const file = await resolveWorkspaceEntry(root, requestedPath, false);
  const metadata = await lstat(file);
  if (!metadata.isFile()) throw new Error('FILE_NOT_REGULAR');
  if (offset > metadata.size) throw new Error('FILE_RANGE_INVALID');
  const length = Math.min(limit, metadata.size - offset);
  const source = Buffer.allocUnsafe(length);
  const handle = await open(file, 'r');
  try {
    const { bytesRead } = await handle.read(source, 0, length, offset);
    const end = offset + bytesRead;
    return {
      path: relative(root, file).split(sep).join('/'),
      size: metadata.size,
      sourceRevision: fileSourceRevision(metadata),
      offset,
      contentBase64: source.subarray(0, bytesRead).toString('base64'),
      nextOffset: end < metadata.size ? end : null
    };
  } finally {
    await handle.close();
  }
}

/** Reads one regular absolute file range using the Node account's filesystem permissions. */
export async function readAbsoluteFileContentRange(
  requestedPath: string,
  offset = 0,
  limit = FILE_READ_LIMIT
): Promise<{
  readonly path: string;
  readonly size: number;
  readonly sourceRevision: string;
  readonly offset: number;
  readonly contentBase64: string;
  readonly nextOffset: number | null;
}> {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > FILE_READ_LIMIT
  )
    throw new Error('FILE_RANGE_INVALID');
  const { file, metadata } = await resolveAbsoluteFile(requestedPath);
  if (offset > metadata.size) throw new Error('FILE_RANGE_INVALID');
  const length = Math.min(limit, metadata.size - offset);
  const source = Buffer.allocUnsafe(length);
  const handle = await open(file, 'r');
  try {
    const { bytesRead } = await handle.read(source, 0, length, offset);
    const end = offset + bytesRead;
    return {
      path: file,
      size: metadata.size,
      sourceRevision: fileSourceRevision(metadata),
      offset,
      contentBase64: source.subarray(0, bytesRead).toString('base64'),
      nextOffset: end < metadata.size ? end : null
    };
  } finally {
    await handle.close();
  }
}

function fileSourceRevision(metadata: Stats): string {
  return createHash('sha256')
    .update(
      [metadata.dev, metadata.ino, metadata.size, metadata.mtimeMs, metadata.ctimeMs].join(':')
    )
    .digest('hex');
}

/** Reads one regular absolute file using the Node account's filesystem permissions. */
export async function readAbsoluteTextFile(
  requestedPath: string,
  offset = 0,
  limit = FILE_READ_LIMIT
): Promise<{
  readonly path: string;
  readonly encoding: 'utf-8' | 'base64';
  readonly size: number;
  readonly content: string;
  readonly truncated: boolean;
  readonly nextOffset: number | null;
}> {
  const { file, metadata } = await resolveAbsoluteFile(requestedPath);
  if (metadata.size > FILE_READ_LIMIT * 16) throw new Error('FILE_TOO_LARGE');
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > FILE_READ_LIMIT
  )
    throw new Error('FILE_RANGE_INVALID');
  const source = await readFile(file);
  const binary = source.includes(0) || !isValidUtf8(source);
  const end = Math.min(source.length, offset + limit);
  if (binary) {
    const slice = source.subarray(offset, end);
    return {
      path: file,
      encoding: 'base64',
      size: source.length,
      content: slice.toString('base64'),
      truncated: end < source.length,
      nextOffset: end < source.length ? end : null
    };
  }
  if (offset > 0 && offset < source.length && isUtf8ContinuationByte(source[offset] as number))
    throw new Error('FILE_RANGE_INVALID');
  let textEnd = end;
  if (textEnd < source.length && isUtf8ContinuationByte(source[textEnd] as number)) {
    while (textEnd > offset && isUtf8ContinuationByte(source[textEnd] as number)) textEnd -= 1;
    if (textEnd === offset) {
      textEnd += 1;
      while (textEnd < source.length && isUtf8ContinuationByte(source[textEnd] as number))
        textEnd += 1;
    }
  }
  const nextOffset = textEnd < source.length ? textEnd : null;
  return {
    path: file,
    encoding: 'utf-8',
    size: source.length,
    content: new TextDecoder('utf-8', { fatal: true }).decode(source.subarray(offset, textEnd)),
    truncated: nextOffset !== null,
    nextOffset
  };
}

export function normalizeFilePreviewPath(requestedPath: string): string {
  if (!/^sandbox:/iu.test(requestedPath)) return requestedPath;
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestedPath.slice(requestedPath.indexOf(':') + 1));
  } catch {
    throw new Error('FILE_PATH_ESCAPE');
  }
  const normalized = decoded.replace(/^\/([a-z]:[\\/])/iu, '$1');
  if (
    normalized.length === 0 ||
    /^[\\/]{2,}[?.](?:[\\/]|$)/u.test(decoded) ||
    (!isAbsolute(normalized) && !win32.isAbsolute(normalized)) ||
    normalized.includes('\0') ||
    normalized.includes('?') ||
    normalized.includes('#')
  )
    throw new Error('FILE_PATH_ESCAPE');
  return normalized;
}

async function resolveAbsoluteFile(
  requestedPath: string
): Promise<{ readonly file: string; readonly metadata: Stats }> {
  if (!isAbsolute(requestedPath)) throw new Error('FILE_PATH_ESCAPE');
  const file = await realpath(requestedPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new Error('FILE_NOT_FOUND');
    throw error;
  });
  const metadata = await lstat(file);
  if (!metadata.isFile()) throw new Error('FILE_NOT_REGULAR');
  return { file, metadata };
}

export async function resolveWorkspaceFileManagerTarget(
  workspaceRoot: string,
  requestedPath: string
): Promise<{ readonly path: string; readonly kind: 'FILE' | 'DIRECTORY' }> {
  const root = await resolveRegisteredWorkspaceRoot(workspaceRoot);
  const entry = await resolveWorkspaceEntryMetadata(root, requestedPath);
  if (entry.metadata.isDirectory()) return { path: entry.path, kind: 'DIRECTORY' };
  if (entry.metadata.isFile()) return { path: entry.path, kind: 'FILE' };
  throw new Error('FILE_NOT_REGULAR');
}

function encodeDirectoryCursor(path: string, name: string): string {
  return Buffer.from(JSON.stringify({ path, name })).toString('base64url');
}

function decodeDirectoryCursor(
  cursor: string | undefined,
  expectedPath: string
): string | undefined {
  if (cursor === undefined) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      typeof value !== 'object' ||
      value === null ||
      (value as Record<string, unknown>).path !== expectedPath ||
      typeof (value as Record<string, unknown>).name !== 'string'
    )
      throw new Error();
    return (value as { name: string }).name;
  } catch {
    throw new Error('DIRECTORY_CURSOR_INVALID');
  }
}

/** Resolving both candidate and roots rejects Linux symlinks which point outside a root. */
