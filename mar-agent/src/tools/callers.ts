import type { ClientToolDefinition } from './contracts.js';
import type { ToolCaller } from './contracts.js';
import { AgentError } from '../error.js';

/** Normalize trusted Host policy independently of discovery, Agent scope and parallel safety. */
export function toolCallers(tool: ClientToolDefinition): readonly ToolCaller[] {
  if (tool.codeModeExposure !== undefined && tool.codeModeExposure !== 'both')
    throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Code Mode exposure is invalid.');
  const value = tool.allowedCallers;
  if (value === undefined)
    return tool.name.startsWith('mcp__') ? ['direct', 'programmatic'] : ['direct'];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((caller) => caller !== 'direct' && caller !== 'programmatic')
  )
    throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Tool caller policy is invalid.');
  return (['direct', 'programmatic'] as const).filter((caller) => value.includes(caller));
}

export function allowsToolCaller(tool: ClientToolDefinition, caller: ToolCaller): boolean {
  // Control tools cannot be widened by a Host override or historical definition.
  if (
    caller === 'programmatic' &&
    ['code_exec', 'code_exec_wait', 'tool_search', 'question', 'skill', 'sleep'].includes(tool.name)
  )
    return false;
  return toolCallers(tool).includes(caller);
}

/** Code Mode Only changes model exposure, never the Host's underlying caller permissions. */
export function allowsDirectTool(tool: ClientToolDefinition, codeModeEnabled: boolean): boolean {
  return (
    allowsToolCaller(tool, 'direct') &&
    (!codeModeEnabled ||
      tool.codeModeExposure === 'both' ||
      !allowsToolCaller(tool, 'programmatic'))
  );
}
