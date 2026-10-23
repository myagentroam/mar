export const WORKSPACE_SESSION_PAGE_SIZE = 30;

export function isKnownSessionActivityAt(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

export interface SessionReorderSnapshot {
  readonly context: string;
  readonly ready: boolean;
  readonly items: readonly {
    readonly key: string;
    readonly lastActivityAt: number | undefined;
    readonly pin: number | null;
  }[];
}

export function shouldAnimateSessionReorder(
  previous: SessionReorderSnapshot | undefined,
  next: SessionReorderSnapshot
): boolean {
  if (
    !previous?.ready ||
    !next.ready ||
    previous.context !== next.context ||
    previous.items.length !== next.items.length ||
    previous.items.every((item, index) => item.key === next.items[index]?.key)
  )
    return false;

  const previousItems = new Map(previous.items.map((item) => [item.key, item]));
  let activityAdvanced = false;
  for (const item of next.items) {
    const old = previousItems.get(item.key);
    if (!old || old.pin !== item.pin) return false;
    if (
      isKnownSessionActivityAt(old.lastActivityAt) &&
      isKnownSessionActivityAt(item.lastActivityAt) &&
      item.lastActivityAt > old.lastActivityAt
    )
      activityAdvanced = true;
  }
  return activityAdvanced;
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
