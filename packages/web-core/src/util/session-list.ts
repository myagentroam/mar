export const WORKSPACE_SESSION_PAGE_SIZE = 30;

export function isKnownSessionActivityAt(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

export function formatRelativeSessionActivity(
  lastActivityAt: number | undefined,
  now = Date.now()
): string {
  if (!isKnownSessionActivityAt(lastActivityAt)) return '—';
  const elapsed = Math.max(0, now - lastActivityAt);
  if (elapsed < 60_000) return '<1m';
  if (elapsed < 60 * 60_000) return `>${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 24 * 60 * 60_000) return `>${Math.floor(elapsed / (60 * 60_000))}h`;
  return `>${Math.floor(elapsed / (24 * 60 * 60_000))}d`;
}
