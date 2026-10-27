import type { AgentModelConfiguration } from './configuration.js';
import type { ModelToolDefinition } from './contracts.js';

/** Native Responses discovery carries deferred definitions in history, not the top-level catalog. */
export function projectModelRequestTools(
  model: Pick<AgentModelConfiguration, 'protocol'>,
  tools: readonly ModelToolDefinition[],
  residentNames: ReadonlySet<string>
): readonly ModelToolDefinition[] {
  return model.protocol === 'OPENAI_RESPONSES'
    ? tools.filter((tool) => residentNames.has(tool.name))
    : tools;
}
