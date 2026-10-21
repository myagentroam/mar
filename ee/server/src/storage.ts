import { stat, statfs } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
const networkTypes = new Set([0x6969, 0x517b, 0xff534d42, 0xfe534d42]);
export async function assertLocalServerSqlitePath(path: string): Promise<void> {
  if (process.platform === 'win32' && /^(?:\\\\|\/\/)/.test(path))
    throw new Error('SQLITE_NETWORK_FILESYSTEM_UNSUPPORTED');
  if (process.platform !== 'linux') return;
  const type = Number((await statfs(await existingParent(dirname(path)))).type) >>> 0;
  if (networkTypes.has(type)) throw new Error('SQLITE_NETWORK_FILESYSTEM_UNSUPPORTED');
}

async function existingParent(path: string): Promise<string> {
  let current = resolve(path);
  for (;;) {
    try {
      if ((await stat(current)).isDirectory()) return current;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) throw new Error('SQLITE_DATA_DIRECTORY_INVALID');
    current = parent;
  }
}
