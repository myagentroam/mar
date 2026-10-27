import type { ClientToolDefinition } from '../contracts.js';

import type { SubagentTaskInput } from '../../subagent/contracts.js';
import type { ToolRuntimeContext } from '../runtime-context.js';
import { AgentError } from '../../error.js';
import { agentReasoningEffortSchema } from '../../model/configuration.js';
import { TOOL_EXECUTION_LIMITS } from '../execution-limits.js';

export const agentStartToolDefinition: ClientToolDefinition = {
  name: 'agent_start',
  allowedCallers: ['direct'],
  parallelSafety: 'serial',
  description:
    'Start one bounded, non-recursive child agent with self-contained context. Startup does not wait for task completion. Returns agentId for agent_wait, agent_message, or agent_cancel, description, queued/running/completed/failed/cancelled/interrupted status, and effective model metadata, not task results. Use agent_wait to read results and verification evidence. The optional reasoningEffort overrides the parent effort and must be supported by the selected model; omit it to inherit.',
  inputSchema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        maxLength: TOOL_EXECUTION_LIMITS.subagentDescriptionMaxCharacters
      },
      prompt: {
        type: 'string',
        description:
          'Self-contained bounded objective, necessary facts, relevant paths, read/write scope, constraints, expected output, and verification responsibility. The child does not inherit parent history.'
      },
      role: { enum: ['general-purpose', 'explore'] },
      modelId: { type: 'string' },
      reasoningEffort: {
        type: 'string',
        enum: agentReasoningEffortSchema.options,
        maxLength: TOOL_EXECUTION_LIMITS.subagentReasoningEffortMaxCharacters,
        description:
          'Reasoning effort override for the subagent. Omit to inherit the parent effort.'
      }
    },
    required: ['description', 'prompt', 'role'],
    additionalProperties: false
  }
};

export function agentStartToolDefinitionWithModels(
  models: readonly {
    readonly id: string;
    readonly name: string;
    readonly reasoningEfforts: readonly string[];
  }[]
): ClientToolDefinition {
  if (models.length === 0) return agentStartToolDefinition;
  const modelLines = [...models]
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map((model) => {
      const efforts =
        model.reasoningEfforts.length === 0
          ? ''
          : `; reasoning efforts: ${model.reasoningEfforts.join(', ')}`;
      return `- ${JSON.stringify(model.id)} (${JSON.stringify(model.name)}${efforts})`;
    });
  return {
    ...agentStartToolDefinition,
    description: [
      agentStartToolDefinition.description,
      'The optional modelId may select an enabled model below. Omit modelId to use the current agent model. Only use a listed reasoning effort for the selected model.',
      'Enabled subagent models:',
      ...modelLines
    ].join('\n')
  };
}

export async function executeAgentStart(arguments_: unknown, context: ToolRuntimeContext) {
  const value = parseAgentStartInput(arguments_);
  if (!context.subagents)
    throw new AgentError('MAR_AGENT_SUBAGENT_RECURSION_DISABLED', 'Subagents cannot recurse.');
  const task = await context.subagents.run(value, {
    signal: context.signal,
    onCreated: async (created) =>
      context.emit({
        type: 'subagent.started',
        agentId: created.agentId,
        description: created.description,
        ...(created.modelId === undefined ? {} : { modelId: created.modelId }),
        ...(created.modelName === undefined ? {} : { modelName: created.modelName }),
        ...(created.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: created.reasoningEffort })
      })
  });
  return { content: JSON.stringify(task), data: task };
}

function parseAgentStartInput(value: unknown): SubagentTaskInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidAgentStart();
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) => !['description', 'prompt', 'role', 'modelId', 'reasoningEffort'].includes(key)
    ) ||
    typeof input.description !== 'string' ||
    input.description.trim().length === 0 ||
    input.description.length > TOOL_EXECUTION_LIMITS.subagentDescriptionMaxCharacters ||
    typeof input.prompt !== 'string' ||
    input.prompt.trim().length === 0 ||
    Buffer.byteLength(input.prompt) > TOOL_EXECUTION_LIMITS.subagentPromptMaxBytes ||
    !['general-purpose', 'explore'].includes(String(input.role)) ||
    (input.modelId !== undefined &&
      input.modelId !== null &&
      (typeof input.modelId !== 'string' || input.modelId.trim().length === 0)) ||
    (input.reasoningEffort !== undefined &&
      input.reasoningEffort !== null &&
      (typeof input.reasoningEffort !== 'string' ||
        !agentReasoningEffortSchema.safeParse(input.reasoningEffort.trim()).success))
  )
    return invalidAgentStart();
  return {
    description: input.description.trim(),
    prompt: input.prompt,
    role: input.role as SubagentTaskInput['role'],
    ...(typeof input.modelId === 'string' ? { modelId: input.modelId } : {}),
    ...(typeof input.reasoningEffort === 'string'
      ? { reasoningEffort: agentReasoningEffortSchema.parse(input.reasoningEffort.trim()) }
      : {}),
    background: true
  };
}

function invalidAgentStart(): never {
  throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Agent start input is invalid.');
}
