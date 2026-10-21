import type { WorkspaceTarget } from '../model/workbench.js';
import type { WorkbenchNotificationTarget } from './WorkbenchNotificationService.js';

export async function navigateWorkbenchNotification(
  target: WorkbenchNotificationTarget,
  options: {
    readonly workspaceTarget: () => WorkspaceTarget | undefined;
    readonly hasSession: (sessionId: string) => boolean;
    readonly showNodes: () => void;
    readonly activateWorkspace: (target: WorkspaceTarget) => Promise<boolean>;
    readonly synchronizeSessions: (workspaceId: string) => Promise<void>;
    readonly openSession: (sessionId: string) => Promise<void>;
    readonly showConversations?: () => void;
    readonly openHostedConversation?: (nodeId: string, conversationId: string) => Promise<void>;
  }
): Promise<void> {
  if (target.targetType === 'HOSTED_CONVERSATION') {
    if (options.showConversations === undefined || options.openHostedConversation === undefined)
      throw new Error('NOTIFICATION_TARGET_NOT_SELECTED');
    options.showConversations();
    await options.openHostedConversation(target.nodeId, target.conversationId);
    return;
  }
  options.showNodes();
  if (target.workspaceId === undefined) return;
  if (
    !(await options.activateWorkspace({ nodeId: target.nodeId, workspaceId: target.workspaceId }))
  )
    throw new Error('NOTIFICATION_TARGET_NOT_SELECTED');
  const selected = options.workspaceTarget();
  if (selected?.nodeId !== target.nodeId || selected.workspaceId !== target.workspaceId)
    throw new Error('NOTIFICATION_TARGET_NOT_SELECTED');
  if (target.sessionId === undefined) return;
  if (!options.hasSession(target.sessionId)) await options.synchronizeSessions(target.workspaceId);
  if (options.workspaceTarget() !== selected) return;
  await options.openSession(target.sessionId);
}
