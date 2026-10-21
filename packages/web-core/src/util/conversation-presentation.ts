export { userInputQuestions } from './conversation-user-input.js';
import { fileChangeDiffSchema } from '@myagentroam/protocol';
import { conversationPayload } from './conversation-history.js';
import type { Approval, ConversationItem } from '../model/workbench.js';
import { translate } from '../service/LocalePreferenceService.js';
import { composerMessagePresentation } from './composer-message.js';
import {
  toolPresentation,
  toolPresentationTitle,
  toolPresentationText,
  toolPresentationDetails
} from './tool-presentation.js';

export type ConversationDisplayItem =
  | { readonly type: 'item'; readonly id: string; readonly item: ConversationItem }
  | {
      readonly type: 'image_generation';
      readonly id: string;
      readonly item: ConversationItem;
    }
  | {
      readonly type: 'reasoning_group';
      readonly id: string;
      readonly items: readonly ConversationItem[];
      readonly text: string;
      readonly completed: boolean;
    }
  | {
      readonly type: 'tool_group';
      readonly id: string;
      readonly items: readonly ConversationItem[];
    }
  | {
      readonly type: 'subagent_group';
      readonly id: string;
      readonly items: readonly ConversationItem[];
    }
  | {
      readonly type: 'command_group';
      readonly id: string;
      readonly items: readonly ConversationItem[];
    }
  | {
      readonly type: 'file_change_group';
      readonly id: string;
      readonly items: readonly ConversationItem[];
    };

export interface FileChangeEntry {
  readonly sourceId?: string;
  readonly changeId?: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly diff?: import('@myagentroam/protocol').FileChangeDiff;
  readonly path: string;
  readonly change: string;
  readonly status: string;
}

const nodeMessageKeysByCanonicalText: Readonly<Record<string, string>> = {
  'Image generation completed': 'nodeMessages.imageGenerationCompleted',
  'Image generation failed': 'nodeMessages.imageGenerationFailed',
  '[Image content filtered]': 'nodeMessages.imageContentFiltered',
  '(Unable to display)': 'nodeMessages.unavailable',
  'Context compacted': 'nodeMessages.contextCompacted',
  '(No command provided)': 'nodeMessages.commandMissing',
  Searching: 'nodeMessages.searching',
  'Generating image': 'nodeMessages.generatingImage',
  'Image generated': 'nodeMessages.imageGenerated',
  '[Image content extracted]': 'nodeMessages.imageContentExtracted',
  'OpenCode applied the patch': 'nodeMessages.patchApplied'
};

const nodeMessageKeysByCode: Readonly<Record<string, string>> = {
  TOOL_RUNNING_WITH_DURATION: 'nodeMessages.toolRunning',
  TOOL_RUNNING: 'nodeMessages.toolRunningNoDuration',
  CONTEXT_COMPACTED: 'nodeMessages.contextCompacted',
  SEARCHING: 'nodeMessages.searching',
  GENERATING_IMAGE: 'nodeMessages.generatingImage',
  IMAGE_GENERATION_COMPLETED: 'nodeMessages.imageGenerationCompleted',
  OPENCODE_PATCH_APPLIED: 'nodeMessages.patchApplied'
};

export function stringField(value: Record<string, unknown>, key: string): string {
  const messageCode = value[`${key}Code`];
  const codeKey = typeof messageCode === 'string' ? nodeMessageKeysByCode[messageCode] : undefined;
  if (codeKey !== undefined) {
    const rawParameters = value[`${key}Parameters`];
    const parameters =
      typeof rawParameters === 'object' && rawParameters !== null && !Array.isArray(rawParameters)
        ? Object.fromEntries(
            Object.entries(rawParameters).filter(
              (entry): entry is [string, string | number] =>
                typeof entry[1] === 'string' || typeof entry[1] === 'number'
            )
          )
        : undefined;
    return translate(codeKey, parameters);
  }
  const messageKey = value[`${key}Key`];
  if (typeof messageKey === 'string' && messageKey.startsWith('nodeMessages.')) {
    const rawParameters = value[`${key}Parameters`];
    const parameters =
      typeof rawParameters === 'object' && rawParameters !== null && !Array.isArray(rawParameters)
        ? Object.fromEntries(
            Object.entries(rawParameters).filter(
              (entry): entry is [string, string | number] =>
                typeof entry[1] === 'string' || typeof entry[1] === 'number'
            )
          )
        : undefined;
    return translate(messageKey, parameters);
  }
  const text = typeof value[key] === 'string' ? (value[key] as string).trim() : '';
  const canonicalKey = nodeMessageKeysByCanonicalText[text];
  return canonicalKey === undefined ? text : translate(canonicalKey);
}

