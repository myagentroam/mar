import type { NodeAgentSession } from '../../session/contracts.js';
import type { NodeConversationItem, NodeConversationTurn } from '../../runtime-model.js';
import { boundedConversationItemId, compactRunnerText } from '../normalization.js';
import { publicGoalHistoryText } from '../../service/goal-runtime.js';
import { normalizeOpenCodeTool } from './tool-normalizer.js';
import {
  RunnerUsageTracker,
  usageToken,
  usageTokenSum,
  type RunnerUsageFact
} from '../../service/runner-usage-tracker.js';

export class OpenCodeUsageNormalizer {
  private readonly tracker: RunnerUsageTracker;
  private readonly messages = new Map<string, { model?: string; provider?: string }>();
  constructor(identity: string, publish: (value: RunnerUsageFact) => void) {
    this.tracker = new RunnerUsageTracker(identity, publish);
  }
  observe(value: unknown, startedAt: number | undefined): void {
    if (startedAt === undefined) return;
    const event = record(value),
      properties = record(event?.properties),
      info = record(properties?.info);
    if (
      event?.type === 'message.updated' &&
      info?.role === 'assistant' &&
      typeof info.id === 'string' &&
      typeof record(info.time)?.created === 'number' &&
      Number(record(info.time)?.created) >= startedAt
    )
      this.messages.set(info.id, {
        ...(typeof info.modelID === 'string' ? { model: info.modelID } : {}),
        ...(typeof info.providerID === 'string' ? { provider: info.providerID } : {})
      });
    const part = record(properties?.part);
    if (
      event?.type !== 'message.part.updated' ||
      part?.type !== 'step-finish' ||
      typeof part.id !== 'string' ||
      typeof part.messageID !== 'string'
    )
      return;
    const model = this.messages.get(part.messageID);
    if (!model) return;
    const tokens = record(part.tokens),
      cache = record(tokens?.cache);
    const input = usageToken(tokens?.input),
      output = usageToken(tokens?.output),
      read = usageToken(cache?.read),
      write = usageToken(cache?.write),
      reasoning = usageToken(tokens?.reasoning);
    const inputTokens =
      input === undefined ? undefined : usageTokenSum(input, read ?? '0', write ?? '0');
    const outputTokens = output === undefined ? undefined : usageTokenSum(output, reasoning ?? '0');
    this.tracker.snapshot(
      part.id,
      {
        purpose: 'conversation',
        agentRole: 'root',
        ...(model.model ? { actualModel: model.model } : {}),
        ...(model.provider ? { provider: model.provider } : {}),
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(read === undefined ? {} : { cacheReadTokens: read }),
        ...(write === undefined ? {} : { cacheWriteTokens: write }),
        ...(reasoning === undefined ? {} : { reasoningTokens: reasoning })
      },
      true,
      'partial'
    );
  }
  finish(state: 'succeeded' | 'failed' | 'cancelled'): void {
    this.tracker.finish(state);
  }
}

export function openCodeUserMessagePreview(messages: readonly unknown[]): string | undefined {
  for (const message of messages) {
    const entry = record(message);
    const info = record(entry?.info);
    if (info?.role !== 'user' || typeof info.id !== 'string') continue;
    const parts = array(entry?.parts);
    if (parts.some((part) => record(part)?.type === 'compaction')) continue;
    const text = parts
      .flatMap((part) => {
        const value = record(part);
        return value?.type === 'text' &&
          value.synthetic !== true &&
          value.ignored !== true &&
          typeof value.text === 'string'
          ? [value.text]
          : [];
      })
      .join('\n');
    const preview = publicGoalHistoryText(text).trim().replace(/\s+/gu, ' ').slice(0, 160);
    if (preview) return preview;
  }
  return undefined;
}

export function openCodeConversationPage(
  session: NodeAgentSession,
  messages: readonly unknown[],
  input: { readonly cursor?: string; readonly limit?: number },
  managedTurn: (nativeTurnId: string) => NodeConversationTurn | undefined
):
  | { readonly turns: readonly NodeConversationTurn[]; readonly nextCursor: string | null }
  | undefined {
  const records = messages.flatMap((value) => {
    const entry = record(value);
    const info = record(entry?.info);
    return info === undefined || typeof info.id !== 'string'
      ? []
      : [{ info, parts: array(entry?.parts) }];
  });
  const parsedTurns = records
    .filter(({ info }) => info.role === 'user')
    .flatMap(({ info, parts }, sequence) => {
      const assistants = records.filter(
        (candidate) => candidate.info.role === 'assistant' && candidate.info.parentID === info.id
      );
      const existing = managedTurn(info.id as string);
      const turn = openCodeTurn(session, info, parts, assistants, sequence, existing);
      const after = assistants.at(-1)?.info.id ?? info.id;
      return turn === undefined || typeof after !== 'string' ? [] : [{ after, turn }];
    });
  const turns = parsedTurns.map(({ after, turn }, index) => ({
    ...turn,
    rewind: { before: parsedTurns[index - 1]?.after ?? null, after }
  }));
  if (turns.length === 0) return undefined;
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 500);
  const end = pageEnd(input.cursor, session.id, turns.length);
  const start = Math.max(0, end - limit);
  return {
    turns: turns.slice(start, end),
    nextCursor:
      start === 0
        ? null
        : Buffer.from(JSON.stringify({ sessionId: session.id, end: start })).toString('base64url')
  };
}

