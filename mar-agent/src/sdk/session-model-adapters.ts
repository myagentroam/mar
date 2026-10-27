import type { ModelAdapter } from '../model/contracts.js';
import type { ModelCredentialProvider } from '../model/configuration.js';
import {
  addModelCredentialProviders,
  closeModelAdapters,
  type ResolvedModelConfiguration
} from './model-runtime.js';

/** Session-owned cache; Agent coordinates references shared across Sessions. */
export class SessionModelAdapters {
  readonly #adapters = new Map<string, ModelAdapter>();
  #generation: number;

  constructor(
    generation: number,
    readonly createAdapter: (
      modelId: string,
      models: ReadonlyMap<string, ResolvedModelConfiguration>
    ) => ModelAdapter,
    readonly hasCustomAdapters: boolean
  ) {
    this.#generation = generation;
  }

  getOrCreate(
    modelId: string,
    models: ReadonlyMap<string, ResolvedModelConfiguration>
  ): ModelAdapter {
    const existing = this.#adapters.get(modelId);
    if (existing !== undefined) return existing;
    const adapter = this.createAdapter(modelId, models);
    // Stateless custom adapters belong to the individual Execution instead.
    if (!this.hasCustomAdapters || adapter.createTurnSession !== undefined)
      this.#adapters.set(modelId, adapter);
    return adapter;
  }

  snapshot(): readonly ModelAdapter[] {
    return [...this.#adapters.values()];
  }

  collectActiveReferences(target: Set<ModelAdapter>): void {
    for (const adapter of this.#adapters.values()) target.add(adapter);
  }

  collectCredentialProviders(target: Set<ModelCredentialProvider>): void {
    for (const adapter of this.#adapters.values())
      addModelCredentialProviders(target, adapter.configuration);
  }

  hasReference(adapter: ModelAdapter): boolean {
    return [...this.#adapters.values()].includes(adapter);
  }

  static closeSessions(sessions: readonly SessionModelAdapters[]): Promise<void> {
    return closeModelAdapters(sessions.flatMap((session) => session.drain()));
  }

  /** Stage one coordinated transition; each cache owns its own retirement and generation. */
  static async stageReconfiguration(
    sessions: readonly SessionModelAdapters[],
    models: ReadonlyMap<string, ResolvedModelConfiguration>,
    active: ReadonlySet<ModelAdapter>,
    assertOpen: () => void
  ): Promise<(generation: number) => void> {
    const commits = new Map<ModelAdapter, () => void>();
    for (const session of sessions)
      for (const { adapter, commit } of session.prepareReconfigure(models, active))
        commits.set(adapter, commit);
    const retained = new Set(commits.keys());
    const retired = new Set(sessions.flatMap((session) => session.retire(retained)));
    await closeModelAdapters([...retired].filter((adapter) => !active.has(adapter)));
    return (generation) => {
      assertOpen();
      for (const commit of commits.values()) commit();
      for (const session of sessions) session.setGeneration(generation);
    };
  }

  async refresh(generation: number, retainedByActive: ReadonlySet<ModelAdapter>): Promise<void> {
    if (this.#generation === generation) return;
    await closeModelAdapters(this.snapshot().filter((adapter) => !retainedByActive.has(adapter)));
    this.#adapters.clear();
    this.#generation = generation;
  }

  prepareReconfigure(
    models: ReadonlyMap<string, ResolvedModelConfiguration>,
    activeAdapters: ReadonlySet<ModelAdapter>
  ): readonly { readonly adapter: ModelAdapter; readonly commit: () => void }[] {
    const plans: { adapter: ModelAdapter; commit: () => void }[] = [];
    for (const [modelId, adapter] of this.#adapters) {
      if (activeAdapters.has(adapter)) continue;
      const configuration = models.get(modelId);
      const commit =
        configuration === undefined ? undefined : adapter.prepareReconfigure?.(configuration);
      if (commit !== undefined) plans.push({ adapter, commit });
    }
    return plans;
  }

  /** Remove unretained references; the caller deduplicates and closes across Sessions. */
  retire(retained: ReadonlySet<ModelAdapter>): readonly ModelAdapter[] {
    const removed: ModelAdapter[] = [];
    for (const [modelId, adapter] of this.#adapters) {
      if (!retained.has(adapter)) {
        removed.push(adapter);
        this.#adapters.delete(modelId);
      }
    }
    return removed;
  }

  setGeneration(generation: number): void {
    this.#generation = generation;
  }

  /** Transfer close responsibility once, so shared references can be closed as a group. */
  drain(): readonly ModelAdapter[] {
    const adapters = this.snapshot();
    this.#adapters.clear();
    return adapters;
  }
}
