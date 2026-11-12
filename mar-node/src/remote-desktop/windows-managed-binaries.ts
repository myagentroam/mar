import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { managedBinariesPlatformDirectory } from '../managed-binaries.js';

/** Discover only the packaged Windows backend, never a system-wide VNC service. */
export async function windowsManagedDesktopBinaries(
  packageDirectory?: string,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch
): Promise<{ binaryPath: string } | undefined> {
  if (platform !== 'win32' || architecture !== 'x64') return undefined;
  try {
    const directory = join(
      packageDirectory ?? managedBinariesPlatformDirectory('win32', 'x64'),
      'vendor/ultravnc/win32-x64'
    );
    for (const name of ['winvnc.exe', 'vnchooks.dll', 'ddengine64.dll', 'ultravnc.portable'])
      await access(join(directory, name), constants.R_OK);
    return { binaryPath: join(directory, 'winvnc.exe') };
  } catch {
    return undefined;
  }
}
