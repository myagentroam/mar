import { ref, type Ref } from 'vue';
import {
  hostedConversationActivityMessageSchema,
  hostedConversationDirectoryPageSchema,
  type HostedConversationActivity,
  type HostedConversationSummary
} from '@myagentroam/protocol';

export function createHostedConversationDirectoryService(options: {
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly selectedNodeId: Readonly<Ref<string | undefined>>;
  readonly selectedConversationId: Readonly<Ref<string | undefined>>;
  readonly pageSize: number;
  readonly onActivity: (
    nodeId: string,
    conversationId: string,
    activity: HostedConversationActivity
  ) => void;
}) {
  const { selectedNodeId, selectedConversationId, pageSize } = options;
  const conversations = ref<HostedConversationSummary[]>([]);
  const hasMoreConversations = ref(false);
  const loadingConversations = ref(false);
  const loadingMoreConversations = ref(false);
  const loadMoreConversationsError = ref<unknown>();
  const conversationsLoaded = ref(false);
  let listSequence = 0;
  let loadMoreOperation = 0;
  let directoryCursor: string | null = null;
  const activityProjections = new Map<
    string,
    { readonly activity: HostedConversationActivity; readonly revision: number }
  >();
  let activityMessageRevision = 0;
  function responseInvalid(): Error {
    return new Error('HOSTED_CONVERSATION_RESPONSE_INVALID');
  }

  function parseListPage(value: unknown) {
    const parsed = hostedConversationDirectoryPageSchema.safeParse(value);
    if (!parsed.success) throw responseInvalid();
    return parsed.data;
  }

  function mergeProjectedActivity(
    conversation: HostedConversationSummary,
    requestActivityRevision: number
  ): HostedConversationSummary {
    const key = targetKey(conversation.nodeId, conversation.id);
    const projected = activityProjections.get(key);
    if (
      projected !== undefined &&
      projected.revision > requestActivityRevision &&
      projected.activity.version > conversation.activity.version
    )
      return { ...conversation, activity: projected.activity };
    activityProjections.set(key, {
      activity: conversation.activity,
      revision: requestActivityRevision
    });
    return conversation;
  }

  function projectActivityMessage(value: unknown): boolean {
    const parsed = hostedConversationActivityMessageSchema.safeParse(value);
    if (!parsed.success) return false;
    const message = parsed.data;
    const key = targetKey(message.nodeId, message.conversationId);
    const current = activityProjections.get(key);
    if (current !== undefined && message.activity.version <= current.activity.version) return true;
    activityProjections.set(key, {
      activity: message.activity,
      revision: ++activityMessageRevision
    });
    conversations.value = conversations.value.map((conversation) =>
      conversation.nodeId === message.nodeId && conversation.id === message.conversationId
        ? { ...conversation, activity: message.activity }
        : conversation
    );
    options.onActivity(message.nodeId, message.conversationId, message.activity);
    return true;
  }

  function conversationIsRunning(conversation: HostedConversationSummary): boolean {
    return ['STARTING', 'RUNNING', 'CANCELLING'].includes(conversation.activity.status);
  }

  async function loadConversations(): Promise<void> {
    const sequence = ++listSequence;
    const requestActivityRevision = activityMessageRevision;
    loadMoreOperation += 1;
    loadingConversations.value = true;
    loadingMoreConversations.value = false;
    loadMoreConversationsError.value = undefined;
    try {
      const page = parseListPage(
        await options.request<unknown>(`/api/hosted-conversations?limit=${pageSize}`)
      );
      if (sequence !== listSequence) return;
      const currentConversations = conversations.value;
      const currentByKey = new Map(
        currentConversations.map((conversation) => [
          targetKey(conversation.nodeId, conversation.id),
          conversation
        ])
      );
      const selectedConversation = currentConversations.find(
        (conversation) =>
          conversation.nodeId === selectedNodeId.value &&
          conversation.id === selectedConversationId.value
      );
      const items = page.items.map((conversation) => {
        conversation = mergeProjectedActivity(conversation, requestActivityRevision);
        const current = currentByKey.get(targetKey(conversation.nodeId, conversation.id));
        if (current === undefined) return conversation;
        const merged = mergeConversationSummary(conversation, current);
        return merged.activity === conversation.activity
          ? merged
          : { ...merged, activity: conversation.activity };
      });
      if (
        page.items.length > 0 &&
        selectedConversation !== undefined &&
        !page.items.some(
          (conversation) =>
            conversation.nodeId === selectedConversation.nodeId &&
            conversation.id === selectedConversation.id
        )
      )
        items.push(selectedConversation);
      conversations.value = deduplicateConversations(items);
      directoryCursor = page.nextCursor;
      hasMoreConversations.value = directoryCursor !== null;
      conversationsLoaded.value = true;
    } finally {
      if (sequence === listSequence) loadingConversations.value = false;
    }
  }

  async function loadMoreConversations(): Promise<void> {
    const cursor = directoryCursor;
    if (cursor === null || loadingMoreConversations.value || loadingConversations.value) return;
    const sequence = listSequence;
    const operation = ++loadMoreOperation;
    const requestActivityRevision = activityMessageRevision;
    loadingMoreConversations.value = true;
    loadMoreConversationsError.value = undefined;
    try {
      const page = parseListPage(
        await options.request<unknown>(
          `/api/hosted-conversations?limit=${pageSize}&cursor=${encodeURIComponent(cursor)}`
        )
      );
      if (sequence !== listSequence) return;
      if (page.nextCursor === cursor) throw new Error('SESSION_PAGINATION_NO_PROGRESS');
      conversations.value = deduplicateConversations([
        ...conversations.value,
        ...page.items.map((conversation) =>
          mergeProjectedActivity(conversation, requestActivityRevision)
        )
      ]);
      directoryCursor = page.nextCursor;
      hasMoreConversations.value = directoryCursor !== null;
    } catch (error) {
      if (sequence === listSequence) loadMoreConversationsError.value = error;
    } finally {
      if (operation === loadMoreOperation) loadingMoreConversations.value = false;
    }
  }

  function upsertConversation(value: HostedConversationSummary): void {
    const index = conversations.value.findIndex(
      (candidate) => candidate.nodeId === value.nodeId && candidate.id === value.id
    );
    if (index < 0) conversations.value = sortConversations([value, ...conversations.value]);
    else {
      const next = [...conversations.value];
      next.splice(index, 1, mergeConversationSummary(value, next[index]!));
      conversations.value = sortConversations(next);
    }
  }

  function remove(nodeId: string, conversationId: string): void {
    conversations.value = conversations.value.filter(
      (conversation) => conversation.id !== conversationId || conversation.nodeId !== nodeId
    );
  }
  return {
    conversations,
    hasMoreConversations,
    loadingConversations,
    loadingMoreConversations,
    loadMoreConversationsError,
    conversationsLoaded,
    loadConversations,
    loadMoreConversations,
    projectActivityMessage,
    conversationIsRunning,
    upsertConversation,
    remove
  };
}

