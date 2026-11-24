import { z } from 'zod';

export const BROWSER_CACHE_CLEANUP_DEFAULT_DAYS = 30;
export const BROWSER_CACHE_CLEANUP_MIN_DAYS = 1;
export const BROWSER_CACHE_CLEANUP_MAX_DAYS = 60;
const cacheCleanupDays = z
  .number()
  .int()
  .min(BROWSER_CACHE_CLEANUP_MIN_DAYS)
  .max(BROWSER_CACHE_CLEANUP_MAX_DAYS);

export const browserSettingsInputSchema = z.strictObject({ cacheCleanupDays });

// Read projections allow additive settings without invalidating already deployed consumers.
export const browserSettingsSnapshotSchema = z.object({
  revision: z.number().int().nonnegative().safe(),
  cacheCleanupDays
});
export type BrowserSettingsSnapshot = z.infer<typeof browserSettingsSnapshotSchema>;
export const browserSettingsSyncResultSchema = z.object({
  settings: browserSettingsSnapshotSchema
});
