import { randomUUID } from 'node:crypto';
import type { AgentModelConfiguration } from './configuration.js';
import type { ModelEvent, ModelRequest, ModelUsage } from './contracts.js';

import type { ModelRequestUsage } from './usage.js';
export type { ModelRequestUsage, ModelUsageObservation, ModelUsageObserver } from './usage.js';

function count(value: number | undefined): string | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : undefined;
}

/** Observe before retry prelude buffering so failed attempts retain reported usage. */
export async function* observeModelRequestUsage(
  start: () => AsyncIterable<ModelEvent>,
  request: ModelRequest,
  configuration: AgentModelConfiguration,
  signal: AbortSignal,
  now: () => number = Date.now
): AsyncIterable<ModelEvent> {
  if (!request.onModelUsage) {
    yield* start();
    return;
  }
  const base = {
    recordId: randomUUID(),
    requestId: request.usageRequestId ?? randomUUID(),
    modelConfigurationId: configuration.id,
    modelName: configuration.name,
    provider: configuration.protocol,
    requestedModel: configuration.modelId,
    startedAt: now()
  };
  let usage: ModelUsage = {};
  let responseId: string | undefined;
  let actualModel: string | undefined;
  let state: ModelRequestUsage['state'] = 'interrupted';
  const publish = async (value: ModelRequestUsage) => {
    try {
      await request.onModelUsage!(value);
    } catch {
      // Metering must not break the model stream or expose callback error details.
      try {
        request.onModelUsageFailure?.();
      } catch {
        // Host diagnostics are also best effort.
      }
    }
  };
  await publish({ ...base, revision: 1, state: 'running' });
  try {
    for await (const event of start()) {
      if (event.type === 'response.started') {
        responseId = event.responseId;
        actualModel = event.modelId;
      } else if (event.type === 'usage') {
        for (const [key, value] of Object.entries(event.usage)) {
          if (value !== undefined) usage = { ...usage, [key]: value };
        }
      } else if (event.type === 'completed') {
        state = event.reason === 'cancelled' ? 'cancelled' : 'succeeded';
      }
      yield event;
    }
  } catch (error) {
    state = signal.aborted ? 'cancelled' : 'failed';
    throw error;
  } finally {
    await publish({
      ...base,
      revision: 2,
      state: signal.aborted && state !== 'succeeded' ? 'cancelled' : state,
      endedAt: now(),
      ...(responseId === undefined ? {} : { responseId }),
      ...(actualModel === undefined ? {} : { actualModel }),
      ...optionalCount('inputTokens', usage.totalInputTokens),
      ...optionalCount('outputTokens', usage.outputTokens),
      ...optionalCount('cacheReadTokens', usage.cacheReadTokens),
      ...optionalCount('cacheWriteTokens', usage.cacheWriteTokens),
      ...optionalCount('reasoningTokens', usage.reasoningTokens)
    });
  }
}

function optionalCount(key: string, value: number | undefined): Record<string, string> {
  const normalized = count(value);
  return normalized === undefined ? {} : { [key]: normalized };
}
