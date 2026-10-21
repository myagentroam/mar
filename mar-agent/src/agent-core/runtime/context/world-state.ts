import { z } from 'zod';
import { MarAgentError } from '../../error.js';
import { contextualBlock, contextualChanges, type ContextualPart } from './contextual-blocks.js';
import type { ModelContextualBlock, ModelTextBlock, ModelMessage } from '../../model/contracts.js';
import { compactSummaryFromCheckpoint } from '../../session/store/index.js';
export interface ContextualWorldState {
  generation: string | undefined;
  initialized: boolean;
  instructionSnapshot: string | undefined;
  resourceSnapshot: string | undefined;
  mcpSnapshot?: string | undefined;
  promptSnapshot?: readonly ContextualPart[];
  entries: Array<{
    index: number;
    kind: 'instructions' | 'resources' | 'mcp' | 'prompt';
    content: string;
    block?: ModelContextualBlock;
    textBlocks?: readonly ModelTextBlock[];
  }>;
}

export function insertContextualWorldState(
  messages: readonly ModelMessage[],
  entries: Readonly<ContextualWorldState['entries']>
): ModelMessage[] {
  const result = [...messages];
  // Entries can be restored before the latest user after Compact. Sort anchors,
  // retaining insertion order at the same anchor rather than using a global offset.
  const ordered = entries
    .map((entry, order) => ({ entry, order }))
    .sort((left, right) => left.entry.index - right.entry.index || left.order - right.order);
  let offset = 0;
  for (const { entry } of ordered) {
    const insertionIndex = Math.max(0, Math.min(entry.index + offset, result.length));
    result.splice(insertionIndex, 0, {
      role: 'user',
      content: entry.content,
      contextKind: 'contextual',
      contextualBlock:
        entry.block ??
        contextualBlock(
          {
            id: `runtime:${entry.kind}`,
            source: 'runtime',
            authority: 'context',
            content: entry.content
          },
          entry.kind
        ),
      ...(entry.textBlocks === undefined ? {} : { textBlocks: entry.textBlocks })
    });
    offset++;
  }
  return result;
}

export function latestContextualWorldStateGeneration(
  records: readonly import('../../session/store/index.js').SessionRecord[]
): string | undefined {
  let generation: string | undefined;
  for (const record of records)
    if (
      record.type === 'context.gc.completed' ||
      compactSummaryFromCheckpoint(record) !== undefined
    )
      generation = record.recordId;
  return generation;
}

const textBlocksSchema = z
  .array(z.object({ text: z.string(), cache: z.literal(true).optional() }).strict())
  .transform((blocks): ModelTextBlock[] =>
    blocks.map((block) => ({
      text: block.text,
      ...(block.cache === true ? { cache: true as const } : {})
    }))
  );
const partSchema = z
  .object({
    id: z.string().min(1).max(256),
    source: z.enum(['sdk', 'host', 'extension', 'runtime']),
    authority: z.enum(['instruction', 'context']),
    content: z.string(),
    textBlocks: textBlocksSchema.optional()
  })
  .strict()
  .transform(({ textBlocks, ...part }): ContextualPart => ({
    ...part,
    ...(textBlocks === undefined ? {} : { textBlocks })
  }));
const blockSchema = z
  .object({
    id: z.string().min(1).max(256),
    source: z.enum(['sdk', 'host', 'extension', 'runtime']),
    authority: z.enum(['instruction', 'context']),
    kind: z.string().min(1).max(128),
    revision: z.string().regex(/^[a-f0-9]{64}$/u),
    operation: z.enum(['replace', 'remove'])
  })
  .strict();

export function updatePromptWorldState(
  state: ContextualWorldState,
  index: number,
  parts: readonly ContextualPart[]
): ContextualWorldState {
  const parsed = z.array(partSchema).max(MAX_CONTEXTUAL_WORLD_STATE_ENTRIES).safeParse(parts);
  if (!parsed.success)
    throw new MarAgentError(
      'MAR_AGENT_EXTENSION_PROMPT_INVALID',
      'Contextual prompt state is invalid.'
    );
  const selected = parsed.data;
  if (new Set(selected.map((part) => part.id)).size !== selected.length)
    throw new MarAgentError(
      'MAR_AGENT_EXTENSION_PROMPT_CONFLICT',
      'Contextual block ids conflict.'
    );
  const changes = contextualChanges(state.promptSnapshot ?? [], selected);
  if (!changes.length && state.promptSnapshot !== undefined) return state;
  return {
    ...state,
    promptSnapshot: selected,
    entries: [
      ...state.entries,
      ...changes.map(({ block, content, textBlocks }) => ({
        index,
        kind: 'prompt' as const,
        content,
        block,
        ...(textBlocks === undefined ? {} : { textBlocks })
      }))
    ]
  };
}

const MAX_CONTEXTUAL_WORLD_STATE_ENTRIES = 1_024;
const MAX_CONTEXTUAL_WORLD_STATE_CONTENT_BYTES = 8 * 1024 * 1024;

