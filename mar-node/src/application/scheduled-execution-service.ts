import type { NodeRuntimeState } from '../runtime-state.js';
import type { NativeSessionProjectionService } from '../session/native-session-projection-service.js';
import type { SessionMessageService } from '../session/session-message-service.js';
import type { RunAuthorizationControl } from '../service/run-authorization-control.js';
import type { RunnerRegistry } from '../runner/runner-registry.js';
import type { GitOperationService } from '../service/git-operation-service.js';
import type { ScheduledRunContext } from '../service/scheduled-session-coordinator.js';
import type { ScheduledSessionTask } from '../service/scheduled-session-store.js';

/** Prepares and submits scheduled input through existing Session/Runner owners.
 * The scheduler retains occurrence state, admission, in-flight work and terminal settlement;
 * this application service owns no timers or alternate execution pipeline.
 */
export class ScheduledExecutionService {
  constructor(
    private readonly options: {
      readonly runtime: Pick<NodeRuntimeState, 'getAgentSession'>;
      readonly projection: Pick<
        NativeSessionProjectionService,
        'resolveCurrent' | 'ensureResumedConfiguration'
      >;
      readonly authorization: Pick<RunAuthorizationControl, 'authorize'>;
      readonly runners: Pick<RunnerRegistry, 'require'>;
      readonly git: Pick<GitOperationService, 'execute'>;
      readonly messages: Pick<SessionMessageService, 'submitScheduled'>;
    }
  ) {}

  readonly authorize = async (
    task: ScheduledSessionTask,
    occurrenceId: string
  ): Promise<ScheduledRunContext> => {
    const session =
      this.options.runtime.getAgentSession(task.sessionId) ??
      (await this.options.projection.resolveCurrent(task.sessionId));
    if (
      session === undefined ||
      session.workspaceId !== task.workspaceId ||
      session.runner !== task.runner
    )
      throw new Error('SCHEDULE_SESSION_NOT_FOUND');
    const configured = this.options.projection.ensureResumedConfiguration(session);
    const context = await this.options.authorization.authorize({
      taskId: task.id,
      revision: task.revision,
      occurrenceId,
      sessionId: task.sessionId,
      workspaceId: task.workspaceId,
      ownerUserId: task.ownerUserId,
      runner: task.runner,
      modelId: configured.modelId
    });
    return {
      ...(context.gitConfiguration === undefined
        ? {}
        : { gitConfiguration: context.gitConfiguration }),
      secretEnvironment: context.secretEnvironment,
      personalInstructions: context.personalInstructions,
      usageGrant: context.usageGrant,
      executionContext: this.options.runners.require(task.runner).prepareExecutionContext(context)
    };
  };

  readonly submit = async (
    task: ScheduledSessionTask,
    occurrenceId: string,
    context: ScheduledRunContext
  ): Promise<{ readonly runId: string }> => {
    const result = (await this.options.git.execute(
      'session.message',
      {
        sessionId: task.sessionId,
        workspaceId: task.workspaceId,
        __requestUserId: task.ownerUserId,
        secretEnvironment: context.secretEnvironment,
        ...(context.gitConfiguration === undefined
          ? {}
          : { gitConfiguration: context.gitConfiguration })
      },
      async (data) =>
        this.options.messages.submitScheduled({
          sessionId: task.sessionId,
          occurrenceId,
          objective: task.objective,
          initiatedByUserId: task.ownerUserId,
          secretEnvironment: (data as { secretEnvironment: Record<string, string> })
            .secretEnvironment,
          personalInstructions: context.personalInstructions,
          ...(context.usageGrant === undefined ? {} : { usageGrant: context.usageGrant }),
          executionContext: context.executionContext
        })
    )) as { run: { id: string } };
    return { runId: result.run.id };
  };
}
