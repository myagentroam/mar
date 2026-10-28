import type { MarAgentModelSummary, MarAgentNodeModelSummary } from '@myagentroam/protocol';
import type { ProcessSecretResolver, RunnerModelCatalog } from './session-run-contracts.js';

/** Profiles must use the requesting user's Runner credentials and model visibility. */
export async function prepareRunnerProfileContext(input: {
  userId: number;
  nodeId: string;
  workspaceId?: string;
  secrets: ProcessSecretResolver;
  models?: Partial<RunnerModelCatalog>;
}): Promise<object> {
  return {
    secretEnvironment: await input.secrets.resolve(input.userId, input.nodeId, input.workspaceId),
    ...(input.models?.listForUser === undefined
      ? {}
      : {
          marAgentModels: (await input.models.listForUser(input.userId)).map(nodeModelSummary)
        })
  };
}

function nodeModelSummary(model: MarAgentModelSummary): MarAgentNodeModelSummary {
  const summary: Partial<MarAgentModelSummary> = { ...model };
  delete summary.access;
  return summary as MarAgentNodeModelSummary;
}
