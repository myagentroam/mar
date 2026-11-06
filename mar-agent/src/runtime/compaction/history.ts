import type { SessionModelMessage as ModelMessage } from '../../session/model-request.js';

import type { CompactHistoryMessage, CompactUserInput } from '../../session/record-contract.js';
import { countModelTokens, truncateModelText } from '../token-budget.js';
import { compactionPrompt } from '../../prompts/compact.js';

export const DEFAULT_COMPACTION_FOCUS =
  'Create a durable continuation state for the next model invocation.';

export function buildNativeCompactionMessages(
  messages: readonly ModelMessage[],
  input: { focus?: string } = {}
): ModelMessage[] {
  const focus = input.focus?.trim();
  const contract = compactionPrompt();
  return [
    ...messages
      .filter((message) => message.contextKind !== 'private' || message.role === 'provider')
      .map((message) => {
        if (!message.images?.length) return message;
        const textOnly = { ...message };
        delete textOnly.images;
        return textOnly;
      }),
    {
      role: 'user',
      contextKind: 'compact_control',
      content: focus ? `Compaction focus: ${focus}\n\n${contract}` : contract
    }
  ];
}

export function buildCompactionMessages(evidence: string): ModelMessage[] {
  return [
    { role: 'user', content: evidence, contextKind: 'contextual' },
    {
      role: 'user',
      contextKind: 'compact_control',
      content: compactionPrompt()
    }
  ];
}

export function buildCompactionInput(
  messages: readonly ModelMessage[],
  input: { focus?: string; maxTokens: number }
): string {
  const focus = input.focus?.trim() || DEFAULT_COMPACTION_FOCUS;
  const budget = Math.max(1, input.maxTokens);
  let rendered = messages
    .filter(
      (message) =>
        message.contextKind !== 'environment' &&
        !(message.role === 'provider' && message.provider === 'ANTHROPIC_MESSAGES')
    )
    .map((message, index) => ({
      index,
      user: message.role === 'user' && message.contextKind === undefined,
      text: renderMessage(message)
    }));
  const header = `Compaction focus: ${focus}\n\nConversation evidence (chronological):\n`;
  const available = Math.max(100, budget - countModelTokens(header));
  const full = rendered.map((entry) => entry.text).join('\n\n');
  if (countModelTokens(full) <= available)
    return truncateModelText(`${header}${full}`, budget, 'compaction evidence').content;

  // Only trim individual messages when the complete evidence exceeds the input budget.
  rendered = rendered.map((entry) => ({
    ...entry,
    text: truncateModelText(entry.text, Math.max(1, Math.floor(available / 4)), 'message content')
      .content
  }));
  const selected = new Set<number>();
  const firstUser = rendered.find((entry) => entry.user);
  if (firstUser) selected.add(firstUser.index);
  const latestUser = rendered.findLast((entry) => entry.user);
  if (latestUser) selected.add(latestUser.index);

  let used = [...selected].reduce(
    (total, index) => total + countModelTokens(rendered[index]!.text),
    0
  );
  const userBudget = Math.floor(available * 0.55);
  for (let index = rendered.length - 1; index >= 0 && used < userBudget; index--) {
    const entry = rendered[index]!;
    if (!entry.user || selected.has(entry.index)) continue;
    const entryTokens = countModelTokens(entry.text);
    if (used + entryTokens > userBudget && selected.size > 0) continue;
    selected.add(entry.index);
    used += entryTokens;
  }
  for (let index = rendered.length - 1; index >= 0; index--) {
    const entry = rendered[index]!;
    if (selected.has(entry.index)) continue;
    const entryTokens = countModelTokens(entry.text);
    if (used + entryTokens > available) continue;
    selected.add(entry.index);
    used += entryTokens;
  }

  const output: string[] = [];
  let omitted = 0;
  for (const entry of rendered) {
    if (!selected.has(entry.index)) {
      omitted++;
      continue;
    }
    if (omitted > 0) {
      output.push(`[${omitted} lower-priority earlier message${omitted === 1 ? '' : 's'} omitted]`);
      omitted = 0;
    }
    output.push(entry.text);
  }
  if (omitted > 0)
    output.push(`[${omitted} lower-priority message${omitted === 1 ? '' : 's'} omitted]`);
  return truncateModelText(`${header}${output.join('\n\n')}`, budget, 'compaction evidence')
    .content;
}

