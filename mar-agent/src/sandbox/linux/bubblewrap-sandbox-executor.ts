import {
  execFile,
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams
} from 'node:child_process';
import { closeSync, existsSync, lstatSync, openSync, readlinkSync, rmSync } from 'node:fs';
import { lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { AgentError } from '../../error.js';
import type {
  LocalProcessExecutor,
  LocalProcessSpawnRequest
} from '../../host/local-process-executor.js';
import { prepareLocalShellProcess } from '../../host/local-shell.js';
import {
  LINUX_BUBBLEWRAP_SANDBOX_POLICY_VERSION,
  type BubblewrapSandboxExecutorOptions,
  type LinuxSandboxMount
} from './profile.js';

const execFileAsync = promisify(execFile);
const DEFAULT_BUBBLEWRAP_PATH = '/usr/bin/bwrap';
const SANDBOX_PATH =
  '/runtime/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const CURSOR_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SANDBOX_CPU_SECONDS = 300;
const SANDBOX_PROCESS_LIMIT = 64;
const SANDBOX_OPEN_FILE_LIMIT = 256;
const SANDBOX_FILE_SIZE_BYTES = 1024 * 1024 * 1024;
const SAFE_ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const GENERATED_IMAGES_SANDBOX_ROOT = '/home/mar/.mar/agent/sessions';
// Fontconfig and LibreOffice resolve required host configuration through absolute /etc paths
// and /usr symlinks. Keep this allowlist read-only and never broaden it to the full /etc tree.
const READ_ONLY_SYSTEM_CONFIGURATION_DIRECTORIES = ['/etc/fonts', '/etc/libreoffice'] as const;
const FORBIDDEN_ENVIRONMENT_NAMES = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'NODE_OPTIONS',
  'PYTHONPATH',
  'PYTHONHOME',
  'BASH_ENV',
  'ENV',
  'SSH_AUTH_SOCK'
]);
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

interface SandboxMount {
  readonly source: string;
  readonly destination: string;
  readonly access: LinuxSandboxMount['access'];
}

/** Compiles one process request into the fixed Linux Bubblewrap policy. */
export class BubblewrapSandboxExecutor implements LocalProcessExecutor {
  readonly #bubblewrapPath: string;

  constructor(private readonly options: BubblewrapSandboxExecutorOptions) {
    this.#bubblewrapPath = options.bubblewrapPath ?? DEFAULT_BUBBLEWRAP_PATH;
  }

  async spawn(request: LocalProcessSpawnRequest): Promise<ChildProcessWithoutNullStreams> {
    request.signal?.throwIfAborted();
    if (process.platform !== 'linux') throw unavailable();
    validateProfile(this.options.profile);
    await validateBackend(this.#bubblewrapPath);
    const mounts = await this.#mounts();
    const runtimeMounts = await trustedRuntimeMounts(request.runtimeDirectories ?? [], mounts);
    const cwd = await workingDirectory(request, mounts, this.options.profile.workingDirectory);
    // Apply the sandbox policy before creating private startup-override variables.
    const environment = Object.fromEntries(explicitEnvironment(request));
    const shellRequest = prepareLocalShellProcess({
      ...request,
      environment,
      environmentKeys: Object.keys(environment),
      environmentOverrides: Object.fromEntries(
        Object.entries(request.environmentOverrides ?? {})
          .filter(
            ([name, value]) =>
              SAFE_ENVIRONMENT_NAME.test(name) &&
              !FORBIDDEN_ENVIRONMENT_NAMES.has(name) &&
              (value === undefined || Object.hasOwn(environment, name))
          )
          .map(([name, value]) => [name, value === undefined ? undefined : environment[name]])
      )
    });
    const command = sandboxCommand(shellRequest, mounts);
    const launchDirectory = await mkdtemp(join(tmpdir(), 'mar-agent-bwrap-launch-'));
    const argumentPath = join(launchDirectory, 'arguments');
    const seccompPath = join(launchDirectory, 'seccomp.bpf');
    try {
      const arguments_ = this.#arguments(mounts, cwd, shellRequest, runtimeMounts);
      await Promise.all([
        writeFile(argumentPath, `${arguments_.join('\0')}\0`, { mode: 0o600, flag: 'wx' }),
        writeFile(seccompPath, seccompFilter(process.arch), { mode: 0o600, flag: 'wx' })
      ]);
    } catch (error) {
      await rm(launchDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw error instanceof AgentError ? error : policyInvalid(error);
    }
    let argumentFd: number | undefined;
    let seccompFd: number | undefined;
    try {
      argumentFd = openSync(argumentPath, 'r');
      seccompFd = openSync(seccompPath, 'r');
      rmSync(launchDirectory, { recursive: true, force: true });
      request.signal?.throwIfAborted();
      try {
        const child = spawn(this.#bubblewrapPath, ['--args', '3', '--', ...command], {
          cwd: '/',
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe', argumentFd, seccompFd],
          windowsHide: true,
          detached: request.detached,
          env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }
        });
        await waitForSpawn(child);
        return child as ChildProcessWithoutNullStreams;
      } catch (error) {
        request.signal?.throwIfAborted();
        throw unavailable(error);
      }
    } finally {
      if (argumentFd !== undefined) closeSync(argumentFd);
      if (seccompFd !== undefined) closeSync(seccompFd);
      rmSync(launchDirectory, { recursive: true, force: true });
    }
  }

