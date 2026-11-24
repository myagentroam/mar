import { chromium } from 'playwright';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { installBrowserContextMenu } from './browser-context-menu.js';
import { attachBrowserProfileData, writeBrowserDataExtension } from './browser-profile-data.js';
import { BROWSER_VIEWPORT } from './browser-video-config.js';

/** Owns one managed Chromium process and its run directory. The session registry
 * supplies the optional durable profile path and owns all scope/capacity rules. */
export function createBrowserLauncher(runRoot: string, failed: (error: unknown) => void) {
  const extension = join(runRoot, 'profile-data-extension');
  let prepared: Promise<void> | undefined;
  return async (profilePath?: string) => {
    await (prepared ??= mkdir(runRoot, { recursive: true, mode: 0o700 })
      .then(() => writeBrowserDataExtension(extension))
      .catch((error: unknown) => {
        prepared = undefined;
        throw error;
      }));
    const run = await mkdtemp(join(runRoot, 'browser-'));
    const downloadsPath = join(run, 'downloads');
    let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
    try {
      context = await chromium.launchPersistentContext(profilePath ?? join(run, 'profile'), {
        channel: 'chromium',
        headless: true,
        chromiumSandbox: false,
        viewport: BROWSER_VIEWPORT,
        acceptDownloads: true,
        downloadsPath,
        ignoreDefaultArgs: ['--disable-extensions'],
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
      });
      const owned = context;
      await installBrowserContextMenu(owned);
      const data = await attachBrowserProfileData(owned);
      let closing: Promise<void> | undefined;
      return {
        context: owned,
        directory: run,
        data,
        close: () =>
          (closing ??= owned
            .close()
            .then(() => rm(run, { force: true, recursive: true }).catch(failed)))
      };
    } catch (error) {
      await context?.close();
      await rm(run, { force: true, recursive: true });
      throw error;
    }
  };
}
