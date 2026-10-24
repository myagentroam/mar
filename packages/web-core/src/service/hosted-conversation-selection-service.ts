import type { HostedConversationSnapshot, HostedConversationSummary } from '@myagentroam/protocol';

interface HostedConversationTarget {
  readonly nodeId: string;
  readonly conversationId: string;
}

export function createHostedConversationSelectionService(options: {
  readonly workspace: {
    selectConversation(
      nodeId: string,
      conversationId: string,
      snapshot?: HostedConversationSnapshot
    ): void;
    clearSelectedConversation(): void;
  };
  readonly markRead: (nodeId: string, conversationId: string) => void;
  readonly coordinator: () =>
    | {
        beginHostedConversation(): Promise<void>;
        stopHostedConversation(): void;
      }
    | undefined;
}) {
  let selectionGeneration = 0;

  async function openTarget(
    nodeId: string,
    conversationId: string,
    snapshot?: HostedConversationSnapshot
  ): Promise<void> {
    selectionGeneration += 1;
    options.workspace.selectConversation(nodeId, conversationId, snapshot);
    options.markRead(nodeId, conversationId);
    await options.coordinator()?.beginHostedConversation();
  }

  function select(
    conversation: HostedConversationSummary,
    snapshot?: HostedConversationSnapshot
  ): Promise<void> {
    return openTarget(conversation.nodeId, conversation.id, snapshot);
  }

  function clear(): void {
    selectionGeneration += 1;
    options.coordinator()?.stopHostedConversation();
    options.workspace.clearSelectedConversation();
  }

  async function restoreTarget(
    target: HostedConversationTarget,
    syncRoute: () => void
  ): Promise<void> {
    const generation = selectionGeneration + 1;
    try {
      await openTarget(target.nodeId, target.conversationId);
    } catch {
      if (generation !== selectionGeneration) return;
      clear();
      syncRoute();
    }
  }

  return { select, openTarget, clear, restoreTarget };
}