  async #mounts(): Promise<readonly SandboxMount[]> {
    const mounts: SandboxMount[] = [];
    for (const definition of this.options.profile.mounts ?? []) {
      mounts.push({
        source: await secureDirectory(definition.source),
        destination: sandboxDestination(definition.destination, definition.access),
        access: definition.access
      });
    }
    if (this.options.profile.temporaryDirectory?.kind === 'MOUNT')
      mounts.push({
        source: await secureDirectory(this.options.profile.temporaryDirectory.source),
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

  #arguments(
    mounts: readonly SandboxMount[],
    cwd: string,
    request: LocalProcessSpawnRequest,
    runtimeMounts: readonly SandboxMount[]
  ): string[] {
    const networkMode = this.options.profile.networkMode ?? 'NONE';
    const temporaryDirectory = this.options.profile.temporaryDirectory ?? { kind: 'EPHEMERAL' };
    const args = [
      '--unshare-user',
      '--unshare-pid',
      ...(networkMode === 'UNRESTRICTED' ? [] : ['--unshare-net']),
      '--unshare-uts',
      '--unshare-ipc',
      '--unshare-cgroup-try',
      '--disable-userns',
      '--die-with-parent',
      '--new-session',
      '--cap-drop',
      'ALL',
      '--hostname',
      'mar-hosted',
      '--clearenv',
      '--setenv',
      'PATH',
      SANDBOX_PATH,
      '--setenv',
      'HOME',
      '/home/mar',
      '--setenv',
      'LANG',
      'C.UTF-8',
      '--setenv',
      'LC_ALL',
      'C.UTF-8',
      '--setenv',
      'TMPDIR',
      '/tmp',
      '--tmpfs',
      '/',
      ...runtimeMountArguments(),
      ...sandboxDirectoryArguments(runtimeMounts),
      ...runtimeMounts.flatMap((mount) => ['--ro-bind', mount.source, mount.destination]),
      ...sandboxDirectoryArguments(mounts),
      ...(temporaryDirectory.kind === 'EPHEMERAL' ? ['--tmpfs', '/tmp'] : []),
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--tmpfs',
      '/run'
    ];
    for (const mount of mounts)
      args.push(
        mount.access === 'READ_WRITE' ? '--bind' : '--ro-bind',
        mount.source,
        mount.destination
      );
    if (request.owner !== undefined) {
      if (
        !CURSOR_SAFE_ID.test(request.owner.sessionId) ||
        (request.owner.executionId !== undefined && !CURSOR_SAFE_ID.test(request.owner.executionId))
      )
        throw policyInvalid();
      args.push('--setenv', 'MAR_AGENT_SESSION_ID', request.owner.sessionId);
      if (request.owner.executionId !== undefined)
        args.push('--setenv', 'MAR_AGENT_EXECUTION_ID', request.owner.executionId);
    }
    for (const [name, value] of explicitEnvironment(request)) args.push('--setenv', name, value);
    args.push('--seccomp', '4', '--chdir', cwd);
    return args;
  }
}

export async function probeBubblewrapSandbox(
  options: {
    readonly bubblewrapPath?: string;
    readonly profile?: BubblewrapSandboxExecutorOptions['profile'];
    readonly cwd?: string;
  } = {}
): Promise<{ readonly version: string; readonly policyVersion: number }> {
  if (process.platform !== 'linux') throw unavailable();
  const bubblewrapPath = options.bubblewrapPath ?? DEFAULT_BUBBLEWRAP_PATH;
  const versionOutput = await execFileAsync(bubblewrapPath, ['--version'], {
    timeout: 5_000,
    windowsHide: true
  }).catch((error) => {
    throw unavailable(error);
  });
  const version = /^bubblewrap\s+([0-9]+(?:\.[0-9]+){1,3})\s*$/u.exec(versionOutput.stdout)?.[1];
  if (version === undefined) throw unavailable();
  const executor = new BubblewrapSandboxExecutor({
    bubblewrapPath,
    profile: options.profile ?? {
      policyVersion: LINUX_BUBBLEWRAP_SANDBOX_POLICY_VERSION
    }
  });
  const child = await executor.spawn({
    command: '/bin/true',
    cwd: options.cwd ?? '/',
    shell: false,
    environment: {},
    detached: true,
    owner: { sessionId: 'sandbox-probe', executionId: 'sandbox-probe' }
  });
  const result = await waitForProbe(child);
  if (result.code !== 0) throw unavailable(new Error(result.stderr));
  return { version, policyVersion: LINUX_BUBBLEWRAP_SANDBOX_POLICY_VERSION };
}

async function waitForProbe(
  child: ChildProcessWithoutNullStreams
): Promise<{ readonly code: number | null; readonly stderr: string }> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  child.stderr.on('data', (chunk: Buffer) => {
    if (bytes >= 8_192) return;
    const remaining = 8_192 - bytes;
    chunks.push(chunk.subarray(0, remaining));
    bytes += Math.min(chunk.length, remaining);
  });
  child.stdin.end();
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(unavailable(new Error('Sandbox probe timed out.')));
    }, 5_000);
    timer.unref();
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(unavailable(error));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

