import { MarAgentError } from '../error.js';
import type { CoreAgentsBackend, CoreAgentWaitResult } from '../extensions/agents.js';
import type { CoreOperationContext } from '../extensions/operation.js';
import { parseAgentWaitTargets } from '../subagent/wait.js';
import type {
  SubagentParentOperation,
  SubagentSessionController
} from '../subagent/session-controller.js';

/** Uses the Session's sole task controller, including its durable children and queue. */
export function createExtensionAgentsBackend(input: {
  readonly controller: () => Promise<SubagentSessionController>;
  readonly existingController: () => SubagentSessionController | undefined;
  readonly parent: (
    controller: SubagentSessionController,
    call: CoreOperationContext
  ) => SubagentParentOperation;
}): CoreAgentsBackend {
  const withController = async <T>(
    call: CoreOperationContext,
    run: (controller: SubagentSessionController) => Promise<T>
  ): Promise<T> => {
    call.signal.throwIfAborted();
    const controller = await input.controller();
    call.signal.throwIfAborted();
    return controller.withOperation(input.parent(controller, call), () => run(controller));
  };
  return {
    own: (owner) => async () => {
      await input.existingController()?.cancelOwned(owner);
    },
    spawn: (task, call) =>
      withController(call, (controller) =>
        controller.run(
          {
            description: task.description ?? 'Extension agent',
            prompt: task.prompt,
            role: task.role ?? 'general-purpose',
            background: task.background ?? true,
            ...(task.modelId === undefined ? {} : { modelId: task.modelId }),
            ...(task.reasoningEffort === undefined ? {} : { reasoningEffort: task.reasoningEffort })
          },
          {
            signal: call.signal,
            ...(task.turnSignal === undefined ? {} : { turnSignal: task.turnSignal }),
            ...(task.waitFor === undefined ? {} : { waitFor: task.waitFor }),
            onCreated: (created) => {
              if (created.status === 'failed')
                throw new MarAgentError(
                  created.errorCode ?? 'MAR_AGENT_SUBAGENT_FAILED',
                  created.errorMessage ?? 'Agent could not start.'
                );
            }
          }
        )
      ),
    list: (call) => withController(call, (controller) => controller.list(call.signal)),
    inspect: (target, call) =>
      withController(call, (controller) => controller.inspect(target.agentId)),
    wait: (target, call) =>
      withController<CoreAgentWaitResult>(call, (controller) => {
        const selection = parseAgentWaitTargets(target);
        const options = {
          waitMs: target.waitMs ?? 30_000,
          ...(target.untilSettled === undefined ? {} : { untilSettled: target.untilSettled }),
          ...(target.waitFor === undefined ? {} : { waitFor: target.waitFor }),
          signal: call.signal
        };
        if (selection.agentIds !== undefined)
          return controller.outputMany(selection.agentIds, {
            ...options,
            mode: selection.mode ?? 'any'
          });
        if (target.untilSettled && target.agentId === undefined)
          throw new MarAgentError(
            'MAR_AGENT_TOOL_INPUT_INVALID',
            'An unbounded wait requires an agent id.'
          );
        return target.agentId === undefined
          ? controller.outputAny(options)
          : controller.output(target.agentId, options);
      }),
    message: (target, call) =>
      withController(call, (controller) =>
        controller.message(target.agentId, target.message, {
          ...(target.delivery === undefined ? {} : { delivery: target.delivery }),
          signal: call.signal
        })
      ),
    cancel: (target, call) =>
      withController(call, (controller) => controller.cancel(target.agentId))
  };
}