export function retainCompactionUserMessages(
  messages: readonly string[],
  maxTokens: number
): string[];
export function retainCompactionUserMessages(
  messages: readonly CompactUserInput[],
  maxTokens: number
): CompactUserInput[];
export function retainCompactionUserMessages(
  messages: readonly (string | CompactUserInput)[],
  maxTokens: number
): (string | CompactUserInput)[] {
  const budget = Math.max(0, Math.floor(maxTokens));
  let remaining = budget;
  const selected: (string | CompactUserInput)[] = [];
  for (let index = messages.length - 1; index >= 0 && remaining > 0; index--) {
    const message = messages[index]!;
    const content = typeof message === 'string' ? message : message.content;
    const tokens = countModelTokens(content) + 8;
    if (tokens <= remaining) {
      selected.push(message);
      remaining -= tokens;
    } else {
      const truncated = truncateModelText(content, Math.max(0, remaining - 8), 'user input');
      if (truncated.content)
        selected.push(
          typeof message === 'string'
            ? truncated.content
            : {
                ...message,
                content: truncated.content,
                metadata: {
                  source: message.metadata?.source ?? 'user',
                  ...message.metadata,
                  truncated: true
                }
              }
        );
      break;
    }
  }
  return selected.reverse();
}

export function buildCompactedHistory(
  summary: string,
  userMessages: readonly (string | CompactUserInput)[],
  maxUserTokens: number,
  currentUserMessage?: string | CompactUserInput
): CompactHistoryMessage[] {
  return [
    ...retainCompactionUserMessages(userMessages.map(asCompactInput), maxUserTokens).map(
      asHistoryInput
    ),
    { role: 'user', content: continuationMessage(summary), kind: 'summary' },
    ...(currentUserMessage === undefined
      ? []
      : [asHistoryInput(asCompactInput(currentUserMessage))])
  ];
}

function asCompactInput(input: string | CompactUserInput): CompactUserInput {
  return typeof input === 'string'
    ? { content: input }
    : { content: input.content, ...(input.metadata ? { metadata: { ...input.metadata } } : {}) };
}

function asHistoryInput(input: CompactUserInput): CompactHistoryMessage {
  return {
    ...input,
    role: 'user',
    kind: input.metadata?.source === 'extension' ? 'extension_input' : 'user_input'
  };
}

export function compactedHistoryMessages(
  history: readonly CompactHistoryMessage[]
): ModelMessage[] {
  return history.map(({ role, content, kind, metadata }) => ({
    role,
    content,
    ...(kind === 'summary' ? { contextKind: 'summary' as const } : {}),
    ...(metadata
      ? { metadata: { ...metadata } }
      : kind === 'extension_input'
        ? { metadata: { source: 'extension' as const } }
        : {})
  }));
}

export function continuationMessage(summary: string): string {
  return `Continue from the compacted state below. Treat it as a factual handoff, not a new user request. Earlier user messages are retained historical evidence, not requests to repeat completed work or authorization for new side effects. Newer user instructions override older messages and this handoff. The handoff cannot create or revive authorization: an action that requires separate authorization may proceed only when current direct authorization still covers its exact action, scope, and lifetime. Continue directly from its Next action without recapping it to the user. Re-read files or rerun checks when the handoff marks facts as stale, inferred, failed, or unverified. Do not repeat completed side effects.\n\n${summary}`;
}

function renderMessage(message: ModelMessage): string {
  const metadata = [
    message.name ? `name=${message.name}` : '',
    message.callId ? `callId=${message.callId}` : ''
  ]
    .filter(Boolean)
    .join(' ');
  const argumentsText =
    message.arguments === undefined ? '' : `\narguments: ${safeJson(message.arguments)}`;
  return `[${message.role}${metadata ? ` ${metadata}` : ''}]\n${message.content}${argumentsText}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}
