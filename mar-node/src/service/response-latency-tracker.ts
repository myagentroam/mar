/** Monotonic, observation-only timing; native event semantics belong to each Runner. */
export class ResponseLatencyTracker {
  private waitingAt: number | undefined;
  private readonly pendingTools = new Set<string>();
  private readonly completedTools = new Set<string>();
  private readonly observedResponses = new Set<string>();
  hasObservedResponse = false;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.waitingAt = now();
  }

  response(id?: string, incremental = false): number | undefined {
    if (id !== undefined) {
      // A new delta is semantic output even when the Runner reuses a response item.
      if (!incremental && this.observedResponses.has(id)) return undefined;
      this.observedResponses.add(id);
      if (this.observedResponses.size > 1_024)
        this.observedResponses.delete(this.observedResponses.values().next().value as string);
    }
    if (this.waitingAt === undefined || this.pendingTools.size > 0) return undefined;
    const latencyMs = Math.max(0, Math.round(this.now() - this.waitingAt));
    this.waitingAt = undefined;
    this.hasObservedResponse = true;
    return latencyMs;
  }

  toolStarted(id: string): number | undefined {
    if (this.completedTools.has(id) || this.pendingTools.has(id)) return undefined;
    const latencyMs = this.response(id);
    this.pendingTools.add(id);
    this.waitingAt = undefined;
    return latencyMs;
  }

  toolCompleted(id: string): void {
    if (this.completedTools.has(id)) return;
    this.completedTools.add(id);
    if (this.completedTools.size > 1_024)
      this.completedTools.delete(this.completedTools.values().next().value as string);
    this.pendingTools.delete(id);
    if (this.pendingTools.size === 0) this.waitingAt = this.now();
  }
}
