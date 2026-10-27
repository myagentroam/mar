import type { SessionStoreMaintenance } from '../contracts.js';

type Release = () => Promise<void>;

/** Owns tree discovery, acquisition order and cleanup; individual writers remain store-owned. */
export async function acquireTreeMaintenance(input: {
  sessionId: string;
  kind: 'clear' | 'delete';
  tree: () => Promise<readonly string[]>;
  acquire: (
    id: string,
    holding: SessionStoreMaintenance,
    registerGate: (release: Release) => void
  ) => Promise<Release>;
  admitted: (holding: SessionStoreMaintenance) => void;
  released: (holding: SessionStoreMaintenance) => void;
}): Promise<SessionStoreMaintenance> {
  const acquired = new Map<string, Release>();
  const gates = new Map<string, Release>();
  let sessionIds: readonly string[] = [];
  let released = false;
  const holding: SessionStoreMaintenance = Object.freeze({
    get sessionIds() {
      return sessionIds;
    },
    release: async () => {
      if (released) return;
      released = true;
      input.released(holding);
      let failure: { error: unknown } | undefined;
      for (const release of [...acquired.values()].reverse()) {
        try {
          await release();
        } catch (error) {
          failure ??= { error };
        }
      }
      for (const release of [...gates.values()].reverse()) {
        try {
          await release();
        } catch (error) {
          failure ??= { error };
        }
      }
      if (failure) throw failure.error;
    }
  });
  try {
    for (;;) {
      const tree = input.kind === 'delete' ? await input.tree() : [input.sessionId];
      for (const id of tree.toReversed()) {
        if (acquired.has(id)) continue;
        const release = await input.acquire(id, holding, (gate) => gates.set(id, gate));
        acquired.set(id, release);
      }
      const current = input.kind === 'clear' ? tree : await input.tree();
      if (current.every((id) => acquired.has(id))) {
        sessionIds = Object.freeze(current);
        break;
      }
    }
    input.admitted(holding);
    return holding;
  } catch (error) {
    await holding.release().catch(() => undefined);
    throw error;
  }
}
