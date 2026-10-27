import { AgentError } from '../error.js';
import { DEFAULT_COMPACTION_FOCUS } from '../runtime/compaction/history.js';
import {
  recordSessionInputCommit,
  type ExtensionSessionActionResult,
  type ExtensionSessionRequest,
  type SessionInputEntry
} from '../extensions/session-input.js';
import type { ExtensionOperationContext } from '../extensions/operation.js';
import type { ExecutionMode, RunInput } from './types.js';
import type { InternalExecutionHandle, InternalExecutionOptions } from './session-execution.js';

/** Adapts committed Extension input to an independently owned Execution. */
export function createExtensionSessionLaunch(
  sourceType: 'user' | 'subagent',
  start: (
    mode: ExecutionMode,
    input: RunInput,
    options: InternalExecutionOptions
  ) => InternalExecutionHandle
) {
  return async (
    entry: SessionInputEntry,
    request: Exclude<ExtensionSessionRequest, { kind: 'append' }>,
    call: ExtensionOperationContext
  ) => {
    if (sourceType !== 'user')
      throw new AgentError(
        'MAR_AGENT_SESSION_INPUT_UNAVAILABLE',
        'Idle subagent input must use its task controller.'
      );
    let resolveInput!: (outcome: ExtensionSessionActionResult) => void;
    let rejectInput!: (error: unknown) => void;
    const inputCommitted = new Promise<ExtensionSessionActionResult>((resolve, reject) => {
      resolveInput = resolve;
      rejectInput = reject;
    });
    void inputCommitted.catch(() => undefined);
    const handle = start(
      request.kind === 'compact' ? 'compact' : 'run',
      {
        prompt:
          request.kind === 'compact'
            ? (request.input.focus ?? DEFAULT_COMPACTION_FOCUS)
            : request.input.text,
        ...(request.kind === 'submit' && request.input.images !== undefined
          ? { images: request.input.images }
          : {})
      },
      {
        automaticInput: true,
        inputCommitted: (recordId) => {
          const outcome = { changed: true, recordId, executionId: handle.executionId };
          recordSessionInputCommit(entry, outcome);
          resolveInput(outcome);
        },
        ...(request.kind === 'submit' ? { promptAdmitted: true } : {}),
        ...(call.actor === 'sdk' && call.extensionId === undefined
          ? {}
          : { inputSource: 'extension' as const }),
        ...(request.kind === 'submit' && request.input.modelText !== undefined
          ? { modelText: request.input.modelText }
          : {}),
        ...(request.kind === 'submit' && request.input.context !== undefined
          ? { inputContext: request.input.context }
          : {}),
        ...(request.kind === 'submit' && request.input.modelContext !== undefined
          ? { modelContext: request.input.modelContext }
          : {}),
        ...(call.actor === 'sdk' && call.extensionId === undefined
          ? {}
          : {
              extensionSource: extensionInputSource(
                call,
                request.kind === 'submit' ? request.input.provenance : undefined,
                request.kind === 'submit' ? request.input.modelAttribution : undefined
              )
            })
      }
    );
    void handle.result().then((result) => {
      if (request.kind === 'compact')
        resolveInput({
          changed: result.status === 'completed',
          executionId: handle.executionId
        });
      else
        rejectInput(
          new AgentError(
            result.errorCode ??
              (result.status === 'cancelled'
                ? 'MAR_AGENT_EXECUTION_CANCELLED'
                : 'MAR_AGENT_SESSION_INPUT_FAILED'),
            'Execution ended before its input record was committed.'
          )
        );
    }, rejectInput);
    return Object.assign(handle, { inputCommitted });
  };
}

export function extensionInputSource(
  call: ExtensionOperationContext,
  provenance?: string,
  modelAttribution?: 'none'
) {
  return {
    operationId: call.operationId,
    actor: call.actor,
    ...(call.extensionId ? { extensionId: call.extensionId } : {}),
    ...(call.ownerInstanceId ? { ownerInstanceId: call.ownerInstanceId } : {}),
    ...(provenance !== undefined ? { provenance } : {}),
    ...(modelAttribution === undefined ? {} : { modelAttribution })
  };
}
