import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { managedBinariesPlatformDirectory } from '../managed-binaries.js';

const run = promisify(execFile);

/** Resolves only targets included in the managed binaries package, never a system VNC. */
export async function linuxManagedDesktopBinaries(
  packageDirectory?: string,
  platform: NodeJS.Platform = process.platform,
  architecture = process.arch
): Promise<{ binaryPath: string; topologyBinary: string } | undefined> {
  if (platform !== 'linux') return undefined;
  const target = `linux-${architecture}`;
  if (target !== 'linux-x64') return undefined;
  try {
    const manifestDirectory =
      packageDirectory ??
      dirname(createRequire(import.meta.url).resolve('@myagentroam/binaries/package.json'));
    const vendor = resolve(manifestDirectory, 'vendor/tigervnc');
    const manifest: unknown = JSON.parse(await readFile(resolve(vendor, 'manifest.json'), 'utf8'));
    if (typeof manifest !== 'object' || manifest === null || !('targets' in manifest))
      return undefined;
    const targets = manifest.targets;
    if (typeof targets !== 'object' || targets === null || !(target in targets)) return undefined;
    const entry = (targets as Record<string, unknown>)[target];
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('server' in entry) ||
      !('topology' in entry)
    )
      return undefined;
    if (entry.server !== `${target}/x0vncserver` || entry.topology !== `${target}/x11-topology`)
      return undefined;
    const binaryVendor =
      packageDirectory === undefined
        ? resolve(managedBinariesPlatformDirectory(platform, architecture), 'vendor/tigervnc')
        : vendor;
    const binaryPath = resolve(binaryVendor, entry.server);
    const topologyBinary = resolve(binaryVendor, entry.topology);
    await Promise.all([access(binaryPath, constants.X_OK), access(topologyBinary, constants.X_OK)]);
    await run(binaryPath, ['--version'], { timeout: 5_000, maxBuffer: 8_192 });
    return { binaryPath, topologyBinary };
  } catch {
    return undefined;
  }
}