export function parsePersistedContextualWorldState(
  payload: unknown
): ContextualWorldState | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  if (record.version !== 1 && record.version !== 2) return undefined;
  const generation =
    record.generation === null
      ? undefined
      : typeof record.generation === 'string' && record.generation.length <= 128
        ? record.generation
        : null;
  if (generation === null) return undefined;
  const instructionSnapshot = nullableWorldStateString(record.instructionSnapshot);
  const resourceSnapshot = nullableWorldStateString(record.resourceSnapshot);
  if (instructionSnapshot === null || resourceSnapshot === null || !Array.isArray(record.entries))
    return undefined;
  if (record.entries.length > MAX_CONTEXTUAL_WORLD_STATE_ENTRIES) return undefined;
  const entries: ContextualWorldState['entries'] = [];
  let contentBytes = 0;
  for (const value of record.entries) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const entry = value as Record<string, unknown>;
    if (
      !Number.isSafeInteger(entry.index) ||
      (entry.index as number) < 0 ||
      (entry.kind !== 'instructions' &&
        entry.kind !== 'resources' &&
        entry.kind !== 'mcp' &&
        entry.kind !== 'prompt') ||
      typeof entry.content !== 'string' ||
      entry.content.length === 0
    )
      return undefined;
    contentBytes += Buffer.byteLength(entry.content);
    if (contentBytes > MAX_CONTEXTUAL_WORLD_STATE_CONTENT_BYTES) return undefined;
    const block = entry.block === undefined ? undefined : blockSchema.safeParse(entry.block);
    const textBlocks =
      entry.textBlocks === undefined ? undefined : textBlocksSchema.safeParse(entry.textBlocks);
    if (
      (block && !block.success) ||
      (textBlocks && !textBlocks.success) ||
      (entry.kind === 'prompt' && !block?.success)
    )
      return undefined;
    entries.push({
      index: entry.index as number,
      kind: entry.kind,
      content: entry.content,
      ...(block?.success ? { block: block.data } : {}),
      ...(textBlocks?.success ? { textBlocks: textBlocks.data } : {})
    });
  }
  const promptSnapshot =
    record.promptSnapshot === undefined
      ? undefined
      : z
          .array(partSchema)
          .max(MAX_CONTEXTUAL_WORLD_STATE_ENTRIES)
          .safeParse(record.promptSnapshot);
  if (promptSnapshot && !promptSnapshot.success) return undefined;
  if (entries.some((entry) => entry.kind === 'prompt') && !promptSnapshot?.success)
    return undefined;
  if (
    promptSnapshot?.success &&
    new Set(promptSnapshot.data.map((part) => part.id)).size !== promptSnapshot.data.length
  )
    return undefined;
  return {
    ...(promptSnapshot?.success ? { promptSnapshot: promptSnapshot.data } : {}),
    generation,
    initialized: true,
    instructionSnapshot,
    resourceSnapshot,
    mcpSnapshot: typeof record.mcpSnapshot === 'string' ? record.mcpSnapshot : undefined,
    entries
  };
}

function nullableWorldStateString(value: unknown): string | undefined | null {
  if (value === null) return undefined;
  return typeof value === 'string' &&
    Buffer.byteLength(value) <= MAX_CONTEXTUAL_WORLD_STATE_CONTENT_BYTES
    ? value
    : null;
}

export async function persistContextualWorldState(
  store: import('../../session/store/index.js').JsonlSessionStore,
  sessionId: string,
  state: ContextualWorldState
): Promise<void> {
  if (state.entries.length > MAX_CONTEXTUAL_WORLD_STATE_ENTRIES)
    throw new MarAgentError(
      'MAR_AGENT_HOST_LIMIT_EXCEEDED',
      'Contextual world state exceeds the entry limit.'
    );
  await store.writeContextualWorldState(sessionId, {
    version: 2,
    ...(state.promptSnapshot === undefined ? {} : { promptSnapshot: state.promptSnapshot }),
    generation: state.generation ?? null,
    instructionSnapshot: state.instructionSnapshot ?? null,
    resourceSnapshot: state.resourceSnapshot ?? null,
    mcpSnapshot: state.mcpSnapshot ?? null,
    entries: state.entries
  });
}

export function updateContextualWorldState(
  state: ContextualWorldState,
  index: number,
  current: {
    instructionSnapshot: string | undefined;
    instructionContent: string | undefined;
  }
): ContextualWorldState {
  const entries = [...state.entries];
  if (!state.initialized || state.instructionSnapshot !== current.instructionSnapshot) {
    if (current.instructionContent !== undefined)
      entries.push({ index, kind: 'instructions', content: current.instructionContent });
  }
  return {
    ...state,
    generation: state.generation,
    mcpSnapshot: state.mcpSnapshot,
    initialized: true,
    instructionSnapshot: current.instructionSnapshot,
    resourceSnapshot: state.resourceSnapshot,
    entries
  };
}

export function resetContextualWorldState(
  generation: string | undefined,
  index: number,
  current: {
    instructionSnapshot: string | undefined;
    instructionContent: string | undefined;
    /** Only a committed Compact may supply a new dynamic-resource snapshot. */
    resourceSnapshot?: string | undefined;
  }
): ContextualWorldState {
  const entries: ContextualWorldState['entries'] = [];
  if (current.instructionContent !== undefined)
    entries.push({ index, kind: 'instructions', content: current.instructionContent });
  if (current.resourceSnapshot !== undefined)
    entries.push({ index, kind: 'resources', content: current.resourceSnapshot });
  return {
    generation,
    initialized: true,
    instructionSnapshot: current.instructionSnapshot,
    resourceSnapshot: current.resourceSnapshot,
    entries
  };
}

export function contextualInstructionInsertIndex(messages: readonly ModelMessage[]): number {
  let index = messages.findLastIndex(
    (message) =>
      message.role === 'user' &&
      message.contextKind === undefined &&
      message.metadata?.source !== 'extension'
  );
  if (index < 0) index = messages.findLastIndex((message) => message.contextKind === 'summary');
  if (index < 0) return messages.length;
  if (index > 0 && messages[index - 1]?.contextKind === 'environment') index--;
  return index;
}
