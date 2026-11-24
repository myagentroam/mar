import type {
  BrowserDataClear,
  BrowserHistoryQuery,
  BrowserHistoryResult
} from '@myagentroam/protocol';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext, Worker } from 'playwright';
import { BROWSER_TAB_ICON_BASE64_MAX, isBrowserWorkspacePreview } from '@myagentroam/protocol';

const HOUR_MS = 60 * 60_000;
const RANGE_HOURS = { hour: 1, day: 24, week: 7 * 24, 'four-weeks': 28 * 24 };
const MAX_RESULTS = 1_000;
const HISTORY_BYTES = 256 * 1024;
const WORKER = 'mar-profile-data.js';

/** Stages the single internal component into a deployment-owned directory.
 * The launcher is responsible for loading only this component. */
export async function writeBrowserDataExtension(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify({
        manifest_version: 3,
        name: 'MAR Profile Data',
        version: '1.0',
        permissions: ['browsingData', 'history', 'favicon'],
        background: { service_worker: WORKER }
      }),
      { mode: 0o600 }
    ),
    writeFile(
      join(directory, WORKER),
      'chrome.runtime.onInstalled.addListener(() => {});\nchrome.runtime.onStartup.addListener(() => {});\n',
      {
        mode: 0o600
      }
    )
  ]);
}

export async function attachBrowserProfileData(
  context: BrowserContext,
  now?: () => number
): Promise<BrowserProfileData> {
  const matches = (worker: Worker) =>
    new RegExp(`^chrome-extension://[a-p]{32}/${WORKER.replace('.', '\\.')}$`, 'u').test(
      worker.url()
    );
  const worker =
    context.serviceWorkers().find(matches) ??
    (await context.waitForEvent('serviceworker', { predicate: matches, timeout: 5_000 }));
  return new BrowserProfileData(worker, now);
}

type Categories = Partial<
  Record<
    | 'history'
    | 'cookies'
    | 'localStorage'
    | 'indexedDB'
    | 'cacheStorage'
    | 'serviceWorkers'
    | 'cache',
    true
  >
>;
type ExtensionApis = {
  browsingData: { remove(options: { since: number }, categories: Categories): Promise<void> };
  history: {
    search(options: {
      text: string;
      startTime: number;
      endTime?: number;
      maxResults: number;
    }): Promise<{ url?: string; title?: string; lastVisitTime?: number }[]>;
    deleteUrl(options: { url: string }): Promise<void>;
  };
};

/** Owns serial native data operations on a single already-verified extension worker.
 * The caller owns profile identity, worker admission and browser shutdown. It does
 * not automatically retry a Chromium mutation whose completion is unknown. */
export class BrowserProfileData {
  private tail = Promise.resolve();

  constructor(
    private readonly worker: Worker,
    private readonly now = Date.now
  ) {}

  async favicon(url: string): Promise<string | undefined> {
    if (!/^https?:\/\//iu.test(url)) return;
    return this.worker.evaluate(
      async ({ url, limit }) => {
        // The native extension endpoint returns a default PNG on misses, not a 404.
        const [image, fallback] = await Promise.all(
          [url, 'about:blank'].map(async (pageUrl) => {
            const favicon = new URL('/_favicon/', globalThis.location.href);
            favicon.search = new URLSearchParams({ pageUrl, size: '16' }).toString();
            const response = await fetch(favicon);
            if (!response.ok) return;
            const png = new Uint8Array(await response.arrayBuffer());
            if (png.byteLength > (limit / 4) * 3 || png[0] !== 137 || png[1] !== 80) return;
            return btoa(String.fromCharCode(...png));
          })
        );
        if (fallback && image !== fallback) return image;
      },
      { url, limit: BROWSER_TAB_ICON_BASE64_MAX }
    );
  }

  clear({ range, categories }: BrowserDataClear): Promise<void> {
    const since = range === 'all' ? 0 : Math.max(0, this.now() - RANGE_HOURS[range] * HOUR_MS);
    const types: Categories = {};
    for (const category of categories) {
      if (category === 'site-data')
        Object.assign(types, {
          cookies: true,
          localStorage: true,
          indexedDB: true,
          cacheStorage: true,
          serviceWorkers: true
        });
      else types[category] = true;
    }
    return this.run(() =>
      this.worker.evaluate(
        ({ since, types }) => {
          const api = (globalThis as unknown as { chrome: ExtensionApis }).chrome;
          return api.browsingData.remove({ since }, types);
        },
        { since, types }
      )
    );
  }

  search(query: BrowserHistoryQuery): Promise<BrowserHistoryResult> {
    return this.run(async () => {
      const native = await this.worker.evaluate(
        (options) => {
          const api = (globalThis as unknown as { chrome: ExtensionApis }).chrome;
          const { endTime, ...rest } = options;
          return api.history.search(endTime === undefined ? rest : { ...rest, endTime });
        },
        { ...query, maxResults: MAX_RESULTS }
      );
      const items: BrowserHistoryResult['items'] = [];
      let bytes = 0;
      let capped = native.length >= MAX_RESULTS;
      for (const entry of native) {
        if (
          !entry.url ||
          entry.url.length > 8192 ||
          !/^https?:\/\//iu.test(entry.url) ||
          isBrowserWorkspacePreview(entry.url) ||
          !Number.isFinite(entry.lastVisitTime)
        )
          continue;
        const item = {
          url: entry.url,
          title: entry.title?.slice(0, 512) ?? '',
          visitedAt: entry.lastVisitTime!
        };
        bytes += Buffer.byteLength(JSON.stringify(item)) + 1;
        if (bytes > HISTORY_BYTES) {
          capped = true;
          break;
        }
        items.push(item);
      }
      return { items, capped };
    });
  }

  deleteUrls(urls: string[]): Promise<void> {
    return this.run(() =>
      this.worker.evaluate(
        async (urls) => {
          const api = (globalThis as unknown as { chrome: ExtensionApis }).chrome;
          for (const url of urls) await api.history.deleteUrl({ url });
        },
        [...new Set(urls)]
      )
    );
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
