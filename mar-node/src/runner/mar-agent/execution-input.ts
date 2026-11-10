import {
  marAgentRuntimeModelConfigurationSchema,
  type MarAgentRuntimeModelConfiguration
} from '@myagentroam/protocol';

/** Unparsed values stay opaque until the existing run/command acceptance boundary. */
export interface MarAgentExecutionInput {
  readonly model?: unknown;
  readonly models?: unknown;
  readonly compact?: unknown;
  readonly runtimeScopeId?: unknown;
  readonly searchBackendAvailable?: unknown;
}

export function captureMarAgentExecutionInput(
  input: Readonly<Record<string, unknown>>
): MarAgentExecutionInput {
  return structuredClone({
    model: input.marAgentModel,
    models: input.marAgentModels,
    compact: input.marAgentCompact,
    runtimeScopeId: input.marAgentRuntimeScopeId,
    searchBackendAvailable: input.searchBackendAvailable
  });
}

/** Only the MAR boundary understands either the wire input or its captured form. */
export function marAgentEnvelopeInput(
  payload: Readonly<Record<string, unknown>>
): MarAgentExecutionInput | undefined {
  if (!Object.hasOwn(payload, 'runnerInput')) return captureMarAgentExecutionInput(payload);
  const input = payload.runnerInput;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  return input;
}

export function resolveMarAgentExecutionInput(
  input: MarAgentExecutionInput | undefined,
  modelId: string
) {
  const parsed = marAgentRuntimeModelConfigurationSchema.safeParse(input?.model);
  if (!parsed.success || parsed.data.id !== modelId) return undefined;
  return {
    model: parsed.data,
    models: resolveRunModels(parsed.data, input?.models),
    compact: input?.compact,
    searchBackendAvailable: input?.searchBackendAvailable !== false,
    ...(typeof input?.runtimeScopeId === 'string' ? { runtimeScopeId: input.runtimeScopeId } : {})
  };
}

export function resolveRunModels(
  marAgentModel: MarAgentRuntimeModelConfiguration,
  marAgentModels: unknown
): MarAgentRuntimeModelConfiguration[] {
  const configurations: MarAgentRuntimeModelConfiguration[] = [];
  if (Array.isArray(marAgentModels))
    for (const candidate of marAgentModels) {
      const parsed = marAgentRuntimeModelConfigurationSchema.safeParse(candidate);
      if (parsed.success)
        configurations.push(
          parsed.data as import('@myagentroam/protocol').MarAgentRuntimeModelConfiguration
        );
    }
  configurations.push(marAgentModel);
  const seen = new Set<string>();
  return configurations.filter((configuration) => {
    if (seen.has(configuration.id)) return false;
    seen.add(configuration.id);
    return true;
  });
}