function reasoningSections(value: Record<string, unknown>): string[] {
  return (Array.isArray(value.sections) ? value.sections : [])
    .map((section) =>
      typeof section === 'object' && section !== null
        ? stringField(section as Record<string, unknown>, 'text')
        : ''
    )
    .filter(Boolean);
}

function formatDetail(label: string, value: string): string {
  return value.length === 0 ? '' : translate('presentation.detailLine', { label, value });
}

function groupType(
  item: ConversationItem | undefined
):
  | 'reasoning_group'
  | 'tool_group'
  | 'subagent_group'
  | 'command_group'
  | 'file_change_group'
  | undefined {
  if (item === undefined) return undefined;
  if (item.permissionStop !== undefined) return undefined;
  if (item.kind === 'reasoning_summary') return 'reasoning_group';
  if (item.kind === 'command_execution') return 'command_group';
  if (item.kind === 'file_change') return 'file_change_group';
  if (item.kind === 'tool_call' && isSubagentToolCall(conversationPayload(item.payload)))
    return 'subagent_group';
  if (
    item.kind === 'tool_call' &&
    !isSubagentToolCall(conversationPayload(item.payload)) &&
    toolPresentation(item.payload) === undefined &&
    !isImageGenerationItem(item)
  )
    return 'tool_group';
  return undefined;
}

function isImageGenerationItem(item: ConversationItem): boolean {
  if (item.kind !== 'tool_call') return false;
  const value = conversationPayload(item.payload);
  return value !== undefined && !isSubagentToolCall(value) && isImageGenerationPayload(value);
}

function groupedDisplayItems(
  items: readonly ConversationItem[],
  reasoningCompleted = false
): ConversationDisplayItem[] {
  const normalizedItems = mergeConsecutiveAssistantItems(items);
  const grouped = new Map<string, ConversationItem[]>();
  const groupKey = (
    item: ConversationItem,
    type: NonNullable<ReturnType<typeof groupType>>
  ): string => {
    if (type !== 'subagent_group') return type;
    const payload = conversationPayload(item.payload);
    const agentId = payload === undefined ? '' : stringField(payload, 'subagentId');
    return JSON.stringify([type, agentId ? 'agent' : 'call', agentId || item.id]);
  };
  for (const item of normalizedItems) {
    const type = groupType(item);
    if (type === undefined) continue;
    const key = groupKey(item, type);
    const values = grouped.get(key) ?? [];
    values.push(item);
    grouped.set(key, values);
  }
  const displayItems: ConversationDisplayItem[] = [];
  for (const item of normalizedItems) {
    const currentGroupType = groupType(item);
    if (currentGroupType !== undefined) {
      const groupItems = grouped.get(groupKey(item, currentGroupType));
      const first = groupItems?.[0];
      // Anchor at the latest member, but keep the first member's ID for disclosure state.
      if (first === undefined || groupItems?.at(-1) !== item) continue;
      if (currentGroupType === 'reasoning_group') {
        displayItems.push({
          type: currentGroupType,
          id: first.id,
          items: groupItems,
          completed: reasoningCompleted,
          text: groupItems
            .flatMap((member) => {
              const payload = conversationPayload(member.payload);
              return payload === undefined ? [] : reasoningSections(payload);
            })
            .join('\n\n')
        });
      } else {
        displayItems.push({ type: currentGroupType, id: first.id, items: groupItems });
      }
      continue;
    }
    if (item.permissionStop === undefined && isImageGenerationItem(item)) {
      displayItems.push({
        type: 'image_generation',
        id: item.id,
        item
      });
      continue;
    }
    displayItems.push({
      type: 'item',
      id: item.id,
      item
    });
  }
  return displayItems;
}

