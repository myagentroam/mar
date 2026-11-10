import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

/** Resolve the Node installed with Server; never download or select another entrypoint. */
export async function serverNodeEntrypoint(): Promise<string> {
  const require = createRequire(import.meta.url);
  const serverManifest = JSON.parse(
    await readFile(resolve(import.meta.dirname, '../../package.json'), 'utf8')
  ) as { private?: boolean; version?: string };
  // The source workspace is private and deliberately does not add Node to the Docker graph.
  const packagePath = serverManifest.private
    ? resolve(import.meta.dirname, '../../../mar-node/package.json')
    : require.resolve('@myagentroam/node/package.json');
  const manifest = JSON.parse(await readFile(packagePath, 'utf8')) as { version?: unknown };
  if (typeof manifest.version !== 'string' || manifest.version !== serverManifest.version)
    throw new Error('QUICK_START_NODE_NOT_PREPARED');
  const entrypoint = join(dirname(packagePath), 'dist/main.js');
  await access(entrypoint);
  return entrypoint;
}
