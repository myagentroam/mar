const DEFAULT_ACTIVE_TTL_MS = 30 * 60_000;

export interface ActiveNodeTransportServiceOptions {
  readonly activate: (nodeId: string) => void;
  readonly release: (nodeId: string) => void;
  readonly activeTtlMs?: number;
  readonly now?: () => number;
}

export function createActiveNodeTransportService(options: ActiveNodeTransportServiceOptions) {
  const activeUntil = new Map<string, number>();
  const activeTtlMs = options.activeTtlMs ?? DEFAULT_ACTIVE_TTL_MS;
  const now = options.now ?? Date.now;
  let currentNodeId: string | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  function select(nodeId: string | undefined): void {
    const timestamp = now();
    if (currentNodeId !== undefined && currentNodeId !== nodeId)
      activeUntil.set(currentNodeId, timestamp + activeTtlMs);
    currentNodeId = nodeId;
    if (nodeId !== undefined) {
      activeUntil.set(nodeId, timestamp + activeTtlMs);
      options.activate(nodeId);
    }
    releaseExpired(timestamp);
    scheduleExpiry();
  }

  function isActive(nodeId: string): boolean {
    return nodeId === currentNodeId || (activeUntil.get(nodeId) ?? 0) > now();
  }

  function activeNodeIds(): string[] {
    releaseExpired(now());
    return [...activeUntil.keys()].filter(isActive);
  }

  function forget(nodeId: string): void {
    activeUntil.delete(nodeId);
    if (currentNodeId === nodeId) currentNodeId = undefined;
    scheduleExpiry();
  }

  function clear(): void {
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    expiryTimer = undefined;
    const nodeIds = new Set(activeUntil.keys());
    if (currentNodeId !== undefined) nodeIds.add(currentNodeId);
    activeUntil.clear();
    currentNodeId = undefined;
    for (const nodeId of nodeIds) options.release(nodeId);
  }

  function releaseExpired(timestamp: number): void {
    for (const [nodeId, expiresAt] of activeUntil) {
      if (nodeId === currentNodeId || expiresAt > timestamp) continue;
      activeUntil.delete(nodeId);
      options.release(nodeId);
    }
  }

  function scheduleExpiry(): void {
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    expiryTimer = undefined;
    let nextExpiry: number | undefined;
    for (const [nodeId, expiresAt] of activeUntil) {
      if (nodeId === currentNodeId) continue;
      nextExpiry = nextExpiry === undefined ? expiresAt : Math.min(nextExpiry, expiresAt);
    }
    if (nextExpiry === undefined) return;
    expiryTimer = setTimeout(
      () => {
        expiryTimer = undefined;
        releaseExpired(now());
        scheduleExpiry();
      },
      Math.max(0, nextExpiry - now())
    );
  }

  return {
    select,
    isActive,
    activeNodeIds,
    forget,
    clear
  };
}
