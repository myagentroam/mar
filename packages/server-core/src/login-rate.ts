const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_RATE_MAX_KEYS = 10_000;

export interface LoginRateRecord {
  attempts: number;
  resetAt: number;
}

export function hashLoginUsername(username: string): string {
  let hash = 0;
  for (let index = 0; index < username.length; index += 1)
    hash = (hash * 31 + (username.charCodeAt(index) >>> 0)) >>> 0;
  return hash.toString(36);
}

export function isRateLimited(
  records: Map<string, LoginRateRecord>,
  key: string,
  timestamp: number
): boolean {
  pruneRateRecords(records, timestamp);
  const record = records.get(key);
  if (record === undefined || record.resetAt <= timestamp) {
    return false;
  }
  return record.attempts >= LOGIN_MAX_ATTEMPTS;
}

export function registerFailedLogin(
  records: Map<string, LoginRateRecord>,
  key: string,
  timestamp: number
): void {
  const existing = records.get(key);
  if (existing === undefined || existing.resetAt <= timestamp) {
    if (existing === undefined && records.size >= LOGIN_RATE_MAX_KEYS) {
      const oldestKey = records.keys().next().value;
      if (typeof oldestKey === 'string') {
        records.delete(oldestKey);
      }
    }
    records.set(key, { attempts: 1, resetAt: timestamp + LOGIN_WINDOW_MS });
    return;
  }
  existing.attempts += 1;
}

export function pruneRateRecords(records: Map<string, LoginRateRecord>, timestamp: number): void {
  for (const [key, record] of records) {
    if (record.resetAt <= timestamp) {
      records.delete(key);
    }
  }
}
