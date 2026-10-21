import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { computerUseRuntimeExecutable, nodeDataDirectory, type NodeConfig } from './config.js';
import { computerUseRuntimeVersion } from './computer-use-runtime-version.js';

const manifestSchema = z
  .object({
    formatVersion: z.literal(1),
    runtimeVersion: z.string().trim().min(1).max(128),
    platform: z.enum(['win32', 'darwin', 'linux']),
    architecture: z.enum(['x64', 'arm64']),
    executable: z.string().trim().min(1).max(512),
    files: z
      .array(
        z
          .object({
            path: z.string().trim().min(1).max(512),
            size: z.number().int().nonnegative(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/u)
          })
          .strict()
      )
      .min(1)
  })
  .strict();

type ManagedRuntimeManifest = z.infer<typeof manifestSchema>;
interface RuntimePackage {
  readonly name: string;
  readonly version: string;
}
type RuntimePackageInstaller = (
  runtimePackage: RuntimePackage,
  destination: string
) => Promise<string>;

// All six packages contain complete managed runtimes. Native Computer Use behavior
// has currently been validated only on win32-x64 and linux-x64; package availability
// for the other targets does not imply native behavior validation.
const runtimePackages = {
  'win32-x64': {
    name: '@myagentroam/computer-runtime-win32-x64',
    version: computerUseRuntimeVersion
  },
  'win32-arm64': {
    name: '@myagentroam/computer-runtime-win32-arm64',
    version: computerUseRuntimeVersion
  },
  'darwin-x64': {
    name: '@myagentroam/computer-runtime-darwin-x64',
    version: computerUseRuntimeVersion
  },
  'darwin-arm64': {
    name: '@myagentroam/computer-runtime-darwin-arm64',
    version: computerUseRuntimeVersion
  },
  'linux-x64': {
    name: '@myagentroam/computer-runtime-linux-x64',
    version: computerUseRuntimeVersion
  },
  'linux-arm64': {
    name: '@myagentroam/computer-runtime-linux-arm64',
    version: computerUseRuntimeVersion
  }
} as const;
const execFileAsync = promisify(execFile);
const installLockTimeoutMs = 620_000;
const installLockPollMs = 100;

export class ComputerUseRuntimeError extends Error {
  constructor(
    readonly code: string,
    options: { cause?: unknown } = {}
  ) {
    super(code, options);
    this.name = 'ComputerUseRuntimeError';
  }
}

export class ManagedComputerUseRuntime {
  #ensurePromise: Promise<string> | undefined;

  constructor(
    private readonly config: () => NodeConfig | undefined,
    private readonly configPath: string | undefined,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly architecture: string = process.arch,
    private readonly installRuntimePackage: RuntimePackageInstaller = defaultRuntimePackageInstaller
  ) {}

