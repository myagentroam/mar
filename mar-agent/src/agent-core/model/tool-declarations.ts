import type { MarAgentModelConfiguration } from './configuration.js';
import type { ClientToolDefinition } from './contracts.js';

/** Native Responses discovery carries deferred definitions in history, not the top-level catalog. */
export function projectModelRequestTools(
  model: Pick<MarAgentModelConfiguration, 'protocol'>,
  tools: readonly ClientToolDefinition[],
  residentNames: ReadonlySet<string>
): readonly ClientToolDefinition[] {
  return model.protocol === 'OPENAI_RESPONSES'
    ? tools.filter((tool) => residentNames.has(tool.name))
    : tools;
}
