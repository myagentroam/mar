import { AgentError } from '../error.js';
import { parseAgentWaitTargets } from '../subagent/wait-targets.js';
import type { AgentReasoningEffort } from '../model/configuration.js';
import type {
  SubagentTaskSnapshot,
  SubagentManyOutput,
  SubagentHandledResult
} from '../subagent/contracts.js';
import type { ExtensionOperationContext } from './operation.js';
import type { ExtensionResourceScope } from './resources.js';
import type { ExtensionHooks } from './hooks.js';
import type { ExtensionCapabilitySnapshot } from './capabilities.js';

export type ExtensionAgentSnapshot = Readonly<SubagentTaskSnapshot>;
export type ExtensionAgentManySnapshot = Readonly<SubagentManyOutput>;
export type ExtensionAgentWaitResult = ExtensionAgentSnapshot | ExtensionAgentManySnapshot;
export type ExtensionAgentHandledResult = SubagentHandledResult;
export type ExtensionAgentSpawnResult = ExtensionAgentSnapshot | ExtensionAgentHandledResult;
export function isHandledAgentResult(
  value: ExtensionAgentSpawnResult | ExtensionAgentManySnapshot
): value is ExtensionAgentHandledResult {
  return 'outcome' in value && value.outcome === 'handled' && !Object.hasOwn(value, 'agentId');
}
export interface ExtensionAgentSpawnInput {
  readonly turnSignal?: AbortSignal;
  readonly waitFor?: 'start' | 'completion';
  readonly background?: boolean;
  readonly prompt: string;
  readonly description?: string;
  readonly modelId?: string;
  readonly reasoningEffort?: AgentReasoningEffort;
  readonly role?: 'general-purpose' | 'explore';
  readonly signal?: AbortSignal;
}
export interface ExtensionAgentTarget {
  readonly agentId: string;
  readonly signal?: AbortSignal;
}
export interface ExtensionAgentWaitInput {
  readonly untilSettled?: true;
  readonly agentId?: string;
  readonly agentIds?: readonly string[];
  readonly mode?: 'any' | 'all';
  readonly signal?: AbortSignal;
  readonly waitMs?: number;
  readonly waitFor?: 'completion' | 'message';
}
export interface ExtensionAgentMessageInput extends ExtensionAgentTarget {
  readonly message: string;
  readonly delivery?: 'append' | 'replace';
}
export interface ExtensionAgentsBackend {
  own(ownerInstanceId: string): () => Promise<void>;
  spawn(
    input: ExtensionAgentSpawnInput,
    call: ExtensionOperationContext
  ): Promise<ExtensionAgentSnapshot>;
  list(call: ExtensionOperationContext): Promise<readonly ExtensionAgentSnapshot[]>;
  inspect(
    input: ExtensionAgentTarget,
    call: ExtensionOperationContext
  ): Promise<ExtensionAgentSnapshot>;
  wait(
    input: ExtensionAgentWaitInput,
    call: ExtensionOperationContext
  ): Promise<ExtensionAgentWaitResult>;
  message(
    input: ExtensionAgentMessageInput,
    call: ExtensionOperationContext
  ): Promise<ExtensionAgentSnapshot>;
  cancel(
    input: ExtensionAgentTarget,
    call: ExtensionOperationContext
  ): Promise<ExtensionAgentSnapshot>;
}
export interface ExtensionAgentsApi {
  spawn(input: ExtensionAgentSpawnInput): Promise<ExtensionAgentSpawnResult>;
  list(input?: { readonly signal?: AbortSignal }): Promise<readonly ExtensionAgentSnapshot[]>;
  inspect(input: ExtensionAgentTarget): Promise<ExtensionAgentSnapshot>;
  wait(
    input: ExtensionAgentWaitInput & { readonly agentIds: readonly string[] }
  ): Promise<ExtensionAgentManySnapshot>;
  wait(
    input: ExtensionAgentWaitInput & { readonly agentIds?: undefined }
  ): Promise<ExtensionAgentSnapshot>;
  wait(input: ExtensionAgentWaitInput): Promise<ExtensionAgentWaitResult>;
  message(input: ExtensionAgentMessageInput): Promise<ExtensionAgentSnapshot>;
  cancel(input: ExtensionAgentTarget): Promise<ExtensionAgentSnapshot>;
}
export interface ExtensionAgentCompletion {
  readonly operation: 'spawn' | 'wait' | 'message' | 'cancel';
  readonly agentId: string;
  readonly status: SubagentTaskSnapshot['status'];
  readonly deliveryStatus?: SubagentTaskSnapshot['deliveryStatus'];
}

type AgentOperation = 'agent.spawn' | 'agent.wait' | 'agent.message' | 'agent.cancel';
export type ExtensionAgentAction = <Key extends AgentOperation>(
  key: Key,
  input: DomainAgentOperations[Key]['input'],
  leaf: (
    input: DomainAgentOperations[Key]['input'],
    call: ExtensionOperationContext
  ) => Promise<DomainAgentOperations[Key]['output']>
) => Promise<DomainAgentOperations[Key]['output']>;