function openCodeTurn(
  session: NodeAgentSession,
  user: Record<string, unknown>,
  userParts: readonly unknown[],
  assistants: readonly {
    readonly info: Record<string, unknown>;
    readonly parts: readonly unknown[];
  }[],
  sequence: number,
  managed: NodeConversationTurn | undefined
): NodeConversationTurn | undefined {
  const nativeTurnId = user.id as string;
  const startedAt = number(record(user.time)?.created);
  const items: NodeConversationItem[] = [];
  const compactionParts = userParts.filter((part) => record(part)?.type === 'compaction');
  const compactionCompletedAt =
    Math.max(0, ...assistants.map(({ info }) => number(record(info.time)?.completed) ?? 0)) || null;
  const userText = userParts
    .flatMap((part) => {
      const value = record(part);
      return value?.type === 'text' && typeof value.text === 'string' ? [value.text] : [];
    })
    .join('\n');
  const localUser = managed?.items.find((item) => item.kind === 'user_message');
  if (localUser !== undefined) items.push({ ...localUser, turnId: managed!.id });
  else if (publicGoalHistoryText(userText).length > 0)
    items.push(
      item(
        session,
        nativeTurnId,
        `user-${nativeTurnId}`,
        'user_message',
        'COMPLETED',
        {
          text: compactRunnerText(publicGoalHistoryText(userText), 20_000),
          attachments: []
        },
        startedAt,
        startedAt,
        sequence
      )
    );
  for (const part of compactionParts) {
    const projected = partItem(
      session,
      nativeTurnId,
      part,
      false,
      startedAt,
      compactionCompletedAt,
      sequence
    );
    if (projected !== undefined) items.push(projected);
  }
  for (const assistant of compactionParts.length === 0 ? assistants : []) {
    const completedAt = number(record(assistant.info.time)?.completed);
    for (const part of assistant.parts) {
      const projected = partItem(
        session,
        nativeTurnId,
        part,
        assistant.info.mode === 'plan',
        startedAt,
        completedAt,
        sequence
      );
      if (projected !== undefined)
        items.push({
          ...projected,
          ...(typeof assistant.info.id === 'string' && typeof record(part)?.id === 'string'
            ? { sourceItemId: openCodeSourceItemId(assistant.info.id, record(part)!.id as string) }
            : {})
        });
    }
  }
  if (items.length === 0) return undefined;
  const completedAt =
    Math.max(
      startedAt ?? 0,
      ...assistants.map(({ info }) => number(record(info.time)?.completed) ?? 0)
    ) || startedAt;
  const id = managed?.id ?? `${session.id}:official:${nativeTurnId}`;
  const runId = managed?.runId ?? null;
  const officialAssistantIds = new Set(
    assistants.flatMap(({ parts }) =>
      parts.flatMap((part) => {
        const value = record(part);
        return value?.type === 'text' && typeof value.id === 'string'
          ? [`${managed?.runId}:${boundedConversationItemId('opencode', value.id)}`]
          : [];
      })
    )
  );
  const pendingOfficialReply = managed?.items.some(
    (item) => item.kind === 'assistant_message' && !officialAssistantIds.has(item.id)
  );
  const projectedItems = pendingOfficialReply ? managed!.items : items;
  return {
    id,
    sessionId: session.id,
    runId,
    userItemId: items.find((value) => value.kind === 'user_message')?.id ?? null,
    status: assistants.some(({ info }) => info.error !== undefined) ? 'FAILED' : 'SUCCEEDED',
    model:
      (assistants.find(({ info }) => typeof info.modelID === 'string')?.info.modelID as
        string | undefined) ?? null,
    effort: managed?.effort ?? null,
    access: managed?.access ?? null,
    items: projectedItems.map((value) => ({ ...value, turnId: id, runId })),
    startedAt,
    completedAt
  };
}

