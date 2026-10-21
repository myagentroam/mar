import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RuntimeCommand } from '@myagentroam/protocol';

const execFileAsync = promisify(execFile);

const COMMANDS: readonly {
  readonly id: RuntimeCommand['id'];
  readonly candidates: readonly string[];
  readonly versionArguments: readonly string[];
}[] = [
  { id: 'npx', candidates: ['npx'], versionArguments: ['--version'] },
  { id: 'git', candidates: ['git'], versionArguments: ['--version'] },
  { id: 'python', candidates: ['python3', 'python'], versionArguments: ['--version'] },
  { id: 'pip', candidates: ['pip3', 'pip'], versionArguments: ['--version'] }
];

export async function detectRuntimeCommands(): Promise<RuntimeCommand[]> {
  return Promise.all(COMMANDS.map(detectCommand));
}

async function detectCommand(descriptor: (typeof COMMANDS)[number]): Promise<RuntimeCommand> {
  for (const command of descriptor.candidates) {
    try {
      const [{ stdout, stderr }, path] = await Promise.all([
        executeVersion(command, descriptor.versionArguments),
        resolveCommandPath(command)
      ]);
      const version = normalizeVersion(
        descriptor.id,
        `${stdout}${stderr}`.trim().split(/\r?\n/u)[0]?.trim() ?? ''
      );
      return {
        id: descriptor.id,
        command,
        available: true,
        ...(version === undefined || version === '' ? {} : { version }),
        ...(path === undefined ? {} : { path })
      };
    } catch {
      // Try the platform-compatible fallback command name.
    }
  }
  return {
    id: descriptor.id,
    command: descriptor.candidates[0]!,
    available: false
  };
}

export function normalizeVersion(id: RuntimeCommand['id'], value: string): string | undefined {
  const normalized = value.trim();
  if (normalized === '') return undefined;
  const patterns: Partial<Record<RuntimeCommand['id'], RegExp>> = {
    git: /^git version\s+(\S+)/iu,
    python: /^python\s+(\S+)/iu,
    pip: /^pip\s+(\S+)/iu
  };
  const match = patterns[id]?.exec(normalized);
  return (match?.[1] ?? normalized).slice(0, 512);
}

async function executeVersion(command: string, args: readonly string[]) {
  const executable = process.platform === 'win32' ? process.env['ComSpec'] || 'cmd.exe' : command;
  const commandArgs =
    process.platform === 'win32' ? ['/d', '/s', '/c', [command, ...args].join(' ')] : [...args];
  return execFileAsync(executable, commandArgs, {
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    windowsHide: true
  });
}

async function resolveCommandPath(command: string): Promise<string | undefined> {
  try {
    const resolver = process.platform === 'win32' ? 'where.exe' : 'which';
    const { stdout } = await execFileAsync(resolver, [command], {
      timeout: 2_000,
      maxBuffer: 64 * 1024,
      windowsHide: true
    });
    return stdout.trim().split(/\r?\n/u)[0]?.trim().slice(0, 2048) || undefined;
  } catch {
    return undefined;
  }
}
