import type { PromptCompletionAttention } from '@myagentroam/protocol';

/** Page-local attention, never persisted or shared with another browser/user. */
export class PromptPredictionAttentionService {
  private entries: { scope: string; value: PromptCompletionAttention }[] = [];
  constructor(private readonly now: () => number = Date.now) {}
  clear(): void {
    this.entries = [];
  }
  record(scope: string, value: Omit<PromptCompletionAttention, 'observedAt'>): void {
    this.prune();
    this.entries = this.entries.filter(
      (entry) =>
        entry.scope !== scope || entry.value.path !== value.path || entry.value.kind !== value.kind
    );
    this.entries.push({ scope, value: { ...value, observedAt: this.now() } });
    this.entries = this.entries.slice(-20);
  }
  snapshot(scope: string): readonly PromptCompletionAttention[] {
    this.prune();
    return this.entries
      .filter((entry) => entry.scope === scope)
      .map((entry) => ({ ...entry.value }));
  }
  private prune(): void {
    const now = this.now();
    this.entries = this.entries.filter(
      (entry) => now - entry.value.observedAt < 180_000 && entry.value.observedAt <= now
    );
  }
}