/** All callers share one interception and authoritative leaf-completion boundary. */
export function invokeCoreAgentOperation<Key extends AgentOperation>(
  hooks: Pick<ExtensionHooks<DomainAgentOperations, DomainAgentFacts>, 'invoke' | 'emit'>,
  key: Key,
  input: DomainAgentOperations[Key]['input'],
  call: ExtensionOperationContext,
  leaf: (
    input: DomainAgentOperations[Key]['input'],
    call: ExtensionOperationContext
  ) => Promise<DomainAgentOperations[Key]['output']>
): Promise<DomainAgentOperations[Key]['output']> {
  return hooks.invoke(key, input, call, async (input, effective) => {
    const result = structuredClone(await leaf(input, effective));
    if (isHandledAgentResult(result)) return result;
    const agents: readonly ExtensionAgentSnapshot[] = Array.isArray(result.agents)
      ? result.agents
      : [result as ExtensionAgentSnapshot];
    for (const agent of agents)
      await hooks.emit(
        'agent.completed',
        {
          operation: key.slice('agent.'.length) as ExtensionAgentCompletion['operation'],
          agentId: agent.agentId,
          status: agent.status,
          ...(agent.deliveryStatus === undefined ? {} : { deliveryStatus: agent.deliveryStatus })
        },
        effective
      );
    return result;
  });
}

export function resolveAgentSpawn(input: ExtensionAgentSpawnInput): ExtensionAgentSpawnInput {
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

export function agentCapabilities(
  capabilities: ExtensionCapabilitySnapshot,
  available: boolean
): ExtensionCapabilitySnapshot {
  const values = Object.freeze(capabilities.list().filter((id) => id !== 'agents' || available));
  return Object.freeze({ has: (id: string) => values.includes(id), list: () => values });
}

export function bindCoreAgents(
  backend: ExtensionAgentsBackend,
  scope: ExtensionResourceScope,
  run: <Value>(
    operation: (call: ExtensionOperationContext) => Promise<Value>,
    signal?: AbortSignal
  ) => Promise<Value>,
  hooks: Pick<ExtensionHooks<DomainAgentOperations, DomainAgentFacts>, 'invoke' | 'emit'>
): ExtensionAgentsApi {
  scope.effect(() => backend.own(scope.instanceId));
  const invoke = <Key extends AgentOperation>(
    key: Key,
    input: DomainAgentOperations[Key]['input']
  ): Promise<DomainAgentOperations[Key]['output']> =>
    run(
      (call) =>
        invokeCoreAgentOperation(hooks, key, input, call, async (effectiveInput, effective) => {
          let result: ExtensionAgentWaitResult;
          switch (key) {
            case 'agent.spawn':
              result = await backend.spawn(
                {
                  ...resolveAgentSpawn(effectiveInput as ExtensionAgentSpawnInput),
                  ...((effectiveInput as ExtensionAgentSpawnInput).turnSignal === undefined
                    ? {}
                    : {
                        turnSignal: AbortSignal.any([
                          scope.signal,
                          (effectiveInput as ExtensionAgentSpawnInput).turnSignal!
                        ])
                      })
                },
                effective
              );
              break;
            case 'agent.wait':
              result = await backend.wait(effectiveInput as ExtensionAgentWaitInput, effective);
              break;
            case 'agent.message':
              result = await backend.message(
                effectiveInput as ExtensionAgentMessageInput,
                effective
              );
              break;
            case 'agent.cancel':
              result = await backend.cancel(effectiveInput as ExtensionAgentTarget, effective);
              break;
          }
          return result as DomainAgentOperations[Key]['output'];
        }),
      input.signal
    );
  const target = <T extends ExtensionAgentTarget>(input: T): T => {
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
    wait: (async (input: ExtensionAgentWaitInput) => {
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw invalid('Agent wait input is invalid.');
      const selection = parseAgentWaitTargets(input);
      return invoke(
        'agent.wait',
        input.agentId === undefined
          ? { ...input, ...selection }
          : target(input as ExtensionAgentTarget)
      );
    }) as ExtensionAgentsApi['wait'],
    message: async (input) => invoke('agent.message', target(input)),
    cancel: async (input) => invoke('agent.cancel', target(input))
  };
}

function invalid(message: string): AgentError {
  return new AgentError('MAR_AGENT_EXTENSION_AGENT_INPUT_INVALID', message);
}

export interface DomainAgentOperations {
  'agent.spawn': { input: ExtensionAgentSpawnInput; output: ExtensionAgentSpawnResult };
  'agent.wait': { input: ExtensionAgentWaitInput; output: ExtensionAgentWaitResult };
  'agent.message': { input: ExtensionAgentMessageInput; output: ExtensionAgentSnapshot };
  'agent.cancel': { input: ExtensionAgentTarget; output: ExtensionAgentSnapshot };
}
export interface DomainAgentFacts {
  'agent.completed': ExtensionAgentCompletion;
}