function mergeAssistantItems(items: readonly ConversationItem[]): ConversationItem {
  const first = items[0];
  const last = items.at(-1);
  if (first === undefined || last === undefined) throw new Error('ASSISTANT_ITEMS_EMPTY');
  if (items.length === 1) return first;
  const firstPayload = conversationPayload(first.payload) ?? {};
  const lastPayload = conversationPayload(last.payload) ?? {};
  const text = items
    .map((item) => {
      const payload = conversationPayload(item.payload);
      return payload !== undefined && typeof payload.text === 'string' ? payload.text : '';
    })
    .filter((text) => text.trim().length > 0)
    .join('\n\n');
  return {
    ...first,
    status: last.status,
    payload: { ...firstPayload, ...lastPayload, text },
    ...(last.completedAt === undefined ? {} : { completedAt: last.completedAt })
  };
}

function mergeConsecutiveAssistantItems(
  items: readonly ConversationItem[]
): readonly ConversationItem[] {
  const normalized: ConversationItem[] = [];
  let assistants: ConversationItem[] = [];
  const flush = (): void => {
    if (assistants.length === 0) return;
    normalized.push(mergeAssistantItems(assistants));
    assistants = [];
  };
  for (const item of items) {
    if (item.kind === 'assistant_message') {
      assistants.push(item);
      continue;
    }
    flush();
    normalized.push(item);
  }
  flush();
  return normalized;
}

export function conversationDisplayItems(
  items: readonly ConversationItem[]
): readonly ConversationDisplayItem[] {
  const displayItems: ConversationDisplayItem[] = [];
  let current: ConversationItem[] = [];
  const compactionsAtAnchor = new Map<number, ConversationItem[]>();
  const relocatedCompactionIds = new Set<string>();
  items.forEach((item, index) => {
    if (item.kind !== 'context_compaction') return;
    const payload = conversationPayload(item.payload);
    const hasExplicitMode = payload?.mode === 'BACKGROUND' || payload?.mode === 'BLOCKING';
    if (!hasExplicitMode) return;
    const anchorItemId = stringField(payload, 'anchorItemId');
    if (anchorItemId.length === 0) return;
    const anchorIndex = items.findIndex((candidate) => candidate.id === anchorItemId);
    if (anchorIndex < 0 || anchorIndex === index) return;
    const anchored = compactionsAtAnchor.get(anchorIndex) ?? [];
    anchored.push(item);
    compactionsAtAnchor.set(anchorIndex, anchored);
    relocatedCompactionIds.add(item.id);
  });
  const flush = (reasoningCompleted = false): void => {
    displayItems.push(...groupedDisplayItems(current, reasoningCompleted));
    current = [];
  };
  const appendCompaction = (item: ConversationItem, anchorResolved: boolean): void => {
    const payload = conversationPayload(item.payload);
    const installed = item.status === 'COMPLETED' && payload?.phase === 'COMPLETED';
    const hasExplicitMode = payload?.mode === 'BACKGROUND' || payload?.mode === 'BLOCKING';
    const reasoningCompleted = hasExplicitMode ? installed && anchorResolved : true;
    flush(reasoningCompleted);
    displayItems.push({ type: 'item', id: item.id, item });
  };
  for (const [index, item] of items.entries()) {
    if (relocatedCompactionIds.has(item.id)) continue;
    if (item.kind === 'context_compaction') {
      appendCompaction(item, false);
      continue;
    }
    if (current.at(-1)?.kind === 'assistant_message' && item.kind !== 'assistant_message') {
      flush(true);
    }
    current.push(item);
    for (const compact of compactionsAtAnchor.get(index) ?? []) appendCompaction(compact, true);
  }
  flush();
  return displayItems;
}

export function reasoningDisclosureOpen(
  previousTurnActive: boolean | undefined,
  turnActive: boolean,
  currentOpen: boolean | undefined
): boolean {
  if (previousTurnActive === undefined) return false;
  if (previousTurnActive && !turnActive) return false;
  return currentOpen ?? false;
}

export function reasoningPreview(text: string): string {
  // GPT reasoning summaries may append Markdown bold headings; show the latest one.
  const heading = [...text.matchAll(/(?:^|\n)[^\S\r\n]*\*\*([^\r\n*]+)\*\*/gu)].at(-1)?.[1]?.trim();
  const latestParagraph =
    text
      .trim()
      .split(/\n\s*\n/u)
      .at(-1) ?? '';
  const firstLine = latestParagraph.split(/\r?\n/u).find((line) => line.trim()) ?? '';
  // Keep the full first line; the subtitle container owns visual truncation.
  return (heading || firstLine).replace(/\s+/g, ' ').trim();
}