async function waitForSpawn(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const spawned = () => {
      child.off('error', failed);
      resolve();
    };
    const failed = (error: Error) => {
      child.off('spawn', spawned);
      reject(unavailable(error));
    };
    child.once('spawn', spawned);
    child.once('error', failed);
  });
}

async function validateBackend(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o111) === 0)
      throw unavailable();
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw unavailable(error);
  }
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

function validateProfile(profile: BubblewrapSandboxExecutorOptions['profile']): void {
  if (
    profile === null ||
    typeof profile !== 'object' ||
    profile.policyVersion !== LINUX_BUBBLEWRAP_SANDBOX_POLICY_VERSION ||
    (profile.networkMode !== undefined &&
      profile.networkMode !== 'NONE' &&
      profile.networkMode !== 'UNRESTRICTED') ||
    (profile.mounts !== undefined && !Array.isArray(profile.mounts))
  )
    throw policyInvalid();
  for (const mount of profile.mounts ?? []) {
    if (
      mount === null ||
      typeof mount !== 'object' ||
      typeof mount.source !== 'string' ||
      typeof mount.destination !== 'string' ||
      (mount.access !== 'READ_ONLY' && mount.access !== 'READ_WRITE')
    )
      throw policyInvalid();
  }
  const temporaryDirectory = profile.temporaryDirectory;
  if (
    temporaryDirectory !== undefined &&
    (temporaryDirectory === null ||
      typeof temporaryDirectory !== 'object' ||
      (temporaryDirectory.kind !== 'EPHEMERAL' &&
        (temporaryDirectory.kind !== 'MOUNT' || typeof temporaryDirectory.source !== 'string')))
  )
    throw policyInvalid();
  const workingDirectory = profile.workingDirectory;
  if (
    workingDirectory !== undefined &&
    (workingDirectory === null ||
      typeof workingDirectory !== 'object' ||
      (workingDirectory.kind !== 'REQUEST' &&
        (workingDirectory.kind !== 'SANDBOX' || typeof workingDirectory.path !== 'string')))
  )
    throw policyInvalid();
}

