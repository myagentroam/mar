import { parseAgentWaitTargets } from '../subagent/wait-targets.js';
import type {
  SubagentController,
  SubagentTaskSnapshot,
  SubagentManyOutput
} from '../subagent/contracts.js';
import type { ToolWaitInterrupt } from '../tools/wait.js';
import {
  resolveAgentSpawn,
  type ExtensionAgentAction,
  type ExtensionAgentWaitInput
} from '../extensions/agents.js';

export function bindAgentController(
  controller: SubagentController,
  action: ExtensionAgentAction
): SubagentController {
  const wait = (input: ExtensionAgentWaitInput, waitInterrupt?: ToolWaitInterrupt) =>
    action('agent.wait', input, (target, call) => {
      const selection = parseAgentWaitTargets(target);
      return selection.agentIds !== undefined
        ? controller.outputMany(selection.agentIds, {
            ...target,
            waitInterrupt,
            mode: selection.mode ?? 'any',
            signal: call.signal
          })
        : target.agentId === undefined
          ? controller.outputAny({ ...target, waitInterrupt, signal: call.signal })
          : controller.output(target.agentId, { ...target, waitInterrupt, signal: call.signal });
    });
  return {
    run: (input, options) => {
      return action(
        'agent.spawn',
        {
          ...(options?.waitFor === undefined ? {} : { waitFor: options.waitFor }),
          prompt: input.prompt,
          description: input.description,
          role: input.role,
          background: input.background ?? false,
          ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
          ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort })
        },
        async (target, call) => {
          const task = resolveAgentSpawn(target);
          return controller.run(
            {
              prompt: task.prompt,
              description: task.description ?? input.description,
              role: task.role ?? input.role,
              background: task.background ?? false,
              ...(input.parentSubagentId === undefined
                ? {}
                : { parentSubagentId: input.parentSubagentId }),
              ...(task.modelId === undefined ? {} : { modelId: task.modelId }),
              ...(task.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: task.reasoningEffort })
            },
            {
              ...options,
              ...(task.turnSignal === undefined ? {} : { turnSignal: task.turnSignal }),
              ...(task.waitFor === undefined ? {} : { waitFor: task.waitFor }),
              signal: call.signal
            }
          );
        }
      );
    },
    output: (id, options) => {
      const { waitInterrupt, ...input } = options ?? {};
      return wait({ ...input, agentId: id }, waitInterrupt) as Promise<SubagentTaskSnapshot>;
    },
    outputAny: (options) => {
      const { waitInterrupt, ...input } = options ?? {};
      return wait(input, waitInterrupt) as Promise<SubagentTaskSnapshot>;
    },
    outputMany: (ids, options) => {
      const { waitInterrupt, ...input } = options ?? {};
      return wait({ ...input, agentIds: ids }, waitInterrupt) as Promise<SubagentManyOutput>;
    },
    message: (id, message, options) =>
      action('agent.message', { ...options, agentId: id, message }, (target, call) =>
        controller.message(target.agentId, target.message, {
          ...(target.delivery === undefined ? {} : { delivery: target.delivery }),
          signal: call.signal
        })
      ),
    cancel: (id) =>
      action('agent.cancel', { agentId: id }, (target) => controller.cancel(target.agentId)),
    listSessionResources: () => controller.listSessionResources(),
    dispose: () => controller.dispose()
  };
}
