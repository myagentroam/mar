import { AgentError } from '../error.js';
import type { ExtensionOperationContext } from '../extensions/operation.js';
import type { ExtensionPromptFacts } from '../extensions/prompt-composition.js';
import type { ExtensionSession } from '../extensions/session.js';
import type { ClientToolDefinition } from '../tools/contracts.js';
import type { ExecutionMode } from './types.js';
import type { SessionExecutionContext } from './session-execution.js';
import type { ResolvedModelConfiguration } from './model-runtime.js';
import type { PromptPart } from '../prompts/prompt-sections.js';

/** Builds the Session prompt preview using the same instruction and capability boundaries as execution. */
export function createSessionExtensionPrompt(ports: {
  readonly source: 'user' | 'subagent';
  readonly codeExecute: boolean;
  execution(): SessionExecutionContext | undefined;
  models(): { models: ReadonlyMap<string, ResolvedModelConfiguration>; defaultModelId: string };
  instruction(): string | undefined;
  capture(call: ExtensionOperationContext): ReturnType<ExtensionSession['capture']> | undefined;
  sections(
    tools: readonly ClientToolDefinition[],
    mode: ExecutionMode,
    model: ResolvedModelConfiguration,
    instruction: string | undefined
  ): readonly PromptPart[];
}) {
  return async (facts: ExtensionPromptFacts, call: ExtensionOperationContext) => {
    call.signal.throwIfAborted();
    const defaults = ports.execution();
    const state = defaults ?? ports.models();
    const modelId = facts.modelId ?? defaults?.modelId ?? ports.models().defaultModelId;
    const instruction = defaults ? defaults.instruction : ports.instruction();
    const model = state.models.get(modelId);
    if (!model) throw new AgentError('MAR_AGENT_MODEL_DISABLED', 'Selected model is unavailable.');
    const mode = facts.mode ?? defaults?.mode ?? 'run';
    const bindings = ports.capture(call);
    if (!bindings)
      throw new AgentError(
        'MAR_AGENT_EXTENSION_PROMPT_UNAVAILABLE',
        'Session prompt tool sources are unavailable.'
      );
    const definitions = [...bindings.values()]
      .filter((binding) => binding.available?.(call) !== false)
      .map((binding) => binding.definition)
      .filter(
        (tool) =>
          !(
            ports.source === 'subagent' &&
            (tool.agentScope === 'ROOT_ONLY' || tool.name === 'question')
          ) &&
          !(tool.name === 'question' && mode !== 'plan') &&
          !(tool.name === 'view_image' && !model.inputCapabilities.includes('IMAGE')) &&
          !(
            ['code_exec', 'code_exec_wait'].includes(tool.name) &&
            (!model.codeMode || !ports.codeExecute)
          )
      );
    const byName = new Map(definitions.map((tool) => [tool.name, tool]));
    const tools =
      facts.tools === undefined
        ? definitions
        : facts.tools.flatMap((name) => {
            const tool = byName.get(name);
            return tool ? [tool] : [];
          });
    call.signal.throwIfAborted();
    return {
      sections: ports.sections(tools, mode, model, instruction),
      facts: { modelId, mode, tools: tools.map((tool) => tool.name) }
    };
  };
}