async function workingDirectory(
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

function sandboxCommand(
  request: LocalProcessSpawnRequest,
  mounts: readonly SandboxMount[]
): readonly string[] {
  const command =
    request.shell === undefined || request.shell === false
      ? [sandboxExecutable(request.command, mounts), ...(request.args ?? [])]
      : [
          sandboxExecutable(typeof request.shell === 'string' ? request.shell : '/bin/sh', mounts),
          '-c',
          request.command,
          ...(request.args ?? [])
        ];
  return [
    '/usr/bin/prlimit',
    `--cpu=${SANDBOX_CPU_SECONDS}:${SANDBOX_CPU_SECONDS}`,
    `--nproc=${SANDBOX_PROCESS_LIMIT}:${SANDBOX_PROCESS_LIMIT}`,
    `--nofile=${SANDBOX_OPEN_FILE_LIMIT}:${SANDBOX_OPEN_FILE_LIMIT}`,
    `--fsize=${SANDBOX_FILE_SIZE_BYTES}:${SANDBOX_FILE_SIZE_BYTES}`,
    '--',
    ...command
  ];
}

function sandboxExecutable(command: string, mounts: readonly SandboxMount[]): string {
  if (!isAbsolute(command)) return command;
  const canonical = resolve(command);
  const nodeRuntimeDirectory = resolve(process.execPath, '..', '..');
  if (
    nodeRuntimeDirectory !== '/usr' &&
    (canonical === nodeRuntimeDirectory || within(nodeRuntimeDirectory, canonical))
  ) {
    const suffix = relative(nodeRuntimeDirectory, canonical).split(sep).filter(Boolean);
    return suffix.length === 0 ? '/runtime/node' : posix.join('/runtime/node', ...suffix);
  }
  const mount = [...mounts]
    .sort((left, right) => right.source.length - left.source.length)
    .find((candidate) => canonical === candidate.source || within(candidate.source, canonical));
  if (mount !== undefined) {
    const suffix = relative(mount.source, canonical).split(sep).filter(Boolean);
    return suffix.length === 0 ? mount.destination : posix.join(mount.destination, ...suffix);
  }
  if (
    ['/usr', '/bin', '/sbin', '/lib', '/lib64'].some(
      (root) => canonical === root || within(root, canonical)
    )
  )
    return canonical;
  throw policyInvalid();
}

function explicitEnvironment(
  request: LocalProcessSpawnRequest
): readonly (readonly [string, string])[] {
  const entries: Array<readonly [string, string]> = [];
  const seen = new Set<string>();
  for (const name of request.environmentKeys ?? []) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (!SAFE_ENVIRONMENT_NAME.test(name)) throw policyInvalid();
    if (FORBIDDEN_ENVIRONMENT_NAMES.has(name)) continue;
    const value = request.environment[name];
    if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > 32_768)
      throw policyInvalid();
    entries.push([name, value]);
  }
  return entries;
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

