import type { MarAgentModelService, MarAgentRuntimeModelService } from './session-run-contracts.js';

/** Legacy delivery cannot relay model options that require explicit Node capability evidence. */
export function assertLegacyModelCompatibility(models: readonly unknown[]): void {
  if (
    models.some(
      (model) =>
        model !== null &&
        typeof model === 'object' &&
        (('gcEnabled' in model && model.gcEnabled === false) ||
          ('socks5Url' in model && model.socks5Url !== undefined))
    )
  )
    throw new Error('CAPABILITY_VERSION_UNSUPPORTED');
}

export async function runtimeModelPayload(input: {
  readonly userId: number;
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly sessionId?: string;
  readonly selectedModelId: string;
  readonly purpose?: 'compact' | 'plan-toggle';
  readonly marAgentModels?: MarAgentModelService;
  readonly marAgentRuntimeModels?: MarAgentRuntimeModelService;
}): Promise<Record<string, unknown>> {
  if (input.marAgentRuntimeModels !== undefined) {
    const prepared = await input.marAgentRuntimeModels.prepare({
      userId: input.userId,
      nodeId: input.nodeId,
      workspaceId: input.workspaceId,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      selectedModelId: input.selectedModelId,
      ...(input.purpose === undefined ? {} : { purpose: input.purpose })
    });
    return {
      marAgentRuntimeScopeId: prepared.runtimeScopeId,
      marAgentModel: prepared.model,
      marAgentModels: prepared.models,
      ...(prepared.compact === undefined ? {} : { marAgentCompact: prepared.compact })
    };
  }
  if (input.marAgentModels === undefined) return {};
  const model = await input.marAgentModels.runtimeForUser(input.userId, input.selectedModelId);
  const models = await input.marAgentModels.runtimeConfigurationsForUser(input.userId);
  assertLegacyModelCompatibility([model, ...(Array.isArray(models) ? models : [])]);
  return {
    marAgentModel: model,
    marAgentModels: models
  };
}
