import {
  marAgentReasoningEffortSchema,
  usesResponsesConfigurationUpdates,
  type MarAgentModelConfiguration,
  type MarAgentReasoningEffort
} from './configuration.js';
import type { ModelMessage } from './contracts.js';

/** Resolve request effort and native updates without owning their persistence or timing. */
export function prepareModelConfiguration(
  model: Pick<
    MarAgentModelConfiguration,
    'id' | 'protocol' | 'responsesConfigurationUpdates' | 'codexCredential'
  >,
  effort: MarAgentReasoningEffort,
  context:
    | {
        readonly baselineEffort: MarAgentReasoningEffort | undefined;
        readonly messages: readonly ModelMessage[];
        readonly checkpointAdopted?: false;
      }
    | {
        readonly checkpointAdopted: true;
      }
): {
  readonly requestReasoningEffort?: MarAgentReasoningEffort;
  readonly updates: readonly ModelMessage[];
  readonly contextProjection: {
    readonly modelProtocol: MarAgentModelConfiguration['protocol'];
    readonly responsesConfigurationUpdates: boolean;
  };
} {
  const useUpdates = usesResponsesConfigurationUpdates(model);
  const contextProjection = {
    modelProtocol: model.protocol,
    responsesConfigurationUpdates: useUpdates
  };
  if (context.checkpointAdopted)
    return { requestReasoningEffort: effort, updates: [], contextProjection };
  if (!useUpdates) return { updates: [], contextProjection };
  const requestReasoningEffort = context.baselineEffort ?? effort;
  const effectiveEffort =
    context.baselineEffort === undefined
      ? requestReasoningEffort
      : (lastConfigurationEffort(context.messages, model.id) ?? requestReasoningEffort);
  return {
    requestReasoningEffort,
    contextProjection,
    updates:
      effectiveEffort === effort
        ? []
        : [
            {
              role: 'provider',
              content: '',
              provider: 'OPENAI_RESPONSES',
              providerModelId: model.id,
              item: { type: 'configuration_update', reasoning: { effort } }
            }
          ]
  };
}

function lastConfigurationEffort(
  messages: readonly ModelMessage[],
  modelId: string
): MarAgentReasoningEffort | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (
      message.role !== 'provider' ||
      message.provider !== 'OPENAI_RESPONSES' ||
      message.providerModelId !== modelId ||
      message.item?.type !== 'configuration_update'
    )
      continue;
    const reasoning = message.item.reasoning as Record<string, unknown> | undefined;
    const effort = marAgentReasoningEffortSchema.safeParse(reasoning?.effort);
    if (effort.success) return effort.data;
  }
  return undefined;
}
