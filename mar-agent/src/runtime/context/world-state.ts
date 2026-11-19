import type { SessionModelMessage as ModelMessage } from '../../session/model-request.js';
import { z } from 'zod';
import { AgentError } from '../../error.js';
import { contextualBlock, contextualChanges, type ContextualPart } from './contextual-blocks.js';
import type { ModelContextualBlock, ModelTextBlock } from '../../model/contracts.js';
import { compactSummaryFromCheckpoint } from '../../session/record-projection.js';
export interface ContextualWorldState {
  generation: string | undefined;
  initialized: boolean;
  instructionSnapshot: string | undefined;
  resourceSnapshot: string | undefined;
  mcpSnapshot?: string | undefined;
  skillSnapshot?: string | undefined;
  promptSnapshot?: readonly ContextualPart[];
  entries: Array<{
    index: number;
    kind: 'instructions' | 'resources' | 'mcp' | 'skills' | 'loaded-skill' | 'prompt';
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
  records: readonly import('../../session/record-contract.js').SessionRecord[]
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

/** A committed GC may be newer than its sidecar after an interruption. In
 * that case recover only loaded Skills, and only from the same Compact epoch. */
export function recoverLoadedSkillEntries(
  previous: ContextualWorldState | undefined,
  records: readonly import('../../session/record-contract.js').SessionRecord[]
): ContextualWorldState['entries'] {
  if (!previous) return [];
  const latestGc = records.findLastIndex((record) => record.type === 'context.gc.completed');
  const compact = records.findLastIndex(
    (record) => compactSummaryFromCheckpoint(record) !== undefined
  );
  if (latestGc <= compact) return [];
  const previousGeneration = previous.generation;
  if (
    previousGeneration === undefined
      ? compact !== -1
      : !records
          .slice(Math.max(0, compact), latestGc)
          .some((record) => record.recordId === previousGeneration)
  )
    return [];
  return previous.entries.filter((entry) => entry.kind === 'loaded-skill');
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
    throw new AgentError(
      'MAR_AGENT_EXTENSION_PROMPT_INVALID',
      'Contextual prompt state is invalid.'
    );
  const selected = parsed.data;
  if (new Set(selected.map((part) => part.id)).size !== selected.length)
    throw new AgentError('MAR_AGENT_EXTENSION_PROMPT_CONFLICT', 'Contextual block ids conflict.');
  const changes = contextualChanges(state.promptSnapshot ?? [], selected);
  // Remove legacy catalog bodies from replay while retaining the trusted removal
  // below to revoke a previously sent instruction on continuation chains.
  const legacySkillBody = (entry: ContextualWorldState['entries'][number]) =>
    entry.block?.id === 'core:skill-catalog' && entry.block.operation === 'replace';
  const hasLegacySkillBody = state.entries.some(legacySkillBody);
  if (!changes.length && state.promptSnapshot !== undefined && !hasLegacySkillBody) return state;
  return {
    ...state,
    promptSnapshot: selected,
    entries: [
      ...state.entries.filter((entry) => !legacySkillBody(entry)),
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
const MAX_LOADED_SKILLS = 64;
const MAX_LOADED_SKILL_CONTENT_BYTES = 1024 * 1024;
const LOADED_SKILL_ID_PREFIX = 'runtime:loaded-skill:';

/** Check both accepted loads and delivered guidance before admitting a new load. */
export function assertLoadedSkillCapacity(
  entries: readonly ContextualWorldState['entries'][number][],
  pending: ReadonlyMap<string, string>,
  name: string,
  content: string
): void {
  const selected = new Map<string, string>();
  for (const entry of entries)
    if (entry.kind === 'loaded-skill')
      selected.set(entry.block!.id.slice(LOADED_SKILL_ID_PREFIX.length), entry.content);
  for (const [pendingName, body] of pending) selected.set(pendingName, body);
  selected.set(name, content);
  let bytes = 0;
  for (const body of selected.values()) bytes += Buffer.byteLength(JSON.stringify(body));
  if (selected.size > MAX_LOADED_SKILLS || bytes > MAX_LOADED_SKILL_CONTENT_BYTES)
    throw new AgentError(
      'MAR_AGENT_HOST_LIMIT_EXCEEDED',
      'Loaded Skill context exceeds the Session limit. Compact before loading more Skills.'
    );
}

export function updateLoadedSkillWorldState(
  state: ContextualWorldState,
  index: number,
  loads: ReadonlyMap<string, string>
): ContextualWorldState {
  const entries = new Map(
    state.entries
      .filter((entry) => entry.kind === 'loaded-skill')
      .map((entry) => [entry.block!.id, entry] as const)
  );
  const replacements: ContextualWorldState['entries'] = [];
  for (const [name, content] of loads) {
    const id = `${LOADED_SKILL_ID_PREFIX}${name}`;
    if (entries.get(id)?.content === content) continue;
    replacements.push({
      index,
      kind: 'loaded-skill',
      content,
      block: contextualBlock(
        { id, source: 'runtime', authority: 'context', content },
        'loaded-skill'
      )
    });
  }
  if (!replacements.length) return state;
  const replaced = new Set(replacements.map((entry) => entry.block!.id));
  return {
    ...state,
    entries: [
      ...state.entries.filter(
        (entry) => entry.kind !== 'loaded-skill' || !replaced.has(entry.block!.id)
      ),
      ...replacements
    ]
  };
}

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
        entry.kind !== 'skills' &&
        entry.kind !== 'loaded-skill' &&
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
      (entry.kind === 'prompt' && !block?.success) ||
      (entry.kind === 'loaded-skill' &&
        (!block?.success ||
          block.data.kind !== 'loaded-skill' ||
          !block.data.id.startsWith(LOADED_SKILL_ID_PREFIX) ||
          block.data.source !== 'runtime' ||
          block.data.authority !== 'context' ||
          block.data.operation !== 'replace'))
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
    skillSnapshot: typeof record.skillSnapshot === 'string' ? record.skillSnapshot : undefined,
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
  store: Pick<import('../../session/store/contracts.js').SessionStore, 'writeContextualWorldState'>,
  sessionId: string,
  state: ContextualWorldState
): Promise<void> {
  if (state.entries.length > MAX_CONTEXTUAL_WORLD_STATE_ENTRIES)
    throw new AgentError(
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
    skillSnapshot: state.skillSnapshot ?? null,
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
