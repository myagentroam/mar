import type { ClientToolDefinition } from './contracts.js';
import { AsyncLocalStorage } from 'node:async_hooks';

const sessionToolIngress = new AsyncLocalStorage<symbol>();

/** A managed independent callback must not borrow its still-active creator's tool barrier. */
export function withIndependentSessionTools<Value>(run: () => Value): Value {
  return sessionToolIngress.run(Symbol(), run);
}

/** One barrier domain for foreground tools and all retained cells in a Session. */
export function createSessionToolScheduler() {
  type Job = { name: string; run: () => Promise<unknown> };
  type Lease = {
    active: boolean;
    readonly ingress: symbol | undefined;
    schedule: (job: Job) => Promise<unknown>;
    children: Set<Promise<void>>;
  };
  const leases = new AsyncLocalStorage<Lease>();
  const definitions = [
    { name: 'safe', parallelSafety: 'safe' },
    { name: 'serial', parallelSafety: 'serial' }
  ] as ClientToolDefinition[];
  const execute = async (job: Job): Promise<unknown> => {
    const lease: Lease = {
      active: true,
      ingress: sessionToolIngress.getStore(),
      schedule: createToolCallScheduler(definitions, execute),
      children: new Set()
    };
    return leases.run(lease, async () => {
      try {
        return await job.run();
      } finally {
        // The parent keeps its barrier until every accepted descendant has settled.
        while (lease.children.size) await Promise.all([...lease.children]);
        lease.active = false;
      }
    });
  };
  const root = createToolCallScheduler(definitions, execute);
  return <T>(definition: ClientToolDefinition | undefined, run: () => Promise<T>): Promise<T> => {
    const inherited = leases.getStore();
    const parent = inherited?.ingress === sessionToolIngress.getStore() ? inherited : undefined;
    const result = (parent?.active ? parent.schedule : root)({
      name: definition?.parallelSafety === 'serial' ? 'serial' : 'safe',
      run
    }) as Promise<T>;
    if (parent?.active) {
      const settled = result.then(
        () => undefined,
        () => undefined
      );
      parent.children.add(settled);
      void settled.then(() => parent.children.delete(settled));
    }
    return result;
  };
}

/** Schedules an incremental stream while preserving the same safe/serial barriers as batches. */
export function createToolCallScheduler<TCall extends { readonly name: string }, TResult>(
  definitions: readonly ClientToolDefinition[],
  execute: (call: TCall) => Promise<TResult>
): (call: TCall) => Promise<TResult> {
  const safety = new Map(
    definitions.map((definition) => [definition.name, definition.parallelSafety])
  );
  let barrier = Promise.resolve();
  const readers = new Set<Promise<void>>();
  return (call) => {
    const safe = safety.get(call.name) !== 'serial';
    const gate = safe ? barrier : Promise.all([barrier, ...readers]).then(() => undefined);
    const result = gate.then(() => execute(call));
    const settled = result.then(
      () => undefined,
      () => undefined
    );
    if (safe) {
      readers.add(settled);
      void settled.then(() => readers.delete(settled));
    } else {
      readers.clear();
      barrier = settled;
    }
    return result;
  };
}

export async function scheduleToolCallBatch<TCall extends { readonly name: string }, TResult>(
  calls: readonly TCall[],
  definitions: readonly ClientToolDefinition[],
  execute: (call: TCall) => Promise<TResult>
): Promise<TResult[]> {
  const safety = new Map(
    definitions.map((definition) => [definition.name, definition.parallelSafety])
  );
  const results = new Array<TResult>(calls.length);
  let index = 0;

  while (index < calls.length) {
    if (safety.get(calls[index]!.name) === 'serial') {
      results[index] = await execute(calls[index]!);
      index++;
      continue;
    }

    let end = index + 1;
    while (end < calls.length && safety.get(calls[end]!.name) !== 'serial') end++;
    const segment = await Promise.all(calls.slice(index, end).map((call) => execute(call)));
    for (let segmentIndex = 0; segmentIndex < segment.length; segmentIndex++)
      results[index + segmentIndex] = segment[segmentIndex]!;
    index = end;
  }

  return results;
}
