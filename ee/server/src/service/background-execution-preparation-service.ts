import {
  executionPrepareResponseSchema,
  type ExecutionPrepareRequest
} from '@myagentroam/protocol';
import { prepareSessionExecutionContext } from '@myagentroam/server-core/session-execution-context';
import type { NodeRequestAuthorization } from '@myagentroam/server-core/node-access-contracts';
import type { ModelUsageGrants } from '@myagentroam/server-core/model-usage-grant';
import type {
  ExecutionPreparer,
  ScheduledRunAuthorizer
} from '@myagentroam/server-core/scheduled-run-authorization-channel';

type Preparation = Parameters<typeof prepareSessionExecutionContext>[0];

/** Authorizes and assembles background execution resources for authenticated Nodes.
 * Resource services remain the owners of secrets, credentials and configuration; this
 * application workflow owns sequencing and response validation, not transport or execution.
 */
export class BackgroundExecutionPreparationService {
  constructor(
    private readonly options: {
      readonly authorize: NodeRequestAuthorization;
      readonly serverUrl: string | undefined;
      readonly secrets: Preparation['secrets'];
      readonly credentials: Preparation['credentials'];
      readonly instructions: Preparation['instructions'];
      readonly git: NonNullable<Preparation['git']>;
      readonly runtimeModels: NonNullable<
        NonNullable<Preparation['model']>['marAgentRuntimeModels']
      >;
      readonly usageGrants: Pick<ModelUsageGrants, 'issue'>;
    }
  ) {}

  readonly prepare: ExecutionPreparer = (nodeId, request) =>
    this.prepareContext(nodeId, request, 'EXECUTION_MODEL_UNAVAILABLE');

  readonly prepareSchedule: ScheduledRunAuthorizer = async (nodeId, request) => {
    const context = await this.prepareContext(
      nodeId,
      {
        userId: request.ownerUserId,
        sessionId: request.sessionId,
        workspaceId: request.workspaceId,
        runner: request.runner,
        modelId: request.modelId
      },
      'SCHEDULE_MODEL_UNAVAILABLE'
    );
    if (request.executionResources === 1) return context;
    const { gitConfiguration: _git, ...legacyContext } = context;
    return legacyContext;
  };

  private async prepareContext(
    nodeId: string,
    request: ExecutionPrepareRequest,
    modelUnavailableCode: string
  ) {
    const { userId, workspaceId, sessionId, runner, modelId } = request;
    const allowed = await this.options.authorize(
      userId,
      nodeId,
      'session.message',
      { sessionId, workspaceId },
      workspaceId
    );
    if (!allowed) throw new Error('WORKSPACE_ACCESS_DENIED');
    if (runner === 'mar-agent' && modelId === null) throw new Error(modelUnavailableCode);
    const context = await prepareSessionExecutionContext({
      user: { userId },
      nodeId,
      workspaceId,
      serverUrl: this.options.serverUrl,
      secrets: this.options.secrets,
      credentials: this.options.credentials,
      instructions: this.options.instructions,
      git: this.options.git,
      ...(runner === 'mar-agent' && modelId !== null
        ? {
            model: {
              selectedModelId: modelId,
              sessionId,
              marAgentRuntimeModels: this.options.runtimeModels
            }
          }
        : {})
    });
    const parsed = executionPrepareResponseSchema.parse({
      context: { ...context, usageGrant: this.options.usageGrants.issue(nodeId, userId, 'work') }
    });
    if (!('context' in parsed)) throw new Error('EXECUTION_CONTEXT_INVALID');
    return parsed.context;
  }
}
