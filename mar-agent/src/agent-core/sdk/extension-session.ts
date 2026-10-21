import { MarAgentError } from '../error.js';
import type { ExecutionHandle } from './types.js';
import type { CoreOperationContext } from '../extensions/operation.js';
import type { CoreRequestSnapshot } from '../extensions/model-request.js';
import type { CorePromptComposition, CorePromptFacts } from '../extensions/prompt-composition.js';
import {
  SessionInputCoordinator,
  type CoreSessionBackend,
  type CoreSessionRequest,
  type SessionInputEntry,
  type CoreSessionMessages,
  type CoreSessionMessagesInput,
  type CoreSessionActionResult
} from '../extensions/session-input.js';
import type { CoreSessionDescription } from '../extensions/session-input.js';

export interface ExtensionSessionPorts {
  describe?(call: CoreOperationContext): Promise<CoreSessionDescription>;
  composePrompt?(
    facts: CorePromptFacts,
    call: CoreOperationContext
  ): Promise<CorePromptComposition>;
  captureRequest(
    call: CoreOperationContext,
    input?: { readonly completed?: boolean }
  ): Promise<CoreRequestSnapshot | undefined>;
  readonly sessionId: string;
  coordinator(): SessionInputCoordinator;
  activeExecutionId(): string | undefined;
  messages(
    input: CoreSessionMessagesInput,
    call: CoreOperationContext
  ): Promise<CoreSessionMessages>;
  append(
    entry: SessionInputEntry,
    request: Extract<CoreSessionRequest, { kind: 'append' }>,
    call: CoreOperationContext
  ): Promise<CoreSessionActionResult>;
  launch(
    entry: SessionInputEntry,
    request: Exclude<CoreSessionRequest, { kind: 'append' }>,
    call: CoreOperationContext
  ): Promise<ExecutionHandle & { readonly inputCommitted: Promise<CoreSessionActionResult> }>;
  diagnose(code: string, operationId: string): void;
}

/** Admission and idle execution reuse the same Session coordinator and SDK entry. */
export function createExtensionSessionBackend(
  ports: ExtensionSessionPorts
): CoreSessionBackend & { kick(): void } {
  let scheduled: Promise<void> | undefined;
  const idleLeaf = async (
    entry: SessionInputEntry,
    request: CoreSessionRequest,
    call: CoreOperationContext
  ): Promise<CoreSessionActionResult> => {
    call.signal.throwIfAborted();
    if (request.kind === 'append') return ports.append(entry, request, call);
    const handle = await ports.launch(entry, request, call);
    ports.coordinator().startExecution(entry, handle.executionId);
    const cancel = () => handle.cancel();
    call.signal.addEventListener('abort', cancel, { once: true });
    if (call.signal.aborted) cancel();
    const completion = handle
      .result()
      .then((result) => {
        ports.coordinator().settleExecution(handle.executionId, result.status);
        return result;
      })
      .finally(() => call.signal.removeEventListener('abort', cancel));
    if (request.kind === 'compact') {
      const result = await completion;
      if (result.status !== 'completed')
        throw new MarAgentError(
          result.errorCode ?? 'MAR_AGENT_COMPACT_FAILED',
          'Requested compaction did not complete.'
        );
    } else {
      void completion.catch(() =>
        ports.diagnose('MAR_AGENT_SESSION_INPUT_FAILED', call.operationId)
      );
      return await handle.inputCommitted;
    }
    return { changed: true, executionId: handle.executionId };
  };
  const kick = (): void => {
    if (
      scheduled ||
      ports.activeExecutionId() ||
      ports.coordinator().executing ||
      !ports.coordinator().hasPending
    )
      return;
    scheduled = Promise.resolve()
      .then(async () => {
        if (!ports.activeExecutionId()) await ports.coordinator().drain(idleLeaf, undefined, 1);
      })
      .catch(() => ports.diagnose('MAR_AGENT_SESSION_INPUT_FAILED', 'idle-admission'))
      .finally(() => {
        scheduled = undefined;
        kick();
      });
  };
  return {
    ...(ports.describe ? { describe: (call: CoreOperationContext) => ports.describe!(call) } : {}),
    ...(ports.composePrompt
      ? {
          composePrompt: (facts: CorePromptFacts, call: CoreOperationContext) =>
            ports.composePrompt!(facts, call)
        }
      : {}),
    captureRequest: (call, input) => ports.captureRequest(call, input),
    kick,
    inspect: async (call) => {
      call.signal.throwIfAborted();
      const executionId = ports.activeExecutionId();
      return {
        sessionId: ports.sessionId,
        epoch: call.sessionEpoch,
        ...(executionId ? { activeExecutionId: executionId } : {}),
        operations: ports.coordinator().inspect()
      };
    },
    messages: (input, call) => ports.messages(input, call),
    handled: (input, call, value) => ports.coordinator().handled(input, call, value),
    own: (id) => {
      const coordinator = ports.coordinator();
      return () => coordinator.retire(id);
    },
    enqueue: async (request, call, action) => {
      const coordinator = ports.coordinator();
      if (request.kind === 'append' && request.input.delivery === 'immediate') {
        try {
          return await coordinator.performAppend(
            request.input,
            call,
            action,
            (entry, value, effective) => {
              if (value.kind !== 'append')
                throw new MarAgentError(
                  'MAR_AGENT_SESSION_INPUT_INVALID',
                  'Immediate record submission must remain an append.'
                );
              return ports.append(entry, value, effective);
            }
          );
        } finally {
          kick();
        }
      }
      const current = request.kind === 'compact' ? coordinator.currentCompact() : undefined;
      if (current)
        throw new MarAgentError(
          'MAR_AGENT_COMPACT_REENTRANT',
          'Recursive compaction is not allowed.'
        );
      const idle = !ports.activeExecutionId() && !coordinator.executing;
      const entry = coordinator.accept(
        request,
        call,
        action,
        request.kind === 'submit' ? 'accepted' : 'queued'
      );
      kick();
      if (idle && request.kind === 'submit' && request.input.waitFor === 'start')
        await entry.started;
      else if (
        (idle &&
          request.kind !== 'submit' &&
          !(request.kind === 'compact' && request.input.async)) ||
        (request.kind === 'submit' && request.input.waitFor === 'commit')
      )
        await entry.terminal;
      return Object.freeze({ ...entry.receipt });
    }
  };
}
