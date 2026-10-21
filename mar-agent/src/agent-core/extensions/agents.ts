import type { ToolWaitInterrupt } from '../tools/wait.js';
import { MarAgentError } from '../error.js';
import { parseAgentWaitTargets } from '../subagent/wait.js';
import type { MarAgentReasoningEffort } from '../model/configuration.js';
import type {
  SubagentController,
  SubagentTaskSnapshot,
  SubagentManyOutput,
  SubagentHandledResult
} from '../subagent/contracts.js';
import type { CoreOperationContext } from './operation.js';
import type { ExtensionResourceScope } from './resources.js';
import type { ExtensionHooks } from './hooks.js';
import type { CoreDomainOperations, CoreDomainFacts, CoreCapabilitySnapshot } from './contracts.js';

export type CoreAgentSnapshot = Readonly<SubagentTaskSnapshot>;
export type CoreAgentManySnapshot = Readonly<SubagentManyOutput>;
export type CoreAgentWaitResult = CoreAgentSnapshot | CoreAgentManySnapshot;
export type CoreAgentHandledResult = SubagentHandledResult;
export type CoreAgentSpawnResult = CoreAgentSnapshot | CoreAgentHandledResult;
export function isHandledAgentResult(
  value: CoreAgentSpawnResult | CoreAgentManySnapshot
): value is CoreAgentHandledResult {
  return 'outcome' in value && value.outcome === 'handled' && !Object.hasOwn(value, 'agentId');
}
export interface CoreAgentSpawnInput {
  readonly turnSignal?: AbortSignal;
  readonly waitFor?: 'start' | 'completion';
  readonly background?: boolean;
  readonly prompt: string;
  readonly description?: string;
  readonly modelId?: string;
  readonly reasoningEffort?: MarAgentReasoningEffort;
  readonly role?: 'general-purpose' | 'explore';
  readonly signal?: AbortSignal;
}
export interface CoreAgentTarget {
  readonly agentId: string;
  readonly signal?: AbortSignal;
}
export interface CoreAgentWaitInput {
  readonly untilSettled?: true;
  readonly agentId?: string;
  readonly agentIds?: readonly string[];
  readonly mode?: 'any' | 'all';
  readonly signal?: AbortSignal;
  readonly waitMs?: number;
  readonly waitFor?: 'completion' | 'message';
}
export interface CoreAgentMessageInput extends CoreAgentTarget {
  readonly message: string;
  readonly delivery?: 'append' | 'replace';
}
export interface CoreAgentsBackend {
  own(ownerInstanceId: string): () => Promise<void>;
  spawn(input: CoreAgentSpawnInput, call: CoreOperationContext): Promise<CoreAgentSnapshot>;
  list(call: CoreOperationContext): Promise<readonly CoreAgentSnapshot[]>;
  inspect(input: CoreAgentTarget, call: CoreOperationContext): Promise<CoreAgentSnapshot>;
  wait(input: CoreAgentWaitInput, call: CoreOperationContext): Promise<CoreAgentWaitResult>;
  message(input: CoreAgentMessageInput, call: CoreOperationContext): Promise<CoreAgentSnapshot>;
  cancel(input: CoreAgentTarget, call: CoreOperationContext): Promise<CoreAgentSnapshot>;
}
export interface CoreAgentsApi {
  spawn(input: CoreAgentSpawnInput): Promise<CoreAgentSpawnResult>;
  list(input?: { readonly signal?: AbortSignal }): Promise<readonly CoreAgentSnapshot[]>;
  inspect(input: CoreAgentTarget): Promise<CoreAgentSnapshot>;
  wait(
    input: CoreAgentWaitInput & { readonly agentIds: readonly string[] }
  ): Promise<CoreAgentManySnapshot>;
  wait(input: CoreAgentWaitInput & { readonly agentIds?: undefined }): Promise<CoreAgentSnapshot>;
  wait(input: CoreAgentWaitInput): Promise<CoreAgentWaitResult>;
  message(input: CoreAgentMessageInput): Promise<CoreAgentSnapshot>;
  cancel(input: CoreAgentTarget): Promise<CoreAgentSnapshot>;
}
export interface CoreAgentCompletion {
  readonly operation: 'spawn' | 'wait' | 'message' | 'cancel';
  readonly agentId: string;
  readonly status: SubagentTaskSnapshot['status'];
  readonly deliveryStatus?: SubagentTaskSnapshot['deliveryStatus'];
}

type AgentOperation = 'agent.spawn' | 'agent.wait' | 'agent.message' | 'agent.cancel';
export type CoreAgentAction = <Key extends AgentOperation>(
  key: Key,
  input: CoreDomainOperations[Key]['input'],
  leaf: (
    input: CoreDomainOperations[Key]['input'],
    call: CoreOperationContext
  ) => Promise<CoreDomainOperations[Key]['output']>
) => Promise<CoreDomainOperations[Key]['output']>;

