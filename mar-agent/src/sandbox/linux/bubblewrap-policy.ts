import { existsSync, lstatSync, readlinkSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { AgentError } from '../../error.js';
import type { LocalProcessSpawnRequest } from '../../process/contracts.js';
import { prepareLocalShellProcess } from '../../host/local-shell.js';
import { seccompFilter } from './bubblewrap-seccomp.js';
import type { LaunchSpec } from './bubblewrap-launch.js';
import { policyInvalid, unavailable } from './sandbox-error.js';
import {
  resolveMounts,
  workingDirectory,
  trustedRuntimeMounts,
  sandboxDirectoryArguments,
  within,
  type SandboxMount
} from './sandbox-mounts.js';
import {
  LINUX_BUBBLEWRAP_SANDBOX_POLICY_VERSION,
  type BubblewrapSandboxProfile,
  type BubblewrapSandboxExecutorOptions
} from './profile.js';

const SANDBOX_PATH =
  '/runtime/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const CURSOR_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SANDBOX_CPU_SECONDS = 300;
const SANDBOX_PROCESS_LIMIT = 64;
const SANDBOX_OPEN_FILE_LIMIT = 256;
const SANDBOX_FILE_SIZE_BYTES = 1024 * 1024 * 1024;
const SAFE_ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
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

export async function compileBubblewrapPolicy(
  options: BubblewrapSandboxExecutorOptions,
  bubblewrapPath: string,
  request: LocalProcessSpawnRequest
): Promise<LaunchSpec> {
  request.signal?.throwIfAborted();
  if (process.platform !== 'linux') throw unavailable();
  const profile = snapshotSandboxProfile(options.profile);
  request = {
    ...request,
    ...(request.args === undefined ? {} : { args: [...request.args] }),
    ...(request.runtimeDirectories === undefined || !Array.isArray(request.runtimeDirectories)
      ? {}
      : { runtimeDirectories: [...request.runtimeDirectories] }),
    ...(request.owner === undefined ? {} : { owner: { ...request.owner } })
  };
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
  await validateBackend(bubblewrapPath);
  const mounts = await resolveMounts(profile);
  const runtimeMounts = await trustedRuntimeMounts(request.runtimeDirectories ?? [], mounts);
  const cwd = await workingDirectory(request, mounts, profile.workingDirectory);
  const command = sandboxCommand(shellRequest, mounts);
  return {
    executable: bubblewrapPath,
    arguments: compileArguments(profile, mounts, cwd, shellRequest, runtimeMounts),
    command,
    seccomp: seccompFilter(process.arch),
    detached: request.detached,
    ...(request.signal === undefined ? {} : { signal: request.signal })
  };
}

export function snapshotSandboxProfile(
  inputProfile: BubblewrapSandboxProfile
): BubblewrapSandboxProfile {
  validateProfile(inputProfile);
  return {
    ...inputProfile,
    ...(inputProfile.mounts === undefined
      ? {}
      : { mounts: inputProfile.mounts.map((mount) => ({ ...mount })) }),
    ...(inputProfile.temporaryDirectory === undefined
      ? {}
      : { temporaryDirectory: { ...inputProfile.temporaryDirectory } }),
    ...(inputProfile.workingDirectory === undefined
      ? {}
      : { workingDirectory: { ...inputProfile.workingDirectory } })
  };
}

function compileArguments(
  profile: BubblewrapSandboxProfile,
  mounts: readonly SandboxMount[],
  cwd: string,
  request: LocalProcessSpawnRequest,
  runtimeMounts: readonly SandboxMount[]
): string[] {
  const networkMode = profile.networkMode ?? 'NONE';
  const temporaryDirectory = profile.temporaryDirectory ?? { kind: 'EPHEMERAL' };
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
