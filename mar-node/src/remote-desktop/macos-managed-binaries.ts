import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { managedBinariesPlatformDirectory } from '../managed-binaries.js';

/** Discovers the packaged macVNC backend and its display topology helper. */
export async function macosManagedDesktopBinaries(
  packageDirectory?: string,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch
): Promise<{ binaryPath: string; topologyBinary: string } | undefined> {
  if (platform !== 'darwin' || !['arm64', 'x64'].includes(architecture)) return undefined;
  try {
    const directory = join(
      packageDirectory ?? managedBinariesPlatformDirectory(platform, architecture),
      `vendor/macvnc/${platform}-${architecture}`
    );
    const binaryPath = join(directory, 'macVNC');
    const topologyBinary = join(directory, 'macos-topology');
    await Promise.all([binaryPath, topologyBinary].map((path) => access(path, constants.X_OK)));
    return { binaryPath, topologyBinary };
  } catch {
    return undefined;
  }
}
