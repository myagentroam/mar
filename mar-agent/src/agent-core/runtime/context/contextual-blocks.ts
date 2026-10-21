import { createHash } from 'node:crypto';
import type { ModelContextualBlock, ModelMessage, ModelTextBlock } from '../../model/contracts.js';
import { resolveModelTextBlocks } from '../../model/text-blocks.js';
import type { CorePromptPart } from '../../extensions/prompt-composition.js';
import { renderPromptSections } from '../../extensions/prompt-composition.js';

export interface ContextualPart {
  id: string;
  source: ModelContextualBlock['source'];
  authority: ModelContextualBlock['authority'];
  content: string;
  textBlocks?: readonly ModelTextBlock[];
}

export function contextualBlock(
  part: ContextualPart,
  kind: string,
  operation: ModelContextualBlock['operation'] = 'replace'
): ModelContextualBlock {
  return {
    id: part.id,
    kind,
    source: part.source,
    authority: part.authority,
    operation,
    revision: createHash('sha256')
      .update(
        JSON.stringify({
          id: part.id,
          source: part.source,
          authority: part.authority,
          content: part.content,
          textBlocks: part.textBlocks,
          operation
        })
      )
      .digest('hex')
  };
}

const CORE_IDS = new Set([
  'core:identity',
  'core:instruction-priority',
  'core:workspace-discipline',
  'core:workflow',
  'core:interaction',
  'core:safety',
  'core:output-style'
]);
const SDK_CONTEXTUAL_IDS = new Set([
  'core:environment-rules',
  'core:tools',
  'core:long-running',
  'core:mode',
  'core:compaction',
  'core:subagent',
  'core:skill-catalog',
  'core:child-instructions'
]);

/** Keep arbitrary whole-string middleware and explicit cache scopes lossless. */
export function splitContextualPrompt(composed: {
  text: string;
  blocks?: readonly ModelTextBlock[];
  sections?: readonly CorePromptPart[];
}): { system: string; systemBlocks?: readonly ModelTextBlock[]; parts: ContextualPart[] } {
  const sections = composed.sections;
  if (
    !sections ||
    !sections.some((part) => CORE_IDS.has(part.id)) ||
    composed.blocks !== undefined ||
    renderPromptSections(sections) !== composed.text
  )
    return {
      system: composed.text,
      ...(composed.blocks === undefined ? {} : { systemBlocks: composed.blocks }),
      parts: []
    };
  let dynamicSeen = false;
  for (const section of sections) {
    if (!section.text) continue;
    if (!CORE_IDS.has(section.id)) dynamicSeen = true;
    else if (dynamicSeen) return { system: composed.text, parts: [] };
  }
  return {
    system: renderPromptSections(sections.filter((part) => CORE_IDS.has(part.id))),
    parts: sections.flatMap((section): ContextualPart[] => {
      if (CORE_IDS.has(section.id) || !section.text) return [];
      return [
        {
          id: section.id,
          source:
            section.id === 'core:caller-instructions'
              ? 'host'
              : SDK_CONTEXTUAL_IDS.has(section.id)
                ? 'sdk'
                : 'extension',
          authority: 'instruction',
          content: section.text
        }
      ];
    })
  };
}

interface ContextualChange {
  part: ContextualPart;
  block: ModelContextualBlock;
  content: string;
  textBlocks?: readonly ModelTextBlock[];
}

export function contextualChanges(
  previous: readonly ContextualPart[],
  current: readonly ContextualPart[]
): ContextualChange[] {
  const before = new Map(previous.map((part) => [part.id, part]));
  const after = new Set(current.map((part) => part.id));
  // A reorder changes instruction precedence even when each text is unchanged.
  const retainedBefore = previous.filter((part) => after.has(part.id)).map((part) => part.id);
  const appendedOrder = [
    ...retainedBefore,
    ...current.filter((part) => !before.has(part.id)).map((part) => part.id)
  ];
  const reordered =
    JSON.stringify(appendedOrder) !== JSON.stringify(current.map((part) => part.id));
  const changes: ContextualChange[] = [];
  for (const part of previous) {
    if (after.has(part.id)) continue;
    const { textBlocks: _blocks, ...retained } = part;
    const removed = { ...retained, content: '' };
    const block = contextualBlock(removed, 'instruction', 'remove');
    changes.push({ part: removed, block, content: renderContextualChange(block, '') });
  }
  for (const part of current) {
    const block = contextualBlock(part, 'instruction');
    const prior = before.get(part.id);
    if (!reordered && prior && contextualBlock(prior, 'instruction').revision === block.revision)
      continue;
    const content = renderContextualChange(block, part.content);
    changes.push({
      part,
      block,
      content,
      ...(part.textBlocks === undefined
        ? {}
        : {
            textBlocks: [
              { text: content.slice(0, content.length - part.content.length) },
              ...resolveModelTextBlocks(part.content, part.textBlocks)
            ]
          })
    });
  }
  return changes;
}

function renderContextualChange(block: ModelContextualBlock, content: string): string {
  const id = JSON.stringify(block.id);
  const action =
    block.operation === 'remove'
      ? `Remove only the previous contextual instruction block with id ${id}. Other instructions and user requests remain in effect.`
      : `This is the current complete contextual instruction block with id ${id}. It replaces only earlier versions of the same block.`;
  return `# Contextual instruction ${id}\n${action}\n${content}`;
}

/** Compact reuses a sent prefix when possible, but fallback evidence excludes private state. */
export function projectCompactPromptMessages(
  messages: readonly ModelMessage[],
  parts: readonly ContextualPart[],
  previous: readonly ContextualPart[]
): ModelMessage[] {
  const baseline = messages.some((message) => message.contextualBlock?.authority === 'instruction')
    ? previous
    : [];
  const additions: ModelMessage[] = contextualChanges(baseline, parts).map(
    ({ content, block, textBlocks }) => ({
      role: 'user',
      content,
      contextKind: 'contextual',
      contextualBlock: block,
      ...(textBlocks === undefined ? {} : { textBlocks })
    })
  );
  const control = messages.findIndex((message) => message.contextKind === 'compact_control');
  const index = control < 0 ? messages.length : control;
  return [...messages.slice(0, index), ...additions, ...messages.slice(index)];
}
