import { MarAgentError } from '../../error.js';
import type { SessionStore } from '../../session/store/contracts.js';
import { appliedInputRecord, pendingDeferredInputs } from '../../session/deferred-input.js';
import type { ModelMessage } from '../../model/contracts.js';
import {
  compactSummaryFromCheckpoint,
  replacementHistoryFromCheckpoint,
  inputMetadataFromRecord
} from '../../session/store/execution-state.js';
import type { CompactUserInput } from '../../session/store/contracts.js';
import { compactedHistoryMessages, continuationMessage } from '../compaction/history.js';
import { restoreCompactTail } from '../compaction/retained-context.js';
import type { EnvironmentContextState } from './contracts.js';
import { environmentContextUpdate, restoreEnvironmentState } from './environment.js';
import { buildContextProjection, type ContextProjection } from './projection.js';
export async function restoreMessages(
  store: SessionStore,
  sessionId: string,
  records: readonly import('../../session/store/index.js').SessionRecord[],
  options: {
    includeImages: boolean;
    strictImages?: boolean;
    currentTurnId?: string;
    projection?: ContextProjection;
    messageSources?: WeakMap<ModelMessage, import('../../session/store/index.js').SessionRecord>;
  }
) {
  const messages: ModelMessage[] = [];
  const outcomes = new Map<string, { isError: boolean; result?: unknown }>();
  const toolOutcomes = new WeakMap<ModelMessage, { isError: boolean; result?: unknown }>();
  const modelProjection = new Map(
    (
      options.projection ??
      buildContextProjection(records, (await store.getSession(sessionId)).workspace)
    ).entries.map((entry) => [entry.record.recordId, entry.message] as const)
  );
  let userMessages: CompactUserInput[] = [];
  let ignoredImages = 0;
  let currentTurnUserIndex: number | undefined;
  let environmentState: EnvironmentContextState | undefined;
  const pendingInputs = pendingDeferredInputs(records);
  for (const record of records) {
    const messageStart = messages.length;
    const applied = appliedInputRecord(record);
    const inputRecord = applied ?? record;
    const payload = inputRecord.payload as Record<string, unknown>;
    if (
      (record.type === 'tool.completed' || record.type === 'tool.failed') &&
      typeof payload.callId === 'string'
    ) {
      const result = record.type === 'tool.failed' ? payload.message : payload.data;
      outcomes.set(JSON.stringify([record.executionId, payload.callId]), {
        isError: record.type === 'tool.failed',
        ...(result === undefined ? {} : { result: structuredClone(result) })
      });
    }
    const compactSummary = compactSummaryFromCheckpoint(record);
    if (
      (applied ||
        ((record.type === 'turn.user' || record.type === 'extension.input') &&
          payload.deferred !== true)) &&
      typeof payload.prompt === 'string'
    ) {
      const content = typeof payload.modelText === 'string' ? payload.modelText : payload.prompt;
      const metadata = inputMetadataFromRecord(inputRecord);
      userMessages.push({ content, metadata });
      let images = [] as Awaited<ReturnType<SessionStore['readInputImages']>>;
      if (options.includeImages)
        try {
          images = await store.readInputImages(sessionId, payload.images);
          if (
            options.strictImages &&
            payload.images !== undefined &&
            (!Array.isArray(payload.images) || images.length !== payload.images.length)
          )
            throw new MarAgentError(
              'MAR_AGENT_SESSION_CORRUPT',
              'Session input images cannot be fully restored.'
            );
        } catch (error) {
          if (options.strictImages) throw error;
          if (!(error instanceof MarAgentError) || error.code !== 'MAR_AGENT_SESSION_CORRUPT')
            throw error;
          ignoredImages += Array.isArray(payload.images) ? payload.images.length : 1;
        }
      if (record.turnId === options.currentTurnId && currentTurnUserIndex === undefined)
        currentTurnUserIndex = messages.length;
      messages.push({
        role: 'user',
        content,
        metadata,
        ...(images.length ? { images } : {})
      });
      const context = payload.modelContext ?? payload.context;
      if (payload.contextRecords !== true && Array.isArray(context))
        for (const text of context)
          if (typeof text === 'string')
            messages.push({ role: 'user', content: text, contextKind: 'contextual' });
    } else if (record.type === 'input.context') {
      if (Array.isArray(payload.modelContext))
        for (const text of payload.modelContext)
          if (typeof text === 'string')
            messages.push({ role: 'user', content: text, contextKind: 'contextual' });
    } else if (
      (record.type === 'message.completed' || record.type === 'plan.completed') &&
      typeof payload.text === 'string'
    )
      messages.push({ role: 'assistant', content: payload.text });
    else if (compactSummary !== undefined) {
      environmentState = restoreEnvironmentState({ version: 1, state: payload.environment });
      if (environmentState) messages.push(environmentContextUpdate(environmentState)!);
      const history = replacementHistoryFromCheckpoint(record);
      userMessages =
        history
          ?.filter((message) => message.kind !== 'summary')
          .map((message) => ({
            content: message.content,
            ...(message.metadata
              ? { metadata: { ...message.metadata } }
              : message.kind === 'extension_input'
                ? { metadata: { source: 'extension' as const } }
                : {})
          })) ?? [];
      messages.push(
        ...(history
          ? compactedHistoryMessages(history)
          : [
              {
                role: 'user' as const,
                content: continuationMessage(compactSummary),
                contextKind: 'summary' as const
              }
            ])
      );
      if (Array.isArray(payload.retainedModelContext))
        for (const item of payload.retainedModelContext) {
          if (!item || typeof item !== 'object') continue;
          const message = restoreCompactTail(item);
          if (message) {
            if (options.includeImages && (item as Record<string, unknown>).inputRef !== undefined) {
              const input = appliedInputRecord({
                ...record,
                type: 'model.context',
                payload: item
              })!;
              const images = await store.readInputImages(
                sessionId,
                (input.payload as Record<string, unknown>).images
              );
              if (images.length) message.images = images;
            }
            messages.push(message);
            if (message.role === 'user' && message.contextKind === undefined)
              userMessages.push({
                content: message.content,
                ...(message.metadata ? { metadata: message.metadata } : {})
              });
          }
        }
    } else if (record.type === 'context.environment') {
      const current = restoreEnvironmentState(payload);
      if (current) {
        const message = environmentContextUpdate(current, environmentState);
        if (message) messages.push(message);
        environmentState = current;
      }
    } else if (record.type === 'model.context') {
      const message = modelProjection.get(record.recordId);
      if (message) {
        messages.push(message);
        if (message.role === 'tool' && message.callId !== undefined) {
          const outcome = outcomes.get(JSON.stringify([record.executionId, message.callId]));
          if (outcome) toolOutcomes.set(message, outcome);
        }
      }
    }
    for (const message of messages.slice(messageStart))
      options.messageSources?.set(message, record);
  }
  const completedToolCalls = new Set(
    messages.filter((message) => message.role === 'tool').map((message) => message.callId)
  );
  return {
    toolOutcomes,
    pendingInputs,
    environmentState,
    userMessages,
    messages: messages.filter((message) => {
      if (message.role === 'tool_call') return completedToolCalls.has(message.callId);
      if (message.role !== 'provider' || message.provider !== 'OPENAI_RESPONSES') return true;
      const item = message.item as Record<string, unknown>;
      if (item.type !== 'function_call' && item.type !== 'custom_tool_call') return true;
      return typeof item.call_id !== 'string' || completedToolCalls.has(item.call_id);
    }),
    ignoredImages,
    currentTurnUserIndex
  };
}
