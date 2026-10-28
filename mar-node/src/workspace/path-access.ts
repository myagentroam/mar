import type { Stats } from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import { platform as hostPlatform } from 'node:os';
import { isAbsolute, posix, relative, resolve, sep, win32 } from 'node:path';

export async function resolveNewWorkspaceEntry(
  root: string,
  requestedPath: string
): Promise<string> {
  const normalized = requestedPath.replaceAll('\\', '/');
  const segments = normalized.split('/');
  const name = segments.at(-1);
  if (
    requestedPath.includes('\0') ||
    normalized.startsWith('/') ||
    isAbsolute(requestedPath) ||
    win32.isAbsolute(normalized) ||
    name === undefined ||
    name.length === 0 ||
    segments.some(invalidWorkspaceMutationSegment)
  )
    throw new Error('FILE_PATH_ESCAPE');
  const parentPath = segments.length === 1 ? '.' : segments.slice(0, -1).join('/');
  await assertWorkspaceMutationPathHasNoSymlinks(root, parentPath);
  const parent = await resolveWorkspaceEntryFromCanonicalRoot(root, parentPath, true);
  const target = resolve(parent, name);
  try {
    await lstat(target);
    throw new Error('FILE_ALREADY_EXISTS');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return target;
}

export async function assertWorkspaceMutationPathHasNoSymlinks(
  root: string,
  requestedPath: string
): Promise<void> {
  const normalized = requestedPath.replaceAll('\\', '/');
  if (normalized === '.') return;
  const segments = normalized.split('/');
  if (
    requestedPath.includes('\0') ||
    normalized.startsWith('/') ||
    isAbsolute(requestedPath) ||
    win32.isAbsolute(normalized) ||
    segments.some(invalidWorkspaceMutationSegment)
  )
    throw new Error('FILE_PATH_ESCAPE');
  let candidate = root;
  for (const segment of segments) {
    candidate = resolve(candidate, segment);
    const metadata = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new Error('FILE_NOT_FOUND');
      throw error;
    });
    if (metadata.isSymbolicLink()) throw new Error('FILE_PATH_ESCAPE');
  }
}

