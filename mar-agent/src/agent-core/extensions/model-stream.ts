import { randomUUID } from 'node:crypto';
import { MarAgentError } from '../error.js';
import type { ModelEvent } from '../model/contracts.js';
import { modelStreamEventObservedAt, observeModelStreamEvent } from '../model/sse.js';

export type CoreModelEvent =
  | Exclude<ModelEvent, { type: 'response.item' }>
  | {
      readonly type: 'opaque';
      readonly sourceRef: string;
    };

/** Pull-through transformation: no speculative reads, background producer, or stream replay. */
export async function* transformCoreModelStream(
  start: (signal: AbortSignal) => AsyncIterable<ModelEvent>,
  parent: AbortSignal,
  transform: (event: CoreModelEvent, signal: AbortSignal) => Promise<CoreModelEvent | undefined>,
  diagnoseCleanup?: () => void
): AsyncIterable<ModelEvent> {
  const controller = new AbortController();
  const signal = AbortSignal.any([parent, controller.signal]);
  signal.throwIfAborted();
  const iterator = start(signal)[Symbol.asyncIterator]();
  let failed = false;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await iterator.next();
      if (next.done) return;
      signal.throwIfAborted();
      const sourceRef = next.value.type === 'response.item' ? randomUUID() : undefined;
      const view: CoreModelEvent = sourceRef
        ? { type: 'opaque', sourceRef }
        : (structuredClone(next.value) as CoreModelEvent);
      const event = await transform(view, signal);
      signal.throwIfAborted();
      if (event === undefined) continue;
      if (!event || typeof event !== 'object' || !validEvent(event))
        throw new MarAgentError('MAR_AGENT_MODEL_EVENT_INVALID', 'Model event is invalid.');
      if (event.type === 'opaque') {
        if (!sourceRef || event.sourceRef !== sourceRef)
          throw new MarAgentError(
            'MAR_AGENT_MODEL_EVENT_INVALID',
            'Model event reference is invalid.'
          );
        yield next.value;
      } else {
        if (event.type === ('response.item' as string))
          throw new MarAgentError(
            'MAR_AGENT_MODEL_EVENT_INVALID',
            'Provider-private model events require their opaque reference.'
          );
        yield observeModelStreamEvent(
          structuredClone(event),
          modelStreamEventObservedAt(next.value)
        );
      }
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    controller.abort();
    try {
      await iterator.return?.();
    } catch (error) {
      // eslint-disable-next-line no-unsafe-finally -- Preserve a primary failure; surface cleanup failures after success.
      if (!failed) throw error;
      diagnoseCleanup?.();
    }
  }
}

function validEvent(event: CoreModelEvent): boolean {
  switch (event.type) {
    case 'opaque':
      return typeof event.sourceRef === 'string';
    case 'response.started':
      return typeof event.responseId === 'string';
    case 'output.started':
    case 'output.delta':
    case 'output.paused':
    case 'output.completed':
    case 'output.reset':
      return true;
    case 'text.delta':
      return (
        typeof event.itemId === 'string' &&
        typeof event.delta === 'string' &&
        ['commentary', 'final_answer'].includes(event.phase)
      );
    case 'text.completed':
      return (
        typeof event.itemId === 'string' &&
        typeof event.text === 'string' &&
        (event.phase === undefined || ['commentary', 'final_answer'].includes(event.phase))
      );
    case 'reasoning.completed':
      return (
        typeof event.itemId === 'string' &&
        typeof event.text === 'string' &&
        ['summary', 'visible_thinking', 'unspecified'].includes(String(event.representation))
      );
    case 'client_tool.call':
      return (
        typeof event.callId === 'string' &&
        typeof event.name === 'string' &&
        (event.inputMode === undefined || ['json', 'freeform'].includes(event.inputMode))
      );
    case 'hosted_tool':
      return (
        typeof event.itemId === 'string' &&
        ['WEB_SEARCH', 'WEB_FETCH'].includes(event.kind) &&
        ['RUNNING', 'COMPLETED', 'FAILED'].includes(event.status) &&
        !!event.summary &&
        typeof event.summary === 'object'
      );
    case 'citation':
      return (
        !!event.citation &&
        typeof event.citation.id === 'string' &&
        typeof event.citation.url === 'string'
      );
    case 'usage':
      return (
        (event.final === undefined || typeof event.final === 'boolean') &&
        !!event.usage &&
        typeof event.usage === 'object' &&
        Object.values(event.usage).every(
          (value) =>
            value === undefined ||
            (typeof value === 'number' && Number.isFinite(value) && value >= 0)
        )
      );
    case 'unknown':
      return typeof event.nativeType === 'string';
    case 'completed':
      return ['completed', 'tool_use', 'max_output', 'pause', 'cancelled'].includes(event.reason);
    default:
      return false;
  }
}