export function mergeConversationSummary(
  incoming: HostedConversationSummary,
  current: HostedConversationSummary
): HostedConversationSummary {
  const summary =
    incoming.updatedAt < current.updatedAt || incoming.lastActivityAt < current.lastActivityAt
      ? current
      : incoming;
  const incomingActivity = incoming.activity;
  const currentActivity = current.activity;
  const activity =
    incomingActivity.version > currentActivity.version ? incomingActivity : currentActivity;
  return summary.activity === activity ? summary : { ...summary, activity };
}

function deduplicateConversations(
  values: readonly HostedConversationSummary[]
): HostedConversationSummary[] {
  const items = new Map<string, HostedConversationSummary>();
  for (const value of values) {
    const key = targetKey(value.nodeId, value.id);
    const current = items.get(key);
    items.set(key, current === undefined ? value : mergeConversationSummary(value, current));
  }
  return sortConversations([...items.values()]);
}

function sortConversations(
  values: readonly HostedConversationSummary[]
): HostedConversationSummary[] {
  return [...values].sort(
    (left, right) =>
      Number(right.pinnedAt !== null) - Number(left.pinnedAt !== null) ||
      right.lastActivityAt - left.lastActivityAt ||
      left.nodeId.localeCompare(right.nodeId, 'en-US') ||
      left.id.localeCompare(right.id, 'en-US')
  );
}

export function targetKey(nodeId: string, conversationId: string): string {
  return `${nodeId}\0${conversationId}`;
}
