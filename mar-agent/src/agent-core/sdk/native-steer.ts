import { MarAgentError } from '../error.js';
import type { CoreOperationContext } from '../extensions/operation.js';
import {
  captureCorePromptInput,
  type CorePromptInput,
  type CorePromptResult
} from '../extensions/prompt-input.js';
import type { SessionInputCoordinator } from '../extensions/session-input.js';
import { imageMetadata } from '../session/catalog.js';
import type { SessionRecord } from '../session/store/index.js';
import type { SteerInput, SteerResult } from './types.js';

/** Admission reserves the existing FIFO before any asynchronous Hook or writer work. */
export function createNativeSteer(input: {
  readonly executionId: string;
  readonly inputs: SessionInputCoordinator;
  readonly signal: AbortSignal;
  isOpen(): boolean;
  operation<T>(action: (call: CoreOperationContext) => T): T;
  admit(
    content: CorePromptInput,
    call: CoreOperationContext,
    write: (content: CorePromptInput, call: CoreOperationContext) => Promise<CorePromptResult>
  ): Promise<unknown>;
  receive(
    content: CorePromptInput,
    clientMessageId: string,
    call: CoreOperationContext
  ): Promise<SessionRecord>;
  notify(entry: Extract<SteerResult, { status: 'accepted' }>['entry']): Promise<unknown>;
  diagnose(): void;
  wake(): void;
}): (request: SteerInput) => Promise<SteerResult> {
  const retries = new Map<string, Promise<SteerResult>>();
  let admissionTail: Promise<unknown> = Promise.resolve();
  return async (request) => {
    if (request.expectedExecutionId !== input.executionId)
      return Promise.resolve({ status: 'notAccepted' });
    const previous = retries.get(request.clientMessageId);
    if (previous) return previous;
    if (!input.isOpen() || input.signal.aborted || input.inputs.hasIdleBarrier)
      return Promise.resolve({ status: 'notAccepted' });
    if (
      typeof request.clientMessageId !== 'string' ||
      !request.clientMessageId.trim() ||
      request.clientMessageId.length > 512
    )
      return Promise.reject(
        new MarAgentError(
          'MAR_AGENT_SESSION_INPUT_INVALID',
          'A stable client message ID is required.'
        )
      );
    const content = captureCorePromptInput({
      text: request.prompt,
      ...(request.modelText === undefined ? {} : { modelText: request.modelText }),
      ...(request.images === undefined ? {} : { images: request.images })
    });
    const result = Promise.withResolvers<SteerResult>();
    const ready = Promise.withResolvers<void>();
    const entry = input.operation((call) =>
      input.inputs.accept(
        { kind: 'submit', input: content },
        call,
        (request, effective, next) => next(request, effective),
        'accepted'
      )
    );
    entry.nativeSteer = { ready: ready.promise };
    const aborted = () => ready.resolve();
    input.signal.addEventListener('abort', aborted, { once: true });
    let committed = false;
    const admission = admissionTail
      .catch(() => undefined)
      .then(() =>
        input.operation((call) =>
          input.admit(content, call, async (actual, effective) => {
            if (committed) return {};
            effective.signal.throwIfAborted();
            if (!input.isOpen()) {
              result.resolve({ status: 'notAccepted' });
              return {};
            }
            const record = await input.receive(actual, request.clientMessageId, effective);
            committed = true;
            entry.nativeSteer!.recordId = record.recordId;
            const payload = record.payload as Record<string, unknown>;
            const images = imageMetadata(payload.images);
            const historyEntry: Extract<SteerResult, { status: 'accepted' }>['entry'] = {
              kind: 'user',
              recordId: record.recordId,
              sequence: record.sequence,
              timestamp: record.timestamp,
              sessionId: record.sessionId,
              executionId: record.executionId!,
              turnId: record.turnId!,
              text: payload.prompt as string,
              clientMessageId: request.clientMessageId,
              ...(images.length ? { images } : {})
            };
            // Neither Hook post-processing nor a failed observer can revoke the writer's receipt.
            void input.notify(historyEntry).catch(() => input.diagnose());
            ready.resolve();
            result.resolve({ status: 'accepted', entry: historyEntry });
            input.wake();
            return {};
          })
        )
      );
    void admission
      .then(
        () => {
          if (!committed) result.resolve({ status: 'handled' });
        },
        (error) => {
          if (!committed) result.reject(error);
          else input.diagnose();
        }
      )
      .finally(() => {
        ready.resolve();
        input.signal.removeEventListener('abort', aborted);
      });
    admissionTail = result.promise;
    retries.set(request.clientMessageId, result.promise);
    return result.promise;
  };
}
