import { MarAgentError } from '../error.js';
import {
  resolveModelDefaultReasoningEffort,
  type MarAgentModelConfiguration,
  type MarAgentReasoningEffort,
  type ModelCredentialProvider
} from '../model/configuration.js';
import type { ModelAdapter, ModelRequest, ModelTurnSession } from '../model/contracts.js';
import { observeModelProgress } from '../runtime/model-progress.js';
export type ResolvedModelConfiguration = MarAgentModelConfiguration & {
  readonly defaultReasoningEffort: MarAgentReasoningEffort;
};
export function resolveAgentModels(
  configurations: readonly MarAgentModelConfiguration[],
  requestedDefaultModelId?: string
): {
  readonly models: Map<string, ResolvedModelConfiguration>;
  readonly defaultModelId: string;
  readonly credentialProviders: Set<ModelCredentialProvider>;
} {
  const configuredModels: ResolvedModelConfiguration[] = configurations.map((model) => ({
    ...model,
    defaultReasoningEffort: resolveModelDefaultReasoningEffort(model)
  }));
  const credentialProviders = new Set<ModelCredentialProvider>();
  for (const model of configuredModels) {
    if ((model.apiKey === undefined) === (model.credentialProvider === undefined))
      throw new MarAgentError(
        'MAR_AGENT_MODEL_CONFIG_INVALID',
        'Exactly one model credential source is required.'
      );
    if (model.fastMode === true && model.protocol !== 'OPENAI_RESPONSES')
      throw new MarAgentError('MAR_AGENT_MODEL_CONFIG_INVALID', 'Fast mode requires Responses.');
    if (
      model.serviceTier !== undefined &&
      (model.protocol !== 'OPENAI_RESPONSES' ||
        !['auto', 'default', 'flex', 'priority', 'fast', 'ultrafast'].includes(model.serviceTier))
    )
      throw new MarAgentError(
        'MAR_AGENT_MODEL_CONFIG_INVALID',
        'Responses service tier is invalid.'
      );
    if (model.credentialProvider !== undefined) credentialProviders.add(model.credentialProvider);
  }
  const models = new Map(
    configuredModels.filter((model) => model.enabled).map((model) => [model.id, model])
  );
  if (models.size === 0)
    throw new MarAgentError(
      'MAR_AGENT_MODEL_CONFIG_INVALID',
      'At least one enabled model is required.'
    );
  const defaultModelId =
    requestedDefaultModelId ??
    [...models.values()].find((model) => model.conversationModel !== false)?.id;
  if (
    !defaultModelId ||
    !models.has(defaultModelId) ||
    models.get(defaultModelId)!.conversationModel === false
  )
    throw new MarAgentError(
      'MAR_AGENT_MODEL_CONFIG_INVALID',
      'Default conversation model is unavailable.'
    );
  return { models, defaultModelId, credentialProviders };
}

export function createModelTurnSession(adapter: ModelAdapter): ModelTurnSession {
  const turn = adapter.createTurnSession?.() ?? {
    start: (request: ModelRequest, signal: AbortSignal) => adapter.start(request, signal),
    close: async () => undefined
  };
  return {
    async *start(request, signal) {
      const before = request.retryState?.attempts;
      try {
        yield* observeModelProgress((requestSignal) => turn.start(request, requestSignal), signal);
      } finally {
        // Custom adapters may not participate in the shared attempt accounting.
        if (request.retryState && request.retryState.attempts === before)
          request.retryState.attempts++;
      }
    },
    resetContinuation: () => turn.resetContinuation?.(),
    close: () => turn.close()
  };
}

/** Owns only one Execution's model turn and explicitly transferred adapters. */
export function createExecutionModelResources(activeAdapters: Set<ModelAdapter>) {
  let turn: ModelTurnSession | undefined;
  const ownedAdapters = new Set<ModelAdapter>();
  return {
    openTurn(adapter: ModelAdapter, ownsAdapter: boolean): ModelTurnSession {
      if (ownsAdapter) {
        ownedAdapters.add(adapter);
        activeAdapters.add(adapter);
      }
      turn = createModelTurnSession(adapter);
      return turn;
    },
    async close(): Promise<void> {
      await turn?.close().catch(() => undefined);
      try {
        await closeModelAdapters(ownedAdapters);
      } catch {
        // Model cleanup must not replace the Execution result.
      } finally {
        for (const adapter of ownedAdapters) activeAdapters.delete(adapter);
      }
    }
  };
}

export async function closeModelAdapters(adapters: Iterable<ModelAdapter>): Promise<void> {
  const results = await Promise.allSettled(
    [...new Set(adapters)].flatMap((adapter) =>
      adapter.close === undefined ? [] : [adapter.close()]
    )
  );
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );
  if (failure !== undefined) throw failure.reason;
}

export function addModelCredentialProviders(
  target: Set<ModelCredentialProvider>,
  configuration: MarAgentModelConfiguration
): void {
  if (configuration.credentialProvider !== undefined) target.add(configuration.credentialProvider);
}
