import type { WorkspaceTarget } from '../model/workbench.js';
import type { ComputedRef, Ref } from 'vue';
import type { WorkspaceQueue, WorkspaceQueueItem } from '../model/workbench.js';
import { translate } from './LocalePreferenceService.js';

export function createWorkspaceQueueService(options: {
  readonly queue: Ref<WorkspaceQueue>;
  readonly currentSessionQueue: ComputedRef<WorkspaceQueue>;
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly selectedSessionId: Ref<string | undefined>;
  readonly draggingQueueItemId: Ref<string | undefined>;
  readonly editingContent: Ref<string>;
  readonly serializeEditedContent?: (content: string) => string;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly finishEditing: () => void;
  readonly notice: (value: string) => void;
  readonly errorMessage: (error: unknown) => string;
  readonly missingQueueItemError: (error: unknown) => boolean;
  readonly beginSubmission: (context?: string) => (() => boolean) | undefined;
}) {
  function current(nodeId: string, workspaceId: string, sessionId: string): boolean {
    return (
      options.workspaceTarget.value?.nodeId === nodeId &&
      options.workspaceTarget.value?.workspaceId === workspaceId &&
      options.selectedSessionId.value === sessionId
    );
  }

  async function reorder(targetQueueItemId: string): Promise<void> {
    const sourceQueueItemId = options.draggingQueueItemId.value;
    const nodeId = options.workspaceTarget.value?.nodeId;
    const workspaceId = options.workspaceTarget.value?.workspaceId;
    const sessionId = options.selectedSessionId.value;
    if (
      sourceQueueItemId === undefined ||
      sourceQueueItemId === targetQueueItemId ||
      nodeId === undefined ||
      workspaceId === undefined ||
      sessionId === undefined
    )
      return;
    const items = [...options.currentSessionQueue.value.items];
    const source = items.findIndex((item) => item.queueItemId === sourceQueueItemId);
    const target = items.findIndex((item) => item.queueItemId === targetQueueItemId);
    if (source < 0 || target < 0) return;
    const [moved] = items.splice(source, 1);
    items.splice(target, 0, moved!);
    try {
      await options.request(`/api/workspaces/${encodeURIComponent(workspaceId)}/queue`, {
        method: 'PUT',
        body: JSON.stringify({
          nodeId,
          sessionId,
          expectedVersion: options.queue.value.version,
          queueItemIds: items.map((item) => item.queueItemId)
        })
      });
    } catch (error) {
      if (current(nodeId, workspaceId, sessionId))
        options.notice(
          translate('generated.workspaceQueueService.theQueueOrderChangedTryAgain', {
            value0: options.errorMessage(error)
          })
        );
    } finally {
      if (options.draggingQueueItemId.value === sourceQueueItemId)
        options.draggingQueueItemId.value = undefined;
    }
  }

  async function save(
    queueItemId: string,
    nextContent = options.editingContent.value
  ): Promise<boolean> {
    const nodeId = options.workspaceTarget.value?.nodeId;
    const workspaceId = options.workspaceTarget.value?.workspaceId;
    const sessionId = options.selectedSessionId.value;
    const content = options.serializeEditedContent?.(nextContent) ?? nextContent.trim();
    if (
      nodeId === undefined ||
      workspaceId === undefined ||
      sessionId === undefined ||
      content.length === 0
    )
      return false;
    try {
      await options.request(`/api/queue-items/${encodeURIComponent(queueItemId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ nodeId, workspaceId, sessionId, content })
      });
      if (current(nodeId, workspaceId, sessionId)) options.finishEditing();
      return true;
    } catch (error) {
      if (options.missingQueueItemError(error)) {
        if (current(nodeId, workspaceId, sessionId)) options.finishEditing();
        return false;
      }
      if (current(nodeId, workspaceId, sessionId))
        options.notice(
          translate('generated.workspaceQueueService.unableToEditTheQueuedMessage', {
            value0: options.errorMessage(error)
          })
        );
      return false;
    }
  }

  async function remove(queueItemId: string): Promise<void> {
    const nodeId = options.workspaceTarget.value?.nodeId;
    const workspaceId = options.workspaceTarget.value?.workspaceId;
    const sessionId = options.selectedSessionId.value;
    if (nodeId === undefined || workspaceId === undefined) return;
    try {
      await options.request(`/api/queue-items/${encodeURIComponent(queueItemId)}`, {
        method: 'DELETE',
        body: JSON.stringify({ nodeId, workspaceId })
      });
    } catch (error) {
      if (options.missingQueueItemError(error)) return;
      if (sessionId !== undefined && current(nodeId, workspaceId, sessionId))
        options.notice(
          translate('generated.workspaceQueueService.unableToDeleteTheQueuedMessage', {
            value0: options.errorMessage(error)
          })
        );
    }
  }

  async function execute(item: WorkspaceQueueItem, editedContent?: string): Promise<void> {
    const nodeId = options.workspaceTarget.value?.nodeId;
    const workspaceId = options.workspaceTarget.value?.workspaceId;
    const sessionId = item.sessionId ?? options.selectedSessionId.value;
    if (nodeId === undefined || workspaceId === undefined) return;
    const finishSubmission = options.beginSubmission(
      sessionId === undefined ? undefined : `session:${sessionId}`
    );
    if (finishSubmission === undefined) return;
    try {
      if (editedContent !== undefined && !(await save(item.queueItemId, editedContent))) return;
      await options.request(`/api/queue-items/${encodeURIComponent(item.queueItemId)}/execute`, {
        method: 'POST',
        body: JSON.stringify({ nodeId, workspaceId })
      });
    } catch (error) {
      const completedInSubmissionWindow = finishSubmission();
      if (options.missingQueueItemError(error)) return;
      if (
        completedInSubmissionWindow &&
        sessionId !== undefined &&
        current(nodeId, workspaceId, sessionId)
      )
        options.notice(
          translate('generated.workspaceQueueService.unableToRunTheQueuedMessageNow', {
            value0: options.errorMessage(error)
          })
        );
    } finally {
      finishSubmission();
    }
  }

  return { reorder, save, remove, execute };
}