  ensure(): Promise<string> {
    this.#ensurePromise ??= this.#ensure().finally(() => {
      this.#ensurePromise = undefined;
    });
    return this.#ensurePromise;
  }

  async #ensure(): Promise<string> {
    const config = this.config();
    if (config === undefined) throw new ComputerUseRuntimeError('NODE_CONFIG_UNAVAILABLE');
    if (config.computerUse?.runtimeExecutable !== undefined) {
      const executable = computerUseRuntimeExecutable(config, this.configPath, this.platform);
      if (executable === undefined) throw new ComputerUseRuntimeError('COMPUTER_RUNTIME_MISSING');
      await access(executable).catch((cause) => {
        throw new ComputerUseRuntimeError('COMPUTER_RUNTIME_MISSING', { cause });
      });
      return executable;
    }
    const runtimePackage =
      runtimePackages[`${this.platform}-${this.architecture}` as keyof typeof runtimePackages];
    if (runtimePackage === undefined)
      throw new ComputerUseRuntimeError('COMPUTER_RUNTIME_PLATFORM_UNSUPPORTED');

    const runtimeRoot = resolve(
      nodeDataDirectory(config, this.configPath),
      'computer-use',
      'runtime'
    );
    await mkdir(runtimeRoot, { recursive: true });
    const current = resolve(
      runtimeRoot,
      `${runtimePackage.version}-${this.platform}-${this.architecture}`
    );
    const currentExecutable = await this.#currentExecutable(current, runtimePackage.version);
    if (currentExecutable !== undefined) return currentExecutable;

    return this.#withInstallLock(runtimeRoot, async () => {
      const lockedCurrent = await this.#currentExecutable(current, runtimePackage.version);
      if (lockedCurrent !== undefined) return lockedCurrent;
      const packageStaging = resolve(runtimeRoot, `.package-${randomUUID()}`);
      const staging = resolve(runtimeRoot, `.staging-${randomUUID()}`);
      try {
        const packageRoot = await this.installRuntimePackage(runtimePackage, packageStaging);
        await this.#verifyPackageMetadata(packageRoot, runtimePackage);
        const source = resolve(packageRoot, 'runtime');
        const manifest = await this.#readManifest(source);
        if (
          manifest.runtimeVersion !== runtimePackage.version ||
          manifest.platform !== this.platform ||
          manifest.architecture !== this.architecture
        )
          throw new ComputerUseRuntimeError('COMPUTER_RUNTIME_MANIFEST_INVALID');
        await this.#verify(source, manifest);
        await cp(source, staging, { recursive: true, errorOnExist: true, force: false });
        await this.#verify(staging, manifest);
        await rm(current, { recursive: true, force: true });
        try {
          await rename(staging, current);
        } catch (error) {
          if (!(await this.#currentExecutable(current, runtimePackage.version))) throw error;
        }
        return resolve(current, manifest.executable);
      } catch (cause) {
        await rm(staging, { recursive: true, force: true });
        if (cause instanceof ComputerUseRuntimeError) throw cause;
        throw new ComputerUseRuntimeError('COMPUTER_RUNTIME_INSTALL_FAILED', { cause });
      } finally {
        await rm(packageStaging, { recursive: true, force: true });
      }
    });
  }

  async #currentExecutable(directory: string, runtimeVersion: string): Promise<string | undefined> {
    try {
      const manifest = await this.#readManifest(directory);
      if (
        manifest.runtimeVersion !== runtimeVersion ||
        manifest.platform !== this.platform ||
        manifest.architecture !== this.architecture
      )
        return undefined;
      await this.#verify(directory, manifest);
      return resolve(directory, manifest.executable);
    } catch {
      return undefined;
    }
  }

  async #readManifest(directory: string): Promise<ManagedRuntimeManifest> {
    try {
      const path = resolve(directory, 'manifest.json');
      if (!(await lstat(path)).isFile())
        throw new ComputerUseRuntimeError('COMPUTER_RUNTIME_MANIFEST_INVALID');
      return manifestSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    } catch (cause) {
      if (cause instanceof ComputerUseRuntimeError) throw cause;
      throw new ComputerUseRuntimeError('COMPUTER_RUNTIME_MANIFEST_INVALID', { cause });
    }
  }

  async #verify(directory: string, manifest: ManagedRuntimeManifest): Promise<void> {
    if (!(await lstat(directory)).isDirectory())
      throw new ComputerUseRuntimeError('COMPUTER_RUNTIME_MANIFEST_INVALID');
    const root = await realpath(directory);
    const paths = new Set<string>();
    for (const file of manifest.files) {
      const path = safeRuntimePath(directory, file.path);
      if (paths.has(path)) throw new ComputerUseRuntimeError('COMPUTER_RUNTIME_MANIFEST_INVALID');
      paths.add(path);
      const fileStat = await lstat(path).catch((cause) => {
        throw new ComputerUseRuntimeError('COMPUTER_RUNTIME_MISSING', { cause });
      });
      if (!fileStat.isFile() || !isWithin(root, await realpath(path)))
        throw new ComputerUseRuntimeError('COMPUTER_RUNTIME_MANIFEST_INVALID');
      const bytes = await readFile(path).catch((cause) => {
        throw new ComputerUseRuntimeError('COMPUTER_RUNTIME_MISSING', { cause });
      });
      if (
        bytes.byteLength !== file.size ||
        createHash('sha256').update(bytes).digest('hex') !== file.sha256
      )
        throw new ComputerUseRuntimeError('COMPUTER_RUNTIME_INTEGRITY_FAILED');
    }
    const actualPaths = new Set(
      (await regularRuntimeFiles(directory))
        .filter((path) => relative(directory, path).split(sep).join('/') !== 'manifest.json')
        .map((path) => resolve(path))
    );
    if (actualPaths.size !== paths.size || [...actualPaths].some((path) => !paths.has(path)))
      throw new ComputerUseRuntimeError('COMPUTER_RUNTIME_MANIFEST_INVALID');
    const executable = safeRuntimePath(directory, manifest.executable);
    if (!paths.has(executable) || !(await stat(executable)).isFile())
      throw new ComputerUseRuntimeError('COMPUTER_RUNTIME_MANIFEST_INVALID');
    if (this.platform !== 'win32')
      await access(executable, constants.X_OK).catch((cause) => {
        throw new ComputerUseRuntimeError('COMPUTER_RUNTIME_INTEGRITY_FAILED', { cause });
      });
  }

  async #verifyPackageMetadata(packageRoot: string, runtimePackage: RuntimePackage): Promise<void> {
    try {
      const path = resolve(packageRoot, 'package.json');
      if (!(await lstat(path)).isFile())
        throw new ComputerUseRuntimeError('COMPUTER_RUNTIME_PACKAGE_INVALID');
      const metadata = z
        .object({ name: z.string(), version: z.string() })
        .passthrough()
        .parse(JSON.parse(await readFile(path, 'utf8')));
      if (metadata.name !== runtimePackage.name || metadata.version !== runtimePackage.version)
        throw new ComputerUseRuntimeError('COMPUTER_RUNTIME_PACKAGE_INVALID');
    } catch (cause) {
      if (cause instanceof ComputerUseRuntimeError) throw cause;
      throw new ComputerUseRuntimeError('COMPUTER_RUNTIME_PACKAGE_INVALID', { cause });
    }
  }

  async #withInstallLock<T>(runtimeRoot: string, operation: () => Promise<T>): Promise<T> {
    const lock = resolve(runtimeRoot, '.install-lock');
    const owner = resolve(lock, 'owner.json');
    const deadline = Date.now() + installLockTimeoutMs;
    for (;;) {
      try {
        await mkdir(lock);
        await writeFile(owner, JSON.stringify({ pid: process.pid, id: randomUUID() }), {
          flag: 'wx'
        });
        break;
      } catch (cause) {
        if (!isAlreadyExists(cause))
          throw new ComputerUseRuntimeError('COMPUTER_RUNTIME_INSTALL_FAILED', { cause });
        if (!(await lockOwnerIsAlive(owner, lock))) {
          await rm(lock, { recursive: true, force: true });
          continue;
        }
        if (Date.now() >= deadline)
          throw new ComputerUseRuntimeError('COMPUTER_RUNTIME_INSTALL_FAILED', {
            cause: new Error('COMPUTER_RUNTIME_INSTALL_LOCK_TIMEOUT')
          });
        await delay(installLockPollMs);
      }
    }
    try {
      return await operation();
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }
}

