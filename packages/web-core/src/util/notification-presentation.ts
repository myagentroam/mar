export function elapsedDurationLabel(elapsedMs: number): string {
  const totalMinutes = Math.max(0, Math.floor(elapsedMs / 60_000));
  if (totalMinutes === 0) return '<1m';
  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  const hours = totalHours % 24;
  const days = Math.floor(totalHours / 24);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function activeRecentRunStatus(status: string): boolean {
  return status === 'STARTING' || status === 'RUNNING' || status === 'CANCELLING';
}

export function recentRunTimeReference(run: {
  readonly status: string;
  readonly startedAt: number;
  readonly completedAt: number | null;
  readonly updatedAt: number;
}): number {
  return activeRecentRunStatus(run.status) ? run.startedAt : (run.completedAt ?? run.updatedAt);
}
