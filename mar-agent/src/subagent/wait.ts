import { waitForToolCondition, type ToolWaitInterrupt } from '../runtime/wait.js';

export { parseAgentWaitTargets } from './wait-targets.js';

export { waitDeadline } from '../runtime/wait.js';

/** Waiters own notification and aggregation, never child state. */
export class SubagentWaitCoordinator<T, A> {
  readonly #completions = new Set<(value: T) => void>();
  readonly #activities = new Set<(value: A) => void>();

  subscribeActivity(listener: (activity: A) => void): () => void {
    this.#activities.add(listener);
    return () => {
      this.#activities.delete(listener);
    };
  }
  notifyCompletion(value: T): void {
    for (const listener of this.#completions) listener(value);
  }
  notifyActivity(value: A): void {
    for (const listener of this.#activities) listener(value);
  }
  waitCompletion(
    accepts: (value: T) => boolean,
    current: () => T | undefined,
    waitMs: number,
    signal?: AbortSignal,
    interrupt?: ToolWaitInterrupt
  ): Promise<T | undefined> {
    return waitForNotification(this.#completions, accepts, current, waitMs, signal, interrupt);
  }
  waitActivity(
    accepts: (value: A) => boolean,
    current: () => A | undefined,
    waitMs: number,
    signal?: AbortSignal,
    interrupt?: ToolWaitInterrupt
  ): Promise<A | undefined> {
    return waitForNotification(this.#activities, accepts, current, waitMs, signal, interrupt);
  }
}

async function waitForNotification<T>(
  waiters: Set<(value: T) => void>,
  accepts: (value: T) => boolean,
  current: () => T | undefined,
  waitMs: number,
  signal?: AbortSignal,
  interrupt?: ToolWaitInterrupt
): Promise<T | undefined> {
  let value: T | undefined;
  await waitForToolCondition({
    ready: () => {
      value ??= current();
      return value !== undefined;
    },
    subscribe: (notify) => {
      const listener = (next: T) => {
        if (accepts(next)) {
          value = next;
          notify();
        }
      };
      waiters.add(listener);
      return () => {
        waiters.delete(listener);
      };
    },
    waitMs,
    signal,
    interrupt
  });
  return value;
}

/** A group owns one listener and one deadline; readiness never consumes observations. */
export async function waitForAgentGroup<T>(input: {
  targets: readonly T[];
  mode: 'any' | 'all';
  waitMs: number | undefined;
  signal: AbortSignal | undefined;
  interrupt: Parameters<typeof waitForToolCondition>[0]['interrupt'];
  refresh(): void;
  ready(target: T): boolean;
  subscribe(notify: () => void): () => void;
}): Promise<{ snapshot: boolean; satisfied: boolean }> {
  const snapshot = input.waitMs === undefined || input.waitMs === 0;
  const satisfied = () =>
    input.mode === 'all' ? input.targets.every(input.ready) : input.targets.some(input.ready);
  if (!snapshot) {
    await waitForToolCondition({
      waitMs: input.waitMs!,
      signal: input.signal,
      interrupt: input.interrupt,
      ready: () => {
        input.refresh();
        return satisfied();
      },
      subscribe: input.subscribe
    });
    input.signal?.throwIfAborted();
  }
  input.refresh();
  return { snapshot, satisfied: !snapshot && satisfied() };
}
