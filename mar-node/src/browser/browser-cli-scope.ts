import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const cleanup = fileURLToPath(
  new URL('../../scripts/browser-bin/close-scope.mjs', import.meta.url)
);
const execute = promisify(execFile);

export function browserCliRoot(scope: string): string {
  if (!/^[a-f0-9]{32}$/u.test(scope)) throw new Error('BROWSER_CLI_SCOPE_INVALID');
  return join(tmpdir(), `mpw-${scope}`);
}

/** Owns the CLI registry and sockets for one authorized Run, not its shared browser. */
export async function openBrowserCliScope(scope: string): Promise<{ close(): Promise<void> }> {
  const root = browserCliRoot(scope);
  await mkdir(root, { mode: 0o700 });
  try {
    await writeFile(join(root, 'active'), '', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    close: () => (closing ??= close())
  };

  async function close() {
    await rm(join(root, 'active'), { force: true });
    // A failed close must not discard the registry of potentially live sessions.
    await execute(process.execPath, [cleanup, root], { timeout: 40_000, windowsHide: true });
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
}
