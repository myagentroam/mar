import { describe, expect, it } from 'vitest';
import { CompactCoordinator } from '../../src/runtime/compaction/coordinator.js';
import { createExecutionCompactionFlight } from '../../src/sdk/execution-compaction-flight.js';

describe('execution compaction flights', () => {
  it.each(['compact', 'run'] as const)(
    'preserves the %s Compact error when its failure notification also fails',
    async (mode) => {
      const coordinator = new CompactCoordinator();
      const primary = new Error('compact failed');
      const secondary = new Error('failure publication failed');
      const emitted: string[] = [];
      const flight = createExecutionCompactionFlight({
        coordinator,
        executionId: 'execution',
        manualId: undefined,
        mode,
        executionSignal: new AbortController().signal,
        compactSignal: new AbortController().signal,
        currentManual: () => mode === 'compact',
        markSmartRequested: () => {},
        compact: async () => {
          throw primary;
        },
        perform: (input, run) => run(input, { signal: new AbortController().signal }),
        emit: async (event) => {
          emitted.push(event.type);
          throw secondary;
        }
      });
      flight.start({ async: mode === 'run' });
      await expect(coordinator.checkpoint(true)).rejects.toBe(primary);
      expect(emitted).toEqual(['context.compact_failed']);
      expect(coordinator.pending).toBe(false);
    }
  );

  it('still exposes a failure to publish the normal waiting event', async () => {
    const coordinator = new CompactCoordinator();
    const failure = new Error('waiting publication failed');
    const flight = createExecutionCompactionFlight({
      coordinator,
      executionId: 'execution',
      manualId: undefined,
      mode: 'run',
      executionSignal: new AbortController().signal,
      compactSignal: new AbortController().signal,
      currentManual: () => false,
      markSmartRequested: () => {},
      compact: async () => true,
      perform: (input, run) => run(input, { signal: new AbortController().signal }),
      emit: async () => {
        throw failure;
      }
    });
    await expect(flight.wait()).rejects.toBe(failure);
    await coordinator.checkpoint(true);
  });

  it('joins an existing flight and publishes one waiting event', async () => {
    const coordinator = new CompactCoordinator();
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const events: string[] = [];
    let calls = 0;
    const flight = createExecutionCompactionFlight({
      coordinator,
      executionId: 'execution',
      manualId: undefined,
      mode: 'run',
      executionSignal: new AbortController().signal,
      compactSignal: new AbortController().signal,
      currentManual: () => false,
      markSmartRequested: () => {},
      perform: (input, run) => run(input, { signal: new AbortController().signal }),
      compact: async (_input, _signal, prepare) => {
        calls++;
        entered();
        await gate;
        await prepare();
        return true;
      },
      emit: async (event) => {
        events.push(event.type);
      }
    });
    const first = flight.start({ async: true });
    await started;
    const joined = flight.wait();
    finish();
    await expect(joined).resolves.toBe(true);
    await expect(first.result).resolves.toBe(true);
    expect(calls).toBe(1);
    expect(events).toEqual(['context.compacting']);
  });
});
