import { createRequire } from 'node:module';
import { dirname } from 'node:path';

/** Resolve platform assets from the unified binaries package's own dependencies. */
export function managedBinariesPlatformDirectory(platform: string, architecture: string): string {
  const require = createRequire(import.meta.url);
  const entry = require.resolve('@myagentroam/binaries/package.json');
  return dirname(
    createRequire(entry).resolve(`@myagentroam/binaries-${platform}-${architecture}/package.json`)
  );
}
