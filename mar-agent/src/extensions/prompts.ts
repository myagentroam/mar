import { AgentError } from '../error.js';
import type { ModelTextBlock } from '../model/contracts.js';
import { resolveModelTextBlocks } from '../model/text-blocks.js';
import { renderPromptSections, type PromptPart } from '../prompts/prompt-sections.js';
import type { ExtensionHooks } from './hooks.js';
import type { ExtensionOperationContext, ExtensionOperationRunner } from './operation.js';
import {
  composePromptSections,
  normalizePromptComposition,
  type ExtensionPromptComposition,
  type ExtensionPromptFacts,
  type ExtensionPromptSection,
  type DomainPromptCompositionOperations,
  type DomainPromptCompositionFacts
} from './prompt-composition.js';
import type { ExtensionResourceRegistration, ExtensionResourceScope } from './resources.js';
import type { ExtensionSessionBackend } from './session-input.js';

interface ExtensionPromptsApi {
  register(section: ExtensionPromptSection): ExtensionResourceRegistration;
  sections(): readonly ExtensionPromptSection[];
  compose(system: string): Promise<string>;
  composeSections(input: ExtensionPromptComposition): Promise<ExtensionPromptComposition>;
  composeDefault(facts?: ExtensionPromptFacts): Promise<ExtensionPromptComposition>;
}

/** Owns Session prompt contributions and their single composition lane. */
export class ExtensionPrompts {
  readonly #prompts: { value: ExtensionPromptSection; scope: ExtensionResourceScope }[] = [];
  constructor(
    private readonly hooks: Pick<
      ExtensionHooks<DomainPromptCompositionOperations, DomainPromptCompositionFacts>,
      'invoke' | 'emit'
    >,
    private readonly assertLive: () => void
  ) {}

  bind(
    scope: ExtensionResourceScope,
    run: ExtensionOperationRunner,
    backend?: Pick<ExtensionSessionBackend, 'composePrompt'>
  ): ExtensionPromptsApi {
    return {
      register: (input) => {
        const section = normalizePromptComposition({ sections: [input] }).sections[0]!;
        if (section.text === null)
          throw new AgentError('MAR_AGENT_EXTENSION_PROMPT_INVALID', 'Prompt section is invalid.');
        if (this.#prompts.some((entry) => entry.value.id === section.id))
          throw new AgentError(
            'MAR_AGENT_EXTENSION_PROMPT_CONFLICT',
            'Prompt section id conflicts.'
          );
        const entry = { value: Object.freeze({ id: section.id, text: section.text }), scope };
        const registration = scope.effect(() => () => {
          const index = this.#prompts.indexOf(entry);
          if (index !== -1) this.#prompts.splice(index, 1);
        });
        this.#prompts.push(entry);
        return registration;
      },
      sections: () => this.sections(),
      compose: (system) => run((call) => this.compose(system, call)),
      composeSections: (input) => {
        const snapshot = normalizePromptComposition(input);
        return run((call) => this.composeSections(snapshot, call));
      },
      composeDefault: (facts = {}) => {
        const snapshot = normalizePromptComposition({ sections: [], facts });
        return run(async (call) => {
          if (!backend?.composePrompt)
            throw new AgentError(
              'MAR_AGENT_EXTENSION_PROMPT_UNAVAILABLE',
              'Session default prompt composition is unavailable.'
            );
          return this.composeSections(await backend.composePrompt(snapshot.facts!, call), call);
        });
      }
    };
  }

  sections(): readonly ExtensionPromptSection[] {
    return this.#prompts
      .filter((entry) => entry.scope.state === 'ACTIVE')
      .map((entry) => entry.value);
  }

  composeSections(
    input: ExtensionPromptComposition,
    call: ExtensionOperationContext
  ): Promise<ExtensionPromptComposition> {
    this.assertLive();
    return composePromptSections(this.hooks, input, this.sections(), call);
  }

  async compose(
    system: string | ExtensionPromptComposition,
    call: ExtensionOperationContext
  ): Promise<string> {
    return (await this.composeModelSystem(system, call)).text;
  }

  async composeModelSystem(
    system: string | ExtensionPromptComposition,
    call: ExtensionOperationContext
  ): Promise<{
    text: string;
    blocks?: readonly ModelTextBlock[];
    sections?: readonly PromptPart[];
  }> {
    if (typeof system !== 'string' && (system === null || typeof system !== 'object'))
      throw new AgentError('MAR_AGENT_EXTENSION_PROMPT_INVALID', 'Prompt composition is invalid.');
    const input =
      typeof system === 'string'
        ? { sections: [{ id: 'core:base', text: system }] }
        : normalizePromptComposition(system);
    const sections = await this.composeSections(input, call);
    const composed = renderPromptSections(sections.sections);
    const result = await this.hooks.invoke(
      'prompt.compose',
      composed,
      call,
      async (value) => value
    );
    call.signal.throwIfAborted();
    if (typeof result !== 'string')
      throw new AgentError('MAR_AGENT_EXTENSION_PROMPT_INVALID', 'Prompt composition is invalid.');
    if (!sections.sections.some((part) => part.scope !== undefined))
      return { text: result, sections: sections.sections };
    const shared = sections.sections
      .filter((part) => part.scope === 'shared' && part.text)
      .map((part) => part.text!)
      .join('\n\n');
    const session = sections.sections
      .filter((part) => part.scope !== 'shared' && part.text)
      .map((part) => part.text!)
      .join('\n\n');
    const blocks: ModelTextBlock[] = [];
    if (shared) blocks.push({ text: shared, cache: true });
    if (session) blocks.push({ text: `${shared ? '\n\n' : ''}${session}` });
    return { text: result, blocks: resolveModelTextBlocks(result, blocks) };
  }
}