function sandboxDirectoryArguments(mounts: readonly SandboxMount[]): string[] {
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
async function trustedRuntimeMounts(
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

function runtimeMountArguments(): string[] {
  const args: string[] = [];
  const nodeRuntimeDirectory = resolve(process.execPath, '..', '..');
  if (nodeRuntimeDirectory !== '/usr')
    args.push(
      '--dir',
      '/runtime',
      '--dir',
      '/runtime/node',
      '--ro-bind',
      nodeRuntimeDirectory,
      '/runtime/node'
    );
  for (const path of ['/usr', '/bin', '/sbin', '/lib', '/lib64']) {
    if (!existsSync(path)) continue;
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) args.push('--symlink', readlinkSync(path), path);
    else if (metadata.isDirectory()) args.push('--ro-bind', path, path);
  }
  for (const path of READ_ONLY_SYSTEM_CONFIGURATION_DIRECTORIES) {
    if (!existsSync(path) || !lstatSync(path).isDirectory()) continue;
    args.push('--ro-bind', path, path);
  }
  for (const path of [
    '/etc/host.conf',
    '/etc/hosts',
    '/etc/ld.so.cache',
    '/etc/resolv.conf',
    '/etc/passwd',
    '/etc/group',
    '/etc/nsswitch.conf',
    '/etc/localtime',
    '/etc/ssl/certs'
  ]) {
    if (existsSync(path)) args.push('--ro-bind', path, path);
  }
  return args;
}

function seccompFilter(architecture: string): Buffer {
  const policy = syscallPolicy(architecture);
  const filters: Array<readonly [number, number, number, number]> = [
    [0x20, 0, 0, 4],
    [0x15, 1, 0, policy.auditArchitecture],
    [0x06, 0, 0, 0x80000000],
    [0x20, 0, 0, 0]
  ];
  if (architecture === 'x64')
    filters.push(
      [0x54, 0, 0, 0x40000000],
      [0x15, 1, 0, 0],
      [0x06, 0, 0, 0x80000000],
      [0x20, 0, 0, 0]
    );
  for (const syscall of policy.blockedSyscalls)
    filters.push([0x15, 0, 1, syscall], [0x06, 0, 0, 0x00050001]);
  filters.push([0x06, 0, 0, 0x7fff0000]);
  const buffer = Buffer.alloc(filters.length * 8);
  for (const [index, [code, jumpTrue, jumpFalse, value]] of filters.entries()) {
    const offset = index * 8;
    buffer.writeUInt16LE(code, offset);
    buffer.writeUInt8(jumpTrue, offset + 2);
    buffer.writeUInt8(jumpFalse, offset + 3);
    buffer.writeUInt32LE(value >>> 0, offset + 4);
  }
  return buffer;
}

function syscallPolicy(architecture: string): {
  readonly auditArchitecture: number;
  readonly blockedSyscalls: readonly number[];
} {
  if (architecture === 'x64')
    return {
      auditArchitecture: 0xc000003e,
      blockedSyscalls: [
        101, 155, 165, 166, 175, 176, 246, 248, 249, 250, 272, 298, 304, 308, 313, 321, 323, 428,
        429, 430, 431, 432, 442
      ]
    };
  if (architecture === 'arm64')
    return {
      auditArchitecture: 0xc00000b7,
      blockedSyscalls: [
        39, 40, 41, 97, 104, 105, 106, 117, 217, 218, 219, 241, 265, 268, 273, 280, 282, 428, 429,
        430, 431, 432, 442
      ]
    };
  throw policyInvalid();
}

function within(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation.length > 0 && relation !== '..' && !relation.startsWith(`..${sep}`);
}

function withinSandboxPath(parent: string, candidate: string): boolean {
  const relation = posix.relative(parent, candidate);
  return relation.length > 0 && relation !== '..' && !relation.startsWith('../');
}

function unavailable(_cause?: unknown): AgentError {
  return new AgentError('SANDBOX_UNAVAILABLE', 'Bubblewrap sandbox is unavailable.');
}

function policyInvalid(_cause?: unknown): AgentError {
  return new AgentError('SANDBOX_POLICY_INVALID', 'Sandbox policy is invalid.');
}
