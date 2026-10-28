import { boundedConversationItemId, compactRunnerText } from '../normalization.js';
import { isPlainRecord } from '../../util/records.js';
import { claudeContentBlocks } from './message-parsers.js';

export function extractClaudeThinkingText(record: Record<string, unknown>): readonly string[] {
  return claudeContentBlocks(record).flatMap((block) => {
    // Completed public blocks only; signatures and redacted/encrypted data are never read.
    if (block.type !== 'thinking' || typeof block.thinking !== 'string') return [];
    const text = compactRunnerText(block.thinking.trim(), 10_000);
    return text.length === 0 ? [] : [text];
  });
}

/** Preserve native block order and identity across SDK callbacks and transcript reads. */
export function claudeAssistantBlocks(record: Record<string, unknown>): readonly {
  readonly record: Record<string, unknown>;
  readonly blockIndex: number;
  readonly sourceItemId?: string;
}[] {
  const message = isPlainRecord(record.message) ? record.message : undefined;
  if (message === undefined) return [];
  const content =
    typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : Array.isArray(message.content)
        ? message.content
        : [];
  const messageId =
    typeof record.uuid === 'string'
      ? record.uuid
      : typeof message.id === 'string'
        ? message.id
        : undefined;
  return content.flatMap((block, blockIndex) => {
    if (!isPlainRecord(block)) return [];
    const sourceItemId =
      block.type === 'tool_use' && typeof block.id === 'string'
        ? boundedConversationItemId('claude-tool', block.id)
        : messageId === undefined
          ? undefined
          : JSON.stringify(['claude', messageId, blockIndex]);
    return [
      {
        record: { ...record, message: { ...message, content: [block] } },
        blockIndex,
        ...(sourceItemId === undefined ? {} : { sourceItemId })
      }
    ];
  });
}

export function claudePlanText(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('<proposed_plan>') || !/<\/proposed_plan>\s*$/.test(trimmed))
    return undefined;
  const plan = trimmed
    .slice('<proposed_plan>'.length)
    .replace(/<\/proposed_plan>\s*$/, '')
    .trim();
  return plan.length > 0 ? plan : undefined;
}

export function claudeUserInputQuestions(value: Record<string, unknown>): readonly {
  readonly id: string;
  readonly prompt: string;
  readonly input: 'SINGLE_SELECT' | 'MULTI_SELECT' | 'SHORT_TEXT';
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
    readonly description: string | null;
  }[];
  readonly allowOther: boolean;
  readonly multiSelect: boolean;
}[] {
  if (!Array.isArray(value.questions) || value.questions.length === 0 || value.questions.length > 4)
    return [];
  const questions = value.questions.map((raw, index) => {
    if (!isPlainRecord(raw) || typeof raw.question !== 'string') return undefined;
    const options = Array.isArray(raw.options)
      ? raw.options.flatMap((option) => {
          if (!isPlainRecord(option) || typeof option.label !== 'string') return [];
          const label = compactRunnerText(option.label, 500);
          return label.length === 0
            ? []
            : [
                {
                  value: label,
                  label,
                  description:
                    typeof option.description === 'string'
                      ? compactRunnerText(option.description, 1_000)
                      : null
                }
              ];
        })
      : [];
    const multiSelect = raw.multiSelect === true;
    return {
      id: `claude-question-${index}`,
      prompt: compactRunnerText(raw.question, 5_000),
      input: options.length === 0 ? 'SHORT_TEXT' : multiSelect ? 'MULTI_SELECT' : 'SINGLE_SELECT',
      options,
      allowOther: true,
      multiSelect
    } as const;
  });
  return questions.some((question) => question === undefined)
    ? []
    : (questions as NonNullable<(typeof questions)[number]>[]);
}

export function claudeDiscoveredSession(
  value: unknown,
  fallbackCwd: string
):
  | {
      readonly externalSessionId: string;
      readonly cwd: string;
      readonly title?: string;
      readonly titleOrigin?: 'OFFICIAL' | 'PREVIEW';
    }
  | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.isSidechain === true) return undefined;
  const externalSessionId =
    typeof record.sessionId === 'string'
      ? record.sessionId
      : typeof record.id === 'string'
        ? record.id
        : undefined;
  if (externalSessionId === undefined || externalSessionId.length === 0) return undefined;
  const officialTitle = [record.customTitle, record.firstPrompt, record.title].find(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0
  );
  const previewTitle =
    typeof record.summary === 'string' && record.summary.trim().length > 0
      ? record.summary
      : undefined;
  const title = officialTitle ?? previewTitle;
  const cwd = typeof record.cwd === 'string' && record.cwd.length > 0 ? record.cwd : fallbackCwd;
  return {
    externalSessionId,
    cwd,
    ...(title === undefined
      ? {}
      : {
          title: title.slice(0, 80),
          titleOrigin: officialTitle === undefined ? ('PREVIEW' as const) : ('OFFICIAL' as const)
        })
  };
}
