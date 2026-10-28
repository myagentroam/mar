import { ref } from 'vue';
import { limitConversationHistory } from '../util/conversation-history.js';
import { createConversationProjectionState } from './conversation-projection-service.js';

export interface SessionContextUsage {
  readonly model: string | null;
  readonly usedTokens: number;
  readonly maxTokens: number;
  readonly percentage: number;
}

export function isCompletedContextCompaction(item: unknown): boolean {
  const value = record(item);
  return value?.kind === 'context_compaction' && value.status === 'COMPLETED';
}

export function hasRetainedContextCompaction(item: unknown): boolean {
  const value = record(item);
  const payload = record(value?.payload);
  return isCompletedContextCompaction(item) && payload?.retainedContext === true;
}

export function contextUsageAfterCompaction(
  item: unknown,
  current: SessionContextUsage | null | undefined
): SessionContextUsage | null | undefined {
  if (!isCompletedContextCompaction(item)) return current;
  if (hasRetainedContextCompaction(item)) return null;
  return current === null || current === undefined
    ? current
    : { ...current, usedTokens: 0, percentage: 0 };
}

export function createConversationStateService(onRecentWindowOverflow: () => void) {
  const { turns, nextCursor, projection } = createConversationProjectionState({
    onRecentWindowOverflow,
    limitHistory: limitConversationHistory
  });
  let detailRequest = 0;
  let pendingInitialRender:
    | {
        readonly version: number;
        readonly resolve: () => void;
        readonly timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  const initialRenderVersion = ref(0);

  function settleInitialRender(): void {
    if (pendingInitialRender === undefined) return;
    clearTimeout(pendingInitialRender.timer);
    pendingInitialRender.resolve();
    pendingInitialRender = undefined;
  }

  function beginInitialRender(): Promise<void> {
    settleInitialRender();
    initialRenderVersion.value += 1;
    const version = initialRenderVersion.value;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pendingInitialRender?.version !== version) return;
        pendingInitialRender = undefined;
        resolve();
      }, 10_000);
      pendingInitialRender = {
        version,
        resolve,
        // Rendering must not leave the conversation permanently loading if its surface is removed.
        timer
      };
    });
  }

  function confirmInitialRender(version: number): void {
    if (pendingInitialRender?.version !== version) return;
    settleInitialRender();
  }

  return {
    turns,
    nextCursor,
    projection,
    loadingInitial: ref(false),
    initialLoadFailed: ref(false),
    loadingOlder: ref(false),
    channelInput: ref(''),
    channelToken: ref<string>(),
    contextUsage: ref<SessionContextUsage | null>(),
    initialRenderVersion,
    beginInitialRender,
    confirmInitialRender,
    cancelInitialRender: settleInitialRender,
    nextDetailRequest: () => ++detailRequest,
    currentDetailRequest: () => detailRequest
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
