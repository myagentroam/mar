import { AgentError } from '../error.js';

export type ToolWaitOutcome =
  'snapshot' | 'message' | 'completion' | 'timeout' | 'yield' | 'interrupted';

/** A wake-up source, deliberately independent of resource cancellation. */
export interface ToolWaitInterrupt {
  pending(): boolean;
  subscribe(listener: () => void): () => void;
}

export function createToolWaitInterrupt(pending: () => boolean) {
  const listeners = new Set<() => void>();
  return {
    pending,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notify() {
      for (const listener of listeners) listener();
    }
  };
}

export function waitMetadata<T extends ToolWaitOutcome>(
  waitOutcome: T
): {
  waitOutcome: T;
  reason?: 'steer';
} {
  return { waitOutcome, ...(waitOutcome === 'interrupted' ? { reason: 'steer' as const } : {}) };
}

/** All exits release listeners; a ready result wins over steer and the deadline. */
export function waitForToolCondition(input: {
  ready(): boolean;
  subscribe(listener: () => void): () => void;
  waitMs: number;
  signal?: AbortSignal | undefined;
  interrupt?: ToolWaitInterrupt | undefined;
}): Promise<'ready' | 'timeout' | 'interrupted'> {
  input.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    let unsubscribeInterrupt = () => {};
    let cancelTimer = () => {};
    const finish = (outcome: 'ready' | 'timeout' | 'interrupted', error?: unknown) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      unsubscribeInterrupt();
      cancelTimer();
      input.signal?.removeEventListener('abort', abort);
      if (error === undefined) resolve(outcome);
      else reject(error);
    };
    const check = () => {
      if (input.signal?.aborted) abort();
      else if (input.ready()) finish('ready');
      else if (input.interrupt?.pending()) finish('interrupted');
    };
    const abort = () =>
      finish(
        'interrupted',
        input.signal?.reason ??
          new AgentError('MAR_AGENT_EXECUTION_CANCELLED', 'Execution cancelled.')
      );
    unsubscribe = input.subscribe(check);
    unsubscribeInterrupt = input.interrupt?.subscribe(check) ?? (() => {});
    cancelTimer = waitDeadline(input.waitMs, () => {
      check();
      finish('timeout');
    });
    input.signal?.addEventListener('abort', abort, { once: true });
    check();
  });
}

/** Explicit waits retain their deadline without overflowing the platform timer. */
export function waitDeadline(waitMs: number, finish: () => void): () => void {
  if (waitMs <= 2_147_483_647) {
    const timer = setTimeout(finish, waitMs);
    return () => clearTimeout(timer);
  }
  const deadline = performance.now() + waitMs;
  let timer: ReturnType<typeof setTimeout>;
  const tick = () => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) finish();
    else arm(remaining);
  };
  const arm = (remaining: number) => {
    timer = setTimeout(tick, Math.min(remaining, 2_147_483_647));
  };
  arm(waitMs);
  return () => clearTimeout(timer);
}
