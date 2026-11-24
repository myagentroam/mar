import { chromium } from 'playwright';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { installBrowserContextMenu } from './browser-context-menu.js';
import { attachBrowserProfileData, writeBrowserDataExtension } from './browser-profile-data.js';
import { BROWSER_VIEWPORT } from './browser-video-config.js';
import { recordBrowserRun, retireBrowserRun, sweepBrowserRuns } from './browser-run-directories.js';

const HTTP_CACHE_BYTES = 128 * 1024 * 1024;

/** Owns one managed Chromium process and its run directory. The session registry
 * supplies the optional durable profile path and owns all scope/capacity rules. */
export function createBrowserLauncher(
  runRoot: string,
  profileRoot: string,
  failed: (error: unknown) => void
) {
  const extension = join(runRoot, 'profile-data-extension');
  let sweeping: Promise<void> | undefined;
  const sweepOrphans = () =>
    (sweeping ??= sweepBrowserRuns(runRoot, profileRoot, failed).catch((error: unknown) => {
      sweeping = undefined;
      failed(error);
    }));
  let prepared: Promise<void> | undefined;
  const launch = async (profilePath?: string) => {
    await (prepared ??= mkdir(runRoot, { recursive: true, mode: 0o700 })
      .then(sweepOrphans)
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
        args: [
          `--disk-cache-size=${HTTP_CACHE_BYTES}`,
          `--disable-extensions-except=${extension}`,
          `--load-extension=${extension}`
        ]
      });
      const owned = context;
      await recordBrowserRun(run, profileRoot, profilePath).catch(failed);
      await installBrowserContextMenu(owned);
      const data = await attachBrowserProfileData(owned);
      let closing: Promise<void> | undefined;
      return {
        context: owned,
        directory: run,
        data,
        close: () => (closing ??= owned.close().then(() => retireBrowserRun(run).catch(failed)))
      };
    } catch (error) {
      await context?.close();
      await retireBrowserRun(run);
      throw error;
    }
  };
  return { launch, sweepOrphans };
}