export function conversationFileChangeEntries(
  items: readonly ConversationItem[]
): readonly FileChangeEntry[] {
  return items.flatMap((item) => {
    const value = conversationPayload(item.payload);
    const changes = value !== undefined && Array.isArray(value.changes) ? value.changes : [];
    return changes.flatMap((change, index) => {
      if (typeof change !== 'object' || change === null) return [];
      const record = change as Record<string, unknown>;
      const path = stringField(record, 'path');
      const changeKind = stringField(record, 'change');
      return path.length === 0
        ? []
        : [
            {
              path,
              change: changeKind,
              status: fileChangeStatus(changeKind),
              ...(typeof record.changeId === 'string' ? { sourceId: `${item.id}:${index}` } : {}),
              ...(typeof record.changeId === 'string' ? { changeId: record.changeId } : {}),
              ...(Number.isSafeInteger(record.additions) && (record.additions as number) >= 0
                ? { additions: record.additions as number }
                : {}),
              ...(Number.isSafeInteger(record.deletions) && (record.deletions as number) >= 0
                ? { deletions: record.deletions as number }
                : {}),
              ...(fileChangeDiffSchema.safeParse(record.diff).success
                ? { diff: fileChangeDiffSchema.parse(record.diff) }
                : {})
            } satisfies FileChangeEntry
          ];
    });
  });
}

function fileChangeStatus(change: string): string {
  const key = {
    ADDED: 'presentation.fileChangeAdded',
    MODIFIED: 'presentation.fileChangeModified',
    DELETED: 'presentation.fileChangeDeleted',
    RENAMED: 'presentation.fileChangeRenamed',
    COPIED: 'presentation.fileChangeCopied',
    TYPE_CHANGED: 'presentation.fileChangeTypeChanged'
  }[change];
  return key === undefined ? '' : translate(key);
}

export function composerMessageSource(input: ReturnType<typeof composerMessagePresentation>) {
  const origin = input.sessionOrigin;
  if (origin !== undefined) {
    if (origin.sessionId !== undefined && origin.name !== undefined)
      return {
        label: translate('generated.conversationPresentation.messageFromSource', {
          name: origin.name
        }),
        title: translate('generated.conversationPresentation.sessionSourceDetails', {
          sessionId: origin.sessionId
        })
      };
    return {
      label: translate('generated.conversationPresentation.messageFromMarctl'),
      title: undefined
    };
  }
  if (input.channel !== undefined)
    return {
      label: translate('generated.conversationPresentation.messageFromSource', {
        name: input.channel.name
      }),
      title: translate('generated.conversationPresentation.webShareSourceDetails')
    };
  return undefined;
}

export function conversationItemLabel(kind: string, payload?: unknown): string {
  if (kind === 'user_message') {
    const input = composerMessagePresentation(payload);
    const source = composerMessageSource(input);
    if (source !== undefined) return source.label;
    const labels: string[] = [];
    if (input.restarted) labels.push(translate('presentation.systemRestart'));
    if (input.scheduled) labels.push(translate('generated.scheduledSession.title'));
    if (input.goal === 'start')
      labels.push(translate('generated.conversationPresentation.goalStart'));
    if (input.goal === 'continue')
      labels.push(translate('generated.conversationPresentation.goalContinue'));
    if (labels.length > 0) return labels.join(' · ');
  }
  if (kind === 'tool_call') {
    const value = conversationPayload(payload);
    const title = toolPresentationTitle(payload);
    if (title) return title;
    if (value !== undefined && !isSubagentToolCall(value) && isImageGenerationPayload(value))
      return translate('presentation.imageGeneration');
    if (isSubagentToolCall(value)) return translate('generated.conversationPresentation.subagent');
  }
  return (
    {
      user_message: translate('generated.conversationPresentation.you'),
      assistant_message: 'Agent',
      reasoning_summary: translate('generated.conversationPresentation.reasoning'),
      plan: translate('generated.conversationPresentation.plan'),
      todo_list: translate('generated.conversationPresentation.taskList'),
      tool_call: translate('generated.conversationPresentation.tool'),
      command_execution: translate('generated.conversationPresentation.command'),
      file_change: translate('generated.conversationPresentation.fileChanges'),
      approval: translate('generated.conversationPresentation.confirmationRequired'),
      user_input_request: translate('generated.conversationPresentation.inputRequired'),
      context_compaction: translate('generated.conversationPresentation.contextCompaction'),
      unknown: translate('generated.conversationPresentation.agentEvent'),
      warning: translate('generated.conversationPresentation.notice'),
      error: translate('generated.conversationPresentation.error')
    }[kind] ?? ''
  );
}