async function defaultRuntimePackageInstaller(
  runtimePackage: RuntimePackage,
  destination: string
): Promise<string> {
  const npmRoot = dirname(createRequire(import.meta.url).resolve('npm/package.json'));
  const npmCli = resolve(npmRoot, 'bin/npm-cli.js');
  await mkdir(destination, { recursive: true });
  await execFileAsync(
    process.execPath,
    [
      npmCli,
      'install',
      `${runtimePackage.name}@${runtimePackage.version}`,
      '--prefix',
      destination,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      '--omit=dev',
      '--loglevel=error'
    ],
    {
      env: { ...process.env, NPM_CONFIG_UPDATE_NOTIFIER: 'false' },
      timeout: 600_000,
      maxBuffer: 1024 * 1024
    }
  );
  return resolve(destination, 'node_modules', '@myagentroam', runtimePackage.name.split('/')[1]!);
}

function safeRuntimePath(root: string, path: string): string {
  const target = resolve(root, path);
  const suffix = relative(root, target);
  if (
    suffix.length === 0 ||
    suffix === '..' ||
    suffix.startsWith(`..${sep}`) ||
    resolve(root, suffix) !== target
  )
    throw new ComputerUseRuntimeError('COMPUTER_RUNTIME_MANIFEST_INVALID');
  return target;
}

function isAlreadyExists(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST'
  );
}

function isWithin(root: string, target: string): boolean {
  const suffix = relative(root, target);
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`));
}

async function regularRuntimeFiles(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await regularRuntimeFiles(path)));
    else if (entry.isFile()) output.push(path);
    else throw new ComputerUseRuntimeError('COMPUTER_RUNTIME_MANIFEST_INVALID');
  }
  return output;
}

async function lockOwnerIsAlive(ownerPath: string, lockPath: string): Promise<boolean> {
  try {
    const owner = z
      .object({ pid: z.number().int().positive() })
      .passthrough()
      .parse(JSON.parse(await readFile(ownerPath, 'utf8')));
    try {
      process.kill(owner.pid, 0);
      return true;
    } catch (cause) {
      return !(
        cause instanceof Error &&
        'code' in cause &&
        (cause as NodeJS.ErrnoException).code === 'ESRCH'
      );
    }
  } catch {
    try {
      return Date.now() - (await stat(lockPath)).mtimeMs < 5_000;
    } catch {
      return true;
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
