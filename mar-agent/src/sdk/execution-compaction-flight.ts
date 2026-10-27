import { randomUUID } from 'node:crypto';
import { describeAgentError } from '../error.js';
import type { CompactCoordinator } from '../runtime/compaction/coordinator.js';
import type { ExecutionEventPayload } from './session-execution.js';

type CompactInput = { readonly focus?: string; readonly async?: boolean };

/** Owns Compact flight admission, joining, cancellation and failure publication. */
export function createExecutionCompactionFlight(ports: {
  readonly coordinator: CompactCoordinator;
  readonly executionId: string;
  readonly manualId: string | undefined;
  readonly mode: 'run' | 'plan' | 'compact';
  readonly executionSignal: AbortSignal;
  readonly compactSignal: AbortSignal;
  currentManual(): boolean;
  markSmartRequested(): void;
  compact(
    input: CompactInput,
    signal: AbortSignal,
    prepare: () => Promise<void>,
    id: string
  ): Promise<boolean>;
  perform(
    input: CompactInput,
    run: (
      effective: CompactInput,
      call: { signal: AbortSignal }
    ) => Promise<{ changed: boolean; executionId: string }>
  ): Promise<{ changed: boolean }>;
  emit(event: ExecutionEventPayload): Promise<void>;
}) {
  const start = (input: CompactInput = {}) => {
    const id = ports.manualId ?? randomUUID();
    const flight = ports.coordinator.start(id, input.focus, async (prepare, signal) => {
      const linked = AbortSignal.any([signal, ports.executionSignal, ports.compactSignal]);
      try {
        if (ports.mode === 'compact' && ports.currentManual())
          return await ports.compact(input, linked, prepare, id);
        return (
          await ports.perform(input, async (effective, call) => ({
            changed: await ports.compact(
              { ...effective, async: input.async === true },
              AbortSignal.any([linked, call.signal]),
              prepare,
              id
            ),
            executionId: ports.executionId
          }))
        ).changed;
      } catch (error) {
        const diagnostic = describeAgentError(error, 'MAR_AGENT_COMPACT_FAILED');
        try {
          await ports.emit({
            type: 'context.compact_failed',
            compactionId: id,
            code: diagnostic.code,
            async: input.async === true,
            cancelled: linked.aborted
          });
        } catch {
          // Failure notification cannot replace the authoritative Compact error.
        }
        throw error;
      }
    });
    ports.markSmartRequested();
    return flight;
  };
  const wait = async (input: CompactInput = {}) => {
    const flight = start(input);
    if (input.async) return false;
    await ports.emit({
      type: 'context.compacting',
      compactionId: flight.id,
      stage: 'WAITING',
      async: false
    });
    return (await ports.coordinator.checkpoint(true)) ?? false;
  };
  return { start, wait };
}