function invalidWorkspaceMutationSegment(segment: string): boolean {
  if (segment.length === 0 || segment === '.' || segment === '..' || segment === '.git')
    return true;
  if (hostPlatform() !== 'win32') return false;
  const normalized = segment.replace(/[. ]+$/u, '').toUpperCase();
  return (
    /[<>:"|?*]/u.test(segment) ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/u.test(normalized)
  );
}

export async function resolveRegisteredWorkspaceRoot(workspaceRoot: string): Promise<string> {
  const root = await realpath(workspaceRoot);
  if (normalizeWorkspacePath(root) !== normalizeWorkspacePath(workspaceRoot))
    throw Object.assign(new Error('WORKSPACE_NOT_ALLOWED'), { code: 'WORKSPACE_NOT_ALLOWED' });
  return root;
}

export class SessionExecutionDirectoryError extends Error {
  readonly code = 'SESSION_EXECUTION_DIRECTORY_INVALID';
  readonly publicParameters: { readonly reason: string };

  constructor(
    reason: string,
    readonly publicMessage: string,
    options?: ErrorOptions
  ) {
    super(publicMessage, options);
    this.publicParameters = { reason };
  }
}

/** Bind ordinary Session execution to one registered Workspace, not all allowed roots. */
export async function resolveWorkspaceExecutionDirectory(
  workspaceRoot: string,
  cwd: string
): Promise<string> {
  if (!isAbsolute(cwd) || (process.platform === 'win32' && win32.parse(cwd).root.length <= 1))
    throw new SessionExecutionDirectoryError(
      'ABSOLUTE_PATH_REQUIRED',
      'The execution directory must be an absolute path on this Node.'
    );
  try {
    const root = await resolveRegisteredWorkspaceRoot(workspaceRoot);
    const directory = await realpath(cwd);
    if (!isWithinAllowedRoot(directory, [root]))
      throw new SessionExecutionDirectoryError(
        'OUTSIDE_WORKSPACE',
        'The execution directory is outside the authorized Workspace.'
      );
    if (!(await stat(directory)).isDirectory())
      throw new SessionExecutionDirectoryError(
        'NOT_DIRECTORY',
        'The execution directory is not a directory.'
      );
    return directory;
  } catch (error) {
    if (error instanceof SessionExecutionDirectoryError) throw error;
    const code =
      error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
    const [reason, message] =
      code === 'WORKSPACE_NOT_ALLOWED'
        ? [
            'WORKSPACE_ROOT_CHANGED',
            'The registered Workspace root no longer identifies the same directory.'
          ]
        : code === 'ENOENT' || code === 'ENOTDIR'
          ? ['NOT_FOUND', 'The execution directory or Workspace root is unavailable.']
          : code === 'EACCES' || code === 'EPERM'
            ? [
                'ACCESS_DENIED',
                'The Node account cannot access the execution directory or Workspace root.'
              ]
            : ['IO_ERROR', 'The execution directory could not be verified.'];
    throw new SessionExecutionDirectoryError(reason!, message!, { cause: error });
  }
}

export async function resolveWorkspaceEntry(
  workspaceRoot: string,
  requestedPath: string,
  directory: boolean
): Promise<string> {
  const root = await resolveRegisteredWorkspaceRoot(workspaceRoot);
  return resolveWorkspaceEntryFromCanonicalRoot(root, requestedPath, directory);
}

export async function resolveWorkspaceEntryFromCanonicalRoot(
  root: string,
  requestedPath: string,
  directory: boolean
): Promise<string> {
  const entry = await resolveWorkspaceEntryMetadata(root, requestedPath);
  if (
    directory
      ? !entry.metadata.isDirectory()
      : !entry.metadata.isFile() && !entry.metadata.isDirectory()
  )
    throw new Error(directory ? 'FILE_NOT_DIRECTORY' : 'FILE_NOT_REGULAR');
  return entry.path;
}

export async function resolveWorkspaceEntryMetadata(
  root: string,
  requestedPath: string
): Promise<{ readonly path: string; readonly metadata: Stats }> {
  if (
    requestedPath.includes('\0') ||
    requestedPath.length === 0 ||
    requestedPath.startsWith('/') ||
    requestedPath.startsWith('\\')
  )
    throw new Error('FILE_PATH_ESCAPE');
  const normalized = requestedPath.replaceAll('\\', '/');
  if (normalized.split('/').some((segment) => segment === '..' || segment === '.git'))
    throw new Error('FILE_PATH_ESCAPE');
  let candidate: string;
  try {
    candidate = await realpath(resolve(root, normalized));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('FILE_NOT_FOUND');
    throw error;
  }
  const pathToCandidate = relative(root, candidate);
  if (
    isAbsolute(pathToCandidate) ||
    pathToCandidate.startsWith('..') ||
    pathToCandidate === '..' ||
    pathToCandidate.startsWith(`..${sep}`)
  )
    throw new Error('FILE_PATH_ESCAPE');
  const metadata = await lstat(candidate);
  return { path: candidate, metadata };
}

export function normalizeWorkspacePath(
  input: string,
  platform: NodeJS.Platform = hostPlatform()
): string {
  if (input.length === 0 || input.includes('\u0000')) {
    throw new Error('WORKSPACE_PATH_INVALID');
  }
  if (platform === 'win32') {
    // Device paths bypass normal Win32 resolution and must never be accepted.
    if (/^\\\\[?.]/.test(input)) {
      throw new Error('WORKSPACE_DEVICE_PATH_REJECTED');
    }
    const normalized = win32.normalize(input.replaceAll('/', '\\'));
    if (!win32.isAbsolute(normalized)) {
      throw new Error('WORKSPACE_PATH_NOT_ABSOLUTE');
    }
    // A drive root must remain absolute instead of becoming drive-relative.
    const root = win32.parse(normalized).root;
    return (normalized === root ? root : normalized.replace(/\\+$/, '')).toLowerCase();
  }
  if (platform !== 'linux' && platform !== 'darwin') {
    throw new Error('WORKSPACE_PLATFORM_UNSUPPORTED');
  }
  const normalized = posix.normalize(input);
  if (!posix.isAbsolute(normalized)) {
    throw new Error('WORKSPACE_PATH_NOT_ABSOLUTE');
  }
  return normalized === '/' ? normalized : normalized.replace(/\/+$/, '');
}

export function isWithinAllowedRoot(
  target: string,
  roots: readonly string[],
  platform: NodeJS.Platform = hostPlatform()
): boolean {
  const normalizedTarget = normalizeWorkspacePath(target, platform);
  const pathApi = platform === 'win32' ? win32 : posix;
  return roots.some((root) => {
    const normalizedRoot = normalizeWorkspacePath(root, platform);
    const relative = pathApi.relative(normalizedRoot, normalizedTarget);
    return relative === '' || (!relative.startsWith('..') && !pathApi.isAbsolute(relative));
  });
}
