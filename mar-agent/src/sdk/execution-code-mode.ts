import type { SessionStore } from '../session/store/contracts.js';
import type { ClientToolDefinition } from '../tools/contracts.js';
import { allowsToolCaller } from '../tools/callers.js';
import type { RoundToolScope } from '../tools/execution.js';
import type { ExecutionResult } from './types.js';

/** Retains the Session and its Extension scope while a code cell outlives the caller. */
export function createExecutionCodeModeContext(input: {
  readonly store: Pick<
    SessionStore,
    'readCodeModeState' | 'retainSessionLease' | 'append' | 'commitCodeModeState'
  >;
  readonly sessionId: string;
  readonly executionId: string;
  readonly turnId: string;
  readonly writerOwner: object;
  readonly supportsImages: boolean;
  readonly tools: readonly ClientToolDefinition[];
  permissionStop(callId: string): ExecutionResult['permissionStop'];
  assertLive(): void;
  pin(): () => void;
  cleanupFailed(): void;
}): NonNullable<RoundToolScope['codeModeContext']> {
  return async (call) => {
    const stateSnapshot =
      call.name === 'code_exec' ? await input.store.readCodeModeState(input.sessionId) : [];
    return {
      retainSession: async () => {
        input.assertLive();
        const release = await input.store.retainSessionLease(input.sessionId, input.writerOwner);
        let unpin: () => void;
        try {
          unpin = input.pin();
        } catch (error) {
          try {
            await release();
          } catch {
            input.cleanupFailed();
          }
          throw error;
        }
        return async () => {
          try {
            await release();
          } finally {
            unpin();
          }
        };
      },
      onSettled: async (result) => {
        await input.store.append(input.sessionId, {
          type: 'code.cell.completed',
          payload: { ...result, callId: call.callId },
          executionId: input.executionId,
          turnId: input.turnId
        });
      },
      supportsImages: input.supportsImages,
      permissionStop: () => input.permissionStop(call.callId),
      tools: input.tools.filter((tool) => allowsToolCaller(tool, 'programmatic')),
      state: stateSnapshot,
      commitState: (mutations) =>
        input.store.commitCodeModeState(input.sessionId, mutations, {
          executionId: input.executionId,
          turnId: input.turnId,
          expectedState: stateSnapshot
        })
    };
  };
}
