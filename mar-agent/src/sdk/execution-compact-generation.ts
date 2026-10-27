import { generateCompactionCandidate } from '../runtime/compaction/generate.js';
import type { CompactionOperation } from '../runtime/compaction/operation.js';
import type { ModelTurnSession } from '../model/contracts.js';

type Snapshot = Parameters<typeof generateCompactionCandidate>[0];
type Generation = Parameters<typeof generateCompactionCandidate>[1];

/** Borrows one independent Compact Turn and joins its operation before closing it. */
export async function generateExecutionCompaction(input: {
  readonly snapshot: Snapshot;
  createOperation(): CompactionOperation;
  withTurn<T>(run: (turn: ModelTurnSession) => Promise<T>): Promise<T>;
  readonly generateExtension: Generation['generateExtension'];
  readonly transformRequest: Generation['transformRequest'];
  readonly stream: Generation['stream'];
  readonly observeUsage: Generation['observeUsage'];
  readonly onAttemptDiagnostic: Generation['onAttemptDiagnostic'];
}) {
  const operation = input.createOperation();
  let entered = false;
  try {
    return await input.withTurn(async (turn) => {
      entered = true;
      try {
        return await generateCompactionCandidate(input.snapshot, {
          operation,
          turn,
          generateExtension: input.generateExtension,
          transformRequest: input.transformRequest,
          stream: input.stream,
          observeUsage: input.observeUsage,
          onAttemptDiagnostic: input.onAttemptDiagnostic
        });
      } finally {
        await operation.dispose();
      }
    });
  } catch (error) {
    if (!entered) await operation.dispose().catch(() => undefined);
    throw error;
  }
}
