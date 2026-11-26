import { AgentError } from '../error.js';
import type { ExtensionOperationContext } from '../extensions/operation.js';
import {
  captureCorePromptInput,
  type ExtensionPromptInput,
  type ExtensionPromptResult
} from '../extensions/prompt-input.js';
import type { SessionInputCoordinator, SessionInputEntry } from '../extensions/session-input.js';
import { imageMetadata } from '../session/catalog.js';
import type { SessionRecord } from '../session/store/index.js';
import type { SteerInput, SteerResult } from './types.js';

/** Admission reserves the existing FIFO before any asynchronous Hook or writer work. */
export function createNativeSteer(input: {
  readonly executionId: string;
  readonly inputs: SessionInputCoordinator;
  readonly admissionSignal: AbortSignal;
  operation<T>(action: (call: ExtensionOperationContext) => T, signal?: AbortSignal): T;
  admit(
    content: ExtensionPromptInput,
    call: ExtensionOperationContext,
    write: (
      content: ExtensionPromptInput,
      call: ExtensionOperationContext
    ) => Promise<ExtensionPromptResult>
  ): Promise<unknown>;
  receive(
    content: ExtensionPromptInput,
    clientMessageId: string,
    call: ExtensionOperationContext,
    source?: import('../extensions/session-input.js').ExtensionInputSource
  ): Promise<SessionRecord>;
  notify(entry: Extract<SteerResult, { status: 'accepted' }>['entry']): Promise<unknown>;
  diagnose(): void;
  wake(): void;
}): (
  request: SteerInput,
  source?: import('../extensions/session-input.js').ExtensionInputSource
) => Promise<SteerResult> {
  const retries = new Map<string, Promise<SteerResult>>();
  let admissionTail: Promise<unknown> = Promise.resolve();
  return async (request, source) => {
    if (request.expectedExecutionId !== input.executionId)
      return Promise.resolve({ status: 'notAccepted' });
    const previous = retries.get(request.clientMessageId);
    if (previous) return previous;
    if (input.admissionSignal.aborted || input.inputs.hasIdleBarrier)
      return Promise.resolve({ status: 'notAccepted' });
    if (
      typeof request.clientMessageId !== 'string' ||
      !request.clientMessageId.trim() ||
      request.clientMessageId.length > 512
    )
      return Promise.reject(
        new AgentError('MAR_AGENT_SESSION_INPUT_INVALID', 'A stable client message ID is required.')
      );
    const content = captureCorePromptInput({
      text: request.prompt,
      ...(request.modelText === undefined ? {} : { modelText: request.modelText }),
      ...(request.images === undefined ? {} : { images: request.images })
    });
    const result = Promise.withResolvers<SteerResult>();
    const entry = input.operation((call) =>
      input.inputs.accept(
        { kind: 'submit', input: content },
        call,
        (request, effective, next) => next(request, effective),
        'accepted'
      )
    );
    const reservation: NonNullable<SessionInputEntry['nativeSteer']> = { pending: true };
    entry.nativeSteer = reservation;
    const releaseAdmission = () => {
      delete reservation.pending;
    };
    const admissionController = new AbortController();
    let writing = false;
    let committed = false;
    const releaseReservation = () => {
      input.inputs.cancelSteerReservation(entry);
      releaseAdmission();
    };
    const aborted = () => {
      admissionController.abort(input.admissionSignal.reason);
      // A writer that has started owns the outcome until it reports whether it committed.
      if (!writing) {
        releaseReservation();
        result.resolve({ status: 'notAccepted' });
      }
    };
    input.admissionSignal.addEventListener('abort', aborted, { once: true });
    const write = async (
      actual: ExtensionPromptInput,
      effective: ExtensionOperationContext
    ): Promise<ExtensionPromptResult> => {
      if (committed) return {};
      effective.signal.throwIfAborted();
      writing = true;
      let record: SessionRecord;
      try {
        record = await input.receive(actual, request.clientMessageId, effective, source);
      } catch (error) {
        if (admissionController.signal.aborted) {
          releaseReservation();
          // I/O errors can leave a durable record. Only the writer's cancellation proves non-admission.
          if (error === admissionController.signal.reason)
            result.resolve({ status: 'notAccepted' });
          else result.reject(error);
        }
        throw error;
      } finally {
        writing = false;
      }
      committed = true;
      input.admissionSignal.removeEventListener('abort', aborted);
      reservation.recordId = record.recordId;
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
      releaseAdmission();
      result.resolve({ status: 'accepted', entry: historyEntry });
      input.wake();
      return {};
    };
    const admission = admissionTail
      .catch(() => undefined)
      .then(() =>
        input.operation((call) => input.admit(content, call, write), admissionController.signal)
      );
    void admission
      .then(
        () => {
          releaseAdmission();
          if (!committed && !admissionController.signal.aborted)
            result.resolve({ status: 'handled' });
        },
        (error) => {
          releaseAdmission();
          if (committed) input.diagnose();
          else if (!admissionController.signal.aborted) result.reject(error);
        }
      )
      .finally(() => {
        input.admissionSignal.removeEventListener('abort', aborted);
      });
    admissionTail = result.promise;
    retries.set(request.clientMessageId, result.promise);
    return result.promise;
  };
}
