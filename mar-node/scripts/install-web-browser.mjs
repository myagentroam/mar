import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

/** Download browser binaries only; operating-system package installation is never implicit. */
export async function installWebBrowser(options = {}) {
  const environment = options.environment ?? process.env;
  if (['1', 'true'].includes(environment.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD)) return 'skipped';
  const exists =
    options.exists ??
    (async (path) => {
      if (!(await stat(path)).isFile()) throw new Error('Browser executable is not a regular file');
      await access(path, constants.X_OK);
    });
  let cached = false;
  try {
    await exists(chromium.executablePath());
    cached = true;
  } catch {
    // The exact browser revision is absent or unusable.
  }
  const require = createRequire(import.meta.url);
  const cli = resolve(dirname(require.resolve('playwright/package.json')), 'cli.js');
  const run = options.run ?? spawnSync;
  const result = run(process.execPath, [cli, 'install', 'chromium', '--no-shell'], {
    stdio: 'inherit',
    env: environment,
    timeout: 12 * 60_000
  });
  if (result.error || result.signal || result.status !== 0)
    throw new Error(
      'NODE_WEB_BROWSER_INSTALL_FAILED: Chromium download failed. Check network access or preinstall the matching Playwright Chromium runtime.'
    );
  // Register this package with Playwright's cache GC even when binaries already exist.
  try {
    await exists(chromium.executablePath());
  } catch {
    throw new Error(
      'NODE_WEB_BROWSER_INSTALL_FAILED: Chromium executable is unavailable or not executable after preparation.'
    );
  }
  return cached ? 'cached' : 'installed';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const outcome = await installWebBrowser();
    process.stdout.write(`Node Chromium preparation: ${outcome}.\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'NODE_WEB_BROWSER_INSTALL_FAILED'}\n`
    );
    process.exitCode = 1;
  }
}