export function conversationItemText(
  kind: string,
  payload: unknown,
  status?: ConversationItem['status']
): string {
  const value = conversationPayload(payload);
  if (value === undefined) return '';
  if (kind === 'user_message') {
    const input = composerMessagePresentation(payload);
    return input.restarted ? translate('presentation.systemRestartMessage') : input.text;
  }
  if (kind === 'reasoning_summary') {
    return status === 'PENDING' || status === 'IN_PROGRESS'
      ? translate('generated.conversationPresentation.thinking')
      : translate('generated.conversationPresentation.thoughtCompleted');
  }
  if (kind === 'tool_call') {
    if (!isSubagentToolCall(value) && isImageGenerationPayload(value)) {
      if (status === 'PENDING' || status === 'IN_PROGRESS')
        return translate('nodeMessages.generatingImage');
      if (status === 'FAILED') return translate('nodeMessages.imageGenerationFailed');
      if (status === 'CANCELLED' || status === 'INTERRUPTED')
        return translate('generated.conversationPresentation.stopped');
      return translate('nodeMessages.imageGenerationCompleted');
    }
    if (toolPresentation(payload)) return toolPresentationText(payload, status ?? 'COMPLETED');
    const toolName = stringField(value, 'toolName');
    const title = stringField(value, 'title');
    const operation = subagentOperation(value);
    if (operation !== undefined) {
      const taskTitle = subagentTaskTitle(value);
      return [subagentOperationText(value), taskTitle].filter(Boolean).join(' ');
    }
    if (toolName.length > 0) return toolName;
    if (title.length > 0) return title;
    return stringField(value, 'namespace');
  }
  if (kind === 'command_execution') {
    const command = stringField(value, 'command');
    if (command.length > 0) return command;
    return stringField(value, 'outputPreview').length > 0 ||
      stringField(value, 'cwd').length > 0 ||
      typeof value.exitCode === 'number'
      ? translate('generated.conversationPresentation.commandExecution')
      : '';
  }
  if (kind === 'user_input_request') {
    const questions = Array.isArray(value.questions) ? value.questions : [];
    return questions.length === 0
      ? translate('generated.conversationPresentation.answersSubmitted')
      : translate('generated.conversationPresentation.questionsAwaitAnswers', {
          value0: questions.length
        });
  }
  if (kind === 'file_change') {
    const changes = Array.isArray(value.changes) ? value.changes : [];
    return changes.length === 0
      ? ''
      : translate('generated.conversationPresentation.fileChanges2', { value0: changes.length });
  }
  if (kind === 'todo_list') {
    const items = Array.isArray(value.items) ? value.items : [];
    return items.length === 0
      ? ''
      : translate('generated.conversationPresentation.taskListItems', { value0: items.length });
  }
  if (kind === 'plan') {
    const explanation = stringField(value, 'explanation');
    if (explanation.length > 0) return explanation;
    const steps = Array.isArray(value.steps) ? value.steps : [];
    return steps.length === 0
      ? ''
      : translate('generated.conversationPresentation.planItems', { value0: steps.length });
  }
  if (kind === 'context_compaction') {
    if (status === 'PENDING' || status === 'IN_PROGRESS') {
      if (stringField(value, 'stage') === 'WAITING')
        return translate('generated.conversationPresentation.contextCompactionWaiting');
      if (stringField(value, 'stage') === 'READY')
        return translate('generated.conversationPresentation.contextCompactionReady');
      if (stringField(value, 'mode') === 'BACKGROUND')
        return translate('generated.conversationPresentation.contextCompactionBackground');
      return translate('nodeMessages.contextCompacting');
    }
    if (status === 'FAILED')
      return typeof value.code === 'string'
        ? translate('generated.conversationPresentation.contextCompactionFailed')
        : translate('generated.conversationPresentation.failed');
    if (status === 'CANCELLED' || status === 'INTERRUPTED')
      return typeof value.code === 'string'
        ? translate('generated.conversationPresentation.contextCompactionCancelled')
        : translate('generated.conversationPresentation.stopped');
    return stringField(value, 'summary') || translate('nodeMessages.contextCompacted');
  }
  if (kind === 'error') {
    const error = conversationErrorPresentation(payload);
    return (
      error.message ||
      error.code ||
      (error.httpStatus === null
        ? ''
        : translate('generated.conversationPresentation.httpStatus', {
            value0: error.httpStatus
          }))
    );
  }
  if (kind === 'unknown')
    return (
      stringField(value, 'label') ||
      translate('generated.conversationPresentation.unrecognizedAgentEvent')
    );
  for (const key of ['text', 'content', 'summary', 'message', 'command', 'reason']) {
    const text = stringField(value, key);
    if (text.length > 0) return text;
  }
  return '';
}

