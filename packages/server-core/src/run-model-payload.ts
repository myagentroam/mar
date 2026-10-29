import type { MarAgentModelService, MarAgentRuntimeModelService } from './session-run-contracts.js';
export async function runtimeModelPayload(input: {
  readonly userId: number;
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly sessionId?: string;
  readonly selectedModelId: string;
  readonly marAgentModels?: MarAgentModelService;
  readonly marAgentRuntimeModels?: MarAgentRuntimeModelService;
}): Promise<Record<string, unknown>> {
  if (input.marAgentRuntimeModels !== undefined) {
    const prepared = await input.marAgentRuntimeModels.prepare({
      userId: input.userId,
      nodeId: input.nodeId,
      workspaceId: input.workspaceId,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      selectedModelId: input.selectedModelId
    });
    return {
      marAgentRuntimeScopeId: prepared.runtimeScopeId,
      marAgentModel: prepared.model,
      marAgentModels: prepared.models,
      ...(prepared.compact === undefined ? {} : { marAgentCompact: prepared.compact })
    };
  }
  if (input.marAgentModels === undefined) return {};
  return {
    marAgentModel: await input.marAgentModels.runtimeForUser(input.userId, input.selectedModelId),
    marAgentModels: await input.marAgentModels.runtimeConfigurationsForUser(input.userId)
  };
}
