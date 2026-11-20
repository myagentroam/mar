import type { ClientToolDefinition } from '../contracts.js';
import { AgentError } from '../../error.js';

import { agentSkillSource, loadAgentSkill } from '../../runtime/context/instructions.js';
import type { ToolRuntimeContext } from '../runtime-context.js';

export const skillToolDefinition: ClientToolDefinition = {
  name: 'skill_load',
  allowedCallers: ['direct', 'programmatic'],
  parallelSafety: 'safe',
  description:
    'Load a Skill by its exact catalog name. On success, returns { success: true } and adds the instructions to the next model context. Read them before acting on them.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 128 }
    },
    required: ['name'],
    additionalProperties: false
  }
};

export async function executeSkill(arguments_: unknown, context: ToolRuntimeContext) {
  context.signal.throwIfAborted();
  if (arguments_ === null || typeof arguments_ !== 'object' || Array.isArray(arguments_))
    throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Skill input must be an object.');
  const input = arguments_ as Record<string, unknown>;
  if (
    typeof input.name !== 'string' ||
    input.name.length === 0 ||
    input.name.length > 128 ||
    Object.keys(input).some((key) => key !== 'name')
  )
    throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Skill input is invalid.');
  const skill = context.skills.get(input.name);
  if (!skill) throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Skill is not available.');
  if (!context.publishSkillContext)
    throw new AgentError('MAR_AGENT_TOOL_NOT_AVAILABLE', 'Skill context delivery is unavailable.');
  const content = await loadAgentSkill(skill);
  if (!content) throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Skill could not be loaded.');
  context.signal.throwIfAborted();
  await context.publishSkillContext(skill.name, content, context.signal);
  const data = { success: true };
  return {
    content: JSON.stringify(data),
    data,
    eventData: { name: skill.name, description: skill.description, source: agentSkillSource(skill) }
  };
}
