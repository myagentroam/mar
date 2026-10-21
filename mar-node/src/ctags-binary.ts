import { chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUNDLED_CTAGS_VERSION = '6.2.0-ab95af1';

const TARGETS = {
  'linux-x64': ['linux-x64', 'ctags'],
  'linux-arm64': ['linux-arm64', 'ctags'],
  'darwin-x64': ['darwin-x64', 'ctags'],
  'darwin-arm64': ['darwin-arm64', 'ctags'],
  'win32-x64': ['win32-x64', 'ctags.exe']
} as const;

export function bundledCtagsDirectory(packageRoot?: string): string {
  return packageRoot === undefined
    ? resolve(dirname(fileURLToPath(import.meta.url)), '..', 'vendor/ctags')
    : resolve(packageRoot, 'mar-node/vendor/ctags');
}

export function bundledCtagsPath(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
  packageRoot?: string
): string {
  const target = TARGETS[`${platform}-${architecture}` as keyof typeof TARGETS];
  if (target === undefined) throw new Error('CTAGS_PLATFORM_UNSUPPORTED');
  return resolve(bundledCtagsDirectory(packageRoot), ...target);
}

/**
 * Restores the execute bit when an installation mechanism lost the bundled
 * Unix binary's archive mode. Explicit Ctags overrides are never modified.
 */
export async function repairBundledCtagsExecutable(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
  packageRoot?: string
): Promise<void> {
  if (platform !== 'linux' && platform !== 'darwin') return;
  await chmod(bundledCtagsPath(platform, architecture, packageRoot), 0o755);
}
