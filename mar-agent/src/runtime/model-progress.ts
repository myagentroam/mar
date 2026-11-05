import { AgentError } from '../error.js';
import type { ModelEvent } from '../model/contracts.js';

const MODEL_PROGRESS_TIMEOUT_MS = 180_000;

/** Watch normalized generation progress, not transport traffic or consumer processing. */
export async function* observeModelProgress(
  start: (signal: AbortSignal) => AsyncIterable<ModelEvent>,
  parent: AbortSignal
): AsyncIterable<ModelEvent> {
  parent.throwIfAborted();
  const controller = new AbortController();
  const signal = AbortSignal.any([parent, controller.signal]);
  const iterator = start(signal)[Symbol.asyncIterator]();
  const hostedStates = new Map<string, string>();
  let remainingMs = MODEL_PROGRESS_TIMEOUT_MS;
  let failed = false;
  try {
    for (;;) {
      signal.throwIfAborted();
      const startedAt = performance.now();
      let abort: (() => void) | undefined;
      const timer = setTimeout(() => {
        controller.abort(
          new AgentError(
            'MAR_AGENT_MODEL_TIMEOUT',
            'Model request produced no generation progress for 180 seconds.',
            { details: { reason: 'MODEL_PROGRESS_TIMEOUT' }, retryable: true }
          )
        );
      }, Math.ceil(remainingMs));
      timer.unref();
      let next: IteratorResult<ModelEvent>;
      try {
        next = await Promise.race([
          iterator.next(),
          new Promise<never>((_resolve, reject) => {
            abort = () => reject(signal.reason);
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
          })
        ]);
        signal.throwIfAborted();
      } finally {
        clearTimeout(timer);
        if (abort) signal.removeEventListener('abort', abort);
      }
      remainingMs = Math.max(0, remainingMs - (performance.now() - startedAt));
      if (next.done) return;
      if (isGenerationProgress(next.value, hostedStates)) remainingMs = MODEL_PROGRESS_TIMEOUT_MS;
      yield next.value;
    }
  } catch (error) {
    failed = true;
    parent.throwIfAborted();
    if (signal.aborted) throw signal.reason;
    throw error;
  } finally {
    controller.abort();
    if (failed) {
      try {
        await iterator.return?.();
      } catch {
        // Keep the generation failure rather than replacing it with a cleanup failure.
      }
    } else {
      await iterator.return?.();
    }
  }
}

function isGenerationProgress(event: ModelEvent, hostedStates: Map<string, string>): boolean {
  switch (event.type) {
    case 'output.delta':
    case 'client_tool.call':
    case 'citation':
    case 'completed':
      return true;
    case 'text.delta':
      return event.delta.length > 0;
    case 'text.completed':
    case 'reasoning.completed':
      return event.text.length > 0;
    case 'hosted_tool': {
      const previous = hostedStates.get(event.itemId);
      hostedStates.set(event.itemId, event.status);
      return previous !== event.status;
    }
    default:
      return false;
  }
}