export function conversationItemDetail(kind: string, payload: unknown): string {
  const value = conversationPayload(payload);
  if (value === undefined) return '';
  if (kind === 'error') return '';
  if (kind === 'reasoning_summary') return reasoningSections(value).join('\n\n');
  if (kind === 'tool_call' && isSubagentToolCall(value)) return subagentToolDetail(value);
  if (kind === 'tool_call' && toolPresentation(payload)) return toolPresentationDetails(payload);
  if (kind === 'tool_call')
    return [
      !isSubagentToolCall(value) && stringField(value, 'title') !== stringField(value, 'toolName')
        ? formatDetail(translate('presentation.detail'), stringField(value, 'title'))
        : '',
      formatDetail(translate('presentation.input'), stringField(value, 'inputSummary')),
      formatDetail(translate('presentation.output'), stringField(value, 'outputSummary')),
      formatDetail(translate('presentation.progress'), stringField(value, 'progressLabel')),
      formatDetail(translate('presentation.error'), stringField(value, 'errorCode'))
    ]
      .filter(Boolean)
      .join('\n');
  if (kind === 'command_execution')
    return [
      formatDetail(translate('presentation.workingDirectory'), stringField(value, 'cwd')),
      formatDetail(translate('presentation.output'), stringField(value, 'outputPreview')),
      typeof value.exitCode === 'number'
        ? translate('presentation.exitCode', { value: value.exitCode })
        : ''
    ]
      .filter(Boolean)
      .join('\n');
  if (kind === 'file_change')
    return (Array.isArray(value.changes) ? value.changes : [])
      .map((change) => {
        if (typeof change !== 'object' || change === null) return '';
        const item = change as Record<string, unknown>;
        const path = stringField(item, 'path');
        const status = stringField(item, 'change');
        return path.length === 0 ? '' : status.length === 0 ? path : `${status} · ${path}`;
      })
      .filter(Boolean)
      .join('\n');
  for (const key of ['outputPreview', 'outputSummary', 'inputSummary', 'reason', 'message']) {
    const text = stringField(value, key);
    if (text.length > 0 && text !== conversationItemText(kind, payload)) return text;
  }
  return '';
}

export interface ConversationErrorPresentation {
  readonly code: string;
  readonly httpStatus: number | null;
  readonly message: string;
}

export function conversationErrorPresentation(payload: unknown): ConversationErrorPresentation {
  const value = conversationPayload(payload);
  if (value === undefined) return { code: '', httpStatus: null, message: '' };
  const candidate = value.httpStatus;
  const httpStatus =
    typeof candidate === 'number' &&
    Number.isInteger(candidate) &&
    candidate >= 100 &&
    candidate <= 599
      ? candidate
      : null;
  const code = stringField(value, 'code');
  const message = stringField(value, 'message');
  return {
    code,
    httpStatus,
    message:
      code === 'subscription_sharing_usage_limit_exceeded'
        ? [translate('errors.subscription_sharing_usage_limit_exceeded'), message]
            .filter(Boolean)
            .join('\n')
        : message
  };
}

export function conversationErrorCodeVisible(error: ConversationErrorPresentation): boolean {
  return error.code.length > 0 && error.code !== `HTTP_${error.httpStatus}`;
}

