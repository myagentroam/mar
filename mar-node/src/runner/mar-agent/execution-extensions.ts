import { MarAgentError, type LocalAgentExecutionExtensions } from '@myagentroam/agent';

/** Composes Node-owned tools without replacing another domain's execution handler. */
export function combineExecutionExtensions(
  ...sources: readonly LocalAgentExecutionExtensions[]
): LocalAgentExecutionExtensions {
  const tools = sources.flatMap((source) => source.tools ?? []);
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length)
    throw new MarAgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Host tool names conflict.');
  return {
    tools,
    skills: sources.flatMap((source) => source.skills ?? []),
    isToolAvailable: (name, context) => {
      const source = sources.find((source) => source.tools?.some((tool) => tool.name === name));
      return source !== undefined && source.isToolAvailable?.(name, context) !== false;
    },
    executeTool: async (call, context) => {
      const source = sources.find((source) =>
        source.tools?.some((tool) => tool.name === call.name)
      );
      if (!source?.executeTool)
        throw new MarAgentError('MAR_AGENT_TOOL_NOT_AVAILABLE', 'Host tool is unavailable.');
      return source.executeTool(call, context);
    }
  };
}
