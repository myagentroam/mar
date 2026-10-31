import type { ClientToolDefinition } from '../tools/contracts.js';
import type { SessionModelMessage as ModelMessage } from './model-request.js';
import { stableToolDefinition, stableToolSchema } from '../model/tool-definition-projection.js';
import { allowsDirectTool, allowsToolCaller } from './tool-callers.js';

export function projectProgrammaticTool(
  tool: ClientToolDefinition
): Pick<ClientToolDefinition, 'name' | 'description' | 'inputSchema'> {
  return {
    name: tool.name,
    description: `${allowsDirectTool(tool, true) ? `Call directly or as tools.${tool.name} inside code_exec.` : `Call only as tools.${tool.name} inside code_exec, never as a direct model tool.`}\n${tool.description}`,
    inputSchema: stableToolSchema(tool.inputSchema)
  };
}

/** Preserve native search definitions while providing the same discovery evidence to other protocols. */
export function projectCodeModeSearchResult(
  message: ModelMessage,
  codeModeEnabled: boolean
): ModelMessage {
  if (!message.toolSearchTools) return message;
  if (!codeModeEnabled)
    return {
      ...message,
      toolSearchTools: message.toolSearchTools
        .filter((tool) => allowsToolCaller(tool, 'direct'))
        .map(stableToolDefinition)
    };
  const tools = message.toolSearchTools.map((tool) => ({
    ...(allowsToolCaller(tool, 'programmatic')
      ? {
          ...projectProgrammaticTool(tool),
          ...(allowsDirectTool(tool, true)
            ? { inputMode: tool.inputMode ?? ('json' as const) }
            : {})
        }
      : {
          name: tool.name,
          description: tool.description,
          inputSchema: stableToolSchema(tool.inputSchema),
          inputMode: tool.inputMode ?? ('json' as const)
        }),
    caller: allowsToolCaller(tool, 'programmatic')
      ? allowsDirectTool(tool, true)
        ? 'both'
        : 'programmatic'
      : 'direct'
  }));
  return {
    ...message,
    content: JSON.stringify({ tools }),
    toolSearchTools: tools.map(({ caller: _caller, ...tool }) => tool)
  };
}
