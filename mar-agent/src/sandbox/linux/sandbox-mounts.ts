import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { AgentError } from '../../error.js';
import type { LocalProcessSpawnRequest } from '../../process/contracts.js';
import type {
  BubblewrapSandboxProfile,
  BubblewrapSandboxExecutorOptions,
  LinuxSandboxMount
} from './profile.js';
import { policyInvalid } from './sandbox-error.js';

const GENERATED_IMAGES_SANDBOX_ROOT = '/home/mar/.mar/agent/sessions';

const RESERVED_SANDBOX_ROOTS = [
  '/home/mar',
  '/runtime',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/etc',
  '/proc',
  '/dev',
  '/run',
  '/tmp'
] as const;

export interface SandboxMount {
  readonly source: string;
  readonly destination: string;
  readonly access: LinuxSandboxMount['access'];
}

export async function resolveMounts(
  profile: BubblewrapSandboxProfile
): Promise<readonly SandboxMount[]> {
  const mounts: SandboxMount[] = [];
  for (const definition of profile.mounts ?? []) {
    mounts.push({
      source: await secureDirectory(definition.source),
      destination: sandboxDestination(definition.destination, definition.access),
      access: definition.access
    });
  }
  if (profile.temporaryDirectory?.kind === 'MOUNT')
    mounts.push({
      source: await secureDirectory(profile.temporaryDirectory.source),
      destination: '/tmp',
      access: 'READ_WRITE'
    });
  for (const [index, mount] of mounts.entries()) {
    for (const other of mounts.slice(index + 1)) {
      if (mount.destination === other.destination) throw policyInvalid();
      const parent = withinSandboxPath(mount.destination, other.destination)
        ? mount
        : withinSandboxPath(other.destination, mount.destination)
          ? other
          : undefined;
      if (parent !== undefined) {
        const child = parent === mount ? other : mount;
        if (parent.access !== 'READ_ONLY' || child.access !== 'READ_WRITE') throw policyInvalid();
      }
      if (mount.source === other.source) {
        if (mount.access !== other.access) throw policyInvalid();
        continue;
      }
      if (within(mount.source, other.source) || within(other.source, mount.source))
        throw policyInvalid();
    }
  }
  const ordered = [...mounts].sort(compareMountDestinations);
  await prepareNestedMountDestinations(ordered);
  return ordered;
}

async function secureDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw policyInvalid();
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw policyInvalid();
    const canonical = await realpath(path);
    if (canonical !== resolve(path)) throw policyInvalid();
    return canonical;
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw policyInvalid(error);
  }
}

export async function workingDirectory(
  request: LocalProcessSpawnRequest,
  mounts: readonly SandboxMount[],
  configuration: BubblewrapSandboxExecutorOptions['profile']['workingDirectory']
): Promise<string> {
  const selected = configuration ?? { kind: 'SANDBOX', path: '/tmp' };
  if (selected.kind === 'REQUEST') return await sandboxPath(request.cwd, mounts);
  const path = normalizedSandboxPath(selected.path);
  if (path === '/tmp' || path === '/home/mar') return path;
  const mount = [...mounts]
    .sort((left, right) => right.destination.length - left.destination.length)
    .find(
      (candidate) =>
        path === candidate.destination || withinSandboxPath(candidate.destination, path)
    );
  if (mount === undefined) throw policyInvalid();
  const suffix = posix.relative(mount.destination, path).split('/').filter(Boolean);
  await secureDirectory(join(mount.source, ...suffix));
  return path;
}

async function sandboxPath(path: string, mounts: readonly SandboxMount[]): Promise<string> {
  const canonical = await secureDirectory(path);
  const mount = [...mounts]
    .sort((left, right) => right.source.length - left.source.length)
    .find((candidate) => canonical === candidate.source || within(candidate.source, canonical));
  if (mount === undefined) throw policyInvalid();
  const suffix = relative(mount.source, canonical).split(sep).filter(Boolean);
  return suffix.length === 0 ? mount.destination : posix.join(mount.destination, ...suffix);
}

function sandboxDestination(path: string, access: LinuxSandboxMount['access']): string {
  const normalized = normalizedSandboxPath(path);
  if (generatedImagesSandboxPath(normalized)) {
    if (access !== 'READ_ONLY') throw policyInvalid();
    return normalized;
  }
  if (
    normalized === '/' ||
    RESERVED_SANDBOX_ROOTS.some(
      (root) =>
        normalized === root ||
        withinSandboxPath(root, normalized) ||
        withinSandboxPath(normalized, root)
    )
  )
    throw policyInvalid();
  return normalized;
}