function isSubagentToolCall(value: Record<string, unknown> | undefined): boolean {
  return subagentOperation(value) !== undefined;
}

function isImageGenerationPayload(value: Record<string, unknown>): boolean {
  return value.toolCategory === 'IMAGE_GENERATION';
}

function subagentOperation(
  value: Record<string, unknown> | undefined
): 'START' | 'STATUS' | 'CANCEL' | 'MESSAGE' | 'RESUME' | undefined {
  const operation = value?.subagentOperation;
  return operation === 'START' ||
    operation === 'STATUS' ||
    operation === 'CANCEL' ||
    operation === 'MESSAGE' ||
    operation === 'RESUME'
    ? operation
    : undefined;
}

export function subagentOperationText(payload: unknown): string {
  const value = conversationPayload(payload);
  const operation = subagentOperation(value);
  if (operation === undefined) return '';
  return translate(
    `presentation.subagentOperation.${operation === 'STATUS' && value?.subagentWait === true ? 'WAIT' : operation}`
  );
}

export function subagentGroupText(items: readonly ConversationItem[]): string {
  const latest = items.at(-1);
  if (latest === undefined) return '';
  const named = [...items].reverse().find((item) => {
    const value = conversationPayload(item.payload);
    return (
      value !== undefined &&
      stringField(value, 'title').length > 0 &&
      stringField(value, 'title').toLowerCase() !== stringField(value, 'toolName').toLowerCase()
    );
  });
  const value = conversationPayload((named ?? latest).payload) ?? {};
  return [subagentTaskTitle(value), subagentOperationText(latest.payload)]
    .filter(Boolean)
    .join(' · ');
}

function subagentToolDetail(value: Record<string, unknown>): string {
  const latestMessage = conversationPayload(value.subagentLatestMessage);
  const phase = latestMessage === undefined ? '' : stringField(latestMessage, 'phase');
  return [
    formatDetail(translate('presentation.operation'), subagentOperationText(value)),
    formatDetail(translate('presentation.subagentId'), stringField(value, 'subagentId')),
    formatDetail(translate('presentation.task'), subagentTaskTitle(value)),
    formatDetail(translate('presentation.model'), stringField(value, 'subagentModelName')),
    formatDetail(translate('presentation.modelId'), stringField(value, 'subagentModelId')),
    formatDetail(
      translate('presentation.reasoningEffort'),
      stringField(value, 'subagentReasoningEffort')
    ),
    formatDetail(
      translate('presentation.messagePhase'),
      phase === 'commentary' || phase === 'final_answer'
        ? translate(`presentation.subagentMessagePhase.${phase}`)
        : ''
    ),
    formatDetail(
      translate('presentation.latestMessage'),
      latestMessage === undefined ? '' : stringField(latestMessage, 'text')
    ),
    latestMessage?.truncated === true
      ? formatDetail(translate('presentation.truncated'), translate('presentation.yes'))
      : '',
    formatDetail(translate('presentation.input'), stringField(value, 'inputSummary')),
    formatDetail(translate('presentation.result'), stringField(value, 'outputSummary')),
    formatDetail(translate('presentation.progress'), stringField(value, 'progressLabel')),
    formatDetail(translate('presentation.error'), stringField(value, 'errorCode'))
  ]
    .filter(Boolean)
    .join('\n');
}

function subagentTaskTitle(value: Record<string, unknown>): string {
  const toolName = stringField(value, 'toolName');
  const title = stringField(value, 'title');
  if (title.length > 0 && title.toLowerCase() !== toolName.toLowerCase()) return title;
  return stringField(value, 'subagentId') || toolName || translate('presentation.subagentTask');
}

export interface TaskListEntry {
  readonly text: string;
  readonly status: string;
  readonly tone: 'todo' | 'in-progress' | 'done';
}

export function taskListItems(payload: unknown): readonly TaskListEntry[] {
  const items = conversationPayload(payload)?.items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const value = item as Record<string, unknown>;
    const text = stringField(value, 'text');
    return text.length === 0 ? [] : [{ text, ...taskListStatus(stringField(value, 'status')) }];
  });
}

