import type { ClientToolDefinition } from '../contracts.js';
import { AgentError } from '../../error.js';

import { agentSkillSource, loadAgentSkill } from '../../runtime/context/instructions.js';
import type { ToolRuntimeContext } from '../runtime-context.js';

export const skillToolDefinition: ClientToolDefinition = {
  name: 'skill',
  allowedCallers: ['direct'],
  parallelSafety: 'safe',
  description: "Load a Skill's instructions by its exact catalog name.",
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
  const content = await loadAgentSkill(skill);
  if (!content) throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Skill could not be loaded.');
  context.signal.throwIfAborted();
  return {
    content,
    data: { name: skill.name, description: skill.description, source: agentSkillSource(skill) }
  };
}