function normalizedSandboxPath(path: string): string {
  if (
    !path.startsWith('/') ||
    path.includes('\0') ||
    path.includes('\\') ||
    posix.normalize(path) !== path ||
    posix.resolve(path) !== path
  )
    throw policyInvalid();
  return path;
}

function generatedImagesSandboxPath(path: string): boolean {
  const segments = posix.relative(GENERATED_IMAGES_SANDBOX_ROOT, path).split('/').filter(Boolean);
  return (
    withinSandboxPath(GENERATED_IMAGES_SANDBOX_ROOT, path) &&
    segments.length === 2 &&
    safePathSegment(segments[0]!) &&
    segments[1] === 'generated_images'
  );
}

function safePathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\')
  );
}

function compareMountDestinations(left: SandboxMount, right: SandboxMount): number {
  const depth =
    left.destination.split('/').filter(Boolean).length -
    right.destination.split('/').filter(Boolean).length;
  return depth === 0 ? left.destination.localeCompare(right.destination, 'en-US') : depth;
}

async function prepareNestedMountDestinations(mounts: readonly SandboxMount[]): Promise<void> {
  for (const [index, mount] of mounts.entries()) {
    const parent = mounts
      .slice(0, index)
      .filter((candidate) => withinSandboxPath(candidate.destination, mount.destination))
      .sort((left, right) => right.destination.length - left.destination.length)[0];
    if (parent === undefined) continue;
    const suffix = relative(parent.destination, mount.destination).split(sep).filter(Boolean);
    const target = join(parent.source, ...suffix);
    try {
      const metadata = await lstat(target);
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        (await realpath(target)) !== resolve(target)
      )
        throw policyInvalid();
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw policyInvalid(error);
    }
  }
}

export function sandboxDirectoryArguments(mounts: readonly SandboxMount[]): string[] {
  const directories = new Set<string>(['/home', '/home/mar']);
  for (const mount of mounts) {
    const segments = mount.destination.split('/').filter(Boolean);
    let current = '';
    for (const segment of segments) {
      current = `${current}/${segment}`;
      directories.add(current);
    }
  }
  return [...directories]
    .sort((left, right) => {
      const depth =
        left.split('/').filter(Boolean).length - right.split('/').filter(Boolean).length;
      return depth === 0 ? left.localeCompare(right, 'en-US') : depth;
    })
    .flatMap((directory) => ['--dir', directory]);
}

/** Host assets retain absolute module URLs, but cannot overlay or widen profile mounts. */
export async function trustedRuntimeMounts(
  directories: readonly string[],
  mounts: readonly SandboxMount[]
): Promise<readonly SandboxMount[]> {
  if (!Array.isArray(directories) || directories.length > 16) throw policyInvalid();
  const result: SandboxMount[] = [];
  for (const path of directories) {
    if (typeof path !== 'string' || path.length > 4096) throw policyInvalid();
    const source = await secureDirectory(path);
    if (source.split('/').filter(Boolean).length < 3) throw policyInvalid();
    const overlaps = (left: string, right: string) =>
      left === right || within(left, right) || within(right, left);
    if (
      mounts.some(
        (mount) => overlaps(source, mount.source) || overlaps(source, mount.destination)
      ) ||
      ['/home/mar', '/runtime', '/etc', '/proc', '/dev', '/run', '/tmp'].some((root) =>
        overlaps(source, root)
      )
    )
      throw policyInvalid();
    // These trees are already exposed read-only by the fixed runtime policy.
    if (['/usr', '/bin', '/sbin', '/lib', '/lib64'].some((root) => within(root, source))) continue;
    if (result.some((mount) => overlaps(source, mount.source))) throw policyInvalid();
    result.push({ source, destination: source, access: 'READ_ONLY' });
  }
  return result;
}

export function within(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation.length > 0 && relation !== '..' && !relation.startsWith(`..${sep}`);
}

function withinSandboxPath(parent: string, candidate: string): boolean {
  const relation = posix.relative(parent, candidate);
  return relation.length > 0 && relation !== '..' && !relation.startsWith('../');
}