function taskListStatus(status: string): Omit<TaskListEntry, 'text'> {
  if (status === 'IN_PROGRESS')
    return {
      status: translate('generated.conversationPresentation.taskStatusInProgress'),
      tone: 'in-progress'
    };
  if (status === 'COMPLETED')
    return {
      status: translate('generated.conversationPresentation.taskStatusDone'),
      tone: 'done'
    };
  return {
    status: translate('generated.conversationPresentation.taskStatusTodo'),
    tone: 'todo'
  };
}

export function planSteps(
  payload: unknown
): readonly { readonly text: string; readonly status: string }[] {
  const steps = conversationPayload(payload)?.steps;
  if (!Array.isArray(steps)) return [];
  return steps.flatMap((step) => {
    if (typeof step !== 'object' || step === null) return [];
    const item = step as Record<string, unknown>;
    const text = stringField(item, 'text');
    return text.length === 0 ? [] : [{ text, status: stringField(item, 'status') }];
  });
}

export function approvalStatusLabel(status: Approval['status']): string {
  return {
    PENDING: translate('presentation.approvalPending'),
    APPROVED: translate('presentation.approvalApproved'),
    REJECTED: translate('presentation.approvalRejected'),
    EXPIRED: translate('presentation.approvalExpired')
  }[status];
}

export function approvalToolLabel(approval: Approval): string {
  const payload = conversationPayload(approval.payload);
  for (const key of ['toolName', 'tool', 'method']) {
    const value = payload?.[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return translate('presentation.toolCall');
}

export function approvalDetail(approval: Approval): {
  readonly label: string;
  readonly text: string;
} {
  const payload = conversationPayload(approval.payload);
  const input = payload?.input ?? payload?.params ?? approval.payload;
  return runnerInputDetail(input);
}

export function approvalReason(approval: Approval): string {
  return stringField(conversationPayload(approval.payload) ?? {}, 'reason');
}

export function permissionStopDetail(item: ConversationItem): {
  readonly label: string;
  readonly text: string;
} {
  const payload = conversationPayload(item.payload);
  let input: unknown = payload;
  if (typeof payload?.inputSummary === 'string') {
    input = payload.inputSummary;
    try {
      input = JSON.parse(payload.inputSummary);
    } catch {
      /* Keep bounded text as supplied. */
    }
  }
  return runnerInputDetail(input);
}

function runnerInputDetail(input: unknown): { readonly label: string; readonly text: string } {
  const detail = runnerInputBody(input);
  const cwd = conversationPayload(input)?.cwd;
  const text =
    typeof cwd === 'string' && cwd.length > 0
      ? `${detail.text}\n\n${translate('presentation.workingDirectory')}: ${cwd}`
      : detail.text;
  return {
    ...detail,
    text:
      text.length > 64 * 1024
        ? `${text.slice(0, 64 * 1024)}\n${translate('presentation.truncated')}`
        : text
  };
}

function runnerInputBody(input: unknown): { readonly label: string; readonly text: string } {
  const record = conversationPayload(input);
  if (typeof record?.code === 'string')
    return { label: translate('permissionStop.code'), text: record.code };
  for (const key of ['command', 'cmd', 'commandLine', 'script']) {
    const command = record?.[key];
    if (typeof command === 'string' && command.trim().length > 0)
      return { label: translate('presentation.command'), text: command };
  }
  if (typeof input === 'string')
    return { label: translate('presentation.parameters'), text: input };
  try {
    return {
      label: translate('presentation.parameters'),
      text: JSON.stringify(input, null, 2) ?? ''
    };
  } catch {
    return {
      label: translate('presentation.parameters'),
      text: translate('presentation.unavailableParameters')
    };
  }
}

export function conversationApproval(item: ConversationItem): Approval | undefined {
  const payload = conversationPayload(item.payload);
  if (item.kind !== 'approval_request' || payload === undefined) return undefined;
  const approvalId = payload.approvalId;
  const approvalStatus = payload.approvalStatus;
  const expiresAt = payload.expiresAt;
  if (
    typeof approvalId !== 'string' ||
    !['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'].includes(String(approvalStatus))
  )
    return undefined;
  return {
    id: approvalId,
    status: approvalStatus as Approval['status'],
    payload: payload.approval,
    expiresAt: typeof expiresAt === 'number' ? expiresAt : 0
  };
}

export { absoluteMessageTime } from './time-presentation.js';