/** All callers share one interception and authoritative leaf-completion boundary. */
export function invokeCoreAgentOperation<Key extends AgentOperation>(
  hooks: ExtensionHooks<CoreDomainOperations, CoreDomainFacts>,
  key: Key,
  input: CoreDomainOperations[Key]['input'],
  call: CoreOperationContext,
  leaf: (
    input: CoreDomainOperations[Key]['input'],
    call: CoreOperationContext
  ) => Promise<CoreDomainOperations[Key]['output']>
): Promise<CoreDomainOperations[Key]['output']> {
  return hooks.invoke(key, input, call, async (input, effective) => {
    const result = structuredClone(await leaf(input, effective));
    if (isHandledAgentResult(result)) return result;
    const agents: readonly CoreAgentSnapshot[] = Array.isArray(result.agents)
      ? result.agents
      : [result as CoreAgentSnapshot];
    for (const agent of agents)
      await hooks.emit(
        'agent.completed',
        {
          operation: key.slice('agent.'.length) as CoreAgentCompletion['operation'],
          agentId: agent.agentId,
          status: agent.status,
          ...(agent.deliveryStatus === undefined ? {} : { deliveryStatus: agent.deliveryStatus })
        },
        effective
      );
    return result;
  });
}

function resolveAgentSpawn(input: CoreAgentSpawnInput): CoreAgentSpawnInput {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    typeof input.prompt !== 'string' ||
    !input.prompt.trim() ||
    (input.turnSignal !== undefined && !(input.turnSignal instanceof AbortSignal)) ||
    (input.description !== undefined &&
      (typeof input.description !== 'string' || !input.description.trim())) ||
    (input.modelId !== undefined && (typeof input.modelId !== 'string' || !input.modelId)) ||
    (input.role !== undefined && input.role !== 'general-purpose' && input.role !== 'explore') ||
    (input.background !== undefined && typeof input.background !== 'boolean') ||
    (input.waitFor !== undefined && input.waitFor !== 'start' && input.waitFor !== 'completion') ||
    (input.reasoningEffort !== undefined &&
      !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(input.reasoningEffort))
  )
    throw invalid('Agent spawn input is invalid.');
  return {
    prompt: input.prompt,
    ...(input.turnSignal === undefined ? {} : { turnSignal: input.turnSignal }),
    ...(input.waitFor === undefined ? {} : { waitFor: input.waitFor }),
    ...(input.background === undefined ? {} : { background: input.background }),
    description: input.description ?? 'Extension agent',
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    role: input.role ?? 'general-purpose'
  };
}

export function bindAgentController(
  controller: SubagentController,
  action: CoreAgentAction
): SubagentController {
  const wait = (input: CoreAgentWaitInput, waitInterrupt?: ToolWaitInterrupt) =>
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

export function agentCapabilities(
  capabilities: CoreCapabilitySnapshot,
  available: boolean
): CoreCapabilitySnapshot {
  const values = Object.freeze(capabilities.list().filter((id) => id !== 'agents' || available));
  return Object.freeze({ has: (id: string) => values.includes(id), list: () => values });
}

export function bindCoreAgents(
  backend: CoreAgentsBackend,
  scope: ExtensionResourceScope,
  run: <Value>(
    operation: (call: CoreOperationContext) => Promise<Value>,
    signal?: AbortSignal
  ) => Promise<Value>,
  hooks: ExtensionHooks<CoreDomainOperations, CoreDomainFacts>
): CoreAgentsApi {
  scope.effect(() => backend.own(scope.instanceId));
  const invoke = <Key extends AgentOperation>(
    key: Key,
    input: CoreDomainOperations[Key]['input']
  ): Promise<CoreDomainOperations[Key]['output']> =>
    run(
      (call) =>
        invokeCoreAgentOperation(hooks, key, input, call, async (effectiveInput, effective) => {
          let result: CoreAgentWaitResult;
          switch (key) {
            case 'agent.spawn':
              result = await backend.spawn(
                {
                  ...resolveAgentSpawn(effectiveInput as CoreAgentSpawnInput),
                  ...((effectiveInput as CoreAgentSpawnInput).turnSignal === undefined
                    ? {}
                    : {
                        turnSignal: AbortSignal.any([
                          scope.signal,
                          (effectiveInput as CoreAgentSpawnInput).turnSignal!
                        ])
                      })
                },
                effective
              );
              break;
            case 'agent.wait':
              result = await backend.wait(effectiveInput as CoreAgentWaitInput, effective);
              break;
            case 'agent.message':
              result = await backend.message(effectiveInput as CoreAgentMessageInput, effective);
              break;
            case 'agent.cancel':
              result = await backend.cancel(effectiveInput as CoreAgentTarget, effective);
              break;
          }
          return result as CoreDomainOperations[Key]['output'];
        }),
      input.signal
    );
  const target = <T extends CoreAgentTarget>(input: T): T => {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      typeof input.agentId !== 'string' ||
      !input.agentId
    )
      throw invalid('Agent target is invalid.');
    return { ...input };
  };
  return {
    spawn: (input) => invoke('agent.spawn', { ...input }),
    list: async (input = {}) => {
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw invalid('Agent list input is invalid.');
      return run(async (call) => structuredClone(await backend.list(call)), input.signal);
    },
    inspect: async (input) => {
      const copied = target(input);
      return run(
        async (call) => structuredClone(await backend.inspect(copied, call)),
        copied.signal
      );
    },
    wait: (async (input: CoreAgentWaitInput) => {
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw invalid('Agent wait input is invalid.');
      const selection = parseAgentWaitTargets(input);
      return invoke(
        'agent.wait',
        input.agentId === undefined ? { ...input, ...selection } : target(input as CoreAgentTarget)
      );
    }) as CoreAgentsApi['wait'],
    message: async (input) => invoke('agent.message', target(input)),
    cancel: async (input) => invoke('agent.cancel', target(input))
  };
}

function invalid(message: string): MarAgentError {
  return new MarAgentError('MAR_AGENT_EXTENSION_AGENT_INPUT_INVALID', message);
}
