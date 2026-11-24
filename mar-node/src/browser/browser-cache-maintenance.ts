import {
  BROWSER_CACHE_CLEANUP_DEFAULT_DAYS,
  type BrowserSettingsSnapshot
} from '@myagentroam/protocol';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** Owns scheduled HTTP cache cleanup for one live Chromium instance. The caller
 * owns the profile lease and closes this owner before releasing it. */
export class BrowserCacheMaintenance {
  private settings: BrowserSettingsSnapshot = {
    revision: 0,
    cacheCleanupDays: BROWSER_CACHE_CLEANUP_DEFAULT_DAYS
  };
  private lastCleanupAt: number;
  private running: Promise<void> | undefined;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly options: {
      lastCleanupAt?: number | undefined;
      record?: ((timestamp: number) => Promise<void>) | undefined;
      clear: () => Promise<void>;
      failed: (error: unknown) => void;
      now?: () => number;
    }
  ) {
    const now = this.now();
    this.lastCleanupAt = Math.min(options.lastCleanupAt ?? now, now);
    this.timer = setInterval(() => this.check(), HOUR_MS);
    this.timer.unref();
  }

  sync(settings?: BrowserSettingsSnapshot): BrowserSettingsSnapshot {
    if (settings && settings.revision >= this.settings.revision) this.settings = settings;
    this.check();
    return this.settings;
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private check(): void {
    if (this.running || this.now() - this.lastCleanupAt < this.settings.cacheCleanupDays * DAY_MS)
      return;
    this.running = Promise.resolve()
      .then(this.options.clear)
      .then(async () => {
        this.lastCleanupAt = this.now();
        await this.options.record?.(this.lastCleanupAt);
      })
      .catch(this.options.failed)
      .finally(() => {
        this.running = undefined;
      });
  }
}
