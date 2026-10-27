import type { PromptPart } from '../prompts/prompt-sections.js';
import { AgentError } from '../error.js';
import type { ExecutionMode } from '../runtime/contracts.js';

import type { ExtensionHooks } from './hooks.js';
import type { ExtensionOperationContext } from './operation.js';

export interface ExtensionPromptFacts {
  readonly modelId?: string;
  readonly mode?: ExecutionMode;
  readonly tools?: readonly string[];
}
export interface ExtensionPromptComposition {
  readonly sections: readonly PromptPart[];
  readonly facts?: ExtensionPromptFacts;
}
export interface ExtensionPromptSectionInput extends PromptPart {
  readonly facts?: ExtensionPromptFacts;
}

function invalid(): never {
  throw new AgentError('MAR_AGENT_EXTENSION_PROMPT_INVALID', 'Prompt composition is invalid.');
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string | null {
  if (value !== null && typeof value !== 'string') invalid();
  return value;
}

export function normalizePromptComposition(value: unknown): ExtensionPromptComposition {
  const source = object(value);
  const sections = source.sections;
  const facts = source.facts;
  if (!Array.isArray(sections)) invalid();
  const ids = new Set<string>();
  let sessionScope = false;
  const parts = Array.from(sections, (value): PromptPart => {
    const source = object(value);
    const id = source.id;
    const content = source.text;
    const scope = source.scope;
    if (typeof id !== 'string' || !id.trim()) invalid();
    if (ids.has(id))
      throw new AgentError('MAR_AGENT_EXTENSION_PROMPT_CONFLICT', 'Prompt section id conflicts.');
    ids.add(id);
    if (scope !== undefined && scope !== 'shared' && scope !== 'session') invalid();
    if (scope === 'shared' && sessionScope) invalid();
    if (scope === 'session') sessionScope = true;
    return Object.freeze({ id, text: text(content), ...(scope === undefined ? {} : { scope }) });
  });
  let copiedFacts: ExtensionPromptFacts | undefined;
  if (facts !== undefined) {
    const source = object(facts);
    const modelId = source.modelId;
    const mode = source.mode;
    const tools = source.tools;
    const copiedTools = Array.isArray(tools) ? Array.from(tools) : undefined;
    if (modelId !== undefined && (typeof modelId !== 'string' || !modelId)) invalid();
    if (mode !== undefined && mode !== 'run' && mode !== 'plan' && mode !== 'compact') invalid();
    if (
      tools !== undefined &&
      (copiedTools === undefined || copiedTools.some((name) => typeof name !== 'string' || !name))
    )
      invalid();
    copiedFacts = Object.freeze({
      ...(modelId === undefined ? {} : { modelId: modelId as string }),
      ...(mode === undefined ? {} : { mode: mode as ExecutionMode }),
      ...(copiedTools === undefined ? {} : { tools: Object.freeze(copiedTools as string[]) })
    });
  }
  return Object.freeze({
    sections: Object.freeze(parts),
    ...(copiedFacts === undefined ? {} : { facts: copiedFacts })
  });
}

export async function composePromptSections(
  hooks: Pick<
    ExtensionHooks<DomainPromptCompositionOperations, DomainPromptCompositionFacts>,
    'invoke' | 'emit'
  >,
  input: ExtensionPromptComposition,
  registered: readonly ExtensionPromptSection[],
  call: ExtensionOperationContext
): Promise<ExtensionPromptComposition> {
  const snapshot = normalizePromptComposition({
    ...input,
    sections: [...input.sections, ...registered]
  });
  const result = await hooks.invoke('prompt.sections', snapshot, call, async (input, call) => {
    const selected = normalizePromptComposition(input);
    const sections: PromptPart[] = [];
    for (const part of selected.sections) {
      const output = await hooks.invoke(
        'prompt.section',
        Object.freeze({
          ...part,
          ...(selected.facts === undefined ? {} : { facts: selected.facts })
        }),
        call,
        async (input, call) => {
          call.signal.throwIfAborted();
          const selected = normalizePromptComposition({
            sections: [input],
            facts: object(input).facts
          });
          // A text handler cannot silently retarget its captured section. Whole-list edits use prompt.sections.
          if (selected.sections[0]!.id !== part.id) invalid();
          return selected.sections[0]!.text;
        }
      );
      call.signal.throwIfAborted();
      sections.push({
        id: part.id,
        text: text(output),
        ...(part.scope === undefined ? {} : { scope: part.scope })
      });
    }
    return normalizePromptComposition({ ...selected, sections });
  });
  call.signal.throwIfAborted();
  return normalizePromptComposition(result);
}

export interface DomainPromptCompositionOperations {
  'prompt.compose': { input: string; output: string };
  'prompt.sections': { input: ExtensionPromptComposition; output: ExtensionPromptComposition };
  'prompt.section': { input: ExtensionPromptSectionInput; output: string | null };
}
export interface DomainPromptCompositionFacts {}

export interface ExtensionPromptSection {
  readonly id: string;
  readonly text: string;
}