function partItem(
  session: NodeAgentSession,
  turnId: string,
  raw: unknown,
  planMode: boolean,
  startedAt: number | null,
  completedAt: number | null,
  sequence: number
): NodeConversationItem | undefined {
  const part = record(raw);
  if (typeof part?.id !== 'string' || typeof part.type !== 'string') return undefined;
  if (part.type === 'reasoning' && (typeof part.text !== 'string' || !part.text.trim()))
    return undefined;
  if ((part.type === 'text' || part.type === 'reasoning') && typeof part.text === 'string')
    return item(
      session,
      turnId,
      part.id,
      part.type === 'text' ? (planMode ? 'plan' : 'assistant_message') : 'reasoning',
      completedAt === null ? 'IN_PROGRESS' : 'COMPLETED',
      part.type === 'text'
        ? planMode
          ? { explanation: compactRunnerText(part.text, 20_000), steps: [] }
          : { text: compactRunnerText(part.text, 20_000), format: 'markdown', model: null }
        : {
            representation: 'unspecified',
            sections: [{ index: 0, text: compactRunnerText(part.text, 10_000) }]
          },
      startedAt,
      completedAt,
      sequence
    );
  if (part.type === 'tool' && typeof part.tool === 'string') {
    const state = record(part.state);
    if (part.tool === 'question' && typeof part.callID === 'string') {
      const questions = openCodeQuestions(record(state?.input)?.questions);
      if (questions.length > 0)
        return item(
          session,
          turnId,
          part.id,
          'user_input_request',
          'COMPLETED',
          { requestId: `native:${part.callID}`, questions },
          startedAt,
          completedAt,
          sequence
        );
    }
    const status =
      state?.status === 'completed'
        ? 'COMPLETED'
        : state?.status === 'error'
          ? 'FAILED'
          : 'IN_PROGRESS';
    const normalized = normalizeOpenCodeTool(part.tool, state);
    return item(
      session,
      turnId,
      part.id,
      normalized.kind,
      status,
      normalized.payload,
      startedAt,
      completedAt,
      sequence
    );
  }
  if (part.type === 'compaction')
    return item(
      session,
      turnId,
      part.id,
      'context_compaction',
      completedAt === null ? 'IN_PROGRESS' : 'COMPLETED',
      {
        phase: completedAt === null ? 'STARTED' : 'COMPLETED',
        summary: null
      },
      startedAt,
      completedAt,
      sequence
    );
  if (part.type === 'patch')
    return item(
      session,
      turnId,
      part.id,
      'tool_call',
      'COMPLETED',
      openCodePatchToolPayload(),
      startedAt,
      completedAt,
      sequence
    );
  if (part.type === 'step-start' || part.type === 'step-finish') return undefined;
  if (part.type === 'text' || part.type === 'reasoning') return undefined;
  return item(
    session,
    turnId,
    part.id,
    'unknown',
    completedAt === null ? 'IN_PROGRESS' : 'COMPLETED',
    {
      sourceEventType: `opencode:${part.type}`,
      label: `OpenCode ${compactRunnerText(part.type, 128)}`
    },
    startedAt,
    completedAt,
    sequence
  );
}

export function openCodeQuestions(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) return [];
  return value.flatMap((value, index) => {
    const question = record(value);
    if (typeof question?.question !== 'string') return [];
    const options = (Array.isArray(question.options) ? question.options : []).flatMap((value) => {
      const option = record(value);
      const label = typeof option?.label === 'string' ? compactRunnerText(option.label, 500) : '';
      return label.length === 0
        ? []
        : [
            {
              value: label,
              label,
              description:
                typeof option?.description === 'string'
                  ? compactRunnerText(option.description, 1_000)
                  : null
            }
          ];
    });
    const multiSelect = question.multiple === true;
    return [
      {
        id: `question-${index + 1}`,
        prompt: compactRunnerText(question.question, 5_000),
        input: options.length === 0 ? 'SHORT_TEXT' : multiSelect ? 'MULTI_SELECT' : 'SINGLE_SELECT',
        options,
        allowOther: true,
        multiSelect
      }
    ];
  });
}

export function openCodePatchToolPayload() {
  return {
    namespace: 'opencode',
    toolName: 'patch',
    title: 'patch',
    inputSummary: null,
    outputSummary: 'OpenCode applied the patch',
    outputSummaryCode: 'OPENCODE_PATCH_APPLIED',
    progressLabel: null,
    errorCode: null,
    truncated: false
  };
}

export function openCodeSourceItemId(messageId: string, partId: string): string {
  return JSON.stringify(['opencode', messageId, partId]);
}

function item(
  session: NodeAgentSession,
  turnId: string,
  nativeId: string,
  kind: string,
  status: string,
  payload: unknown,
  startedAt: number | null,
  completedAt: number | null,
  sequence: number
): NodeConversationItem {
  return {
    id: boundedConversationItemId(`${session.id}:official:${turnId}`, nativeId),
    sessionId: session.id,
    turnId: `${session.id}:official:${turnId}`,
    runId: null,
    parentItemId: null,
    sourceSequence: sequence,
    revision: 1,
    kind,
    status,
    payload,
    startedAt,
    completedAt
  };
}

function pageEnd(cursor: string | undefined, sessionId: string, fallback: number): number {
  if (cursor === undefined) return fallback;
  try {
    const parsed = record(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    return parsed?.sessionId === sessionId && Number.isInteger(parsed.end)
      ? Math.min(Math.max(Number(parsed.end), 0), fallback)
      : fallback;
  } catch {
    return fallback;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
